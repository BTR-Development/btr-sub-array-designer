import { useState } from 'react';
import { useStore } from '../state/store';
import { Modal } from './widgets';
import { useT } from '../i18n/useT';
import { proceed, saveProject } from './projectFiles';

/**
 * The one question the program still asks before it acts: what to do with
 * work that is not in a file, when a new or another project is about to
 * replace it. Save / Don't save / Cancel, as every document program asks it.
 *
 * Deleting used to be asked here too, and no longer is: it happens at once and the toast that says so carries Undo.
 * The difference is that a deletion can always be undone in this window; work
 * replaced by another project and never saved is gone with the window.
 */
export function ConfirmDialog() {
  const s = useStore();
  const t = useT();
  const [busy, setBusy] = useState(false);
  const c = s.pendingConfirm;
  if (!c) return null;

  const close = () => s.askConfirm(null);
  const name = s.file.name ?? s.project.name;

  const save = async () => {
    setBusy(true);
    const saved = await saveProject();
    setBusy(false);
    if (!saved) return; // cancelled or failed: stay here, nothing is lost
    close();
    proceed(c.then);
  };

  return (
    <Modal title={t('discard.title')} onClose={close}>
      <p className="confirm-lead">{t('discard.lead', { name })}</p>
      <p className="hint">{t('discard.hint')}</p>
      <div className="btn-row end">
        <button onClick={close}>{t('ui.cancel')}</button>
        <button
          className="danger"
          onClick={() => {
            close();
            proceed(c.then);
          }}
        >
          {t('discard.dontSave')}
        </button>
        <button className="primary" onClick={save} disabled={busy} autoFocus>
          {t('discard.save')}
        </button>
      </div>
    </Modal>
  );
}
