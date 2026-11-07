/**
 * Evaluation of imported balloon data (frequency x azimuth x elevation,
 * magnitude + phase).
 *
 * No quality-A/B dataset ships with the MVP — see README, "Speaker data
 * architecture". This module exists so that an importer can drop a real
 * measured dataset in without touching the engine.
 *
 * Strategy: at prepare-time we collapse the frequency axis by interpolating
 * (log-frequency, dB magnitude, unwrapped-per-cell phase) between the two
 * nearest bands. That leaves a 2D complex slab which the inner loop samples
 * bilinearly in azimuth / elevation.
 */

import type { BalloonDataset } from '../speakers/schema';

export interface BalloonSlice {
  az: number[];
  el: number[];
  /** interleaved [re, im] per (az, el) cell, index = (ai * nEl + ei) * 2 */
  data: Float64Array;
}

function lowerIndex(grid: number[], v: number): number {
  // A single-sample axis has no interval to sit in. Without this the next line
  // returns -1, which indexes off the front of the slab: a one-elevation
  // dataset — the horizontal-plane case the importer explicitly endorses —
  // produced NaN for every receiver above the cabinet, and NaN reaches the user
  // as SILENCE_DB, indistinguishable from a correct answer.
  if (grid.length < 2) return 0;
  if (v <= grid[0]) return 0;
  if (v >= grid[grid.length - 1]) return grid.length - 2;
  let lo = 0, hi = grid.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= v) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Does this azimuth grid cover the whole circle?
 *
 * Two shapes do. An OPEN grid stops one step short of where it started
 * (0..350, -180..170), because repeating the first sample would be redundant;
 * it leaves a seam that has to be bridged. A CLOSED grid carries both ends
 * (0..360, -180..180) and has no seam, but a 0-based one still needs the query
 * folded into its range, because atan2 hands us the entire negative half from
 * outside it.
 *
 * Getting only the open case right is not enough: a closed 0..360 grid then
 * clamps every negative azimuth to the first cell, which is the original
 * defect — the whole left hemisphere reading the on-axis level — surviving in
 * a different grid shape.
 *
 * A partial grid (-90..90) is not periodic at all and must keep clamping,
 * because there is genuinely no measurement out there to interpolate towards.
 */
function isFullCircle(az: number[]): boolean {
  const n = az.length;
  if (n < 2) return false;
  const span = az[n - 1] - az[0];
  if (span >= 360 - 1e-9) return true; // closed: no seam, but still periodic
  // The leftover gap should be one more step. Compare it with the step at the
  // ENDS, which is what the seam would actually be — the mean step is wrong on
  // a grid that is fine around the main axis and coarse behind, which is how a
  // hand-assembled dataset usually looks.
  const gap = 360 - span;
  const endStep = Math.max(az[1] - az[0], az[n - 1] - az[n - 2]);
  if (endStep <= 0) return false;
  return Math.abs(gap - endStep) <= endStep * 0.5 + 1e-6;
}

/** Bracketing samples and the fraction between them, wrapping if the grid does. */
function azBracket(az: number[], v: number): { i0: number; i1: number; t: number } {
  const n = az.length;
  if (n < 2) return { i0: 0, i1: 0, t: 0 };

  let a = v;
  const first = az[0], last = az[n - 1];
  if (isFullCircle(az)) {
    // Fold into [first, first + 360). Loops rather than a modulo: the argument
    // is almost always already in range or one turn out, and two float `%`
    // per receiver per source measured as half the cost of this function.
    while (a < first) a += 360;
    while (a >= first + 360) a -= 360;
    if (a > last) {
      // in the seam, between the last sample and the first one again. Only
      // reachable on an open grid; a closed one has last = first + 360.
      const width = first + 360 - last;
      return { i0: n - 1, i1: 0, t: width > 0 ? (a - last) / width : 0 };
    }
  }

  const i0 = lowerIndex(az, a);
  const i1 = Math.min(i0 + 1, n - 1);
  const a0 = az[i0], a1 = az[i1];
  const t = a1 > a0 ? Math.max(0, Math.min(1, (a - a0) / (a1 - a0))) : 0;
  return { i0, i1, t };
}

export function sliceBalloon(b: BalloonDataset, frequencyHz: number): BalloonSlice {
  const fs = b.frequenciesHz;
  const nAz = b.azimuthDeg.length;
  const nEl = b.elevationDeg.length;
  const data = new Float64Array(nAz * nEl * 2);

  let i0: number, i1: number, t: number;
  if (fs.length === 1) {
    i0 = 0; i1 = 0; t = 0;
  } else {
    i0 = lowerIndex(fs, frequencyHz);
    i1 = i0 + 1;
    const l0 = Math.log10(fs[i0]), l1 = Math.log10(fs[i1]);
    t = l1 > l0 ? (Math.log10(Math.max(frequencyHz, 1e-6)) - l0) / (l1 - l0) : 0;
    t = Math.max(0, Math.min(1, t));
  }

  for (let a = 0; a < nAz; a++) {
    for (let e = 0; e < nEl; e++) {
      const cell = a * nEl + e;
      const k0 = (i0 * nAz + a) * nEl + e;
      const k1 = (i1 * nAz + a) * nEl + e;
      const db = b.magnitudeDb[k0] * (1 - t) + b.magnitudeDb[k1] * t;
      // shortest-arc phase interpolation. Folded with a modulo, not stepped:
      // an imported balloon with unwrapped phase (thousands of degrees) made
      // the old `while (dp > 180) dp -= 360` loop run once per turn, and a
      // large enough value never finished at all.
      const dp = ((((b.phaseDeg[k1] - b.phaseDeg[k0] + 180) % 360) + 360) % 360) - 180;
      const ph = (b.phaseDeg[k0] + dp * t) * (Math.PI / 180);
      const mag = Math.pow(10, db / 20);
      data[cell * 2] = mag * Math.cos(ph);
      data[cell * 2 + 1] = mag * Math.sin(ph);
    }
  }
  return { az: [...b.azimuthDeg], el: [...b.elevationDeg], data };
}

/** Bilinear sample of a prepared slice. Writes [re, im] into `out`. */
export function sampleBalloon(
  s: BalloonSlice,
  azDeg: number,
  elDeg: number,
  out: Float64Array,
): void {
  const nEl = s.el.length;

  // Azimuth wraps when the grid goes all the way round; elevation never does,
  // because -90 and +90 are the poles rather than two sides of a seam.
  const { i0: ai, i1: ai1, t: ta } = azBracket(s.az, azDeg);

  const ei = lowerIndex(s.el, elDeg);
  const ei1 = Math.min(ei + 1, nEl - 1);
  const e0 = s.el[ei], e1 = s.el[ei1];
  const te = Math.max(0, Math.min(1, e1 > e0 ? (elDeg - e0) / (e1 - e0) : 0));

  const idx = (a: number, e: number) => (a * nEl + e) * 2;

  const i00 = idx(ai, ei), i01 = idx(ai, ei1), i10 = idx(ai1, ei), i11 = idx(ai1, ei1);
  const w00 = (1 - ta) * (1 - te), w01 = (1 - ta) * te, w10 = ta * (1 - te), w11 = ta * te;

  out[0] = s.data[i00] * w00 + s.data[i01] * w01 + s.data[i10] * w10 + s.data[i11] * w11;
  out[1] = s.data[i00 + 1] * w00 + s.data[i01 + 1] * w01 + s.data[i10 + 1] * w10 + s.data[i11 + 1] * w11;
}
