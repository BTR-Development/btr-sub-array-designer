/**
 * The speed of sound, which every delay in this program divides by.
 *
 * The cases below are the published figures for dry air, not figures read off
 * our own function: c goes as the square root of ABSOLUTE temperature, so the
 * linear 331.3 + 0.606*T that this replaced is its tangent at 0 C and reads
 * high everywhere above that. The tolerances are tight enough that the tangent
 * fails all three of them and loose enough to survive any sane refactor.
 */
import { describe, it, expect } from 'vitest';
import { defaultSimulationSettings, speedOfSoundFromTemp } from './types';

describe('speed of sound from temperature', () => {
  it('matches the published figures for dry air', () => {
    // 0 C is where the two forms agree, so it pins the constant, not the shape
    expect(speedOfSoundFromTemp(0)).toBeCloseTo(331.3, 2);
    // and these two are where they part company: the linear form gives 343.42
    // and 355.54, which are 0.21 and 0.81 m/s high
    expect(speedOfSoundFromTemp(20)).toBeCloseTo(343.21, 2);
    expect(speedOfSoundFromTemp(40)).toBeCloseTo(354.73, 2);
    expect(speedOfSoundFromTemp(-10)).toBeCloseTo(325.18, 2);
  });

  it('bends the right way, which is the whole difference', () => {
    // sqrt is concave: every chord lies BELOW the curve, so each step of 10 K
    // buys less than the one before it. A straight line gives equal steps and
    // fails this outright.
    const step = (t: number) => speedOfSoundFromTemp(t + 10) - speedOfSoundFromTemp(t);
    for (const t of [0, 10, 20, 30]) {
      expect(step(t + 10), `${t} C`).toBeLessThan(step(t) - 1e-6);
    }
  });

  it('rises with temperature across the range the control offers', () => {
    for (let t = -20; t < 50; t++) {
      expect(speedOfSoundFromTemp(t + 1)).toBeGreaterThan(speedOfSoundFromTemp(t));
    }
  });
});

describe('the default prediction area', () => {
  it('is 200 x 200 m, mostly in front of the stage', () => {
    const a = defaultSimulationSettings().area;
    expect(a.xMax - a.xMin).toBe(200);
    expect(a.vMax - a.vMin).toBe(200);
    expect(a.xMin).toBe(-a.xMax);
    expect(a.vMin).toBe(-20);
  });
});
