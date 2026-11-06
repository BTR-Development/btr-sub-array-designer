import { useState } from 'react';
import { Modal, NumField, Field } from './widgets';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { orientedDimensions } from '../speakers/schema';

export function ArrayDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const seedId = s.selectedSourceIds[0];
  const seed = s.sources.find((x) => x.id === seedId);
  const model = seed ? s.provider.get(seed.speakerId) : undefined;

  const [count, setCount] = useState(8);
  const [spacing, setSpacing] = useState(2);
  const [axis, setAxis] = useState<'x' | 'y' | 'z'>('x');
  const [centered, setCentered] = useState(true);
  const [arc, setArc] = useState(0);

  if (!seed) {
    return (
      <Modal title={t('arr.title')} onClose={onClose}>
        <p className="empty-hint">{t('arr.needSeed')}</p>
      </Modal>
    );
  }

  // The width the seed cabinet actually presents, which is not the datasheet's
  // when it is standing on its end face.
  const width = model ? orientedDimensions(model, seed?.rotation.rollDeg ?? 0).widthM : null;
  const span = (count - 1) * spacing;

  return (
    <Modal title={t('arr.title')} onClose={onClose}>
      <p className="hint">
        {t('arr.seed')}: <b>{seed.label}</b>,{' '}
        {model ? `${model.manufacturer} ${model.model}` : t('arr.unknownModel')}. {t('arr.seedNote')}
      </p>

      <div className="row3">
        <Field label={t('arr.count')}><NumField value={count} onChange={(v) => setCount(Math.max(1, Math.round(v)))} step={1} min={1} max={128} /></Field>
        <Field label={t('arr.spacing')}><NumField value={spacing} onChange={setSpacing} unit="m" step={0.05} /></Field>
        <Field label={t('arr.direction')}>
          <select className="text-input" value={axis} onChange={(e) => setAxis(e.target.value as 'x' | 'y' | 'z')}>
            <option value="x">{t('arr.alongX')}</option>
            <option value="y">{t('arr.alongY')}</option>
            <option value="z">{t('arr.alongZ')}</option>
          </select>
        </Field>
      </div>

      <div className="check-row">
        <label>
          <input type="checkbox" checked={centered} onChange={(e) => setCentered(e.target.checked)} />
          {t('arr.centre')}
        </label>
      </div>

      {axis === 'x' && (
        <Field label={t('arr.arc')} hint={t('arr.arcHint')}>
          <NumField value={arc} onChange={setArc} unit="°" step={5} min={-180} max={180} />
        </Field>
      )}

      <div className="readout">
        <div><span>{t('arr.span')}</span><b>{span.toFixed(2)} m</b></div>
        {width != null && (
          <div>
            <span>{t('arr.edgeGap')}</span>
            <b>{(spacing - width).toFixed(2)} m</b>
          </div>
        )}
        <div>
          <span>{t('arr.aliasing')}</span>
          <b>{spacing > 0 ? `${(s.sim.speedOfSound / spacing).toFixed(0)} Hz` : '-'}</b>
        </div>
      </div>
      {width != null && spacing < width && (
        <p className="warn">{t('arr.overlap', { w: width.toFixed(2) })}</p>
      )}

      <div className="btn-row right">
        <button onClick={onClose}>{t('ui.cancel')}</button>
        <button
          className="primary"
          onClick={() => {
            s.createArray({ sourceId: seedId, count, spacingM: spacing, axis, centered, arcDeg: axis === 'x' ? arc : 0 });
            onClose();
          }}
        >
          {t('arr.create', { count })}
        </button>
      </div>
    </Modal>
  );
}
