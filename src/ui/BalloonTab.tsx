import { useRef, useState } from 'react';
import { Field, NumField } from './widgets';
import { newId } from '../state/store';
import { useT } from '../i18n/useT';
import type { SpeakerModel } from '../speakers/schema';
import {
  BALLOON_EXTENSIONS,
  buildBalloonModel,
  parseBalloonFile,
  type BalloonMeta,
  type ParsedBalloonFile,
} from '../io/speakerData/balloonImport';

/**
 * Import of directivity data the user already holds.
 *
 * This is the licence-clean route into grade A/B prediction: BTR ships no
 * manufacturer data and will not read a compiled .GLL, but a user who is
 * licensed for one can export its balloon and bring that here. What lands is a
 * custom model in their own project — nothing is redistributed.
 */
export function BalloonTab({ onCreate }: { onCreate: (m: SpeakerModel) => void }) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedBalloonFile | null>(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<BalloonMeta>({});
  const [licensed, setLicensed] = useState(false);

  const open = async (file: File) => {
    setError(null);
    setParsed(null);
    try {
      const p = await parseBalloonFile(file);
      setParsed(p);
      setFileName(file.name);
      setMeta((m) => ({ ...m, ...p.meta }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const raw = parsed?.raw;
  const cells = raw
    ? raw.frequenciesHz.length * raw.azimuthDeg.length * raw.elevationDeg.length
    : 0;

  return (
    <div className="balloon-tab">
      <p className="hint">
        {/* The column names are the file's own header row, not prose: they are
            spelled the same whatever language the operator reads. */}
        {t('bal.bringIn')} <b>{t('bal.oneRow')}</b>: {t('bal.fileTypes')} (
        <span className="mono">freq_hz, az_deg, el_deg, mag_db, phase_deg</span>),{' '}
        {t('bal.orBtrJson')}
      </p>
      <p className="warn">
        {t('bal.noGllLead')} <span className="mono">.GLL</span>. {t('bal.noGllWhy')}
      </p>

      <div className="btn-row">
        <button className="primary" onClick={() => fileRef.current?.click()}>
          {t('bal.chooseFile')}
        </button>
        {fileName && <span className="readout mono">{fileName}</span>}
      </div>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept={BALLOON_EXTENSIONS.join(',')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) open(f);
          e.target.value = '';
        }}
      />

      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}

      {raw && (
        <>
          <div className="readout">
            <div>
              <span>{t('bal.grid')}</span>
              <b className="mono">
                {raw.frequenciesHz.length} f × {raw.azimuthDeg.length} az × {raw.elevationDeg.length} el
              </b>
            </div>
            <div>
              <span>{t('bal.cells')}</span>
              <b className="mono">{cells.toLocaleString('en-GB')}</b>
            </div>
            <div>
              <span>{t('bal.freqRange')}</span>
              <b className="mono">
                {raw.frequenciesHz[0]} - {raw.frequenciesHz[raw.frequenciesHz.length - 1]} Hz
              </b>
            </div>
            <div>
              <span>{t('bal.phase')}</span>
              <b className="mono">{t(raw.phaseAssumed ? 'bal.phaseAbsent' : 'bal.phasePresent')}</b>
            </div>
          </div>

          {parsed.warnings.map((w, i) => (
            <p className="warn" key={i}>
              {w}
            </p>
          ))}

          <div className="row2">
            <Field label={t('bal.manufacturer')}>
              <input
                className="text-input"
                value={meta.manufacturer ?? ''}
                onChange={(e) => setMeta({ ...meta, manufacturer: e.target.value })}
              />
            </Field>
            <Field label={t('bal.model')}>
              <input
                className="text-input"
                value={meta.model ?? ''}
                onChange={(e) => setMeta({ ...meta, model: e.target.value })}
              />
            </Field>
          </div>

          <div className="row3">
            <Field label={t('bal.width')} hint={t('bal.dimHint')}>
              <NumField
                value={meta.widthM ?? 0}
                onChange={(v) => setMeta({ ...meta, widthM: v || null })}
                unit="m"
                step={0.01}
              />
            </Field>
            <Field label={t('bal.height')}>
              <NumField
                value={meta.heightM ?? 0}
                onChange={(v) => setMeta({ ...meta, heightM: v || null })}
                unit="m"
                step={0.01}
              />
            </Field>
            <Field label={t('bal.depth')}>
              <NumField
                value={meta.depthM ?? 0}
                onChange={(v) => setMeta({ ...meta, depthM: v || null })}
                unit="m"
                step={0.01}
              />
            </Field>
          </div>

          <Field label={t('bal.provenance')} hint={t('bal.provenanceHint')}>
            <input
              className="text-input"
              placeholder={t('bal.provenancePlaceholder')}
              value={meta.sourceNote ?? ''}
              onChange={(e) => setMeta({ ...meta, sourceNote: e.target.value })}
            />
          </Field>

          <div className="check-row">
            <label>
              <input
                type="checkbox"
                checked={licensed}
                onChange={(e) => setLicensed(e.target.checked)}
              />
              {t('bal.licensed')}
            </label>
          </div>
          <p className="hint">
            {t('bal.localOnly')}
            {raw.phaseAssumed && ` ${t('bal.gradeB')}`}
          </p>

          <div className="btn-row end">
            <button
              className="primary"
              disabled={!licensed}
              title={licensed ? undefined : t('bal.confirmFirst')}
              onClick={() => {
                const { model } = buildBalloonModel(raw, {
                  id: newId('spk'),
                  meta,
                  quality: 'A',
                });
                onCreate(model);
              }}
            >
              {t('bal.add')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
