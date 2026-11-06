import { useStore } from '../state/store';
import type { Group } from '../core/types';
import { useT } from '../i18n/useT';

const MS = 1000;

interface Props {
  ids: string[];
  group: Group | null;
}

const NUDGE = {
  levelDb: 0.5,
  x: 0.1,
  y: 0.1,
  z: 0.1,
  azimuthDeg: 5,
  delayS: 0.0001,
} as const;

type Col = keyof typeof NUDGE;

/**
 * Spreadsheet view of the module. Every cell is the real project value —
 * editing here is identical to editing in the Inspector.
 *
 * "Total dly" is the cabinet's own delay plus the module's common offset,
 * which is what you would actually type into a processor.
 */
export function SourceTable({ ids, group }: Props) {
  const s = useStore();
  const t = useT();
  const members = s.sources.filter((x) => ids.includes(x.id));
  const offsetS = group?.delayOffsetS ?? 0;
  const offsetDb = group?.levelOffsetDb ?? 0;

  // The steppers act on the SELECTION, not on the whole module. Nudging every
  // cabinet at once is almost never what is wanted once an array is laid out —
  // and when it is, Select All is one keystroke away.
  const targets = ids.filter((id) => s.selectedSourceIds.includes(id));
  const nudge = (col: Col, sign: number) => s.nudgeColumn(targets, col, NUDGE[col] * sign);

  const Stepper = ({ col }: { col: Col }) => (
    <span className="nudge">
      <button
        onClick={() => nudge(col, -1)}
        disabled={!targets.length}
        title={targets.length ? `−${NUDGE[col]}` : t('tbl.relativeNone')}
      >
        −
      </button>
      <button
        onClick={() => nudge(col, 1)}
        disabled={!targets.length}
        title={targets.length ? `+${NUDGE[col]}` : t('tbl.relativeNone')}
      >
        +
      </button>
    </span>
  );

  return (
    <div className="stable-wrap">
      <table className="stable mono">
        <thead>
          {/* The steppers move the selected rows by one step. They are relative by
              definition — this program has no absolute level to nudge towards. */}
          <tr className="stable-nudge">
            <th colSpan={2} className="left">
              <span className={`rel-tag${targets.length ? '' : ' off'}`}>{t('tbl.relative')}</span>
              <span className="rel-scope">
                {targets.length
                  ? t('tbl.relativeSel', { count: targets.length })
                  : t('tbl.relativeNone')}
              </span>
            </th>
            <th><Stepper col="levelDb" /></th>
            <th><Stepper col="x" /></th>
            <th><Stepper col="y" /></th>
            <th><Stepper col="z" /></th>
            <th><Stepper col="azimuthDeg" /></th>
            <th />
            <th />
            <th><Stepper col="delayS" /></th>
            <th />
          </tr>
          <tr>
            <th className="left">{t('tbl.no')}</th>
            <th className="left">{t('tbl.speaker')}</th>
            <th>{t('tbl.level')}</th>
            <th>X (m)</th>
            <th>Y (m)</th>
            <th>Z (m)</th>
            <th>{t('tbl.horiz')}</th>
            <th>{t('tbl.vert')}</th>
            <th title={t('tbl.polarity')}>Ø</th>
            <th>{t('tbl.delay')}</th>
            <th>{t('tbl.totalDelay')}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const model = s.provider.get(m.speakerId);
            const sel = s.selectedSourceIds.includes(m.id);
            const cell = (name: string, value: number, onChange: (v: number) => void, step: number, digits = 2) => (
              <input
                type="number"
                aria-label={`${i + 1} ${name}`}
                step={step}
                value={Number(value.toFixed(digits))}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (isFinite(v)) onChange(v);
                }}
              />
            );
            return (
              <tr
                key={m.id}
                className={`${sel ? 'sel' : ''} ${m.mute ? 'muted' : ''}`}
                onClick={(e) => {
                  const tag = (e.target as HTMLElement).tagName;
                  if (tag !== 'INPUT' && tag !== 'BUTTON') {
                    s.selectSourceAt(m.id, ids, { toggle: e.metaKey || e.ctrlKey, range: e.shiftKey });
                  }
                }}
              >
                <td className="left">{i + 1}</td>
                <td className="left name">{model ? model.model : '-'}</td>
                <td>{cell(t('tbl.level'), m.levelDb, (v) => s.patchSources([m.id], { levelDb: v }), 0.5, 1)}</td>
                <td>{cell('X (m)', m.position.x, (v) => s.patchSources([m.id], { position: { x: v } }), 0.1)}</td>
                <td>{cell('Y (m)', m.position.y, (v) => s.patchSources([m.id], { position: { y: v } }), 0.1)}</td>
                <td>{cell('Z (m)', m.position.z, (v) => s.patchSources([m.id], { position: { z: v } }), 0.1)}</td>
                <td>{cell(t('tbl.horiz'), m.rotation.azimuthDeg, (v) => s.patchSources([m.id], { rotation: { azimuthDeg: v } }), 5, 1)}</td>
                <td>{cell(t('tbl.vert'), m.rotation.elevationDeg, (v) => s.patchSources([m.id], { rotation: { elevationDeg: v } }), 1, 1)}</td>
                <td>
                  <button
                    className={`pol-btn${m.invertPolarity ? ' on' : ''}`}
                    title={m.invertPolarity ? t('tbl.polarityOn') : t('tbl.polarityOff')}
                    onClick={() => s.patchSources([m.id], { invertPolarity: !m.invertPolarity })}
                  >
                    Ø
                  </button>
                </td>
                <td>{cell(t('tbl.delay'), m.delayS * MS, (v) => s.patchSources([m.id], { delayS: v / MS }), 0.1, 2)}</td>
                {/* Delay całkowity to liczba do procesora, więc zawiera też
                    ZASZYTY gradient kardioidy odwróconej skrzyni — czas, który
                    żyje poza kolumną edycji. Patrz Source.gradientDelayS. */}
                <td
                  className="total"
                  title={
                    m.gradientDelayS
                      ? t('tbl.totalGradient', { ms: (m.gradientDelayS * MS).toFixed(2) })
                      : undefined
                  }
                >
                  {((m.delayS + (m.gradientDelayS ?? 0) + offsetS) * MS).toFixed(2)}
                  {m.gradientDelayS ? '*' : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
        {group && (offsetS !== 0 || offsetDb !== 0) && (
          <tfoot>
            <tr>
              <td className="left" colSpan={2}>{t('tbl.moduleOffset')}</td>
              <td>{offsetDb ? `${offsetDb > 0 ? '+' : ''}${offsetDb.toFixed(1)}` : '-'}</td>
              <td colSpan={6} />
              <td>{offsetS ? `${(offsetS * MS).toFixed(2)}` : '-'}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
