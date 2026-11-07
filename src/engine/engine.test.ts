import { describe, it, expect } from 'vitest';
import {
  computeGrid,
  computePoint,
  computeSpectrum,
  localFrame,
  prepareSources,
  pressureAt,
  toDb,
} from './engine';
import type { EngineSource } from './types';
import { analyticCardioidDataset } from '../speakers/schema';
import { sliceBalloon, sampleBalloon } from './balloon';

const C = 343;

function omni(over: Partial<EngineSource> = {}): EngineSource {
  return {
    id: over.id ?? 's1',
    position: { x: 0, y: 0, z: 0 },
    azimuthDeg: 0,
    elevationDeg: 0,
    rollDeg: 0,
    levelDb: 0,
    delayS: 0,
    invertPolarity: false,
    refSplDb: 130,
    elements: null,
    normaliseOnAxis: false,
    ...over,
  };
}

function splAt(sources: EngineSource[], p: [number, number, number], f = 63): number {
  const prepared = prepareSources(sources, f, C);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  pressureAt(prepared, p[0], p[1], p[2], f, C, out, scratch);
  return toDb(out[0], out[1]);
}

describe('Test 1 — inverse square law', () => {
  it('drops 6.02 dB per doubling of distance in free field', () => {
    const s = [omni()];
    const a = splAt(s, [0, 10, 0]);
    const b = splAt(s, [0, 20, 0]);
    const c = splAt(s, [0, 40, 0]);
    expect(a - b).toBeCloseTo(6.0206, 3);
    expect(b - c).toBeCloseTo(6.0206, 3);
  });

  it('reports the model reference SPL at 1 m', () => {
    expect(splAt([omni({ refSplDb: 140 })], [0, 1, 0])).toBeCloseTo(140, 6);
  });
});

describe('Test 2 — coherent summation', () => {
  it('two co-located identical sources sum to +6.02 dB', () => {
    const one = splAt([omni()], [0, 12, 0]);
    const two = splAt([omni({ id: 'a' }), omni({ id: 'b' })], [0, 12, 0]);
    expect(two - one).toBeCloseTo(6.0206, 6);
  });

  it('four co-located identical sources sum to +12.04 dB', () => {
    const one = splAt([omni()], [0, 12, 0]);
    const four = splAt(
      ['a', 'b', 'c', 'd'].map((id) => omni({ id })),
      [0, 12, 0],
    );
    expect(four - one).toBeCloseTo(12.0412, 6);
  });
});

describe('Test 3 — anti-phase cancellation', () => {
  it('polarity inversion cancels a co-located pair to silence', () => {
    const db = splAt([omni({ id: 'a' }), omni({ id: 'b', invertPolarity: true })], [0, 12, 0]);
    expect(db).toBeLessThan(-100);
  });

  it('a 180 deg phase offset from delay also cancels', () => {
    const f = 50;
    const db = splAt([omni({ id: 'a' }), omni({ id: 'b', delayS: 1 / (2 * f) })], [0, 12, 0], f);
    expect(db).toBeLessThan(-100);
  });
});

describe('Test 4 — delay of one full period is transparent', () => {
  it('delay = 1/f leaves the summed level unchanged', () => {
    const f = 63;
    const ref = splAt([omni({ id: 'a' }), omni({ id: 'b' })], [3, 12, 0], f);
    const shifted = splAt([omni({ id: 'a' }), omni({ id: 'b', delayS: 1 / f })], [3, 12, 0], f);
    expect(shifted).toBeCloseTo(ref, 6);
  });

  it('delay = 1/f rotates a single source phase back to where it started', () => {
    const f = 63;
    const base = computePoint([omni()], { x: 0, y: 7, z: 0 }, f, C);
    const delayed = computePoint([omni({ delayS: 1 / f })], { x: 0, y: 7, z: 0 }, f, C);
    expect(Math.cos((delayed.phaseDeg - base.phaseDeg) * (Math.PI / 180))).toBeCloseTo(1, 6);
  });
});

describe('Test 5 — delay = 1/(2f) equals 180 degrees', () => {
  it('rotates the phase of a single source by half a turn', () => {
    const f = 80;
    const base = computePoint([omni()], { x: 0, y: 7, z: 0 }, f, C);
    const delayed = computePoint([omni({ delayS: 1 / (2 * f) })], { x: 0, y: 7, z: 0 }, f, C);
    const d = ((delayed.phaseDeg - base.phaseDeg) * Math.PI) / 180;
    expect(Math.cos(d)).toBeCloseTo(-1, 6);
  });

  it('is equivalent to a polarity flip for a single source', () => {
    const f = 80;
    const a = computePoint([omni({ delayS: 1 / (2 * f) })], { x: 1, y: 7, z: 0 }, f, C);
    const b = computePoint([omni({ invertPolarity: true })], { x: 1, y: 7, z: 0 }, f, C);
    expect(a.splDb).toBeCloseTo(b.splDb, 9);
    expect(Math.cos(((a.phaseDeg - b.phaseDeg) * Math.PI) / 180)).toBeCloseTo(1, 6);
  });
});

describe('Test 6 — distance changes magnitude AND phase', () => {
  it('phase advances by exactly one turn per wavelength of extra path', () => {
    const f = 100;
    const lambda = C / f;
    const near = computePoint([omni()], { x: 0, y: 5, z: 0 }, f, C);
    const oneWave = computePoint([omni()], { x: 0, y: 5 + lambda, z: 0 }, f, C);
    const halfWave = computePoint([omni()], { x: 0, y: 5 + lambda / 2, z: 0 }, f, C);

    expect(Math.cos(((oneWave.phaseDeg - near.phaseDeg) * Math.PI) / 180)).toBeCloseTo(1, 6);
    expect(Math.cos(((halfWave.phaseDeg - near.phaseDeg) * Math.PI) / 180)).toBeCloseTo(-1, 6);

    // magnitude follows 1/r over the same move
    expect(near.splDb - oneWave.splDb).toBeCloseTo(20 * Math.log10((5 + lambda) / 5), 6);
  });

  it('propagation delay is r/c', () => {
    const r = computePoint([omni()], { x: 0, y: 34.3, z: 0 }, 63, C);
    expect(r.contributions[0].propagationDelayS).toBeCloseTo(0.1, 9);
    expect(r.contributions[0].distanceM).toBeCloseTo(34.3, 9);
  });
});

describe('two-source interference geometry', () => {
  it('half-wavelength spacing puts a null on the perpendicular bisector axis', () => {
    // Two sources spaced lambda/2 apart, one inverted -> on-axis cancellation
    const f = 63;
    const lambda = C / f;
    const s = [
      omni({ id: 'a', position: { x: -lambda / 4, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: lambda / 4, y: 0, z: 0 }, invertPolarity: true }),
    ];
    expect(splAt(s, [0, 30, 0], f)).toBeLessThan(splAt([omni()], [0, 30, 0], f) - 30);
  });

  it('end-fire delay steers energy forward and rejects backward', () => {
    // Classic 2-element end-fire: rear cabinet fires first, front cabinet is
    // delayed by its own spacing. With d = lambda/4 the backward path
    // difference is 2d = lambda/2, so the rear lobe cancels.
    const f = 63;
    const d = C / f / 4;
    const s = [
      omni({ id: 'rear', position: { x: 0, y: -d, z: 0 } }),
      omni({ id: 'front', position: { x: 0, y: 0, z: 0 }, delayS: d / C }),
    ];
    const single = splAt([omni()], [0, 40, 0], f);
    const front = splAt(s, [0, 40, 0], f);
    const back = splAt(s, [0, -40, 0], f);
    // Coherent forward addition. Slightly under +6.02 dB because the rear
    // cabinet is d further away, so its 1/r amplitude is a touch lower.
    expect(front).toBeGreaterThan(single + 5.8);
    expect(front).toBeLessThan(single + 6.03);
    expect(front - back).toBeGreaterThan(30); // deep rear rejection
  });

  it('changing spacing changes the pattern (lobing is real, not cosmetic)', () => {
    const f = 100;
    const at = (spacing: number) =>
      splAt(
        [
          omni({ id: 'a', position: { x: -spacing / 2, y: 0, z: 0 } }),
          omni({ id: 'b', position: { x: spacing / 2, y: 0, z: 0 } }),
        ],
        [20, 20, 0],
        f,
      );
    expect(Math.abs(at(1.0) - at(3.0))).toBeGreaterThan(1);
  });
});

describe('analytical cardioid', () => {
  const cardioidSource = (azimuthDeg: number) =>
    omni({
      azimuthDeg,
      elements: analyticCardioidDataset(0.7, C).elements,
      normaliseOnAxis: true,
    });

  it('rejects strongly to the rear', () => {
    const s = [cardioidSource(0)];
    const front = splAt(s, [0, 20, 0]);
    const rear = splAt(s, [0, -20, 0]);
    expect(front - rear).toBeGreaterThan(20);
  });

  it('rotating the cabinet 180 deg rotates its pattern', () => {
    const fwd = [cardioidSource(0)];
    const rev = [cardioidSource(180)];
    expect(splAt(fwd, [0, 20, 0])).toBeCloseTo(splAt(rev, [0, -20, 0]), 6);
    expect(splAt(fwd, [0, -20, 0])).toBeCloseTo(splAt(rev, [0, 20, 0]), 6);
  });

  it('rotating 90 deg steers the front lobe to +X', () => {
    const s = [cardioidSource(90)];
    expect(splAt(s, [20, 0, 0])).toBeGreaterThan(splAt(s, [-20, 0, 0]) + 20);
  });

  it('on-axis normalisation keeps the front response level across frequency', () => {
    const s = [cardioidSource(0)];
    const a = splAt(s, [0, 20, 0], 40);
    const b = splAt(s, [0, 20, 0], 100);
    expect(Math.abs(a - b)).toBeLessThan(0.5);
  });
});

describe('local frame', () => {
  it('is orthonormal and points where the convention says', () => {
    for (const [az, el] of [[0, 0], [37, 12], [-140, -25], [180, 0]]) {
      const f = localFrame(az, el, 0);
      const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const F = [f.fx, f.fy, f.fz], R = [f.rx, f.ry, f.rz], U = [f.ux, f.uy, f.uz];
      expect(dot(F, F)).toBeCloseTo(1, 9);
      expect(dot(R, R)).toBeCloseTo(1, 9);
      expect(dot(U, U)).toBeCloseTo(1, 9);
      expect(dot(F, R)).toBeCloseTo(0, 9);
      expect(dot(F, U)).toBeCloseTo(0, 9);
      expect(dot(R, U)).toBeCloseTo(0, 9);
    }
    const f0 = localFrame(0, 0, 0);
    expect([f0.fx, f0.fy, f0.fz]).toEqual([0, 1, 0]);
    const f90 = localFrame(90, 0, 0);
    expect(f90.fx).toBeCloseTo(1, 9);
    expect(f90.fy).toBeCloseTo(0, 9);
  });
});

describe('ground model', () => {
  it('perfect rigid ground adds ~6 dB right on the boundary', () => {
    const s = [omni({ position: { x: 0, y: 0, z: 0 } })];
    const free = computePoint(s, { x: 0, y: 20, z: 0 }, 63, C, 'off');
    const rigid = computePoint(s, { x: 0, y: 20, z: 0 }, 63, C, 'rigid');
    expect(rigid.splDb - free.splDb).toBeCloseTo(6.0206, 4);
    expect(rigid.contributions).toHaveLength(2);
  });
});

describe('grid', () => {
  it('produces a grid whose max matches a direct point evaluation', () => {
    const s = [
      omni({ id: 'a', position: { x: -1, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: 1, y: 0, z: 0 } }),
    ];
    const g = computeGrid({
      sources: s, frequencyHz: 63, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: -10, xMax: 10, vMin: 0, vMax: 20, planeOffset: 0, nx: 41, nv: 41,
    });
    expect(g.spl).toHaveLength(41 * 41);
    // sample cell (20, 20) == world (0, 10)
    const cell = g.spl[20 * 41 + 20];
    expect(cell).toBeCloseTo(computePoint(s, { x: 0, y: 10, z: 0 }, 63, C).splDb, 4);
    // "maxDb is at least some sampled cell" was true of any monotone nonsense
    // the loop could have produced. maxDb has to be the level at a real place:
    // find the cell it came from, turn its index back into coordinates by hand,
    // and evaluate there. That pins the reduction and the index-to-world
    // mapping at the same time.
    let peak = 0;
    for (let k = 1; k < g.spl.length; k++) if (g.spl[k] > g.spl[peak]) peak = k;
    const at = { x: -10 + (peak % 41) * 0.5, y: Math.floor(peak / 41) * 0.5, z: 0 };
    expect(g.maxDb).toBeCloseTo(computePoint(s, at, 63, C).splDb, 3);
    expect(g.maxDb).toBeGreaterThan(cell);
  });

  it('side plane maps the second axis to Z', () => {
    const s = [omni({ position: { x: 0, y: 0, z: 0 } })];
    const g = computeGrid({
      sources: s, frequencyHz: 63, speedOfSound: C, plane: 'side', ground: 'off',
      xMin: 0, xMax: 0, vMin: 5, vMax: 5, planeOffset: 0, nx: 1, nv: 1,
    });
    // grid is Float32, point result is Float64 — compare at Float32 precision
    expect(g.spl[0]).toBeCloseTo(computePoint(s, { x: 0, y: 0, z: 5 }, 63, C).splDb, 4);
  });

  it('side plane runs its first axis along Y and fixes X', () => {
    // A side view is a section ALONG the room, so the horizontal grid axis is
    // depth and the constant coordinate is stage width. Pairing X with Z would
    // draw a front elevation, which for a sub line across the stage shows the
    // array end-on.
    const s = [omni({ position: { x: 0, y: 0, z: 0 } })];
    const g = computeGrid({
      sources: s, frequencyHz: 63, speedOfSound: C, plane: 'side', ground: 'off',
      xMin: 12, xMax: 12, vMin: 3, vMax: 3, planeOffset: 4, nx: 1, nv: 1,
    });
    expect(g.spl[0]).toBeCloseTo(computePoint(s, { x: 4, y: 12, z: 3 }, 63, C).splDb, 4);
  });
});

describe('the reference the whole colour scale is measured against', () => {
  /**
   * `refDb` is what every pixel's colour is a distance from, and the area panel
   * states its definition to the user in so many words: "the loudest point more
   * than 2 m from any cabinet". Nothing asserted it. The near field of a single
   * cabinet is 10-20 dB above anything in the audience, so a refDb that picked
   * up one of those cells renders the whole field 25-40 dB down and uniformly
   * dark, which reads as a quiet rig rather than as a broken scale.
   *
   * These grids are a single omni in free field, where the level at range r is
   * exactly refSpl - 20*log10(r). That makes every expected value below a
   * closed form rather than a reading taken off the function under test.
   */
  const one = [omni({ refSplDb: 130, position: { x: 0, y: 0, z: 0 } })];

  /** Free-field level of `one` at range r. */
  const at = (r: number) => 130 - 20 * Math.log10(r);

  /** A column of cells straight out from the cabinet, 0.5 m apart. */
  const column = (over: Partial<Parameters<typeof computeGrid>[0]> = {}) =>
    computeGrid({
      sources: one, frequencyHz: 63, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: 0, xMax: 0, vMin: 0.5, vMax: 10, planeOffset: 0, nx: 1, nv: 20,
      ...over,
    });

  it('is the loudest cell outside the exclusion, not the loudest cell', () => {
    const g = column();
    // nearest cell is 0.5 m out, which is 6.02 dB ABOVE the 1 m rating
    expect(g.maxDb).toBeCloseTo(at(0.5), 4);
    // the first cell at or beyond 2 m is the one at exactly 2 m
    expect(g.refDb).toBeCloseTo(at(2), 4);
    expect(g.minDb).toBeCloseTo(at(10), 4);
    expect(g.refDb).toBeLessThan(g.maxDb - 12);
  });

  it('counts a cell exactly on the boundary as outside it', () => {
    // The boundary is where the user is told the reference comes from, so the
    // cell at 2.000 m is the reference and the one at 1.5 m is not. Half a
    // metre of grid is 2.5 dB here, and the ramp shifts with it.
    expect(column().refDb).toBeCloseTo(at(2), 4);
    expect(column({ nearFieldExclusionM: 2.5 }).refDb).toBeCloseTo(at(2.5), 4);
    expect(column({ nearFieldExclusionM: 2.6 }).refDb).toBeCloseTo(at(3), 4);
  });

  it('defaults to the 2 m the interface promises', () => {
    expect(column().refDb).toBeCloseTo(column({ nearFieldExclusionM: 2 }).refDb, 9);
  });

  it('is the plain maximum when the exclusion is switched off', () => {
    const g = column({ nearFieldExclusionM: 0 });
    expect(g.refDb).toBe(g.maxDb);
  });

  it('falls back to the maximum rather than to silence when nothing qualifies', () => {
    // Zoomed right in on one cabinet: every cell is inside the exclusion. A
    // -Infinity reference would paint the entire map the top colour.
    const g = computeGrid({
      sources: one, frequencyHz: 63, speedOfSound: C, plane: 'top', ground: 'off',
      xMin: -0.5, xMax: 0.5, vMin: 0.5, vMax: 1, planeOffset: 0, nx: 5, nv: 5,
    });
    expect(g.refDb).toBe(g.maxDb);
    expect(isFinite(g.refDb)).toBe(true);
  });

  it('measures the exclusion in three dimensions, including the plane offset', () => {
    // A section 1.9 m to the side of the cabinet. Both cells are well inside
    // 2 m of it as drawn, and only one of them is really 2 m away from it:
    // sqrt(1.9^2 + 0.7^2) = 2.025. Measuring in the plane alone disqualifies
    // both and silently falls back to the peak.
    const rNear = Math.hypot(1.9, 0.3);
    const rFar = Math.hypot(1.9, 0.7);
    const g = computeGrid({
      sources: one, frequencyHz: 63, speedOfSound: C, plane: 'side', ground: 'off',
      xMin: 0.3, xMax: 0.7, vMin: 0, vMax: 0, planeOffset: 1.9, nx: 2, nv: 1,
    });
    expect(g.maxDb).toBeCloseTo(at(rNear), 4);
    expect(g.refDb).toBeCloseTo(at(rFar), 4);
    expect(g.refDb).toBeLessThan(g.maxDb);
  });

  it('does not let the ground image push the exclusion zone around', () => {
    // A cabinet 1 m up over rigid ground has an image 1 m under it. The cell at
    // z = -1.2 is 2.2 m from the real cabinet and 0.2 m from the image, so it
    // qualifies -- the image is a term in the summation, not a box anyone can
    // stand near. Excluding around it instead hands the reference to the
    // quieter cell and drops the whole ramp by 15 dB.
    const flown = [omni({ refSplDb: 130, position: { x: 0, y: 0, z: 1 } })];
    const g = computeGrid({
      sources: flown, frequencyHz: 63, speedOfSound: C, plane: 'side', ground: 'rigid',
      xMin: 0, xMax: 0, vMin: -1.2, vMax: 4, planeOffset: 0, nx: 1, nv: 2,
    });
    // the near-the-image cell is the loudest, and it is the reference
    expect(g.spl[0]).toBeGreaterThan(g.spl[1]);
    expect(g.refDb).toBe(g.maxDb);
  });

  it('brackets every cell it reports on', () => {
    // maxDb and minDb are the ends of the data, and refDb sits between them.
    // The one assertion the suite had here compared maxDb against a single
    // sampled cell, which any of the three could have satisfied.
    const g = column();
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of g.spl) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Float32 grid against Float64 scalars, so compared at the grid's precision
    expect(g.maxDb).toBeCloseTo(hi, 4);
    expect(g.minDb).toBeCloseTo(lo, 4);
    expect(g.refDb).toBeGreaterThanOrEqual(lo);
    expect(g.refDb).toBeLessThanOrEqual(hi);
  });
});

describe('spectrum', () => {
  it('shows a comb whose first null lands at the predicted frequency', () => {
    // two sources, path difference dr -> first null at f = c / (2 dr)
    const dr = 2.0;
    const s = [
      omni({ id: 'a', position: { x: 0, y: 0, z: 0 } }),
      omni({ id: 'b', position: { x: 0, y: -dr, z: 0 } }),
    ];
    const fNull = C / (2 * dr);
    const at = (f: number) => computeSpectrum(s, { x: 0, y: 40, z: 0 }, [f], C)[0];
    expect(at(fNull)).toBeLessThan(at(fNull * 0.6) - 20);
    expect(at(fNull)).toBeLessThan(at(fNull * 1.6) - 20);
  });
});

describe('balloon dataset path', () => {
  it('interpolates a synthetic dataset and steers with the cabinet', () => {
    // synthetic 1-band figure-of-eight: 0 dB on axis, -inf at +-90, -0 dB behind
    const az = [-180, -90, 0, 90, 180];
    const el = [0];
    const mag = new Float32Array([0, -40, 0, -40, 0]);
    const pha = new Float32Array([180, 0, 0, 0, 180]);
    const ds = {
      kind: 'balloon' as const,
      frequenciesHz: [63],
      azimuthDeg: az,
      elevationDeg: el,
      magnitudeDb: mag,
      phaseDeg: pha,
    };
    const slice = sliceBalloon(ds, 63);
    const out = new Float64Array(2);
    sampleBalloon(slice, 0, 0, out);
    expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 6);
    sampleBalloon(slice, 90, 0, out);
    expect(20 * Math.log10(Math.hypot(out[0], out[1]))).toBeCloseTo(-40, 4);

    const s = [omni({ balloon: ds, azimuthDeg: 90 })];
    // pattern rotated: the null now sits along -Y / +Y is off the null
    expect(splAt(s, [20, 0, 0], 63)).toBeGreaterThan(splAt(s, [0, 20, 0], 63) + 20);
  });
});

describe('level and mute semantics', () => {
  it('levelDb is a straight dB offset', () => {
    const a = splAt([omni()], [0, 10, 0]);
    const b = splAt([omni({ levelDb: -6 })], [0, 10, 0]);
    expect(a - b).toBeCloseTo(6, 9);
  });
});
