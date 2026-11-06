/**
 * Who has the keyboard: the dialogs, or the canvas behind them.
 *
 * The global shortcut handler in `App` listens on `window`, so with a dialog
 * open every one of its bindings still reached the project underneath. The
 * arrows walked the selection, Cmd+D duplicated it, Cmd+Z undid an edit the
 * user could not see, and Backspace raised a delete confirmation stacked on top
 * of the dialog already on screen. None of those is what the keystroke meant,
 * and none of them is visible while a dialog covers the canvas.
 *
 * A counter rather than a boolean because dialogs can stack, and a module of
 * its own rather than store state because the handler reads it outside React's
 * render — and because a `Modal` that also exported a plain function would cost
 * the component file its fast refresh.
 */
let openModals = 0;

/** Called by `Modal` on mount; the returned function releases the claim. */
export function claimModal(): () => void {
  openModals++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openModals = Math.max(0, openModals - 1);
  };
}

/** True while any modal is on screen. */
export function modalIsOpen() {
  return openModals > 0;
}

/**
 * Tab stops, in document order. Deliberately not filtered by visibility: jsdom
 * has no layout, so an `offsetParent` test would make the focus trap a no-op in
 * every test that exercises it.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
  ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
