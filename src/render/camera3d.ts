/**
 * Orthographic 3D camera, as pure functions over the world frame.
 *
 * WHY ORTHOGRAPHIC, AND WHY NO LIBRARY
 *
 * This is a measuring tool. Under an orthographic camera a metre is the same
 * number of pixels wherever it is, so a spacing read off the 3D view is the
 * spacing, and the two existing 2D views are special cases of this one rather
 * than a different renderer. Perspective would make the picture prettier and
 * every distance in it a lie.
 *
 * It also makes the whole thing small enough to own. A plane maps to a
 * PARALLELOGRAM under an orthographic projection, never to a general
 * quadrilateral, so the SPL map can be laid into the scene with a plain affine
 * canvas transform — exactly, not approximately — and a cabinet is six flat
 * faces. That is a few hundred lines of arithmetic against ~600 KB of WebGL
 * library inside a 2 MB offline application, and the arithmetic is testable
 * the way the rest of this project's geometry is.
 *
 * THE FRAME
 *
 * World is the app's own: X = stage width, Y = depth into the audience,
 * Z = up. The camera's `yawDeg` is the direction it LOOKS, in the same
 * clockwise-positive convention as a cabinet's azimuth — 0 looks along +Y,
 * from the stage into the audience, so 180 is the house view back at the
 * stage. `pitchDeg` is how far it looks DOWN, so 90 is a plan view and 0 is
 * eye level.
 *
 * At yaw 0, pitch 90 this reduces to the top view (screen right = +X, screen up
 * = +Y) and at yaw 270, pitch 0 to the side view (screen right = +Y, screen up
 * = +Z). Those are asserted in camera3d.test.ts, because a 3D view that
 * disagrees with the 2D ones about which way the room faces is worse than no
 * 3D view.
 */

import type { Vec3 } from '../core/types';

const DEG = Math.PI / 180;

export interface Camera3D {
  /** direction the camera looks, degrees, clockwise-positive from +Y */
  yawDeg: number;
  /** how far it looks DOWN from the horizontal, degrees */
  pitchDeg: number;
  /** pixels per metre */
  scale: number;
  /** world point that lands at the centre of the viewport */
  target: Vec3;
}

export const DEFAULT_CAMERA: Camera3D = {
  // Widok IZOMETRYCZNY — domyślny widok programu:
  // z widowni, po przekątnej (45° od osi sceny), pod kątem izometrii
  // atan(1/√2) ≈ 35.26°. Z przekątnej widać naraz front obudów, ich bok i
  // płaszczyznę mapy, czyli wszystkie trzy rzeczy, które się tu ustawia;
  // dawny widok na wprost (yaw 180, pitch 22) chował boki rzędu.
  yawDeg: 225,
  pitchDeg: (Math.atan(1 / Math.SQRT2) * 180) / Math.PI,
  scale: 14,
  target: { x: 0, y: 6, z: 1 },
};

/** Lowest and highest the camera may look; past either the picture degenerates. */
export const PITCH_RANGE: [number, number] = [-89, 89];
export const SCALE_RANGE: [number, number] = [1, 400];

export interface Basis {
  /** unit vector the camera looks along */
  dir: Vec3;
  /** unit vector that points to the RIGHT of the screen */
  right: Vec3;
  /** unit vector that points UP the screen */
  up: Vec3;
}

export function basisOf(cam: Camera3D): Basis {
  const y = cam.yawDeg * DEG;
  const p = cam.pitchDeg * DEG;
  const cp = Math.cos(p);
  // Looking down is NEGATIVE z, hence the sign: pitch is quoted the way a
  // person describes a camera, not the way the z axis runs.
  const dir: Vec3 = { x: Math.sin(y) * cp, y: Math.cos(y) * cp, z: -Math.sin(p) };
  // Screen right is horizontal whatever the pitch, so it is the yaw turned a
  // quarter turn and nothing else. At yaw 0 it is +X, which is what the top
  // view draws.
  const right: Vec3 = { x: Math.cos(y), y: -Math.sin(y), z: 0 };
  // up = right x dir
  const up: Vec3 = {
    x: right.y * dir.z - right.z * dir.y,
    y: right.z * dir.x - right.x * dir.z,
    z: right.x * dir.y - right.y * dir.x,
  };
  return { dir, right, up };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export interface Viewport3D {
  width: number;
  height: number;
  cam: Camera3D;
}

/** World point to screen pixels. */
export function project(vp: Viewport3D, p: Vec3, basis = basisOf(vp.cam)): [number, number] {
  const d = sub(p, vp.cam.target);
  return [
    vp.width / 2 + dot(d, basis.right) * vp.cam.scale,
    vp.height / 2 - dot(d, basis.up) * vp.cam.scale,
  ];
}

/**
 * How far along the view axis a point lies. Larger is further from the camera,
 * so painting in descending order puts near things on top.
 */
export function depthOf(cam: Camera3D, p: Vec3, basis = basisOf(cam)): number {
  return dot(sub(p, cam.target), basis.dir);
}

/**
 * The canvas transform that lays a w x h image onto the parallelogram whose
 * image-space origin, +x edge and +y edge land on the three given world points.
 *
 * Returned as the six numbers `setTransform` takes. Exact, because an
 * orthographic projection is affine: the SPL map goes into the scene without
 * being resampled by hand or sliced into triangles.
 */
export function affineForQuad(
  vp: Viewport3D,
  origin: Vec3,
  alongX: Vec3,
  alongY: Vec3,
  imageW: number,
  imageH: number,
  basis = basisOf(vp.cam),
): [number, number, number, number, number, number] | null {
  if (!(imageW > 0) || !(imageH > 0)) return null;
  const [ox, oy] = project(vp, origin, basis);
  const [ux, uy] = project(vp, alongX, basis);
  const [vx, vy] = project(vp, alongY, basis);
  const a = (ux - ox) / imageW;
  const b = (uy - oy) / imageW;
  const c = (vx - ox) / imageH;
  const d = (vy - oy) / imageH;
  // A plane seen EDGE-ON projects to a line, and the transform collapses with
  // it. A vertical prediction plane at the default camera is exactly that, so
  // this is not a corner case: it is what the side-view plane does the moment
  // somebody opens the 3D view. Returning the flat matrix drew nothing and
  // said nothing; null lets the caller say the plane is edge-on.
  if (Math.abs(a * d - b * c) < 1e-12) return null;
  return [a, b, c, d, ox, oy];
}

/**
 * Drag the orbit. `dx`/`dy` are pixels; yaw follows the pointer horizontally
 * and pitch vertically, and the pitch is clamped short of straight down so the
 * horizontal reference never collapses to a point.
 */
export function orbit(cam: Camera3D, dx: number, dy: number, degPerPx = 0.4): Camera3D {
  return {
    ...cam,
    yawDeg: wrap360(cam.yawDeg - dx * degPerPx),
    pitchDeg: clamp(cam.pitchDeg + dy * degPerPx, PITCH_RANGE[0], PITCH_RANGE[1]),
  };
}

/** Zoom about the viewport centre. */
export function zoom(cam: Camera3D, factor: number): Camera3D {
  return { ...cam, scale: clamp(cam.scale * factor, SCALE_RANGE[0], SCALE_RANGE[1]) };
}

/**
 * Zoom about a point on the SCREEN, keeping whatever is under it where it is.
 *
 * This is the one a wheel wants. Zooming about the centre means the thing you
 * are pointing at slides away as you lean in, so reading one stack closely is
 * zoom, pan, zoom, pan - and the 2D views already pin the world point under
 * the cursor, so the 3D view doing something else was an inconsistency on top
 * of an inconvenience.
 *
 * Exact under an orthographic camera: the screen offset from the centre is
 * `scale` times the target-relative position in the screen plane, so holding
 * the offset while the scale changes is one subtraction per axis. The shift
 * uses the CLAMPED scale, because at either end of SCALE_RANGE the zoom does
 * not happen and the pan must not happen either - otherwise the view creeps
 * sideways every notch once it has hit the stop.
 */
export function zoomAt(vp: Viewport3D, factor: number, px: number, py: number): Camera3D {
  const cam = vp.cam;
  const next = clamp(cam.scale * factor, SCALE_RANGE[0], SCALE_RANGE[1]);
  if (next === cam.scale) return cam;
  const b = basisOf(cam);
  // Screen-plane coordinates of the cursor relative to the target, before and
  // after. Screen y runs down, world `up` runs up, hence the sign.
  const k = (px - vp.width / 2) * (1 / cam.scale - 1 / next);
  const m = -(py - vp.height / 2) * (1 / cam.scale - 1 / next);
  return {
    ...cam,
    scale: next,
    target: {
      x: cam.target.x + b.right.x * k + b.up.x * m,
      y: cam.target.y + b.right.y * k + b.up.y * m,
      z: cam.target.z + b.right.z * k + b.up.z * m,
    },
  };
}

/** Slide the target in the camera's own screen plane, so a drag tracks the pointer. */
export function pan(vp: Viewport3D, dx: number, dy: number): Camera3D {
  const b = basisOf(vp.cam);
  const kx = -dx / vp.cam.scale;
  const ky = dy / vp.cam.scale;
  return {
    ...vp.cam,
    target: {
      x: vp.cam.target.x + b.right.x * kx + b.up.x * ky,
      y: vp.cam.target.y + b.right.y * kx + b.up.y * ky,
      z: vp.cam.target.z + b.right.z * kx + b.up.z * ky,
    },
  };
}

/**
 * Frame a set of world points, leaving a margin.
 *
 * Measured on the SCREEN axes rather than in world units, because what has to
 * fit is the projection: a rig that is 20 m wide seen end-on needs the scale
 * its depth asks for, not the one its width does.
 */
export function fitCamera(
  cam: Camera3D,
  points: Vec3[],
  width: number,
  height: number,
  marginPx = 48,
): Camera3D {
  if (!points.length || width <= 0 || height <= 0) return cam;
  const b = basisOf(cam);
  let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of points) {
    const h = dot(p, b.right);
    const v = dot(p, b.up);
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const spanH = Math.max(maxH - minH, 1e-6);
  const spanV = Math.max(maxV - minV, 1e-6);
  // A fixed margin can exceed a short viewport — the canvas shrinks when a
  // bottom panel opens — which drives the scale into the clamp floor and turns
  // a 20 m array into 20 px. Capped at a fraction of each dimension, the same
  // way `fitView` caps it for the 2D views.
  const margin = Math.max(0, Math.min(marginPx, width * 0.2, height * 0.2));
  const usableW = Math.max(1, width - margin * 2);
  const usableH = Math.max(1, height - margin * 2);
  const scale = clamp(Math.min(usableW / spanH, usableH / spanV), SCALE_RANGE[0], SCALE_RANGE[1]);

  // The target has to be the MIDPOINT of what was just measured, not the
  // centroid of the points. Scaling for the bounding box and centring on the
  // centroid are two different framings: a rig with many cabinets at one end
  // and a wide prediction plane at the other pulls the centroid toward the
  // cabinets, and "fit" then pushed the far corners of the plane 56 px off the
  // bottom of an 800x600 canvas that had 82 px of slack. `fitView` centres on
  // the midpoint for exactly this reason.
  const midH = (minH + maxH) / 2;
  const midV = (minV + maxV) / 2;
  const target: Vec3 = {
    x: b.right.x * midH + b.up.x * midV,
    y: b.right.y * midH + b.up.y * midV,
    z: b.right.z * midH + b.up.z * midV,
  };
  // ...plus whatever the old target had along the view axis, which the screen
  // cannot see and which keeps the camera where it was in depth.
  const depth = dot(cam.target, b.dir);
  target.x += b.dir.x * depth;
  target.y += b.dir.y * depth;
  target.z += b.dir.z * depth;
  return { ...cam, scale, target };
}

/**
 * The part of a screen segment that lies inside a rectangle, or null.
 *
 * Liang-Barsky, and it exists so the 3D grid can be LABELLED. A floor gridline
 * runs off the edge of the canvas in both directions and its world axis is
 * often off screen entirely, so there is no fixed point on it to write the
 * number at: the only place guaranteed to be visible is where the line meets
 * the edge of what you can see. The 2D views put their numbers down the same
 * two edges for the same reason.
 */
export function clipSegment(
  p0: [number, number],
  p1: [number, number],
  rect: { x0: number; y0: number; x1: number; y1: number },
): [[number, number], [number, number]] | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  let t0 = 0;
  let t1 = 1;
  const edge = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel to this edge: inside iff not beyond it
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!edge(-dx, p0[0] - rect.x0)) return null;
  if (!edge(dx, rect.x1 - p0[0])) return null;
  if (!edge(-dy, p0[1] - rect.y0)) return null;
  if (!edge(dy, rect.y1 - p0[1])) return null;
  return [
    [p0[0] + t0 * dx, p0[1] + t0 * dy],
    [p0[0] + t1 * dx, p0[1] + t1 * dy],
  ];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Metres per floor-grid square.
 *
 * Literally the 2D views' own function, not a second ladder that looks like
 * it. The first attempt here was its own table and disagreed with the 2D grid
 * on 42% of the zoom range — at scale 30 one view drew 5 m squares and the
 * other 2 m, with no label on either, so a spacing counted off the 3D floor
 * came out two and a half times wrong.
 */
export { gridStep as gridStepFor } from './view';
