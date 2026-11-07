/**
 * Band averaging.
 *
 * The point of the feature is that a map at one frequency shows nulls no music
 * ever produces. These tests pin the two things that make the average honest:
 * it is a POWER average (a null cannot drag it down the way a dB average
 * would), and it actually samples the comb rather than the centre alone.
 */
import { describe, expect, it } from 'vitest';
import { bandFrequencies, computeBandLevel, computeGrid, computePoint, sourceSpreadM } from './engine';
import type { EngineSource } from './types';

const C = 343.4;

const omni = (over: Partial<EngineSource> = {}): EngineSource => ({
  id: 'a', position: { x: 0, y: 0, z: 0 },
  azimuthDeg: 0, elevationDeg: 0, rollDeg: 0,
  levelDb: 0, delayS: 0, invertPolarity: false,
  refSplDb: 130, elements: null, normaliseOnAxis: false,
  ...over,
});

describe('bandFrequencies', () => {
  it('is a single tone when no band is asked for', () => {
    expect(bandFrequencies(63, 0)).toEqual([63]);
    expect(bandFrequencies(63, -1)).toEqual([63]);
  });

  it('spans the third octave around the centre', () => {
    const f = bandFrequencies(63, 1 / 3, { points: 5 });
    expect(f).toHaveLength(5);
    expect(f[0]).toBeCloseTo(63 * Math.pow(2, -1 / 6), 6);
    expect(f[4]).toBeCloseTo(63 * Math.pow(2, 1 / 6), 6);
  });

  it('always evaluates the nominal centre frequency', () => {
    // odd count, log spaced: the middle point IS the centre, so the number the
    // user typed is never merely interpolated
    for (const oct of [1 / 3, 1 / 2, 1]) {
      const f = bandFrequencies(63, oct, { spreadM: 22, speedOfSound: C });
      expect(f.length % 2).toBe(1);
      expect(f[(f.length - 1) / 2]).toBeCloseTo(63, 6);
    }
  });

  it('spends more points on a wider array, whose comb is finer', () => {
    const tight = bandFrequencies(200, 1 / 3, { spreadM: 2, speedOfSound: C });
    const wide = bandFrequencies(200, 1 / 3, { spreadM: 40, speedOfSound: C });
    expect(wide.length).toBeGreaterThan(tight.length);
    expect(wide.length).toBeLessThanOrEqual(33);
  });

  it('does not go wild on a single cabinet, which has no comb', () => {
    expect(bandFrequencies(200, 1 / 3, { spreadM: 0, speedOfSound: C })).toHaveLength(5);
  });
});

describe('sourceSpreadM', () => {
  it('is zero for one source and the diagonal for a line', () => {
    expect(sourceSpreadM([omni()])).toBe(0);
    const line = [omni({ position: { x: -5, y: 0, z: 0 } }), omni({ position: { x: 5, y: 0, z: 0 } })];
    expect(sourceSpreadM(line)).toBeCloseTo(10, 9);
  });
});

describe('band-averaged grid', () => {
  const cell = (bandOct: number, sources: EngineSource[], at: { h: number; v: number }) =>
    computeGrid({
      sources, frequencyHz: 63, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: at.h, xMax: at.h, vMin: at.v, vMax: at.v, planeOffset: 0, nx: 1, nv: 1,
      bandOct,
    });

  it('a single tone is unchanged by the new code path', () => {
    const s = [omni()];
    const g = cell(0, s, { h: 0, v: 10 });
    expect(g.bandPoints).toBe(1);
    expect(g.spl[0]).toBeCloseTo(computePoint(s, { x: 0, y: 10, z: 0 }, 63, C).splDb, 4);
  });

  it('fills a single-tone null instead of leaving a hole', () => {
    // Averaging only helps where the comb is FINE compared with the band. Two
    // cabinets a couple of metres apart null over a 126 Hz-wide trough, and a
    // third octave cannot fill that: the null is real broadband cancellation,
    // not an artefact, and the map should keep showing it. A wide array heard
    // well off axis is the opposite case, and the one this feature is for.
    const s = [
      omni({ id: 'a', position: { x: -12.5, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: 12.5, y: 0, z: 0 } }),
    ];
    const at = { h: 20, v: 20 };

    // the comb here repeats every c/dr, well inside a third octave at 200 Hz
    const dr = Math.abs(Math.hypot(20 + 12.5, 20) - Math.hypot(20 - 12.5, 20));
    expect(C / dr).toBeLessThan(200 * (Math.pow(2, 1 / 6) - Math.pow(2, -1 / 6)));

    // find the tone that actually nulls here rather than assuming one
    let f0 = 200, lowest = Infinity;
    for (let f = 180; f <= 220; f += 0.25) {
      const db = computeGrid({
        sources: s, frequencyHz: f, speedOfSound: C, plane: 'top', ground: 'off',
        xMin: at.h, xMax: at.h, vMin: at.v, vMax: at.v, planeOffset: 0, nx: 1, nv: 1,
      }).spl[0];
      if (db < lowest) { lowest = db; f0 = f; }
    }

    const tone = computeGrid({
      sources: s, frequencyHz: f0, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: at.h, xMax: at.h, vMin: at.v, vMax: at.v, planeOffset: 0, nx: 1, nv: 1,
    }).spl[0];
    const band = computeGrid({
      sources: s, frequencyHz: f0, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: at.h, xMax: at.h, vMin: at.v, vMax: at.v, planeOffset: 0, nx: 1, nv: 1,
      bandOct: 1 / 3,
    }).spl[0];

    // Not a bottomless null: the far cabinet arrives about 5 dB quieter than
    // the near one, so cancellation is partial and the gap the averaging opens
    // up is around 8 dB rather than tens. That is the honest figure for two
    // boxes; a real line array combs far harder.
    expect(band).toBeGreaterThan(tone + 6);
  });

  it('is a power average, so it cannot fall below the quietest term', () => {
    const s = [
      omni({ id: 'a', position: { x: -8, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: 8, y: 0, z: 0 } }),
    ];
    const freqs = bandFrequencies(63, 1 / 3, { spreadM: 16, speedOfSound: C });
    const each = freqs.map((f) => computeGrid({
      sources: s, frequencyHz: f, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: 4, xMax: 4, vMin: 25, vMax: 25, planeOffset: 0, nx: 1, nv: 1,
    }).spl[0]);
    const band = cell(1 / 3, s, { h: 4, v: 25 }).spl[0];

    expect(band).toBeGreaterThanOrEqual(Math.min(...each) - 1e-6);
    expect(band).toBeLessThanOrEqual(Math.max(...each) + 1e-6);

    // and it equals the explicit power mean of those same terms
    const mean = 10 * Math.log10(each.reduce((a, db) => a + Math.pow(10, db / 10), 0) / each.length);
    expect(band).toBeCloseTo(mean, 3);
  });

  it('reports how many frequencies it summed', () => {
    const s = [omni({ position: { x: -11, y: 0, z: 0 } }), omni({ position: { x: 11, y: 0, z: 0 } })];
    const g = cell(1 / 3, s, { h: 0, v: 20 });
    expect(g.bandPoints).toBeGreaterThan(1);
    expect(g.bandPoints).toBe(bandFrequencies(63, 1 / 3, { spreadM: 22, speedOfSound: C }).length);
  });
});

describe('computeBandLevel', () => {
  it('matches the map cell at the same receiver', () => {
    const s = [
      omni({ id: 'a', position: { x: -6, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: 6, y: 0, z: 0 } }),
    ];
    const g = computeGrid({
      sources: s, frequencyHz: 63, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: 3, xMax: 3, vMin: 18, vMax: 18, planeOffset: 0, nx: 1, nv: 1, bandOct: 1 / 3,
    });
    const p = computeBandLevel(s, { x: 3, y: 18, z: 0 }, 63, 1 / 3, C);
    expect(p.splDb).toBeCloseTo(g.spl[0], 3);
    expect(p.points).toBe(g.bandPoints);
  });

  it('collapses to the plain tone when the band is off', () => {
    const s = [omni()];
    const p = computeBandLevel(s, { x: 0, y: 12, z: 0 }, 63, 0, C);
    expect(p.points).toBe(1);
    expect(p.splDb).toBeCloseTo(computePoint(s, { x: 0, y: 12, z: 0 }, 63, C).splDb, 6);
  });
});
