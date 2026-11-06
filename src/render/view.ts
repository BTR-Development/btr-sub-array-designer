/**
 * Canvas <-> world mapping.
 *
 * The world is X = stage width, Y = depth into the audience, Z = height, so the
 * canvas draws:
 *   plane 'top'  : horizontal = X, vertical = Y  (Y increases UP the screen)
 *   plane 'side' : horizontal = Y, vertical = Z  (Z increases UP the screen)
 *
 * A side view is a section cut along the room, so its horizontal axis has to be
 * the depth axis. Pairing X with Z would draw a front elevation instead, which
 * for a sub line spread across the stage shows the array end-on and hides the
 * only thing the view exists to show.
 *
 * The third coordinate is the plane offset and is edited numerically.
 */

import type { PredictionArea, PredictionPlane, Vec3 } from '../core/types';
import type { ViewTransform } from '../state/store';

export interface Viewport {
  width: number;
  height: number;
  view: ViewTransform;
}

export function worldToScreen(vp: Viewport, wx: number, wv: number): [number, number] {
  return [
    vp.width / 2 + (wx - vp.view.cx) * vp.view.scale,
    vp.height / 2 - (wv - vp.view.cy) * vp.view.scale,
  ];
}

export function screenToWorld(vp: Viewport, sx: number, sv: number): [number, number] {
  return [
    (sx - vp.width / 2) / vp.view.scale + vp.view.cx,
    -(sv - vp.height / 2) / vp.view.scale + vp.view.cy,
  ];
}

/**
 * The two world axes the plane actually draws, horizontal first.
 *
 * For code that has to decide WHERE to put something so the user can see it.
 * Anything stepped along the third axis is invisible twice over: off the drawn
 * section, and off the plane the SPL map is computed on.
 */
export function drawnAxes(plane: PredictionPlane): ['x', 'y'] | ['y', 'z'] {
  return plane === 'top' ? ['x', 'y'] : ['y', 'z'];
}

/** Projects a 3D point onto the drawn plane's two axes. */
export function planeAxes(plane: PredictionPlane, p: Vec3): [number, number] {
  return plane === 'top' ? [p.x, p.y] : [p.y, p.z];
}

/** Builds a Vec3 from the two on-screen axes plus the untouched third value. */
export function fromPlaneAxes(
  plane: PredictionPlane,
  h: number,
  v: number,
  original: Vec3,
): Vec3 {
  return plane === 'top' ? { x: h, y: v, z: original.z } : { x: original.x, y: h, z: v };
}

/**
 * A 3D point from the two on-screen axes plus the plane offset for the third.
 *
 * For placing something that has no previous position: a probe, a fresh cabinet,
 * a new measurement point. `fromPlaneAxes` keeps the third coordinate of a point
 * that already exists; this one takes it from the drawn section.
 *
 * It exists because the same two lines were written by hand in three places and
 * one of them still carried the pre-2026-08-19 pairing (X with Z), so a click in
 * the side view probed a point nowhere near the cursor.
 */
export function pointOnPlane(
  plane: PredictionPlane,
  h: number,
  v: number,
  planeOffset: number,
): Vec3 {
  return plane === 'top'
    ? { x: h, y: v, z: planeOffset }
    : { x: planeOffset, y: h, z: v };
}

/** World-space delta from a screen-space drag, on the current plane. */
export function planeDelta(plane: PredictionPlane, dh: number, dv: number): Vec3 {
  return plane === 'top' ? { x: dh, y: dv, z: 0 } : { x: 0, y: dh, z: dv };
}

export function snapValue(v: number, snap: number): number {
  return snap > 0 ? Math.round(v / snap) * snap : v;
}

/** Nice grid spacing for the current zoom: 1/2/5 x 10^n metres. */
export function gridStep(scale: number): number {
  const targetPx = 70;
  const raw = targetPx / scale;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= mag * m) return mag * m;
  return mag * 10;
}

/**
 * The three world corners that lay an SPL image onto its prediction plane:
 * where image (0,0) goes, where its +x edge ends and where its +y edge ends.
 *
 * Image row 0 is the HIGH end of the plane's vertical axis, because that is
 * how the 2D views draw it — `drawImage` from (xMin, vMax) to (xMax, vMin).
 * The 3D viewport lays the same image into the scene with an affine transform
 * and has to agree, or the same solve comes out mirrored in one of the two
 * views and nothing on screen says which.
 */
export function planeImageCorners(
  plane: PredictionPlane,
  r: { xMin: number; xMax: number; vMin: number; vMax: number },
  planeOffset: number,
): { origin: Vec3; alongX: Vec3; alongY: Vec3 } {
  return {
    origin: pointOnPlane(plane, r.xMin, r.vMax, planeOffset),
    alongX: pointOnPlane(plane, r.xMax, r.vMax, planeOffset),
    alongY: pointOnPlane(plane, r.xMin, r.vMin, planeOffset),
  };
}

export interface Bounds {
  minH: number;
  maxH: number;
  minV: number;
  maxV: number;
}

/** Zoom/pan so `b` fills the viewport with a margin. */
export function fitView(vp: { width: number; height: number }, b: Bounds, marginPx = 60): ViewTransform {
  const w = Math.max(1e-3, b.maxH - b.minH);
  const h = Math.max(1e-3, b.maxV - b.minV);
  // A fixed margin can exceed a short viewport (the canvas shrinks when a
  // bottom panel opens), which would make the scale negative and slam it into
  // the clamp floor. Cap the margin at a fraction of each dimension instead.
  const margin = Math.max(0, Math.min(marginPx, vp.width * 0.2, vp.height * 0.2));
  const sx = (vp.width - margin * 2) / w;
  const sy = (vp.height - margin * 2) / h;
  const scale = Math.min(sx, sy);
  return {
    scale: Math.max(0.5, Math.min(400, scale > 0 ? scale : 1)),
    cx: (b.minH + b.maxH) / 2,
    cy: (b.minV + b.maxV) / 2,
  };
}

/**
 * Ask the canvas to fit its content.
 *
 * Deferred by a frame on purpose: callers fire this straight after mutating the
 * store, and the canvas's fit handler closes over the state it last rendered
 * with. Dispatching synchronously would fit to the OUTGOING project.
 */
export function requestFit() {
  // Two passes: the first once React has re-rendered, the second after any
  // layout change (a panel opening/closing) has resized the canvas.
  setTimeout(() => window.dispatchEvent(new Event('btr:fit')), 0);
  setTimeout(() => window.dispatchEvent(new Event('btr:fit')), 180);
}

/**
 * Obszar predykcji przeskalowany do zadanego ROZMIARU (dłuższy bok, metry)
 * względem punktu `pivot` — w praktyce środka rigu.
 *
 * Skalowanie względem środka OBSZARU wypychało rig z mapy: domyślny obszar
 * stoi przed sceną (y od −5 do 45, środek 20 m), więc zmniejszenie go do 20 m
 * wokół środka zostawiało y 10..30, a array stojący na y = 0 lądował poza
 * płaszczyzną. Względem rigu jego miejsce na mapie zostaje to samo: jeśli
 * stał w 10 % wysokości od dolnej krawędzi, stoi tam dalej. Proporcje boków
 * też zostają. Pivot spoza obszaru jest dociągany do niego — inaczej skalowanie
 * wokół punktu za krawędzią przesuwałoby mapę zamiast ją powiększać.
 */
export function scaleAreaTo(
  area: PredictionArea,
  sizeM: number,
  pivot: [number, number],
): PredictionArea {
  const w = Math.abs(area.xMax - area.xMin);
  const h = Math.abs(area.vMax - area.vMin);
  const current = Math.max(w, h);
  if (!(current > 0) || !(sizeM > 0)) return area;
  const k = sizeM / current;
  const lo = (a: number, b: number) => Math.min(a, b);
  const hi = (a: number, b: number) => Math.max(a, b);
  const ph = Math.min(hi(area.xMin, area.xMax), Math.max(lo(area.xMin, area.xMax), pivot[0]));
  const pv = Math.min(hi(area.vMin, area.vMax), Math.max(lo(area.vMin, area.vMax), pivot[1]));
  return {
    ...area,
    xMin: ph + (area.xMin - ph) * k,
    xMax: ph + (area.xMax - ph) * k,
    vMin: pv + (area.vMin - pv) * k,
    vMax: pv + (area.vMax - pv) * k,
  };
}

/** Dłuższy bok obszaru predykcji, metry — to, co pokazuje pole rozmiaru. */
export function areaSize(area: PredictionArea): number {
  return Math.max(Math.abs(area.xMax - area.xMin), Math.abs(area.vMax - area.vMin));
}
