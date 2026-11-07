/**
 * Reverse-stack cardioid: the case that proved cabinets cannot be points.
 *
 * A sub is omnidirectional, so its directivity is 1 in every direction and
 * turning it round changes nothing about how it radiates. The ONLY thing a 180
 * degree rotation changes is where it radiates FROM — the baffle swaps ends of
 * the box. Model the cabinet as a dimensionless point at its handle and that
 * information is gone, so the textbook reverse stack (turn the top box round,
 * delay it by d/c, invert it) returns two coincident sources: same level in
 * front and behind, at every delay, forever.
 *
 * These tests pin both halves — that the geometry now produces a cardioid, and
 * that without the acoustic origin it provably cannot.
 */
import { describe, expect, it } from 'vitest';
import { prepareSources, pressureAt, toDb } from './engine';
import type { EngineSource } from './types';
import { acousticOrigin, boxSize } from '../speakers/schema';
import { BUILTIN_SPEAKERS } from '../speakers/library';
import { EXAMPLE_RIGS } from '../state/exampleRigs';
import { toEngineSources, resolveAll } from '../state/resolve';
import { builtinProvider } from '../speakers/provider';

const C = 343;
const KS21 = BUILTIN_SPEAKERS.find((m) => m.id === 'la-ks21')!;
const DEPTH = boxSize(KS21).depthM;   // 0.601 m, manufacturer
const HEIGHT = boxSize(KS21).heightM; // 0.571 m, manufacturer

function ks21(o: {
  y?: number; z: number; az: number; delayS?: number; inv?: boolean; origin?: boolean;
}): EngineSource {
  return {
    id: `s${o.z}${o.az}`,
    position: { x: 0, y: o.y ?? 0, z: o.z },
    azimuthDeg: o.az, elevationDeg: 0, rollDeg: 0,
    levelDb: 0, delayS: o.delayS ?? 0, invertPolarity: !!o.inv,
    refSplDb: 138, elements: null, normaliseOnAxis: false,
    originOffset: o.origin === false ? null : acousticOrigin(KS21),
  };
}

function spl(sources: EngineSource[], f: number, x: number, y: number, z: number): number {
  const prep = prepareSources(sources, f, C, 'off');
  const out = new Float64Array(2), scratch = new Float64Array(2);
  pressureAt(prep, x, y, z, f, C, out, scratch);
  return toDb(out[0], out[1]);
}

const FRONT: [number, number, number] = [0, 20, 1.5];
const REAR: [number, number, number] = [0, -20, 1.5];

/** The user's own experiment: one KS21 on another, top one turned round. */
function reverseStack(delayS: number, origin = true): EngineSource[] {
  return [
    ks21({ z: HEIGHT / 2, az: 0, origin }),
    ks21({ z: HEIGHT * 1.5, az: 180, delayS, inv: true, origin }),
  ];
}

describe('reverse-stack cardioid', () => {
  it('rejects to the rear when the delay matches the cabinet depth', () => {
    const s = reverseStack(DEPTH / C);
    const front = spl(s, 63, ...FRONT);
    const rear = spl(s, 63, ...REAR);
    // Measured 29.3 dB. The bound is deliberately loose: what matters is that
    // this is a pattern, not the third decimal place of an analytical model.
    expect(front - rear).toBeGreaterThan(20);
  });

  it('still gains forward rather than paying for the null with level', () => {
    const one = [ks21({ z: HEIGHT / 2, az: 0 })];
    const s = reverseStack(DEPTH / C);
    // Two boxes in gradient give roughly +2 dB at 63 Hz over one box, not the
    // +6 dB of two coincident boxes: the rear one is doing pattern work.
    expect(spl(s, 63, ...FRONT)).toBeGreaterThan(spl(one, 63, ...FRONT) + 1);
  });

  it('puts the null at d/c and nowhere else', () => {
    const at = (ms: number) => {
      const s = reverseStack(ms / 1000);
      return spl(s, 63, ...FRONT) - spl(s, 63, ...REAR);
    };
    const best = at((DEPTH / C) * 1000);
    expect(best).toBeGreaterThan(at(0.5));
    expect(best).toBeGreaterThan(at(1.0));
    expect(best).toBeGreaterThan(at(2.5));
    expect(best).toBeGreaterThan(at(3.5));
  });

  it('is arithmetically impossible without the acoustic origin', () => {
    // Two omni point sources at the same x and y differ only in height, so the
    // whole arrangement is mirror-symmetric about the y = 0 plane and front and
    // rear are the same number by construction. No delay can break that.
    for (const ms of [0, 0.5, 1.752, 3]) {
      const s = reverseStack(ms / 1000, false);
      expect(spl(s, 63, ...FRONT) - spl(s, 63, ...REAR)).toBeCloseTo(0, 6);
    }
  });
});

describe('acoustic origin', () => {
  it('is the front baffle, derived from the cabinet depth', () => {
    expect(acousticOrigin(KS21)).toEqual({ x: 0, y: DEPTH / 2, z: 0 });
  });

  it('never guesses when the depth is unknown', () => {
    expect(acousticOrigin({ ...KS21, dimensions: { widthM: 1, heightM: 1, depthM: null } }))
      .toEqual({ x: 0, y: 0, z: 0 });
  });

  it('honours an explicit override instead of the depth', () => {
    const m = { ...KS21, acousticOriginM: { x: 0, y: 0.1, z: -0.2 } };
    expect(acousticOrigin(m)).toEqual({ x: 0, y: 0.1, z: -0.2 });
  });

  it('offsetting a source is the same as having placed it there', () => {
    // The offset must be a pure change of position, not an extra phase term.
    const offset = [ks21({ z: 1, az: 0 })];
    const moved: EngineSource[] = [
      { ...ks21({ z: 1, az: 0, origin: false }), position: { x: 0, y: DEPTH / 2, z: 1 } },
    ];
    for (const f of [31.5, 63, 125]) {
      expect(spl(offset, f, 3, 9, 1.5)).toBeCloseTo(spl(moved, f, 3, 9, 1.5), 9);
    }
  });

  it('turns with the cabinet on every axis', () => {
    const az90 = prepareSources([ks21({ z: 1, az: 90 })], 63, C)[0];
    expect(az90.x).toBeCloseTo(DEPTH / 2, 9);
    expect(az90.y).toBeCloseTo(0, 9);

    const up = prepareSources(
      [{ ...ks21({ z: 1, az: 0 }), elevationDeg: 90 }], 63, C,
    )[0];
    expect(up.z).toBeCloseTo(1 + DEPTH / 2, 9);
  });

  it('mirrors with the ground image instead of drifting off it', () => {
    // A cabinet tilted up radiates from above its handle; its image below the
    // floor must radiate the same distance BELOW its own handle.
    const tilted: EngineSource = { ...ks21({ z: 2, az: 0 }), elevationDeg: 30 };
    const [real, image] = prepareSources([tilted], 63, C, 'rigid');
    expect(image.x).toBeCloseTo(real.x, 9);
    expect(image.y).toBeCloseTo(real.y, 9);
    expect(image.z).toBeCloseTo(-real.z, 9);
  });
});

describe('Cardioid Pair preset', () => {
  it('delays by the acoustic spacing, so the rear null is real', () => {
    const preset = EXAMPLE_RIGS.find((p) => p.id === 'cardioid-pair')!;
    const { doc } = preset.build();
    const sources = toEngineSources(resolveAll(doc.sources, doc.groups, builtinProvider));
    expect(sources).toHaveLength(2);
    expect(spl(sources, 63, ...FRONT) - spl(sources, 63, ...REAR)).toBeGreaterThan(20);
  });
});
