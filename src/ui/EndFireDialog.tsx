import { useState } from 'react';
import { Modal, NumField, Field } from './widgets';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { resolveAll } from '../state/resolve';
import { forwardHeadingOf } from '../state/arrayTools';
import { hzForSpacing, rowsAlong, spacingForHz } from '../state/efArrays';
import { EF_MAX_ROWS } from '../core/types';

/**
 * Making an end-fire block, in one dialog.
 *
 * The selection decides what the dialog offers, and says so in its first line:
 * cabinets in ONE row become the front row and the program builds the rows
 * behind them; cabinets already standing in several rows are used as they
 * stand. Either way the delays are not a step: they are computed from the
 * rows and kept right afterwards.
 */
export function EndFireDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const c = s.sim.speedOfSound;
  const picked = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
  const assigned = picked.filter((x) => x.ef).length;

  const [aim, setAim] = useState(() =>
    picked.length ? Math.round(forwardHeadingOf(picked)) : 0,
  );
  const [rows, setRows] = useState(3);
  const startHz = Math.min(120, Math.max(40, Math.round(s.sim.frequencyHz)));
  const [hz, setHz] = useState(startHz);
  const [spacing, setSpacing] = useState(() => Math.round(spacingForHz(startHz, c) * 100) / 100);

  // Rows as the selection stands now, along the aim being dialled in.
  const byId = new Map(resolveAll(s.sources, s.groups, s.provider).map((r) => [r.source.id, r]));
  const found = rowsAlong(
    picked.map((p) => ({ id: p.id, position: byId.get(p.id)!.position })),
    aim,
  );

  if (!picked.length) {
    return (
      <Modal title={t('efd.title')} onClose={onClose}>
        <p className="empty-hint">{t('efd.needSel')}</p>
        <div className="btn-row right">
          <button onClick={onClose}>{t('ui.close')}</button>
        </div>
      </Modal>
    );
  }

  const adopt = found.length >= 2;
  const perRow = found.length ? found[0].ids.length : picked.length;
  const nRows = adopt ? found.length : rows;
  const gaps = adopt ? found.slice(1).map((r, i) => found[i].depthM - r.depthM) : [];
  const step = adopt ? gaps.reduce((a, b) => a + b, 0) / gaps.length : spacing;
  const uneven = gaps.length > 1 && Math.max(...gaps) > Math.min(...gaps) * 1.15;
  const depths = picked
    .map((p) => s.provider.get(p.speakerId)?.dimensions.depthM ?? null)
    .filter((d): d is number => d != null);
  const cabDepth = depths.length ? Math.max(...depths) : null;
  const overlap = !adopt && cabDepth != null && spacing < cabDepth;

  return (
    <Modal title={t('efd.title')} onClose={onClose}>
      <p className="hint">{t('efd.what')}</p>
      <p className="hint">
        <b>
          {adopt
            ? t('efd.adopt', { count: picked.length, rows: found.length })
            : t('efd.build', { count: picked.length })}
        </b>
      </p>

      <div className="row3">
        <Field label={t('efd.aim')} hint={t('efd.aimHint')}>
          <NumField label={t('efd.aim')} value={aim} onChange={(v) => setAim(((Math.round(v) % 360) + 360) % 360)} unit="°" step={5} />
        </Field>
        {!adopt && (
          <>
            <Field label={t('efd.rows')} hint={t('efd.rowsHint')}>
              <NumField
                label={t('efd.rows')}
                value={rows}
                onChange={(v) => setRows(Math.min(EF_MAX_ROWS, Math.max(2, Math.round(v))))}
                step={1}
                min={2}
                max={EF_MAX_ROWS}
              />
            </Field>
            <Field label={t('efd.tune')} hint={t('efd.tuneHint')}>
              <NumField
                label={t('efd.tune')}
                value={hz}
                onChange={(v) => {
                  const f = Math.min(250, Math.max(20, v));
                  setHz(f);
                  setSpacing(Math.round(spacingForHz(f, c) * 100) / 100);
                }}
                unit="Hz"
                step={1}
              />
            </Field>
          </>
        )}
      </div>
      {!adopt && (
        <Field label={t('efd.spacing')} hint={t('efd.spacingHint')}>
          <NumField
            label={t('efd.spacing')}
            value={spacing}
            onChange={(v) => {
              const d = Math.min(5, Math.max(0.2, v));
              setSpacing(d);
              setHz(Math.round(hzForSpacing(d, c)));
            }}
            unit="m"
            step={0.05}
          />
        </Field>
      )}

      <div className="readout">
        <div><span>{t('efd.rRows')}</span><b>{nRows} × {perRow}</b></div>
        <div><span>{t('efd.rStep')}</span><b>{step.toFixed(2)} m · {((step / c) * 1000).toFixed(2)} ms</b></div>
        <div><span>{t('efd.rFront')}</span><b>{((((nRows - 1) * step) / c) * 1000).toFixed(2)} ms</b></div>
        <div><span>{t('efd.rTuned')}</span><b>{hzForSpacing(step, c).toFixed(0)} Hz</b></div>
        {!adopt && <div><span>{t('efd.rAdded')}</span><b>{(rows - 1) * picked.length}</b></div>}
      </div>
      {overlap && <p className="warn">{t('efd.overlap', { d: cabDepth!.toFixed(2) })}</p>}
      {uneven && <p className="warn">{t('ef.uneven')}</p>}
      {assigned > 0 && <p className="warn">{t('ef.alreadyAssigned')}</p>}

      <div className="btn-row right">
        <button onClick={onClose}>{t('ui.cancel')}</button>
        <button
          className="primary"
          disabled={assigned > 0}
          onClick={() => {
            s.createEndFire({
              ids: picked.map((p) => p.id),
              aimDeg: aim,
              rows,
              spacingM: spacing,
              targetHz: adopt ? null : hz,
            });
            onClose();
          }}
        >
          {adopt ? t('efd.createAdopt', { rows: nRows }) : t('efd.createBuild', { rows: nRows })}
        </button>
      </div>
    </Modal>
  );
}
