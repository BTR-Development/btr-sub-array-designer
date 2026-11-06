/**
 * Design tokens, for code that paints on a canvas.
 *
 * A stylesheet cannot reach a `<canvas>`: everything drawn there is a colour
 * string handed to the 2D context. So this project once carried
 * 52 colours written twice — once in `:root` and once again, as hex literals,
 * in the drawing code. Changing the palette moved the chrome and left the map,
 * the 3D view and the polar plot in the old colours, with a visible seam
 * between them.
 *
 * This reads the real tokens off the document, so there is one source of truth
 * and the canvases follow the stylesheet. The fallbacks are not decoration:
 * `getComputedStyle` returns an empty string for a property that does not
 * exist, and a canvas handed an empty fill silently paints nothing.
 */

let cache: Map<string, string> | null = null;

/** The value of a CSS custom property, or `fallback` when it is not defined. */
export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  if (!cache) cache = new Map();
  const hit = cache.get(name);
  if (hit !== undefined) return hit || fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  cache.set(name, v);
  return v || fallback;
}

/**
 * Forget what was read.
 *
 * Only a theme change needs this, and this program has one theme — but a cache
 * that cannot be cleared is the kind of thing that makes the second theme a
 * rewrite instead of a stylesheet.
 */
export function clearTokenCache(): void {
  cache = null;
}
