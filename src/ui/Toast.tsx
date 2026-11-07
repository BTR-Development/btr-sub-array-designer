import { useEffect } from 'react';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';
import { Icon } from './icons';

const SHOW_MS = 8000;

/**
 * A short message over the plot, for things that happened rather than things
 * to decide: "Deleted 8 cabinets [Undo]", "Saved: Gig.btrsub".
 *
 * The Undo button undoes exactly the step the message is about. It is offered
 * only while that step is still the latest in the history: after any other
 * edit, pressing it would undo the wrong thing, so the message drops it.
 */
export function Toast() {
  const toast = useStore((s) => s.toast);
  const depth = useStore((s) => s.undoStack.length);
  const dismiss = useStore((s) => s.dismissToast);
  const undo = useStore((s) => s.undo);
  const t = useT();

  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const timer = setTimeout(() => dismiss(id), SHOW_MS);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;
  const canUndo = toast.undoDepth !== null && depth === toast.undoDepth;

  return (
    <div className="toast" role="status">
      <span>{t(toast.message, toast.vars)}</span>
      {canUndo && (
        <button
          className="toast-undo"
          onClick={() => {
            undo();
            dismiss(toast.id);
          }}
        >
          {t('toast.undo')}
        </button>
      )}
      <button className="icon-only toast-close" aria-label={t('ui.close')} onClick={() => dismiss(toast.id)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
