import { useState } from 'react';
import { Modal } from './widgets';
import { useStore } from '../state/store';
import { sceneToProject } from '../io/vendor/sceneToProject';
import { requestFit } from '../render/view';
import { useT } from '../i18n/useT';
import type { VendorScene } from '../io/vendor/importTypes';
import type { VendorImporter } from '../io/vendor/importTypes';

/**
 * Foreign-format import. A vendor project usually holds more than a sub array — an
 * ArrayCalc file carries the mains and an "Unused channels" group too — so the user
 * picks what comes across instead of the app guessing.
 */
export function ImportDialog({
  scene,
  importer,
  onClose,
}: {
  scene: VendorScene;
  importer: VendorImporter;
  onClose: () => void;
}) {
  const s = useStore();
  const t = useT();
  const [selected, setSelected] = useState<string[]>(
    scene.groups.filter((g) => g.looksLikeSubs).map((g) => g.id),
  );

  const preview = sceneToProject(scene, selected, s.provider);
  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Replace or add (UX instruction 6): an ArrayCalc or Soundvision file is as
  // often the subs to drop into a project already set up as a project of its
  // own, and importing used to throw the open project away every time.
  const load = (mode: 'replace' | 'add') => {
    const r = sceneToProject(scene, selected, s.provider);
    const doc = {
      project: r.project.project,
      sources: r.project.sources,
      groups: r.project.groups,
      measurementPoints: r.project.measurementPoints,
      customSpeakers: r.project.customSpeakers,
      efArrays: r.project.efArrays ?? [],
    };
    if (mode === 'add') {
      s.appendDoc(doc);
    } else {
      s.loadDoc(doc, r.project.simulationSettings);
      // a new project, not yet in any file of ours: Save must ask where
      useStore.setState({ file: { path: null, name: null }, dirty: true });
    }
    requestFit();
    onClose();
  };
  const hasProject = s.sources.length > 0;

  return (
    <Modal title={t('imp.title', { source: importer.label })} onClose={onClose} wide>
      <div className="export">
        <p className="hint">
          {scene.projectName ? <><b>{scene.projectName}</b>: </> : null}
          {t('imp.groupsFound', { count: scene.groups.length })} {t('imp.choose')}
        </p>

        <section>
          <h4>{t('imp.groupsInFile')}</h4>
          <table className="stable mono export-map">
            <thead>
              <tr>
                <th />
                <th className="left">{t('imp.group')}</th>
                <th className="left">{t('imp.cabinet')}</th>
                <th>{t('imp.count')}</th>
                <th>{t('imp.relDelay')}</th>
              </tr>
            </thead>
            <tbody>
              {scene.groups.map((g) => (
                <tr key={g.id} onClick={() => toggle(g.id)} className={selected.includes(g.id) ? 'sel' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.includes(g.id)}
                      onChange={() => toggle(g.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="left">
                    {g.name}
                    {!g.looksLikeSubs && <span className="warn-inline"> · {t('imp.notSubs')}</span>}
                  </td>
                  <td className="left">{g.boxType ?? '-'}</td>
                  <td>{g.sources.length}</td>
                  <td>{g.relativeDelayMs ? `${g.relativeDelayMs.toFixed(1)} ms` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">{t('imp.notSubsWhy')}</p>
        </section>

        {!!preview.diagnostics.mapping.length && (
          <section>
            <h4>{t('imp.mapping')}</h4>
            <ul className="diag">
              {preview.diagnostics.mapping.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </section>
        )}

        {!!preview.diagnostics.warnings.length && (
          <section>
            <h4>{t('imp.couldNotTell')}</h4>
            <ul className="diag warn-list">
              {preview.diagnostics.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        <p className="verify-note">
          {/* Two whole sentences rather than one with a spliced-in clause: in
              Polish and Italian "and polarity" does not slot into the middle of
              the list the way it does in English. */}
          <b>{t('imp.headsUp')}</b>{' '}
          {t(importer.target === 'soundvision' ? 'imp.onlyGeometryPolarity' : 'imp.onlyGeometry')}{' '}
          {t('imp.acousticNever')}
        </p>

        <div className="btn-row right">
          <button onClick={onClose}>{t('ui.cancel')}</button>
          {hasProject && (
            <button
              className="imp-add"
              onClick={() => load('add')}
              disabled={!preview.stats.sources}
              title={t('imp.addHint')}
            >
              {t('imp.add', { count: preview.stats.sources })}
            </button>
          )}
          <button className="primary imp-replace" onClick={() => load('replace')} disabled={!preview.stats.sources}>
            {hasProject
              ? t('imp.replace', { count: preview.stats.sources })
              : t('imp.importBtn', { count: preview.stats.sources })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
