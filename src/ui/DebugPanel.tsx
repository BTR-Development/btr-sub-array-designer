import { useMemo } from 'react';
import { Icon } from './icons';
import { computePoint } from '../engine/engine';
import { resolveAll, toEngineSources } from '../state/resolve';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';

/**
 * Developer view of the summation at one receiver. Every column here is a term
 * the engine actually used, so a wrong pattern can be traced to a wrong number.
 */
export function DebugPanel({ style }: { style?: React.CSSProperties }) {
  const s = useStore();
  const t = useT();
  // An explicitly selected measurement point wins over the loose click probe.
  const receiver =
    s.measurementPoints.find((m) => m.id === s.selectedPointId)?.position ??
    s.cursorPoint ??
    s.measurementPoints[0]?.position ??
    null;

  const engineSources = useMemo(
    () => toEngineSources(resolveAll(s.sources, s.groups, s.provider)),
    [s.sources, s.groups, s.provider],
  );

  const res = useMemo(
    () => (receiver ? computePoint(engineSources, receiver, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground) : null),
    [engineSources, receiver, s.sim.frequencyHz, s.sim.speedOfSound, s.sim.ground],
  );

  const labelOf = (id: string) => {
    const base = id.replace(/#img$/, '');
    const src = s.sources.find((x) => x.id === base);
    return (src?.label ?? base) + (id.endsWith('#img') ? ` (${t('dbg.groundImage')})` : '');
  };

  return (
    <div className="debug" style={style}>
      <header>
        <b>{t('dbg.title')}</b>
        <span className="mono">
          {receiver
            ? t('dbg.receiver', {
                x: receiver.x.toFixed(2),
                y: receiver.y.toFixed(2),
                z: receiver.z.toFixed(2),
                hz: s.sim.frequencyHz.toFixed(1),
                c: s.sim.speedOfSound.toFixed(1),
              })
            : t('dbg.noReceiver')}
        </span>
        <button className="icon-btn" aria-label="Close" onClick={() => s.toggle('showDebug')}><Icon name="close" /></button>
      </header>
      {res && (
        <>
          <div className="debug-total mono">
            Σ p = {res.re.toExponential(4)} {res.im < 0 ? '−' : '+'} j{Math.abs(res.im).toExponential(4)} →{' '}
            <b>{res.splDb.toFixed(2)} dBFS</b> @ {res.phaseDeg.toFixed(1)}°
          </div>
          <div className="debug-scroll">
            <table className="mono">
              <thead>
                <tr>
                  <th>{t('dbg.hSource')}</th>
                  <th>{t('dbg.hDist')}</th>
                  <th>{t('dbg.hProp')}</th>
                  <th>{t('dbg.hSrc')}</th>
                  <th>{t('dbg.hTotal')}</th>
                  <th>{t('dbg.hPhase')}</th>
                  <th>{t('dbg.hDir')}</th>
                  <th>{t('dbg.hMag')}</th>
                  {/* Re and Im are the mathematical parts of one complex
                      pressure, not words. */}
                  <th>Re</th>
                  <th>Im</th>
                </tr>
              </thead>
              <tbody>
                {res.contributions.map((c, i) => (
                  <tr key={`${c.sourceId}-${i}`}>
                    <td className="left">{labelOf(c.sourceId)}</td>
                    <td>{c.distanceM.toFixed(3)}</td>
                    <td>{(c.propagationDelayS * 1000).toFixed(3)}</td>
                    <td>{(c.sourceDelayS * 1000).toFixed(3)}</td>
                    <td>{(c.totalDelayS * 1000).toFixed(3)}</td>
                    <td>{c.phaseDeg.toFixed(1)}</td>
                    <td>{c.directivityGainDb.toFixed(2)}</td>
                    <td>{c.magnitudeDb.toFixed(2)}</td>
                    <td>{c.re.toExponential(3)}</td>
                    <td>{c.im.toExponential(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
