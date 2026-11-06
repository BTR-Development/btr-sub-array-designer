import { useRef, useState } from 'react';
import { useStore } from '../state/store';
import { useT } from '../i18n/useT';

type Axis = 'x' | 'y';

interface Props {
  /** 'x' resizes width (a column boundary), 'y' resizes height (a stacked pane). */
  axis: Axis;
  /** Which neighbour this handle sizes. The other one takes up the slack. */
  target: 'prev' | 'next';
  /** Where the pixel size is stored, so the same pane keeps its size across renders. */
  sizeKey: string;
  min?: number;
  max?: number;
}

/**
 * A drag handle between two panes.
 *
 * It measures its own neighbour rather than being handed a ref, which keeps the
 * call sites to one line and means a pane that has never been dragged has no
 * stored size at all — the stylesheet keeps it, responsive breakpoints included,
 * until the user takes hold of the handle. Double-click hands it back.
 */
export function Splitter({ axis, target, sizeKey, min = 60, max = 2400 }: Props) {
  const t = useT();
  const setLayoutSize = useStore((s) => s.setLayoutSize);
  const resetLayoutSize = useStore((s) => s.resetLayoutSize);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; base: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Growing `prev` means dragging towards larger coordinates; `next` is the mirror. */
  const sign = target === 'prev' ? 1 : -1;

  const neighbour = () => {
    const el = ref.current;
    if (!el) return null;
    const n = target === 'prev' ? el.previousElementSibling : el.nextElementSibling;
    return n instanceof HTMLElement ? n : null;
  };

  const coord = (e: React.PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);

  return (
    <div
      ref={ref}
      className={`splitter splitter-${axis}${dragging ? ' dragging' : ''}`}
      data-size-key={sizeKey}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={t('ui.splitterHint')}
      onDoubleClick={() => resetLayoutSize(sizeKey)}
      onPointerDown={(e) => {
        const n = neighbour();
        if (!n) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const r = n.getBoundingClientRect();
        drag.current = { from: coord(e), base: axis === 'x' ? r.width : r.height };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const next = drag.current.base + (coord(e) - drag.current.from) * sign;
        setLayoutSize(sizeKey, Math.max(min, Math.min(max, next)));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
        setDragging(false);
      }}
    />
  );
}
