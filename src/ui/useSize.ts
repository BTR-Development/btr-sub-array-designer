import { useStore } from '../state/store';

type Axis = 'x' | 'y';

/**
 * The style a resizable pane should carry: a pinned pixel size once the user has
 * dragged it, and nothing at all before that.
 */
export function useSize(sizeKey: string, axis: Axis): React.CSSProperties | undefined {
  const px = useStore((s) => s.layout[sizeKey]);
  if (px === undefined) return undefined;
  return axis === 'x'
    ? { width: px, flex: `0 0 ${px}px` }
    : { height: px, flex: `0 0 ${px}px` };
}
