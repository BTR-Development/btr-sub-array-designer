/**
 * Inline icon set.
 *
 * 16 px stroke glyphs on a shared grid, drawn to read at small sizes against the
 * grey chrome. Everything is hand-drawn geometry — no vendor artwork.
 */

export type IconName =
  | 'home'
  | 'topview'
  | 'sideview'
  | 'view3d'
  | 'temperature'
  | 'chevron'
  | 'close'
  | 'undo'
  | 'redo';

const P: Record<IconName, React.ReactNode> = {
  // ── chrome ──────────────────────────────────────────────────────────────
  home: <path d="M2 7.2 8 2.2l6 5v6.4a.8.8 0 0 1-.8.8H9.6v-4H6.4v4H2.8a.8.8 0 0 1-.8-.8Z" />,
  chevron: <path d="M4 6.5 8 10l4-3.5" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  undo: (
    <>
      <path d="M5.4 2.8 2.2 6l3.2 3.2" />
      <path d="M2.4 6h7.1a3.7 3.7 0 0 1 0 7.4H6" />
    </>
  ),
  redo: (
    <>
      <path d="M10.6 2.8 13.8 6l-3.2 3.2" />
      <path d="M13.6 6H6.5a3.7 3.7 0 0 0 0 7.4H10" />
    </>
  ),

  // ── workspace tabs ──────────────────────────────────────────────────────
  topview: (
    <>
      <rect x="2" y="2.4" width="12" height="11.2" rx="1" />
      <path d="M2 10.2h12" />
      <path d="M8 10.2V13" />
      <path d="M5.4 7.4 8 4.6l2.6 2.8" />
    </>
  ),
  sideview: (
    <>
      <rect x="2" y="2.4" width="12" height="11.2" rx="1" />
      <path d="M2 11.4h12" />
      <path d="M4.4 11.4V8.2" />
      <path d="M4.4 9.4 12.4 5" />
    </>
  ),
  view3d: (
    <>
      <path d="M8 1.9 14.2 5.2v5.6L8 14.1 1.8 10.8V5.2z" />
      <path d="M1.8 5.2 8 8.5l6.2-3.3" />
      <path d="M8 8.5v5.6" />
    </>
  ),

  // ── file ────────────────────────────────────────────────────────────────

  // ── instrumentation ─────────────────────────────────────────────────────
  temperature: (
    <>
      <path d="M6.6 9.4V3.6a1.4 1.4 0 0 1 2.8 0v5.8a2.6 2.6 0 1 1-2.8 0Z" />
      <circle cx="8" cy="11.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),

  // ── actions ─────────────────────────────────────────────────────────────
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icn${className ? ` ${className}` : ''}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {P[name]}
    </svg>
  );
}
