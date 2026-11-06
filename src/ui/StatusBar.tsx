/**
 * The strip along the bottom of the window.
 *
 * It exists because the facts it carries had nowhere to live. Where the cursor
 * is reads off the plot only while the mouse is moving; what is selected had to
 * be counted in the tree; which tool is armed and what the snap is were
 * knowable only by looking at the toolbar. None of that is worth a panel, and
 * all of it is worth a line.
 *
 * Everything here is READ. The bar has no controls, so it cannot become
 * another place where the project is changed, and nothing in it needs undo.
 */
import { useSyncExternalStore } from 'react';
import { useStore } from '../state/store';
import { BRANDING } from '../branding';
import { useT } from '../i18n/useT';
import { lastDraftAt, onDraftSaved } from '../state/autosave';

export function StatusBar() {
  const s = useStore();
  const t = useT();

  const cursor = s.cursorPoint
    ? `X ${s.cursorPoint.x.toFixed(2)} · Y ${s.cursorPoint.y.toFixed(2)}`
    : `X - · Y -`;

  // A group selection and a point selection are selections too: counting only
  // the cabinets would have the bar say "nothing selected" over a highlighted
  // group.
  const n = s.selectedSourceIds.length;
  const selection = n
    ? t('status.selected', { n })
    : s.selectedGroupId
      ? t('status.group')
      : s.selectedPointId
        ? t('status.point')
        : t('status.nothing');

  const active = s.sources.filter((x) => !x.mute).length;
  // the crash-recovery copy, so it is visible that work is being kept
  const draft = useSyncExternalStore(onDraftSaved, lastDraftAt);

  return (
    <div className="statusbar">
      <span className="statusbar-strong">{cursor}</span>
      <span>{selection}</span>
      <span className="statusbar-gap" />
      <span>
        {t('status.tool')}{' '}
        <span className="statusbar-strong">
          {s.tool === 'addPoint' ? t('status.toolPoint') : t('status.toolSelect')}
        </span>
      </span>
      <span>{s.snap > 0 ? t('status.snap', { v: s.snap.toFixed(2) }) : t('status.snapOff')}</span>
      <span>{t('status.active', { a: active, n: s.sources.length })}</span>
      <span className="statusbar-author">{t('app.author', { name: BRANDING.author })}</span>
      {draft && (
        <span className="statusbar-draft">
          {t('status.draftSaved', {
            time: draft.toLocaleTimeString(s.lang, { hour: '2-digit', minute: '2-digit' }),
          })}
        </span>
      )}
    </div>
  );
}
