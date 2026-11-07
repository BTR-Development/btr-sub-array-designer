/**
 * BTR simulation engine — free-field coherent complex pressure summation.
 *
 * MODEL
 *   Every source is a point radiator with an optional directivity function.
 *   For a source i and a receiver at distance r:
 *
 *     a_i   = 10^((refSpl_i + level_i)/20) / r          (pressure, 1/r spreading)
 *     tau_i = r / c  +  delay_i                          (propagation + user delay)
 *     phi_i = -2*pi*f*tau_i                              (e^{j(wt - k r)} convention)
 *     D_i   = complex directivity gain in the source's own rotated frame
 *     p_i   = s_i * a_i * D_i * e^{j*phi_i}              (s_i = +-1 polarity)
 *
 *     p_tot = SUM p_i        <- COMPLEX sum, never a dB sum
 *     SPL   = 20*log10(|p_tot|)   with pressures already expressed re 20 uPa
 *
 * The 1/r law makes the level drop 20*log10(2) = 6.02 dB per doubling of
 * distance, and the complex sum makes two coherent equal sources add +6.02 dB
 * and two anti-phase sources cancel. Those are engine tests 1-3.
 */

import type { RadiatingElement } from '../speakers/schema';
import type { EngineSource, GridRequest, GridResult, PointResult, SourceContribution } from './types';
import { sliceBalloon, sampleBalloon, type BalloonSlice } from './balloon';

const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
/** Distance floor: keeps the 1/r singularity out of the grid. */
export const MIN_DISTANCE_M = 0.15;
/** SPL reported where the pressure is numerically zero. */
export const SILENCE_DB = -400;

/**
 * A source pre-resolved for one frequency: world position, orthonormal local
 * frame, linear amplitude, and (optionally) the cabinet's radiating elements.
 * Everything is plain numbers so the inner loop allocates nothing.
 */
export interface PreparedSource {
  id: string;
  x: number;
  y: number;
  z: number;
  /** front / right / up unit vectors of the cabinet's local frame */
  fx: number; fy: number; fz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
  /** linear pressure amplitude at 1 m, re 20 uPa */
  amp: number;
  delayS: number;
  sign: number;
  /** flattened elements: [ex, ey, ez, gain*sign, delayS] * n, or null for omni */
  elems: Float64Array | null;
  /** imported measured directivity, already collapsed to this frequency */
  balloon: BalloonSlice | null;
  /** 1 / |D_onaxis(f)| when the model normalises its own on-axis response */
  normFactor: number;
  /**
   * -1 for the mirror image that models rigid ground, +1 otherwise.
   *
   * The mirrored frame is an improper rotation, so the `up` it computes comes
   * out negated while `front` and `right` do not. The element path compensates
   * inside `flattenElements`; a balloon cannot, because it is sampled by angle
   * rather than by vector. Without this the image of an imported cabinet was
   * read off the wrong half of its own pattern in elevation.
   */
  elSign: number;
}

/**
 * How much boost `normaliseOnAxis` is allowed to invent, in dB.
 *
 * The flag models the preset EQ that flattens a cardioid's on-axis roll-off.
 * A real processor has finite boost; dividing by |D_onaxis| does not, and
 * |D_onaxis| = 2|sin kd| passes through zero at d = lambda/2. On axis the
 * numerator vanishes with it and the quotient stays sane, but OFF axis it does
 * not: a shipped cabinet predicted 172 dB at 90 degrees, thirty above its own
 * maximum, at a frequency one drag of the slider away.
 *
 * 12 dB is far more than the band ever legitimately asks for — a 0.4 m
 * cardioid needs about 11 dB at 20 Hz and a 0.975 m one needs none above
 * 28 Hz — so the cap changes nothing in normal use. Above the on-axis peak no
 * boost is applied at all, because there the response is falling into the
 * null for geometric reasons and lifting it would be inventing output the
 * driver does not have. Attenuation is left alone in both cases.
 */
const MAX_NORM_BOOST_DB = 12;
const MAX_NORM_FACTOR = Math.pow(10, MAX_NORM_BOOST_DB / 20);

/** front / right / up basis for a given yaw-pitch-roll, see core/types.ts. */
export function localFrame(azimuthDeg: number, elevationDeg: number, rollDeg: number) {
  const az = azimuthDeg * DEG;
  const el = elevationDeg * DEG;
  const sa = Math.sin(az), ca = Math.cos(az);
  const se = Math.sin(el), ce = Math.cos(el);

  const fx = sa * ce, fy = ca * ce, fz = se;
  let rx = ca, ry = -sa, rz = 0;
  // up = right x front
  let ux = ry * fz - rz * fy;
  let uy = rz * fx - rx * fz;
  let uz = rx * fy - ry * fx;

  if (rollDeg) {
    const ro = rollDeg * DEG;
    const cr = Math.cos(ro), sr = Math.sin(ro);
    const nrx = rx * cr + ux * sr, nry = ry * cr + uy * sr, nrz = rz * cr + uz * sr;
    const nux = ux * cr - rx * sr, nuy = uy * cr - ry * sr, nuz = uz * cr - rz * sr;
    rx = nrx; ry = nry; rz = nrz;
    ux = nux; uy = nuy; uz = nuz;
  }
  return { fx, fy, fz, rx, ry, rz, ux, uy, uz };
}

function flattenElements(elements: RadiatingElement[], mirrorZ: boolean): Float64Array {
  const out = new Float64Array(elements.length * 5);
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i];
    out[i * 5 + 0] = e.position.x;
    out[i * 5 + 1] = e.position.y;
    out[i * 5 + 2] = mirrorZ ? -e.position.z : e.position.z;
    out[i * 5 + 3] = e.gain * (e.invert ? -1 : 1);
    out[i * 5 + 4] = e.delayS;
  }
  return out;
}

/** On-axis complex magnitude of an element cluster, used for normalisation. */
function onAxisMagnitude(elems: Float64Array, f: number, c: number): number {
  const k = TWO_PI * f / c;
  let re = 0, im = 0;
  for (let i = 0; i < elems.length; i += 5) {
    // on axis => local unit direction is (0, 1, 0), so u . p = ey
    const phase = -TWO_PI * f * elems[i + 4] + k * elems[i + 1];
    const g = elems[i + 3];
    re += g * Math.cos(phase);
    im += g * Math.sin(phase);
  }
  return Math.hypot(re, im);
}

/**
 * Where the on-axis response of an element cluster first stops climbing, and
 * how much boost is allowed once it has.
 *
 * Below the peak, |D_onaxis| rising with frequency is the gradient roll-off a
 * preset EQ exists to flatten. Above it, any further rise is the far side of a
 * null and boosting into it invents output the driver does not have.
 *
 * `above` holds the factor at the value it reached at the peak rather than
 * snapping to unity, so the modelled EQ shelves instead of switching off. For
 * every cluster this project can build the two agree (a gradient peaks at
 * |D| = 2, so both give 1), but a cluster whose on-axis response never reaches
 * unity would otherwise take a step in level at the gate frequency.
 *
 * Cached because the answer depends only on the geometry and the speed of
 * sound, never on frequency — and `prepareSources` runs per frequency in the
 * response chart and per angle in the polar plot, both on the main thread.
 * Uncached, the 496-sample scan made the polar panel four times slower.
 */
const peakCache = new WeakMap<RadiatingElement[], Map<number, { hz: number; above: number }>>();

function onAxisGate(
  key: RadiatingElement[],
  elems: Float64Array,
  c: number,
): { hz: number; above: number } {
  let byC = peakCache.get(key);
  if (!byC) { byC = new Map(); peakCache.set(key, byC); }
  const hit = byC.get(c);
  if (hit) return hit;

  let prev = -Infinity;
  let hz = Infinity;
  for (let f = 5; f <= 500; f += 1) {
    const m = onAxisMagnitude(elems, f, c);
    if (m < prev) { hz = f - 1; break; }
    prev = m;
  }
  // `prev` is the magnitude at the peak when one was found. Never boost ABOVE
  // what was already being applied there; never attenuate more than 1/m would.
  const above = hz === Infinity ? MAX_NORM_FACTOR : Math.min(MAX_NORM_FACTOR, Math.max(1, 1 / prev));
  const val = { hz, above };
  byC.set(c, val);
  return val;
}

/**
 * Resolve sources for one frequency. `ground: 'rigid'` appends a mirror image
 * source below z = 0 for each real source (perfectly reflecting hard ground).
 */
export function prepareSources(
  sources: EngineSource[],
  frequencyHz: number,
  speedOfSound: number,
  ground: 'off' | 'rigid' = 'off',
): PreparedSource[] {
  const out: PreparedSource[] = [];
  for (const s of sources) {
    const base = makePrepared(s, frequencyHz, speedOfSound, false);
    out.push(base);
    if (ground === 'rigid') out.push(makePrepared(s, frequencyHz, speedOfSound, true));
  }
  return out;
}

function makePrepared(
  s: EngineSource,
  f: number,
  c: number,
  mirror: boolean,
): PreparedSource {
  const fr = localFrame(s.azimuthDeg, mirror ? -s.elevationDeg : s.elevationDeg, mirror ? -s.rollDeg : s.rollDeg);
  const elems = s.elements && s.elements.length ? flattenElements(s.elements, mirror) : null;
  let normFactor = 1;
  if (elems && s.normaliseOnAxis) {
    const m = onAxisMagnitude(elems, f, c);
    // Bound the BOOST, not the divisor: clamping `m` still let the quotient run
    // away off axis, because only the numerator vanishes there.
    //
    // And boost only where there is a roll-off to flatten. The on-axis response
    // of a gradient climbs out of zero, peaks, then dives into the lambda/2
    // null; a preset EQ lifts the climb, it does not chase the hole.
    //
    // This has to be decided against the FIRST peak, not against the local
    // slope: |D| is a magnitude, so it turns and rises again on the far side of
    // the null, and a one-step slope test reads that as a roll-off to correct.
    const gate = onAxisGate(s.elements!, elems, c);
    const cap = f < gate.hz ? MAX_NORM_FACTOR : gate.above;
    normFactor = m > 0 ? Math.min(cap, 1 / m) : cap;
  }
  // The radiating point, not the handle. `o` is given in the cabinet's local
  // frame, so it turns with the cabinet: azimuth 180 moves the origin from the
  // front of the box to the back of it.
  //
  // The mirrored frame that models rigid ground is an improper rotation, so its
  // computed `up` comes out negated (see flattenElements, which compensates the
  // same way). Negating the local z restores the true reflection.
  const o = s.originOffset;
  const oz = o ? (mirror ? -o.z : o.z) : 0;
  const ox = o ? o.x : 0;
  const oy = o ? o.y : 0;
  const wx = ox * fr.rx + oy * fr.fx + oz * fr.ux;
  const wy = ox * fr.ry + oy * fr.fy + oz * fr.uy;
  const wz = ox * fr.rz + oy * fr.fz + oz * fr.uz;

  return {
    id: mirror ? `${s.id}#img` : s.id,
    x: s.position.x + wx,
    y: s.position.y + wy,
    z: (mirror ? -s.position.z : s.position.z) + wz,
    ...fr,
    amp: Math.pow(10, (s.refSplDb + s.levelDb) / 20),
    delayS: s.delayS,
    sign: s.invertPolarity ? -1 : 1,
    elems,
    balloon: s.balloon ? sliceBalloon(s.balloon, f) : null,
    normFactor,
    elSign: mirror ? -1 : 1,
  };
}

/**
 * Complex directivity of one prepared source toward a unit direction given in
 * WORLD coordinates. Writes [re, im] into `out` to avoid allocating.
 */
function directivity(
  p: PreparedSource,
  dx: number, dy: number, dz: number, // unit vector, source -> receiver
  f: number, c: number,
  out: Float64Array,
): void {
  const elems = p.elems;
  if (!elems && !p.balloon) { out[0] = 1; out[1] = 0; return; }

  // direction expressed in the cabinet's local frame (x=right, y=front, z=up)
  const lr = dx * p.rx + dy * p.ry + dz * p.rz;
  const lf = dx * p.fx + dy * p.fy + dz * p.fz;
  const lu = dx * p.ux + dy * p.uy + dz * p.uz;

  if (p.balloon) {
    const azDeg = (Math.atan2(lr, lf) * 180) / Math.PI;
    // elSign undoes the negated `up` of the mirrored frame, so the ground image
    // reads the same half of the pattern the real reflection would. Azimuth
    // needs no such correction: `right` and `front` mirror properly.
    const elDeg = (p.elSign * Math.asin(Math.max(-1, Math.min(1, lu))) * 180) / Math.PI;
    sampleBalloon(p.balloon, azDeg, elDeg, out);
    return;
  }
  if (!elems) { out[0] = 1; out[1] = 0; return; }

  const k = TWO_PI * f / c;
  let re = 0, im = 0;
  for (let i = 0; i < elems.length; i += 5) {
    const dot = lr * elems[i] + lf * elems[i + 1] + lu * elems[i + 2];
    const phase = -TWO_PI * f * elems[i + 4] + k * dot;
    const g = elems[i + 3];
    re += g * Math.cos(phase);
    im += g * Math.sin(phase);
  }
  out[0] = re * p.normFactor;
  out[1] = im * p.normFactor;
}

/** Complex pressure at one receiver. Writes [re, im] into `out`. */
export function pressureAt(
  prepared: PreparedSource[],
  rx: number, ry: number, rz: number,
  f: number, c: number,
  out: Float64Array,
  scratch: Float64Array,
): void {
  let sumRe = 0, sumIm = 0;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const dx = rx - p.x, dy = ry - p.y, dz = rz - p.z;
    let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < MIN_DISTANCE_M) r = MIN_DISTANCE_M;
    const inv = 1 / r;

    directivity(p, dx * inv, dy * inv, dz * inv, f, c, scratch);

    const a = p.amp * inv * p.sign;
    const phase = -TWO_PI * f * (r / c + p.delayS);
    const cp = Math.cos(phase), sp = Math.sin(phase);
    // (scratch) * e^{j phase} * a
    sumRe += a * (scratch[0] * cp - scratch[1] * sp);
    sumIm += a * (scratch[0] * sp + scratch[1] * cp);
  }
  out[0] = sumRe;
  out[1] = sumIm;
}

export function toDb(re: number, im: number): number {
  const mag = Math.hypot(re, im);
  return mag > 0 ? 20 * Math.log10(mag) : SILENCE_DB;
}

export function wrapDeg(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/**
 * Largest distance across the array, used to guess how fine the interference
 * comb is: two sources D apart produce nulls spaced c/D apart in frequency.
 * The bounding-box diagonal rather than the true pairwise maximum, because it
 * is O(n), never underestimates, and this only sets a sampling density.
 */
export function sourceSpreadM(sources: EngineSource[]): number {
  if (sources.length < 2) return 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const s of sources) {
    const p = s.position;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  return Math.hypot(x1 - x0, y1 - y0, z1 - z0);
}

/**
 * The frequencies a band-averaged map is evaluated at.
 *
 * WHY THIS EXISTS AT ALL. A map drawn at one frequency shows deep interference
 * nulls that no programme material ever produces: the null at 63 Hz sits
 * somewhere else at 60 Hz, and music occupies the whole band at once. An
 * engineer reading a single-tone map moves cabinets to chase an artefact of the
 * analysis. Averaging POWER across the band is what the ear and a real
 * measurement both do.
 *
 * Power, not pressure, and not dB: incoherent energy summation across
 * frequency, `Lp = 10 log10( mean(|p|^2) )`. Averaging the dB values instead
 * would let a single deep null drag the mean down by tens of dB.
 *
 * HOW MANY POINTS. Enough to resolve the comb, and no more, because every point
 * is another full solve of the grid. Nulls repeat every `c / spread` hertz, so
 * the count follows from how wide the band is in comparison. A 16-cabinet line
 * 22 m across combs every 15.6 Hz; a third octave at 63 Hz is 14.6 Hz wide, so
 * a handful of points covers it, while the same band at 200 Hz spans three
 * comb periods and needs more. Odd, so the nominal centre frequency is always
 * one of the points actually evaluated.
 */
export function bandFrequencies(
  centreHz: number,
  bandOct: number,
  opts: { spreadM?: number; speedOfSound?: number; points?: number } = {},
): number[] {
  if (!(bandOct > 0) || !(centreHz > 0)) return [centreHz];

  const lo = centreHz * Math.pow(2, -bandOct / 2);
  const hi = centreHz * Math.pow(2, bandOct / 2);

  let n = opts.points ?? 0;
  if (!(n > 0)) {
    const spread = opts.spreadM ?? 0;
    const c = opts.speedOfSound ?? 343;
    // 4 samples per comb period; a single source has no comb to resolve.
    const combHz = spread > 0 ? c / spread : Infinity;
    n = Math.ceil((4 * (hi - lo)) / combHz) + 1;
  }
  n = Math.max(5, Math.min(33, n));
  if (n % 2 === 0) n += 1;

  const ratio = hi / lo;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = lo * Math.pow(ratio, i / (n - 1));
  return out;
}

/** Power-averaged level, from summed |p|^2 and the number of terms. */
function bandDb(power: number, terms: number): number {
  if (!(power > 0) || terms < 1) return SILENCE_DB;
  return 10 * Math.log10(power / terms);
}

/** Full prediction grid. This is the function the Web Worker calls. */
export function computeGrid(req: GridRequest): GridResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const { nx, nv, xMin, xMax, vMin, vMax, frequencyHz: fc, speedOfSound: c } = req;

  // One frequency when no band is asked for, so the single-tone path stays the
  // same solve it always was.
  const freqs = bandFrequencies(fc, req.bandOct ?? 0, {
    spreadM: sourceSpreadM(req.sources),
    speedOfSound: c,
    points: req.bandPoints,
  });

  const cells = nx * nv;
  // |p|^2 accumulated across the band. Float64: summing many squared pressures
  // at 1e-2..1e2 in Float32 loses the quiet ones.
  const power = new Float64Array(cells);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);

  const dx = nx > 1 ? (xMax - xMin) / (nx - 1) : 0;
  const dv = nv > 1 ? (vMax - vMin) / (nv - 1) : 0;
  const top = req.plane === 'top';

  // Frequency OUTSIDE the grid loop: prepareSources resolves balloon slices and
  // element phases per frequency, so hoisting it saves that work per cell.
  for (let fi = 0; fi < freqs.length; fi++) {
    const f = freqs[fi];
    const prepared = prepareSources(req.sources, f, c, req.ground);
    for (let j = 0; j < nv; j++) {
      const v = vMin + j * dv;
      const rowOff = j * nx;
      for (let i = 0; i < nx; i++) {
        // The grid's two axes are the plane's own: X/Y on top, Y/Z on side. The
        // side view is a section along the room, so its horizontal axis is depth
        // and the fixed coordinate is X.
        const h = xMin + i * dx;
        const rx = top ? h : req.planeOffset;
        const ry = top ? v : h;
        const rz = top ? req.planeOffset : v;
        pressureAt(prepared, rx, ry, rz, f, c, out, scratch);
        power[rowOff + i] += out[0] * out[0] + out[1] * out[1];
      }
    }
  }

  const spl = new Float32Array(cells);

  // Real sources only — a ground image sits at the mirrored height and must not
  // push the exclusion zone around.
  const real = req.sources;
  const excl = req.nearFieldExclusionM ?? 2;
  const exclSq = excl * excl;

  let maxDb = -Infinity;
  let refDb = -Infinity;
  let minDb = Infinity;

  for (let j = 0; j < nv; j++) {
    const v = vMin + j * dv;
    const rowOff = j * nx;
    for (let i = 0; i < nx; i++) {
      const idx = rowOff + i;
      const db = bandDb(power[idx], freqs.length);
      spl[idx] = db;
      if (db > maxDb) maxDb = db;
      if (db < minDb) minDb = db;

      if (db > refDb && excl > 0) {
        const h = xMin + i * dx;
        const rx = top ? h : req.planeOffset;
        const ry = top ? v : h;
        const rz = top ? req.planeOffset : v;
        let clear = true;
        for (let k = 0; k < real.length; k++) {
          const p = real[k].position;
          const ddx = rx - p.x, ddy = ry - p.y, ddz = rz - p.z;
          if (ddx * ddx + ddy * ddy + ddz * ddz < exclSq) { clear = false; break; }
        }
        if (clear) refDb = db;
      }
    }
  }

  if (!isFinite(maxDb)) { maxDb = 0; minDb = 0; }
  if (!isFinite(refDb)) refDb = maxDb;

  return {
    nx, nv, xMin, xMax, vMin, vMax,
    spl,
    maxDb,
    refDb,
    minDb,
    bandPoints: freqs.length,
    computeMs: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0,
  };
}

/** Detailed single-point evaluation, including per-source breakdown (debug panel). */
export function computePoint(
  sources: EngineSource[],
  receiver: { x: number; y: number; z: number },
  frequencyHz: number,
  speedOfSound: number,
  ground: 'off' | 'rigid' = 'off',
): PointResult {
  const prepared = prepareSources(sources, frequencyHz, speedOfSound, ground);
  const scratch = new Float64Array(2);
  const contributions: SourceContribution[] = [];
  let sumRe = 0, sumIm = 0;

  for (const p of prepared) {
    const dx = receiver.x - p.x, dy = receiver.y - p.y, dz = receiver.z - p.z;
    let r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (r < MIN_DISTANCE_M) r = MIN_DISTANCE_M;
    const inv = 1 / r;
    directivity(p, dx * inv, dy * inv, dz * inv, frequencyHz, speedOfSound, scratch);

    const a = p.amp * inv * p.sign;
    const propagation = r / speedOfSound;
    const totalDelay = propagation + p.delayS;
    const phase = -TWO_PI * frequencyHz * totalDelay;
    const cp = Math.cos(phase), sp = Math.sin(phase);
    const re = a * (scratch[0] * cp - scratch[1] * sp);
    const im = a * (scratch[0] * sp + scratch[1] * cp);
    sumRe += re;
    sumIm += im;

    const dGain = Math.hypot(scratch[0], scratch[1]);
    contributions.push({
      sourceId: p.id,
      distanceM: r,
      propagationDelayS: propagation,
      sourceDelayS: p.delayS,
      totalDelayS: totalDelay,
      phaseDeg: wrapDeg((Math.atan2(im, re) * 180) / Math.PI),
      magnitudeDb: toDb(re, im),
      directivityGainDb: dGain > 0 ? 20 * Math.log10(dGain) : SILENCE_DB,
      re,
      im,
    });
  }

  return {
    splDb: toDb(sumRe, sumIm),
    phaseDeg: wrapDeg((Math.atan2(sumIm, sumRe) * 180) / Math.PI),
    re: sumRe,
    im: sumIm,
    contributions,
  };
}

/** Summed magnitude response at one point over a list of frequencies. */
export function computeSpectrum(
  sources: EngineSource[],
  receiver: { x: number; y: number; z: number },
  frequencies: number[],
  speedOfSound: number,
  ground: 'off' | 'rigid' = 'off',
): Float32Array {
  const res = new Float32Array(frequencies.length);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i];
    const prepared = prepareSources(sources, f, speedOfSound, ground);
    pressureAt(prepared, receiver.x, receiver.y, receiver.z, f, speedOfSound, out, scratch);
    res[i] = toDb(out[0], out[1]);
  }
  return res;
}

/**
 * Summed magnitude AND phase at one point over a list of frequencies.
 *
 * The phase is returned unwrapped, because a sub array's phase falls through
 * many turns across 20–200 Hz and a wrapped trace is a picket fence that shows
 * nothing. Unwrapping needs a fine enough frequency step that consecutive bins
 * are less than half a turn apart — the response chart's log axis satisfies
 * that comfortably at these frequencies.
 */
export function computeSpectrumComplex(
  sources: EngineSource[],
  receiver: { x: number; y: number; z: number },
  frequencies: number[],
  speedOfSound: number,
  ground: 'off' | 'rigid' = 'off',
): { db: Float32Array; phaseDeg: Float32Array } {
  const db = new Float32Array(frequencies.length);
  const phaseDeg = new Float32Array(frequencies.length);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  let turns = 0;
  let prev = 0;

  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i];
    const prepared = prepareSources(sources, f, speedOfSound, ground);
    pressureAt(prepared, receiver.x, receiver.y, receiver.z, f, speedOfSound, out, scratch);
    db[i] = toDb(out[0], out[1]);

    const raw = (Math.atan2(out[1], out[0]) * 180) / Math.PI;
    if (i > 0) {
      const step = raw - prev;
      if (step > 180) turns -= 1;
      else if (step < -180) turns += 1;
    }
    prev = raw;
    phaseDeg[i] = raw + turns * 360;
  }
  return { db, phaseDeg };
}

/** Logarithmically spaced frequency axis, used by the response chart. */
export function logFrequencies(minHz: number, maxHz: number, count: number): number[] {
  const a = Math.log10(minHz), b = Math.log10(maxHz);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.pow(10, a + ((b - a) * i) / (count - 1)));
  return out;
}

/**
 * Power-averaged level at one receiver, over the same frequencies the map uses.
 *
 * Exists so the cursor readout cannot disagree with the picture behind it: with
 * band averaging on, a map cell and the number next to it have to be the same
 * quantity. Phase is deliberately not returned — the phase of a power average
 * is not defined, and a plausible-looking angle here would be a lie.
 */
export function computeBandLevel(
  sources: EngineSource[],
  receiver: { x: number; y: number; z: number },
  centreHz: number,
  bandOct: number,
  speedOfSound: number,
  ground: 'off' | 'rigid' = 'off',
): { splDb: number; points: number; loHz: number; hiHz: number } {
  const freqs = bandFrequencies(centreHz, bandOct, {
    spreadM: sourceSpreadM(sources),
    speedOfSound,
    points: undefined,
  });
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  let power = 0;

  for (const f of freqs) {
    const prepared = prepareSources(sources, f, speedOfSound, ground);
    pressureAt(prepared, receiver.x, receiver.y, receiver.z, f, speedOfSound, out, scratch);
    power += out[0] * out[0] + out[1] * out[1];
  }

  return {
    splDb: bandDb(power, freqs.length),
    points: freqs.length,
    loHz: freqs[0],
    hiHz: freqs[freqs.length - 1],
  };
}
