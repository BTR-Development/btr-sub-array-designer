import { useStore } from '../state/store';

/**
 * A slider held with the pointer drops the map to Draft, as a drag on the
 * canvas does, and the full grid comes back when it is let go. Without it the frequency slider asked for a Normal or High solve
 * on every step, and the map lagged behind the thumb.
 *
 * The release is listened for on the window, not on the slider: the pointer is
 * often let go somewhere else, and a slider that missed its pointerup would
 * leave the whole application in Draft.
 */
export function holdDraft(): void {
  const { setInteracting } = useStore.getState();
  setInteracting(true);
  const release = () => {
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
    useStore.getState().setInteracting(false);
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
}
