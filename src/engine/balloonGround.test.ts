/**
 * The four sampling and normalisation defects the September audit measured,
 * pinned so they cannot come back.
 *
 * Each one produced a plausible-looking number rather than an error, which is
 * why none of them had a test: an omnidirectional left hemisphere, a silent
 * region overhead, a ground reflection off the wrong half of the pattern, and
 * a cabinet predicting thirty decibels above its own maximum. The assertions
 * below are written against physics that can be derived independently of this
 * engine, not against whatever it happens to output today.
 */
import { describe, expect, it } from 'vitest';
import { prepareSources, pressureAt, toDb } from './engine';
import { sampleBalloon, sliceBalloon } from './balloon';
import type { EngineSource } from './types';
import type { BalloonDataset } from '../speakers/schema';
import { BUILTIN_SPEAKERS, } from '../speakers/library';
import { acousticOrigin } from '../speakers/schema';

const C = 343;
const F = 63;

function balloonOf(az: number[], el: number[], magDb: (a: number, e: number) => number): BalloonDataset {
  const mag = new Float32Array(az.length * el.length);
  for (let a = 0; a < az.length; a++) {
    for (let e = 0; e < el.length; e++) mag[a * el.length + e] = magDb(az[a], el[e]);
  }
  return {
    kind: 'balloon',
    frequenciesHz: [F],
    azimuthDeg: az,
    elevationDeg: el,
    magnitudeDb: mag,
    phaseDeg: new Float32Array(mag.length),
  };
}

const source = (balloon: BalloonDataset, z = 1): EngineSource => ({
  id: 'b', position: { x: 0, y: 0, z },
  azimuthDeg: 0, elevationDeg: 0, rollDeg: 0,
  levelDb: 0, delayS: 0, invertPolarity: false, refSplDb: 130,
  elements: null, normaliseOnAxis: false, balloon,
});

function spl(sources: EngineSource[], ground: 'off' | 'rigid', x: number, y: number, z: number, f = F) {
  const prep = prepareSources(sources, f, C, ground);
  const out = new Float64Array(2), scratch = new Float64Array(2);
  pressureAt(prep, x, y, z, f, C, out, scratch);
  return toDb(out[0], out[1]);
}

const STEP10 = (from: number, to: number) => {
  const g: number[] = [];
  for (let v = from; v <= to + 1e-9; v += 10) g.push(v);
  return g;
};

describe('balloon azimuth wraps when the grid goes round', () => {
  // 0..350 is how measurement software exports a full circle: the last sample
  // is one step short of the first, because repeating it would be redundant.
  const az = STEP10(0, 350);
  // -12 dB over the left half, 0 dB over the right
  const sided = balloonOf(az, [0], (a) => (a > 180 ? -12 : 0));

  it('reads the left hemisphere from the left of the pattern', () => {
    // The defect: lowerIndex clamped instead of wrapping, so every negative
    // azimuth fell back to the first grid cell and the whole left side came
    // back at the on-axis level. For a cardioid that deleted the rear
    // rejection down one side with nothing on screen to say so.
    const right = spl([source(sided)], 'off', 20, 0, 1);
    const left = spl([source(sided)], 'off', -20, 0, 1);
    expect(right - left).toBeCloseTo(12, 1);
  });

  it('interpolates across the seam instead of stepping at it', () => {
    // 355 degrees sits between the last sample and the first one again. A
    // clamp returns the endpoint; a wrap returns the midpoint.
    const ramp = balloonOf(az, [0], (a) => (a === 350 ? -20 : 0));
    const s = sliceBalloon(ramp, F);
    const out = new Float64Array(2);

    sampleBalloon(s, 350, 0, out);
    const at350 = 20 * Math.log10(Math.hypot(out[0], out[1]));
    sampleBalloon(s, 355, 0, out);
    const at355 = 20 * Math.log10(Math.hypot(out[0], out[1]));
    sampleBalloon(s, 0, 0, out);
    const at360 = 20 * Math.log10(Math.hypot(out[0], out[1]));

    expect(at350).toBeCloseTo(-20, 6);
    expect(at360).toBeCloseTo(0, 6);
    // halfway across the seam in linear magnitude, i.e. between the two cells
    expect(at355).toBeGreaterThan(at350 + 3);
    expect(at355).toBeLessThan(at360);
  });

  it('still clamps a grid that does not go round', () => {
    // -90..90 is a genuine half-sphere measurement. There is nothing out at
    // 150 degrees to interpolate towards, so holding the edge is the honest
    // answer and wrapping would fabricate a pattern.
    const half = balloonOf(STEP10(-90, 90), [0], (a) => (a >= 90 ? -20 : 0));
    const s = sliceBalloon(half, F);
    const out = new Float64Array(2);
    sampleBalloon(s, 150, 0, out);
    expect(20 * Math.log10(Math.hypot(out[0], out[1]))).toBeCloseTo(-20, 6);
  });

  it('handles a closed grid, whichever end it starts from', () => {
    // A -180..180 grid clamps correctly even with the wrap removed, so on its
    // own it proves nothing. 0..360 is the case that matters: the same full
    // circle, written with the redundant endpoint and starting at zero, so
    // atan2's whole negative half lands outside the grid and a clamp sends it
    // to the on-axis cell. That is the original defect in a different grid
    // shape, and the first version of this fix still had it.
    const sided = (a: number) => {
      const x = ((a % 360) + 360) % 360;
      return x > 180 ? -12 : 0;
    };
    for (const az of [STEP10(-180, 180), STEP10(0, 360)]) {
      const b = balloonOf(az, [0], sided);
      const right = spl([source(b)], 'off', 20, 0, 1);
      const left = spl([source(b)], 'off', -20, 0, 1);
      expect(right - left, `grid ${az[0]}..${az[az.length - 1]}`).toBeCloseTo(12, 1);
    }
  });

  it('recognises a full circle whose steps are not uniform', () => {
    // Fine around the main axis and coarse behind, which is how a
    // hand-assembled or digitised dataset usually looks. Testing the leftover
    // gap against the MEAN step calls this aperiodic and the left hemisphere
    // collapses again; the gap has to be compared with the step at the ends.
    // 5 degrees within 20 of the main axis, 15 elsewhere. The proportions
    // matter: with a WIDER fine region the mean step happens to land close
    // enough to the seam gap that the mean test also passes, and the test
    // stops discriminating. Here mean = 13.2 against a 5 degree gap, so only
    // comparing against the end step gets it right.
    const az: number[] = [];
    for (let a = 0; a < 360; a += a < 20 || a > 340 ? 5 : 15) az.push(a);
    const b = balloonOf(az, [0], (a) => (a > 180 ? -12 : 0));
    const right = spl([source(b)], 'off', 20, 0, 1);
    const left = spl([source(b)], 'off', -20, 0, 1);
    expect(right - left).toBeCloseTo(12, 1);
  });
});

describe('balloon with a single elevation', () => {
  // The importer explicitly endorses this: "only one elevation is present, so
  // the pattern is treated as constant with elevation."
  //
  // The pattern must VARY with azimuth for these to mean anything. With a
  // uniform balloon the defect is invisible: reading the neighbouring cell
  // returns the same number, and the test passes while the bug is present.
  const az = STEP10(0, 350);
  const sided = balloonOf(az, [0], (a) => (a > 180 ? -12 : 0));

  it('is constant with elevation rather than reading the wrong azimuth', () => {
    // The defect: lowerIndex returned length - 2 = -1 for a one-sample axis.
    // At that index the sampler read the PREVIOUS azimuth's cell, so a
    // receiver above the cabinet got a pattern rotated by one grid step.
    const onPlane = spl([source(sided)], 'off', -20, 0, 1); // left, elevation 0
    for (const z of [1, 6, 20, 60]) {
      const raised = spl([source(sided)], 'off', -20, 0, z);
      const slant = Math.hypot(20, z - 1);
      expect(raised).toBeCloseTo(onPlane - 20 * Math.log10(slant / 20), 6);
    }
  });

  it('does not read off the front of the slab at the first azimuth cell', () => {
    // At azimuth 0 the wrong index is -2, which is undefined rather than a
    // neighbouring cell: the result is NaN, and NaN reaches the user as
    // SILENCE_DB — a dead region overhead, indistinguishable from a real null.
    for (const z of [1, 10, 50]) {
      const v = spl([source(sided)], 'off', 0, 20, z);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(-100);
    }
  });

  it('samples a one-sample axis without reading outside the slab', () => {
    const s = sliceBalloon(balloonOf(az, [0], () => 0), F);
    const out = new Float64Array(2);
    for (const el of [-90, -30, 0, 30, 90]) {
      for (const a of [0, 5, 95, 185, 355]) {
        sampleBalloon(s, a, el, out);
        expect(Number.isNaN(out[0]), `az ${a}, el ${el}`).toBe(false);
        expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('the rigid-ground image of a balloon', () => {
  // Vertically asymmetric, which is what a real sub balloon is and precisely
  // the case worth importing: 0.08 dB per degree, 14.4 dB top to bottom.
  const tilted = balloonOf(STEP10(-180, 180), STEP10(-90, 90), (_a, e) => -0.08 * e);

  it('matches the exact image-source answer', () => {
    // A rigid plane at z = 0 is equivalent to the real cabinet radiating both
    // to the receiver and to the receiver's mirror image. Computing it that
    // way uses no mirrored frame at all, so it is an independent check.
    const H = 4, RY = 20, RZ = 1.6;
    const engine = spl([source(tilted, H)], 'rigid', 0, RY, RZ);

    const free = prepareSources([source(tilted, H)], F, C, 'off');
    const a = new Float64Array(2), b = new Float64Array(2), scratch = new Float64Array(2);
    pressureAt(free, 0, RY, RZ, F, C, a, scratch);
    pressureAt(free, 0, RY, -RZ, F, C, b, scratch);
    const exact = toDb(a[0] + b[0], a[1] + b[1]);

    expect(engine).toBeCloseTo(exact, 9);
  });

  it('gives the image the opposite up vector, as a reflection must', () => {
    const prep = prepareSources([source(tilted, 4)], F, C, 'rigid');
    expect(prep).toHaveLength(2);
    expect(prep[1].z).toBeCloseTo(-prep[0].z, 9);
    expect(prep[1].elSign).toBe(-prep[0].elSign);
  });

  it('is exact for a flat balloon either way, so the check is about elevation', () => {
    const flat = balloonOf(STEP10(-180, 180), STEP10(-90, 90), () => 0);
    const H = 4, RY = 20, RZ = 1.6;
    const engine = spl([source(flat, H)], 'rigid', 0, RY, RZ);
    const free = prepareSources([source(flat, H)], F, C, 'off');
    const a = new Float64Array(2), b = new Float64Array(2), scratch = new Float64Array(2);
    pressureAt(free, 0, RY, RZ, F, C, a, scratch);
    pressureAt(free, 0, RY, -RZ, F, C, b, scratch);
    expect(engine).toBeCloseTo(toDb(a[0] + b[0], a[1] + b[1]), 9);
  });
});

describe('on-axis normalisation cannot invent output', () => {
  const model = BUILTIN_SPEAKERS.find((m) => m.id === 'db-sl-sub')!;
  const pd = model.predictionData;
  if (pd.kind !== 'elements') throw new Error('db-sl-sub is expected to be an element model');
  const elements = pd.elements;
  const DEPTH = model.dimensions.depthM!;
  const NOTCH = C / (2 * DEPTH); // 175.9 Hz, and the slider steps 0.5 Hz

  const cabinet = (): EngineSource => ({
    id: 'a', position: { x: 0, y: 0, z: 1 },
    azimuthDeg: 0, elevationDeg: 0, rollDeg: 0,
    levelDb: 0, delayS: 0, invertPolarity: false,
    refSplDb: model.maxSpl ?? 130,
    elements, normaliseOnAxis: true, originOffset: acousticOrigin(model),
  });

  it('never exceeds what the cabinet can physically radiate', () => {
    // The defect: normFactor was 1 / |D_onaxis|, and |D_onaxis| = 2|sin kd|
    // passes through zero at d = lambda/2. On axis the numerator vanished with
    // it; off axis it did not, so the model predicted 172.7 dB at 20 m from a
    // cabinet rated 144 dB at 1 m — thirty above its own maximum, at a
    // frequency one drag of the slider away.
    //
    // The ceiling is derived, not tuned. Above the gate the normalisation can
    // no longer boost, so the directivity cannot exceed the sum of the element
    // gains — that is the most a coherent cluster can add in any direction —
    // and the level is that, spread over the shortest path to the ring.
    //
    // The first version of this test used a hand-waved "+6 dB off axis" and a
    // +0.1 fudge, and the real worst case sat 0.07 dB the wrong side of it at
    // azimuths the loop did not sample. Sweep the whole circle instead.
    const sumGain = elements.reduce((t, e) => t + Math.abs(e.gain ?? 1), 0);
    const R = 20;
    // Not 20 m: the cabinet radiates from its baffle, so its acoustic origin
    // sits forward of the position the ring is drawn around and the nearest
    // point of that ring is closer than R. Using R flat put the ceiling
    // 0.04 dB under a legitimate reading.
    const o = acousticOrigin(model);
    const nearest = R - Math.hypot(o.x, o.y, o.z);
    const ceiling = (model.maxSpl ?? 130) - 20 * Math.log10(nearest) + 20 * Math.log10(sumGain);

    let worst = -Infinity, worstAt = 0, worstAz = 0;
    for (let f = 20; f <= 200; f += 0.5) {
      for (let a = 0; a < 360; a += 5) {
        const rad = (a * Math.PI) / 180;
        const v = spl([cabinet()], 'off', R * Math.sin(rad), R * Math.cos(rad), 1, f);
        if (v > worst) { worst = v; worstAt = f; worstAz = a; }
      }
    }
    expect(worst, `worst ${worst.toFixed(2)} dB at ${worstAt} Hz, az ${worstAz}`).toBeLessThanOrEqual(ceiling);
  });

  it('leaves the genuine on-axis null alone', () => {
    // The null at lambda/2 is what a gradient with a d/c delay does. Bounding
    // the EQ must not paper over it, or the fix would be hiding the physics
    // rather than the artefact.
    const onNotch = spl([cabinet()], 'off', 0, 20, 1, Math.round(NOTCH * 2) / 2);
    const inBand = spl([cabinet()], 'off', 0, 20, 1, 63);
    expect(inBand - onNotch).toBeGreaterThan(20);
  });

  it('still flattens the low-frequency roll-off it exists for', () => {
    // Below the first on-axis peak the boost is the whole point. Without
    // normalisation a gradient loses 6 dB per octave downwards; with it the
    // response should be far flatter across the band the cabinet works in.
    const level = (f: number, norm: boolean) =>
      spl([{ ...cabinet(), normaliseOnAxis: norm }], 'off', 0, 20, 1, f);

    const spreadOn = level(80, true) - level(32, true);
    const spreadOff = level(80, false) - level(32, false);
    expect(spreadOn).toBeLessThan(spreadOff);
    expect(Math.abs(spreadOn)).toBeLessThan(Math.abs(spreadOff));
  });
});
