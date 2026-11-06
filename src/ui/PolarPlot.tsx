import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../state/store';
import { polarResponse, type PolarPlane } from '../engine/polar';
import { Icon } from './icons';
import { useT } from '../i18n/useT';
import type { EngineSource } from '../engine/types';
import type { GroundModel } from '../core/types';

/**
 * Free- and far-field polar pattern of the whole array, at up to four
 * frequencies at once.
 *
 * This is the view that answers "what shape is this array", independently of the
 * room and of where the audience happens to sit. It is read off the same engine
 * as the map, on a circle far enough out that spreading loss is common to every
 * angle and cancels in the normalisation.
 */

/** One colour per trace slot, in the order they are drawn. */
const TRACE_COLORS = ['#e2483c', '#e8c33a', '#54c264', '#4da3ff'];

const SIZE = 300;
const R = 116;
const CX = SIZE / 2;
const CY = SIZE / 2 + 6;
const RANGE_DB = 30;

/** Screen point for an angle and a level, in dB below the trace peak. */
function pt(angleDeg: number, db: number) {
  const clamped = Math.max(-RANGE_DB, Math.min(0, db));
  const r = R * (1 + clamped / RANGE_DB);
  // 0 deg points up (the array front), positive angles swing clockwise
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)] as const;
}

export function PolarPlot({
  sources,
  speedOfSound,
  ground,
  style,
}: {
  sources: EngineSource[];
  speedOfSound: number;
  ground: GroundModel;
  style?: React.CSSProperties;
}) {
  const s = useStore();
  const tr = useT();

  // The polar shows the same slice of the room as the map: switching the view to
  // the side section switches the polar to the elevation plane with it. The
  // toggle still overrides, until the view changes again.
  const viewPlane: PolarPlane = s.sim.plane === 'top' ? 'horizontal' : 'vertical';
  const [plane, setPlane] = useState<PolarPlane>(viewPlane);
  useEffect(() => setPlane(viewPlane), [viewPlane]);

  const result = useMemo(() => {
    if (!sources.length) return null;
    return polarResponse({
      sources,
      frequencies: s.polarFrequencies,
      speedOfSound,
      ground,
      plane,
      stepDeg: 1.5,
    });
  }, [sources, s.polarFrequencies, speedOfSound, ground, plane]);

  const rings = [-6, -12, -18, -24];
  const spokes = [0, 30, 60, 90, 120, 150, 180, -150, -120, -90, -60, -30];

  return (
    <section className="panel polar-panel" style={style}>
      <header className="panel-head">
        {tr('polar.title')}
        <span className="spacer" />
        <div className="seg small">
          <button
            className={plane === 'horizontal' ? 'on' : ''}
            onClick={() => setPlane('horizontal')}
            title={tr('polar.horizHint')}
          >
            {tr('polar.horiz')}
          </button>
          <button
            className={plane === 'vertical' ? 'on' : ''}
            onClick={() => setPlane('vertical')}
            title={tr('polar.vertHint')}
          >
            {tr('polar.vert')}
          </button>
        </div>
        <button className="panel-head-btn" aria-label={tr('ui.close')} onClick={() => s.toggle('showPolar')}><Icon name="close" /></button>
      </header>

      <div className="polar-body">
        {/* sized by CSS, not by attributes: the dock height varies with the
            window and a fixed pixel size would clip the plot */}
        <svg
          className="polar-svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          preserveAspectRatio="xMidYMid meet"
        >
          <circle cx={CX} cy={CY} r={R} className="polar-outer" />
          {rings.map((db) => (
            <g key={db}>
              <circle cx={CX} cy={CY} r={R * (1 + db / RANGE_DB)} className="polar-ring" />
              <text x={CX + 3} y={CY - R * (1 + db / RANGE_DB) + 9} className="polar-ringlabel">
                {db}
              </text>
            </g>
          ))}
          {spokes.map((a) => {
            const [x, y] = pt(a, 0);
            const la = ((a - 90) * Math.PI) / 180;
            return (
              <g key={a}>
                <line x1={CX} y1={CY} x2={x} y2={y} className="polar-spoke" />
                <text
                  x={CX + (R + 11) * Math.cos(la)}
                  y={CY + (R + 11) * Math.sin(la) + 3}
                  className="polar-anglelabel"
                  textAnchor="middle"
                >
                  {a}
                </text>
              </g>
            );
          })}

          {result?.traces.map((t, i) => {
            const d = result.anglesDeg
              .map((a, k) => {
                const [x, y] = pt(a, t.db[k]);
                return `${k === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
              })
              .join('');
            return <path key={t.frequencyHz + '-' + i} d={`${d}Z`} className="polar-trace" style={{ stroke: TRACE_COLORS[i] }} />;
          })}

          {!result && (
            <text x={CX} y={CY} className="polar-anglelabel" textAnchor="middle">
              {tr('polar.noSources')}
            </text>
          )}
        </svg>

        <div className="polar-legend">
          <div className="polar-legend-head">
            {/* Both planes are cut through the same on-axis direction, so 0°
                means the same thing on either one. */}
            0° = {tr('polar.forward')} · +Y
          </div>
          {s.polarFrequencies.map((f, i) => (
            <label key={i} className="polar-freq">
              <span className="polar-swatch" style={{ background: TRACE_COLORS[i] }} />
              <input
                type="number"
                min={5}
                max={500}
                step={1}
                value={f}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v)) s.setPolarFrequency(i, Math.max(1, Math.min(500, v)));
                }}
              />
              <em>Hz</em>
            </label>
          ))}
          <p className="panel-note">
            {tr('polar.note', { r: result ? result.radiusM.toFixed(0) : '-' })}
          </p>
        </div>
      </div>
    </section>
  );
}
