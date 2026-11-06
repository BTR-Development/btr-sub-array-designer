/**
 * A cabinet as six flat faces in world space.
 *
 * The orientation comes from `localFrame` — the engine's own function, the one
 * that turns the radiating elements and the acoustic origin. Drawing has its
 * own copy of that arithmetic exactly nowhere, because a picture that disagrees
 * with the prediction about which way a box points is the most expensive kind
 * of wrong this program can be: a reverse stack looks identical to a plain one
 * until somebody measures it on site.
 *
 * The dimensions here are the PUBLISHED ones, not `orientedDimensions`. Those
 * two are not alternatives: the oriented pair is the axis-aligned box a rolled
 * cabinet OCCUPIES, which is what a deck and a stack pitch need, while the
 * frame below rotates the real box and so needs the real sides. Handing the
 * oriented pair to a rotating frame would roll the cabinet twice.
 */

import type { Vec3 } from '../core/types';
import { localFrame } from '../engine/engine';

/** Which side of the cabinet a face is, in the cabinet's own terms. */
export type FaceKind = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';

export interface Face3D {
  kind: FaceKind;
  /** four corners, in order round the face */
  corners: [Vec3, Vec3, Vec3, Vec3];
  /** outward unit normal */
  normal: Vec3;
}

export interface BoxSize {
  widthM: number;
  heightM: number;
  depthM: number;
}

export interface Rotation3D {
  azimuthDeg: number;
  elevationDeg: number;
  rollDeg: number;
}

/**
 * The eight corners and six faces of a cabinet standing at `position` (its
 * geometric centre, the convention everywhere in this program) turned by
 * `rotation` and `size` metres on a side.
 */
export function cabinetFaces(position: Vec3, rotation: Rotation3D, size: BoxSize): Face3D[] {
  const fr = localFrame(rotation.azimuthDeg, rotation.elevationDeg, rotation.rollDeg);
  const r: Vec3 = { x: fr.rx, y: fr.ry, z: fr.rz };
  const f: Vec3 = { x: fr.fx, y: fr.fy, z: fr.fz };
  const u: Vec3 = { x: fr.ux, y: fr.uy, z: fr.uz };
  const hw = size.widthM / 2;
  const hd = size.depthM / 2;
  const hh = size.heightM / 2;

  // a, b, c are in units of half-width, half-depth and half-height
  const at = (a: number, b: number, c: number): Vec3 => ({
    x: position.x + r.x * a * hw + f.x * b * hd + u.x * c * hh,
    y: position.y + r.y * a * hw + f.y * b * hd + u.y * c * hh,
    z: position.z + r.z * a * hw + f.z * b * hd + u.z * c * hh,
  });
  const neg = (v: Vec3): Vec3 => ({ x: -v.x, y: -v.y, z: -v.z });

  return [
    {
      kind: 'front',
      normal: f,
      corners: [at(-1, 1, -1), at(1, 1, -1), at(1, 1, 1), at(-1, 1, 1)],
    },
    {
      kind: 'back',
      normal: neg(f),
      corners: [at(1, -1, -1), at(-1, -1, -1), at(-1, -1, 1), at(1, -1, 1)],
    },
    {
      kind: 'right',
      normal: r,
      corners: [at(1, 1, -1), at(1, -1, -1), at(1, -1, 1), at(1, 1, 1)],
    },
    {
      kind: 'left',
      normal: neg(r),
      corners: [at(-1, -1, -1), at(-1, 1, -1), at(-1, 1, 1), at(-1, -1, 1)],
    },
    {
      kind: 'top',
      normal: u,
      corners: [at(-1, 1, 1), at(1, 1, 1), at(1, -1, 1), at(-1, -1, 1)],
    },
    {
      kind: 'bottom',
      normal: neg(u),
      corners: [at(-1, -1, -1), at(1, -1, -1), at(1, 1, -1), at(-1, 1, -1)],
    },
  ];
}

/** Every corner of the box, for framing the camera on a whole rig. */
export function cabinetCorners(position: Vec3, rotation: Rotation3D, size: BoxSize): Vec3[] {
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (const face of cabinetFaces(position, rotation, size)) {
    for (const c of face.corners) {
      const key = `${c.x.toFixed(6)},${c.y.toFixed(6)},${c.z.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/**
 * Is this face turned toward the camera?
 *
 * A box is convex, so the faces whose outward normal opposes the view
 * direction are exactly the ones you can see, and the other three can be
 * dropped rather than painted over. Exported so the rule is testable: a sign
 * error here hides the front of every cabinet and shows the inside of the
 * back, which on a reverse stack reads as the opposite rig.
 */

/**
 * Lambert shade for a face, 0..1, from a fixed light.
 *
 * One-sided on purpose: a face turned away from the light gets the ambient
 * floor rather than a mirrored highlight, so the box reads as a solid and the
 * side that is actually lit is unambiguous.
 */
export function facesCamera(normal: Vec3, viewDir: Vec3): boolean {
  return normal.x * viewDir.x + normal.y * viewDir.y + normal.z * viewDir.z < 0;
}

export function shadeOf(normal: Vec3, light: Vec3 = DEFAULT_LIGHT, ambient = 0.45): number {
  const d = normal.x * light.x + normal.y * light.y + normal.z * light.z;
  return ambient + (1 - ambient) * Math.max(0, d);
}

/** Up and over the left shoulder of the default camera. */
export const DEFAULT_LIGHT: Vec3 = normalise({ x: -0.35, y: 0.45, z: 0.82 });

function normalise(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}
