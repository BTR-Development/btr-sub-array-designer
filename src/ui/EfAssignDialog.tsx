import { useState } from 'react';
import { Modal, Field } from './widgets';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { efRowCounts } from '../state/efArrays';

/**
 * Assigning the selection to one row of one end-fired array.
 *
 * The two rules the store enforces are VISIBLE here instead of failing later:
 * an occupied row is listed but cannot be chosen, and a selection that already
 * belongs somewhere disables the button and says why. Releasing is always the
 * explicit step in between, so nothing is ever moved by accident.
 */
export function EfAssignDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const sel = s.selectedSourceIds;
  const [efId, setEfId] = useState(s.efArrays[0]?.id ?? '');
  const [rowPick, setRowPick] = useState(1);

  if (!s.efArrays.length) {
    return (
      <Modal title={t('ctx.assignEf')} onClose={onClose}>
        <p className="empty-hint">{t('ef.none')}</p>
        <div className="btn-row right">
          <button onClick={onClose}>{t('ui.close')}</button>
        </div>
      </Modal>
    );
  }

  const ef = s.efArrays.find((a) => a.id === efId) ?? s.efArrays[0];
  const counts = efRowCounts(s.sources, ef.id);
  const row = Math.min(rowPick, ef.rows);
  const rowTaken = (counts.get(row) ?? 0) > 0;
  const alreadyAssigned = s.sources.filter((x) => sel.includes(x.id) && x.ef).length;

  return (
    <Modal title={t('ctx.assignEf')} onClose={onClose}>
      <p className="hint">{t('ef.assignLead', { count: sel.length })}</p>

      <div className="row3">
        <Field label={t('ef.array')}>
          <select className="text-input" value={ef.id} onChange={(e) => setEfId(e.target.value)}>
            {s.efArrays.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('ef.row')} hint={t('arr.efRowsHint')}>
          <select
            className="text-input"
            value={row}
            onChange={(e) => setRowPick(parseInt(e.target.value, 10))}
          >
            {Array.from({ length: ef.rows }, (_, i) => i + 1).map((n) => {
              const taken = counts.get(n) ?? 0;
              return (
                <option key={n} value={n} disabled={taken > 0}>
                  {taken > 0 ? t('ef.rowTaken', { n, count: taken }) : t('ef.rowOption', { n })}
                </option>
              );
            })}
          </select>
        </Field>
      </div>

      <p className="hint">{t('arr.efRowsHint')} {t('ef.noOverwrite')}</p>
      {alreadyAssigned > 0 && <p className="warn">{t('ef.alreadyAssigned')}</p>}

      <div className="btn-row right">
        <button onClick={onClose}>{t('ui.cancel')}</button>
        <button
          className="primary"
          disabled={!sel.length || rowTaken || alreadyAssigned > 0}
          onClick={() => {
            s.assignToEf(sel, ef.id, row);
            onClose();
          }}
        >
          {t('ef.assign')}
        </button>
      </div>
    </Modal>
  );
}
