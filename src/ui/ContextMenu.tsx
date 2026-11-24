import { useEffect, useRef } from 'react';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';

/**
 * The right-click menu over a selection of cabinets. Deliberately small: it
 * holds only what has no better home than "on the thing itself", which today
 * is end-fire. Everything in it also exists as a visible control (the
 * End-fire… buttons and the End-fire panel), so the menu is a shortcut.
 */
export function ContextMenu() {
  const s = useStore();
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const open = !!s.ctxMenu;

  useEffect(() => {
    if (open) ref.current?.querySelector('button')?.focus();
  }, [open]);

  if (!s.ctxMenu) return null;
  const sel = s.selectedSourceIds;
  const anyAssigned = s.sources.some((x) => sel.includes(x.id) && x.ef);

  // Kept on screen even near the window edge.
  const left = Math.max(4, Math.min(s.ctxMenu.x, window.innerWidth - 240));
  const top = Math.max(4, Math.min(s.ctxMenu.y, window.innerHeight - 96));

  return (
    <div
      className="ctx-overlay"
      onPointerDown={() => s.closeCtxMenu()}
      onContextMenu={(e) => {
        e.preventDefault();
        s.closeCtxMenu();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') s.closeCtxMenu();
      }}
    >
      <div
        ref={ref}
        className="menu ctx-menu"
        role="menu"
        style={{ left, top }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          role="menuitem"
          disabled={!sel.length || anyAssigned}
          onClick={() => {
            s.closeCtxMenu();
            s.setEndFireOpen(true);
          }}
        >
          {t('ctx.makeEf')}
        </button>
        <button
          role="menuitem"
          disabled={!anyAssigned}
          onClick={() => {
            s.closeCtxMenu();
            s.removeFromEf(sel);
          }}
        >
          {t('ctx.releaseEf')}
        </button>
      </div>
    </div>
  );
}
