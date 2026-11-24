import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { NumField } from './widgets';
import { Icon } from './icons';
import { resolveAll } from '../state/resolve';
import { efLayouts, spacingForHz, type EfLayout } from '../state/efArrays';

const MS = 1000;
/** Rows are taped out on a stage in centimetres. */
const cm = (m: number) => Math.round(m * 100) / 100;

/**
 * Every end-fire block in the project, read off the cabinets: its rows front
 * to rear with the delay each one plays, the spacing and what it is tuned for,
 * and the few things worth warning about. The panel is always there, so the
 * feature can be found before it has been used.
 */
export function EndFirePanel() {
  const s = useStore();
  const t = useT();
  const [open, setOpen] = useState(true);
  const count = s.efArrays.length;
  const was = useRef(count);
  useEffect(() => {
    // a new block opens the panel; closing it by hand afterwards sticks
    if (count > was.current) setOpen(true);
    was.current = count;
  }, [count]);

  const layouts = open
    ? efLayouts(resolveAll(s.sources, s.groups, s.provider), s.efArrays, s.sim.speedOfSound)
    : [];
  const sel = s.selectedSourceIds;

  return (
    <section className="panel ef-panel">
      <header className="panel-head">
        <button className="twisty" aria-label={t('ef.panelTitle')} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron" className={open ? '' : 'twisty-closed'} />
        </button>
        {t('ef.panelTitle')}
        {count > 0 && <span className="tree-meta mono">&nbsp;{count}</span>}
        <span className="spacer" />
        <button
          className="panel-head-btn"
          disabled={!sel.length}
          title={t('ef.newHint')}
          onClick={() => s.setEndFireOpen(true)}
        >
          {t('ef.newDots')}
        </button>
      </header>
      {open && (
        <div className="panel-body ef-body">
          {!count && <p className="empty-hint small">{t('ef.none')}</p>}
          {layouts.map((l) => (
            <EfBlock key={l.ef.id} l={l} />
          ))}
        </div>
      )}
    </section>
  );
}

function EfBlock({ l }: { l: EfLayout }) {
  const s = useStore();
  const t = useT();
  const c = s.sim.speedOfSound;
  const ef = l.ef;
  const memberIds = l.rows.flatMap((r) => r.ids);
  const sel = s.selectedSourceIds;
  const selIn = sel.filter((id) => memberIds.includes(id)).length;
  const selOut = sel.filter((id) => !memberIds.includes(id) && !s.sources.find((x) => x.id === id)?.ef).length;
  const [tuneHz, setTuneHz] = useState(() => Math.round(ef.targetHz ?? l.tunedHz ?? 80));
  const isSel = memberIds.length > 0 && memberIds.every((id) => sel.includes(id));

  return (
    <div className="ef-block">
      <div
        className={`tree-row group${isSel ? ' sel' : ''}`}
        tabIndex={0}
        role="button"
        aria-pressed={isSel}
        title={t('ef.selectHint')}
        onClick={() => memberIds.length && s.selectSources(memberIds)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            if (memberIds.length) s.selectSources(memberIds);
          }
        }}
      >
        <span className="tree-name">{ef.name}</span>
        <span className="tree-meta mono">{t('ef.meta', { rows: l.rows.length, count: l.count })}</span>
        <button
          className="mute-btn ef-del"
          title={t('ef.deleteHint')}
          aria-label={`${ef.name}: ${t('ef.delete')}`}
          onClick={(e) => {
            e.stopPropagation();
            s.deleteEfArray(ef.id);
          }}
        >
          ×
        </button>
      </div>

      <div className="ef-line">
        <span title={t('efd.aimHint')}>{t('efd.aim')}</span>
        <NumField
          label={`${ef.name}: ${t('efd.aim')}`}
          value={ef.aimDeg}
          onChange={(v) => s.patchEfArray(ef.id, { aimDeg: ((Math.round(v) % 360) + 360) % 360 })}
          unit="°"
          step={5}
          width={56}
        />
      </div>

      {l.rows.length > 0 ? (
        <table className="ef-rows mono">
          <tbody>
            {l.rows.map((r) => (
              <tr key={r.n}>
                <td className="ef-row-name">R{r.n}</td>
                <td className="ef-row-role">
                  {r.n === 1 && l.rows.length > 1
                    ? t('ef.front')
                    : r.n === l.rows.length && l.rows.length > 1
                      ? t('ef.rear')
                      : ''}
                </td>
                <td className="ef-row-count">{t('groups.members', { n: r.ids.length })}</td>
                <td className="ef-row-delay">{(r.delayS * MS).toFixed(2)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-hint small">{t('ef.empty')}</p>
      )}

      {l.meanGapM != null && (
        <p className="hint small">
          {t('ef.spacingRead', {
            m: l.meanGapM.toFixed(2),
            hz: l.tunedHz!.toFixed(0),
            max: (c / (3 * l.meanGapM)).toFixed(0),
          })}
        </p>
      )}
      {l.rows.length === 1 && <p className="warn small">{t('ef.oneRow')}</p>}
      {l.rows.length === 2 && <p className="warn small">{t('ef.twoRows')}</p>}
      {l.rows.length >= 5 && <p className="warn small">{t('ef.manyRows')}</p>}
      {l.uneven && <p className="warn small">{t('ef.uneven')}</p>}
      {l.offAimIds.length > 0 && (
        <p className="warn small">{t('ef.offAim', { count: l.offAimIds.length })}</p>
      )}

      {l.rows.length >= 2 && (
        <div className="ef-line">
          <span title={t('ef.respaceHint')}>{t('efd.tune')}</span>
          <NumField
            label={`${ef.name}: ${t('efd.tune')}`}
            value={tuneHz}
            onChange={(v) => setTuneHz(Math.min(250, Math.max(20, Math.round(v))))}
            unit="Hz"
            step={1}
            width={56}
          />
          <button title={t('ef.respaceHint')} onClick={() => s.respaceEf(ef.id, cm(spacingForHz(tuneHz, c)))}>
            {t('ef.respace', { m: cm(spacingForHz(tuneHz, c)).toFixed(2) })}
          </button>
        </div>
      )}

      <div className="btn-row ef-actions">
        <button disabled={!selOut} title={t('ef.addHint')} onClick={() => s.addToEf(sel, ef.id)}>
          {t('ef.addSel', { count: selOut })}
        </button>
        <button disabled={!selIn} onClick={() => s.removeFromEf(sel.filter((id) => memberIds.includes(id)))}>
          {t('ef.removeSel', { count: selIn })}
        </button>
        <button title={t('ef.bakeHint')} onClick={() => s.bakeEfArray(ef.id)}>
          {t('ef.bake')}
        </button>
      </div>
    </div>
  );
}
