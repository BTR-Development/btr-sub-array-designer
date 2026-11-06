import { describe, it, expect } from 'vitest';
import { polarResponse, polarDirection, farFieldRadius } from './polar';
import { positionsFromSpacing, steeringDelays } from './steering';
import { analyticCardioidDataset } from '../speakers/schema';
import type { EngineSource } from './types';

const C = 343;

function omni(over: Partial<EngineSource> = {}): EngineSource {
  return {
    id: 's', position: { x: 0, y: 0, z: 0 },
    azimuthDeg: 0, elevationDeg: 0, rollDeg: 0,
    levelDb: 0, delayS: 0, invertPolarity: false,
    refSplDb: 130, elements: null, normaliseOnAxis: false,
    ...over,
  };
}

/**
 * Peak angle within the forward half-plane.
 *
 * A broadside line of omni cabinets radiates identically forward and backward, so
 * the global maximum is genuinely ambiguous and float noise decides which of the
 * two it reports. Aiming is a forward-hemisphere question, so ask that question.
 */
function frontPeak(r: ReturnType<typeof polarResponse>, i = 0) {
  let best = -Infinity;
  let bestA = 0;
  r.anglesDeg.forEach((a, k) => {
    if (Math.abs(a) > 90) return;
    if (r.traces[i].db[k] > best) { best = r.traces[i].db[k]; bestA = a; }
  });
  return bestA;
}

/** Level of a trace at a given angle, in dB below its own peak. */
function at(r: ReturnType<typeof polarResponse>, angleDeg: number, i = 0) {
  const idx = r.anglesDeg.reduce(
    (best, a, k) => (Math.abs(a - angleDeg) < Math.abs(r.anglesDeg[best] - angleDeg) ? k : best),
    0,
  );
  return r.traces[i].db[idx];
}

describe('angle convention', () => {
  it('matches the app azimuth: 0 deg is the front, +90 is to the right', () => {
    expect(polarDirection(0, 'horizontal').map((v) => Math.round(v))).toEqual([0, 1, 0]);
    expect(polarDirection(90, 'horizontal').map((v) => Math.round(v))).toEqual([1, 0, 0]);
    expect(polarDirection(180, 'horizontal').map((v) => Math.round(v))).toEqual([0, -1, 0]);
  });

  it('uses +Y forward and +Z up in the vertical plane', () => {
    // The vertical plane is the elevation cut through the SAME on-axis
    // direction as the horizontal one, which is what makes it the section the
    // side view draws.
    expect(polarDirection(0, 'vertical').map((v) => Math.round(v))).toEqual([0, 1, 0]);
    expect(polarDirection(90, 'vertical').map((v) => Math.round(v))).toEqual([0, 0, 1]);
  });
});

describe('far-field radius', () => {
  it('scales with the array and never gets close in', () => {
    expect(farFieldRadius([omni()])).toBe(60);
    const wide = positionsFromSpacing(16, 1.5).map((x) => omni({ position: { x, y: 0, z: 0 } }));
    expect(farFieldRadius(wide)).toBeGreaterThan(22.5 * 30);
  });
});

describe('polar response', () => {
  it('a single omni source is a circle', () => {
    const r = polarResponse({ sources: [omni()], frequencies: [63], speedOfSound: C });
    const vals = [...r.traces[0].db];
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(0.01);
  });

  it('normalises each trace to its own peak', () => {
    const r = polarResponse({ sources: [omni()], frequencies: [40, 63, 100], speedOfSound: C });
    for (const t of r.traces) {
      expect(Math.max(...t.db)).toBeCloseTo(0, 4); // Float32 grid
      expect(t.peakDb).toBeGreaterThan(60); // the real level is kept alongside
    }
  });

  it('a broadside line beams forward and backward, and pinches at the sides', () => {
    const sources = positionsFromSpacing(8, 1.5).map((x) => omni({ position: { x, y: 0, z: 0 } }));
    const r = polarResponse({ sources, frequencies: [80], speedOfSound: C, stepDeg: 1 });
    // symmetric front/back for omni cabinets
    expect(at(r, 0)).toBeCloseTo(at(r, 180), 1);
    // and far down at 90 deg, along the line of the array
    expect(at(r, 90)).toBeLessThan(-12);
  });

  it('a delay-steered array peaks at the angle it was aimed at', () => {
    const pos = positionsFromSpacing(10, 1.2);
    for (const aim of [0, 20, -35]) {
      const d = steeringDelays({ positions: pos, steerDeg: aim, speedOfSound: C });
      const sources = pos.map((x, i) => omni({ id: `s${i}`, position: { x, y: 0, z: 0 }, delayS: d[i] }));
      const r = polarResponse({ sources, frequencies: [80], speedOfSound: C, stepDeg: 1 });
      expect(frontPeak(r)).toBeCloseTo(aim, 0);
    }
  });

  it('a cardioid cabinet shows its rear null', () => {
    const sources = [
      omni({ elements: analyticCardioidDataset(0.7, C).elements, normaliseOnAxis: true }),
    ];
    const r = polarResponse({ sources, frequencies: [63], speedOfSound: C, stepDeg: 1 });
    expect(frontPeak(r)).toBeCloseTo(0, 0);
    expect(at(r, 180)).toBeLessThan(-20);
  });

  it('follows the cabinet when it is rotated', () => {
    const mk = (az: number) =>
      omni({ azimuthDeg: az, elements: analyticCardioidDataset(0.7, C).elements, normaliseOnAxis: true });
    const r = polarResponse({ sources: [mk(90)], frequencies: [63], speedOfSound: C, stepDeg: 1 });
    expect(frontPeak(r)).toBeCloseTo(90, 0);
    expect(at(r, -90)).toBeLessThan(-20);
  });

  it('an end-fire stack fires forward and rejects behind', () => {
    const f = 63;
    const d = C / f / 4;
    const sources = [
      omni({ id: 'rear', position: { x: 0, y: -d, z: 0 } }),
      omni({ id: 'front', position: { x: 0, y: 0, z: 0 }, delayS: d / C }),
    ];
    const r = polarResponse({ sources, frequencies: [f], speedOfSound: C, stepDeg: 1 });
    // The forward lobe of a 2-element end-fire is broad and flat on axis, so the
    // argmax wanders by a step. What matters is that on-axis IS the peak.
    expect(at(r, 0)).toBeGreaterThan(-0.1);
    expect(Math.abs(frontPeak(r))).toBeLessThanOrEqual(2);
    expect(at(r, 180)).toBeLessThan(-25);
  });

  it('narrows as frequency rises', () => {
    const sources = positionsFromSpacing(8, 1.5).map((x) => omni({ position: { x, y: 0, z: 0 } }));
    const r = polarResponse({ sources, frequencies: [40, 100], speedOfSound: C, stepDeg: 1 });
    // width at -6 dB, measured off the forward lobe
    const widthOf = (i: number) => {
      let w = 0;
      for (let a = 0; a <= 90; a += 1) if (at(r, a, i) > -6) w = a;
      return w;
    };
    expect(widthOf(1)).toBeLessThan(widthOf(0));
  });

  it('shows the arc delay widening a broadside line', () => {
    // Not an absolute threshold: "nominal dispersion" is a design construction,
    // not a promise of -6 dB at a given angle. The meaningful claim is that the
    // taper widens the pattern relative to the same array run flat.
    const pos = positionsFromSpacing(16, 1.5);
    const flatSources = pos.map((x, i) => omni({ id: `f${i}`, position: { x, y: 0, z: 0 } }));
    const d = steeringDelays({ positions: pos, dispersionDeg: 90, speedOfSound: C });
    const arcSources = pos.map((x, i) => omni({ id: `a${i}`, position: { x, y: 0, z: 0 }, delayS: d[i] }));

    const opts = { frequencies: [63], speedOfSound: C, stepDeg: 1 };
    const flat = polarResponse({ sources: flatSources, ...opts });
    const arc = polarResponse({ sources: arcSources, ...opts });

    const halfWidth6 = (r: ReturnType<typeof polarResponse>) => {
      let w = 0;
      for (let a = 0; a <= 90; a += 1) if (at(r, a) > -6) w = a;
      return w;
    };
    expect(halfWidth6(arc)).toBeGreaterThan(halfWidth6(flat) * 3);
    expect(at(arc, 40)).toBeGreaterThan(at(flat, 40) + 12);
  });

  it('covers the full circle at the requested resolution', () => {
    const r = polarResponse({ sources: [omni()], frequencies: [63], speedOfSound: C, stepDeg: 5 });
    expect(r.anglesDeg.length).toBe(72);
    expect(r.anglesDeg[0]).toBe(-180);
    expect(r.traces[0].db.length).toBe(72);
  });

  it('is unaffected by how far out the circle is drawn', () => {
    const sources = positionsFromSpacing(6, 2).map((x) => omni({ position: { x, y: 0, z: 0 } }));
    const a = polarResponse({ sources, frequencies: [63], speedOfSound: C, radiusM: 300, stepDeg: 5 });
    const b = polarResponse({ sources, frequencies: [63], speedOfSound: C, radiusM: 1200, stepDeg: 5 });
    for (let i = 0; i < a.traces[0].db.length; i++) {
      // The pattern itself is radius-independent. Null DEPTH is not: exact
      // cancellation is hypersensitive to sub-millimetre path differences, so
      // compare where there is actually something to compare.
      if (a.traces[0].db[i] > -20 || b.traces[0].db[i] > -20) {
        expect(a.traces[0].db[i]).toBeCloseTo(b.traces[0].db[i], 0);
      } else {
        expect(b.traces[0].db[i]).toBeLessThan(-18); // both agree it is a null
      }
    }
  });
});
