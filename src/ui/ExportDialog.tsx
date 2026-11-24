import { useMemo, useState } from 'react';
import { Modal } from './widgets';
import { useStore } from '../state/store';
import { VENDOR_EXPORTERS } from '../io/vendor/registry';
import { describeMapping } from '../io/vendor/deviceMap';
import { downloadBlob } from '../io/registry';
import { useT } from '../i18n/useT';
import type { VendorExporter } from '../io/vendor/types';

/**
 * Foreign-format export. The dialog exists because these exports are lossy in ways
 * the user has to see BEFORE the file lands on disk: cabinets get substituted for
 * vendor products, and neither format can carry everything BTR models.
 */
export function ExportDialog({ exporter, onClose }: { exporter: VendorExporter; onClose: () => void }) {
  const s = useStore();
  const t = useT();
  const [nativeModels, setNativeModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Not memoised: toProject() just assembles references off the store, and this
  // component only renders while the dialog is open.
  const project = s.toProject();
  const diag = useMemo(
    () => exporter.describe(project, s.provider, { nativeModels }),
    [exporter, project, s.provider, nativeModels],
  );
  const mapping = useMemo(
    () => describeMapping(exporter.target, project.sources.map((x) => x.speakerId), nativeModels),
    [exporter.target, project.sources, nativeModels],
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await exporter.export(project, s.provider, { nativeModels });
      downloadBlob(res.blob, res.filename);
      setDone(res.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = project.sources.length;

  return (
    <Modal title={t('exp.title', { target: exporter.label })} onClose={onClose} wide>
      <div className="export">
        <p className="hint">
          {t('exp.sources', { count: active })} <b>{exporter.extension}</b>. {t('exp.written')}
        </p>

        <section>
          <h4>{t('exp.mapping')}</h4>
          <table className="stable mono export-map">
            <thead>
              <tr>
                <th className="left">{t('exp.btrModel')}</th>
                <th className="left">{t('exp.exportedAs')}</th>
                <th className="left">{t('exp.status')}</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((m) => {
                const model = s.provider.get(m.btrSpeakerId);
                return (
                  <tr key={m.btrSpeakerId}>
                    <td className="left">{model ? `${model.manufacturer} ${model.model}` : m.btrSpeakerId}</td>
                    <td className="left">{m.model}</td>
                    <td className="left">
                      {m.substituted ? (
                        <span className="warn-inline">{t('exp.substituted')}</span>
                      ) : m.verified ? (
                        <span className="ok-inline">{t('exp.equivalent')}</span>
                      ) : (
                        <span className="warn-inline">{t('exp.equivalentUnverified')}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {exporter.target === 'soundvision' && (
          <label className="check-line">
            <input type="checkbox" checked={nativeModels} onChange={(e) => setNativeModels(e.target.checked)} />
            <span>
              {t('exp.nativeNames')}.
              <em> {t('exp.nativeNamesWhy')}</em>
            </span>
          </label>
        )}

        {!!diag.substitutions.length && (
          <section>
            <h4>{t('exp.substitutions')}</h4>
            <ul className="diag">
              {diag.substitutions.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        {!!diag.warnings.length && (
          <section>
            <h4>{t('exp.notCarried')}</h4>
            <ul className="diag warn-list">
              {diag.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        {!!diag.errors.length && (
          <section>
            <h4>{t('exp.errors')}</h4>
            <ul className="diag error-list">
              {diag.errors.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        <p className="verify-note">
          {/* The exporter's own note stays in the language it was written in:
              it is a statement about what has been checked against a real
              vendor file, and translating it here would detach it from the
              evidence. */}
          <b>{t('exp.verification')}</b> {t(exporter.verificationNote)}{' '}
          {t('exp.openAndCheck', { app: exporter.application })}
        </p>

        {error && <p className="error-list">{error}</p>}
        {done && <p className="ok-inline">{t('exp.wrote', { name: done })}</p>}

        <div className="btn-row right">
          <button onClick={onClose}>{t('ui.close')}</button>
          <button className="primary" onClick={run} disabled={busy || !!diag.errors.length}>
            {busy ? t('exp.building') : t('exp.exportBtn', { ext: exporter.extension })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export { VENDOR_EXPORTERS };
