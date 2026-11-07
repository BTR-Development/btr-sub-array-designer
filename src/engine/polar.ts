/**
 * Free- and far-field polar response of the whole array.
 *
 * The array is evaluated on a circle far enough away that every point is
 * effectively at the same distance, so the 1/r spreading term is common to all
 * angles and drops out entirely once the trace is normalised. What is left is the
 * pattern: purely the interference between cabinets.
 *
 * ANGLE CONVENTION — the same one the rest of the app uses for azimuth, so a
 * cabinet aimed at 40 deg in the table shows up at 40 deg here:
 *
 *   horizontal (XY)   0 deg = +Y, the front / audience direction
 *                     positive angles swing toward +X (right on the top view)
 *   vertical   (YZ)   0 deg = +Y, the same front direction, seen from the side
 *                     positive angles swing toward +Z (up)
 *
 * Both planes therefore share 0 deg — the on-axis direction — and each one is
 * the plane the matching SPL map draws, so the polar and the map always describe
 * the same slice of the room. Pairing the vertical plane with X instead would
 * cut across the array rather than along its aim, which for a sub line spread
 * across the stage is a section through nothing.
 *
 * Each trace is normalised to its OWN maximum, because a polar plot is read for
 * shape. The absolute peak is returned alongside for anyone who needs it.
 */

import { computePoint } from './engine';
import type { EngineSource } from './types';
import type { GroundModel } from '../core/types';

export type PolarPlane = 'horizontal' | 'vertical';

export interface PolarOptions {
  sources: EngineSource[];
  frequencies: number[];
  speedOfSound: number;
  ground?: GroundModel;
  plane?: PolarPlane;
  /** evaluation radius; defaults to well outside the array's own extent */
  radiusM?: number;
  /** angular resolution, degrees */
  stepDeg?: number;
}

export interface PolarTrace {
  frequencyHz: number;
  /** dB relative to this trace's own peak — 0 at the loudest angle, negative elsewhere */
  db: Float32Array;
  /** the absolute level at that peak, dB */
  peakDb: number;
  peakAngleDeg: number;
}

export interface PolarResult {
  anglesDeg: number[];
  traces: PolarTrace[];
  radiusM: number;
  plane: PolarPlane;
}

/** Unit direction for an angle in the chosen plane. */
export function polarDirection(angleDeg: number, plane: PolarPlane): [number, number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return plane === 'horizontal'
    ? [Math.sin(a), Math.cos(a), 0] // 0 deg -> +Y, +90 -> +X
    : [0, Math.cos(a), Math.sin(a)]; // 0 deg -> +Y, +90 -> +Z
}

/**
 * Radius that puts the whole circle safely in the far field: at least 60 m, and
 * at least 40x the array's own largest dimension so the path-length spread across
 * the array is negligible compared with the distance.
 */
export function farFieldRadius(sources: EngineSource[]): number {
  if (sources.length < 2) return 60;
  const xs = sources.map((s) => s.position.x);
  const ys = sources.map((s) => s.position.y);
  const zs = sources.map((s) => s.position.z);
  const extent = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    Math.max(...zs) - Math.min(...zs),
  );
  return Math.max(60, extent * 40);
}

export function polarResponse(opts: PolarOptions): PolarResult {
  const plane = opts.plane ?? 'horizontal';
  const step = opts.stepDeg ?? 2;
  const radius = opts.radiusM ?? farFieldRadius(opts.sources);
  const ground = opts.ground ?? 'off';

  const anglesDeg: number[] = [];
  for (let a = -180; a < 180; a += step) anglesDeg.push(a);

  // the array's own centre, so the circle really is concentric with it
  const n = Math.max(1, opts.sources.length);
  const cx = opts.sources.reduce((t, s) => t + s.position.x, 0) / n;
  const cy = opts.sources.reduce((t, s) => t + s.position.y, 0) / n;
  const cz = opts.sources.reduce((t, s) => t + s.position.z, 0) / n;

  const traces: PolarTrace[] = opts.frequencies.map((f) => {
    const db = new Float32Array(anglesDeg.length);
    let peakDb = -Infinity;
    let peakAngleDeg = 0;

    for (let i = 0; i < anglesDeg.length; i++) {
      const [dx, dy, dz] = polarDirection(anglesDeg[i], plane);
      const v = computePoint(
        opts.sources,
        { x: cx + dx * radius, y: cy + dy * radius, z: cz + dz * radius },
        f,
        opts.speedOfSound,
        ground,
      ).splDb;
      db[i] = v;
      if (v > peakDb) {
        peakDb = v;
        peakAngleDeg = anglesDeg[i];
      }
    }

    // normalise to this trace's own peak: the plot is read for shape
    if (isFinite(peakDb)) for (let i = 0; i < db.length; i++) db[i] -= peakDb;
    return { frequencyHz: f, db, peakDb, peakAngleDeg };
  });

  return { anglesDeg, traces, radiusM: radius, plane };
}
