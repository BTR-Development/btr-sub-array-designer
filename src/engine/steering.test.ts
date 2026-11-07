import { describe, it, expect } from 'vitest';
import {
  endFireDelays,
  endFireSpacingFor,
  focusRadiusForDispersion,
  levelTaper,
  patternControlLimitHz,
  positionsFromSpacing,
  positionsFromSpan,
  spacingFromSpan,
  spanFromPositions,
  steeringDelays,
  steerDegForDownTilt,
  tiltAngleFromGeometry,
  overallWidth,
  spacingFromOverallWidth,
  stackCentreFromRef,
  stackExtent,
  stackRefFromCentre,
  anchorFromCentre,
  centreFromAnchor,
} from './steering';
import { computeSpectrum, computePoint } from './engine';
import type { EngineSource } from './types';

const C = 343;

function omni(x: number, delayS = 0): EngineSource {
  return {
    id: `s${x}`,
    position: { x, y: 0, z: 0 },
    azimuthDeg: 0,
    elevationDeg: 0,
    rollDeg: 0,
    levelDb: 0,
    delayS,
    invertPolarity: false,
    refSplDb: 130,
    elements: null,
    normaliseOnAxis: false,
  };
}

/** SPL on a far arc at `angleDeg` off the array normal (+Y). */
function splAtAngle(sources: EngineSource[], angleDeg: number, f: number, radius = 200): number {
  const a = (angleDeg * Math.PI) / 180;
  return computePoint(sources, { x: radius * Math.sin(a), y: radius * Math.cos(a), z: 0 }, f, C).splDb;
}

/** Angle of the strongest lobe, searched over the front half-plane. */
function mainLobeAngle(sources: EngineSource[], f: number): number {
  let best = -Infinity;
  let bestA = 0;
  for (let a = -89; a <= 89; a += 0.25) {
    const v = splAtAngle(sources, a, f);
    if (v > best) { best = v; bestA = a; }
  }
  return bestA;
}

describe('layout', () => {
  it('spaces cabinets symmetrically about zero', () => {
    expect(positionsFromSpacing(4, 2)).toEqual([-3, -1, 1, 3]);
    expect(positionsFromSpacing(1, 2)).toEqual([0]);
    expect(positionsFromSpacing(3, 2)).toEqual([-2, 0, 2]);
  });

  it('spreads cabinets evenly across a span', () => {
    expect(positionsFromSpan(4, 30)).toEqual([-15, -5, 5, 15]);
    expect(spacingFromSpan(4, 30)).toBe(10);
    expect(spanFromPositions(positionsFromSpan(4, 30))).toBe(30);
  });
});

describe('beam steering (plane wave)', () => {
  it('applies the classic p*sin(theta)/c taper', () => {
    const pos = positionsFromSpacing(4, 2); // -3 -1 1 3
    const d = steeringDelays({ positions: pos, steerDeg: 30, speedOfSound: C });
    // relative to the earliest cabinet at -3
    for (let i = 0; i < pos.length; i++) {
      expect(d[i]).toBeCloseTo(((pos[i] + 3) * Math.sin(Math.PI / 6)) / C, 12);
    }
    expect(Math.min(...d)).toBe(0);
  });

  it('actually moves the main lobe to the requested angle', () => {
    const pos = positionsFromSpacing(8, 1.2);
    for (const target of [0, 15, -20, 30]) {
      const d = steeringDelays({ positions: pos, steerDeg: target, speedOfSound: C });
      const sources = pos.map((p, i) => omni(p, d[i]));
      expect(mainLobeAngle(sources, 80)).toBeCloseTo(target, 0);
    }
  });

  it('matches the flown-column tilt formula element by element', () => {
    // a vertical column: dt per element = boxHeight * sin(tilt) / c
    const boxH = 0.585;
    const tilt = 12;
    const pos = positionsFromSpacing(6, boxH);
    const d = steeringDelays({ positions: pos, steerDeg: tilt, speedOfSound: C });
    const step = (boxH * Math.sin((tilt * Math.PI) / 180)) / C;
    for (let i = 1; i < d.length; i++) expect(d[i] - d[i - 1]).toBeCloseTo(step, 12);
  });

  it('zero steer means zero delay everywhere', () => {
    const d = steeringDelays({ positions: positionsFromSpacing(6, 1.5), steerDeg: 0, speedOfSound: C });
    expect(d.every((v) => Math.abs(v) < 1e-15)).toBe(true);
  });
});

describe('nominal dispersion (virtual arc)', () => {
  it('derives the focus so the ray fan IS the nominal angle', () => {
    // tan(disp/2) = (span/2) / R. The old convention read the span as an ARC
    // (R = span/rad): at 90 deg nominal it built a 76-degree fan, at 130 a
    // 97-degree one, and 180 was unreachable. The number on the control has to
    // mean the angle the wavefront actually diverges through.
    expect(focusRadiusForDispersion(30, 80)).toBeCloseTo(15 / Math.tan((40 * Math.PI) / 180), 9);
    expect(focusRadiusForDispersion(30, 0)).toBe(Infinity);
    // 180 degrees collapses the focus onto the array: a half-space fan
    expect(focusRadiusForDispersion(30, 180)).toBeLessThan(0.01);
    // and the fan angle is monotone in the control, which the arc-length
    // convention also failed near its 115-degree ceiling
    const fan = (disp: number) =>
      (2 * Math.atan2(15, focusRadiusForDispersion(30, disp)) * 180) / Math.PI;
    expect(fan(60)).toBeCloseTo(60, 6);
    expect(fan(90)).toBeCloseTo(90, 6);
    expect(fan(130)).toBeCloseTo(130, 6);
  });

  it('reproduces the reference 4-position, 80 deg case', () => {
    // positions +-5 / +-15 m, 80 deg nominal dispersion.
    // Outer cabinets sit further from the virtual focus, so they are delayed
    // MORE than the inner ones — the wavefront leaves as a convex arc.
    const pos = [-15, -5, 5, 15];
    const d = steeringDelays({ positions: pos, dispersionDeg: 80, speedOfSound: C });
    const ms = d.map((v) => v * 1000);
    expect(ms[1]).toBeCloseTo(0, 6);
    expect(ms[2]).toBeCloseTo(0, 6);
    expect(ms[0]).toBeCloseTo(ms[3], 9); // symmetric
    // R = 15/tan(40 deg) = 17.88 m; edge (sqrt(R^2+225)-R)/c minus the inner
    // cabinet's own 2.02 ms = 13.89 ms
    expect(ms[0]).toBeGreaterThan(13);
    expect(ms[0]).toBeLessThan(15);
  });

  it('widens coverage compared with a flat broadside line', () => {
    const pos = positionsFromSpan(8, 14);
    const flat = pos.map((p) => omni(p, 0));
    const arc = (() => {
      const d = steeringDelays({ positions: pos, dispersionDeg: 90, speedOfSound: C });
      return pos.map((p, i) => omni(p, d[i]));
    })();
    const f = 63;
    const onAxis = (s: EngineSource[]) => splAtAngle(s, 0, f);
    const offAxis = (s: EngineSource[]) => splAtAngle(s, 40, f);
    // relative level at 40 deg improves once the arc delay is applied
    expect(offAxis(arc) - onAxis(arc)).toBeGreaterThan(offAxis(flat) - onAxis(flat));
  });

  it('stays symmetric with no steer, and shifts when steered', () => {
    const pos = positionsFromSpan(6, 12);
    const sym = steeringDelays({ positions: pos, dispersionDeg: 60, speedOfSound: C });
    expect(sym[0]).toBeCloseTo(sym[5], 12);
    const steered = steeringDelays({ positions: pos, dispersionDeg: 60, steerDeg: 20, speedOfSound: C });
    expect(steered[0]).not.toBeCloseTo(steered[5], 6);
  });

  it('degrades to plane-wave steering as dispersion goes to zero', () => {
    const pos = positionsFromSpacing(5, 2);
    const plane = steeringDelays({ positions: pos, steerDeg: 25, speedOfSound: C });
    const almost = steeringDelays({ positions: pos, steerDeg: 25, dispersionDeg: 0.01, speedOfSound: C });
    for (let i = 0; i < pos.length; i++) expect(almost[i]).toBeCloseTo(plane[i], 6);
  });

  it('never produces a negative delay', () => {
    for (const disp of [0, 30, 80, 140]) {
      for (const steer of [-40, 0, 35]) {
        const d = steeringDelays({ positions: positionsFromSpan(7, 16), dispersionDeg: disp, steerDeg: steer, speedOfSound: C });
        expect(Math.min(...d)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('end-fire', () => {
  it('delays each cabinet by its own offset from the rear-most', () => {
    const pos = [-3, -2, -1, 0];
    const d = endFireDelays(pos, C);
    expect(d).toEqual([0, 1 / C, 2 / C, 3 / C]);
  });

  it('quarter-wavelength spacing puts a deep null behind the stack', () => {
    const f = 63;
    const d = endFireSpacingFor(f, C);
    expect(d).toBeCloseTo(C / f / 4, 12);
    const pos = [-3 * d, -2 * d, -d, 0];
    const delays = endFireDelays(pos, C);
    const sources = pos.map((p, i) => ({ ...omni(0, delays[i]), id: `e${i}`, position: { x: 0, y: p, z: 0 } }));
    const front = computePoint(sources, { x: 0, y: 200, z: 0 }, f, C).splDb;
    const back = computePoint(sources, { x: 0, y: -200, z: 0 }, f, C).splDb;
    expect(front - back).toBeGreaterThan(25);
  });
});

describe('pattern control limit', () => {
  it('is c / spacing for an unsteered array', () => {
    expect(patternControlLimitHz(2, C)).toBeCloseTo(C / 2, 9);
  });

  it('falls as the array is steered further off axis', () => {
    const straight = patternControlLimitHz(2, C, 0)!;
    const steered = patternControlLimitHz(2, C, 30)!;
    expect(steered).toBeLessThan(straight);
    expect(steered).toBeCloseTo(C / (2 * 1.5), 9);
  });

  it('is undefined for zero spacing', () => {
    expect(patternControlLimitHz(0, C)).toBeNull();
  });

  it('predicts where grating lobes actually appear', () => {
    const spacing = 2;
    const pos = positionsFromSpacing(8, spacing);
    const sources = pos.map((p) => omni(p, 0));
    const limit = patternControlLimitHz(spacing, C)!;
    const sideLobeLevel = (f: number) => {
      let best = -Infinity;
      for (let a = 35; a <= 89; a += 0.5) best = Math.max(best, splAtAngle(sources, a, f));
      return best - splAtAngle(sources, 0, f);
    };
    // well below the limit the array holds its pattern; at the limit it does not
    expect(sideLobeLevel(limit * 0.45)).toBeLessThan(-8);
    expect(sideLobeLevel(limit)).toBeGreaterThan(-1);
  });
});

describe('flown column tilt from geometry', () => {
  it('aims the array centre at the target', () => {
    // 6 cabinets of 0.585 m, top at 9 m => centre at 9 - 1.755 = 7.245 m
    const tilt = tiltAngleFromGeometry({
      arrayTopM: 9,
      cabinetHeightM: 0.585,
      count: 6,
      distanceM: 30,
      targetHeightM: 1.6,
    });
    expect(tilt).toBeCloseTo((Math.atan((9 - (0.585 * 6) / 2 - 1.6) / 30) * 180) / Math.PI, 9);
    expect(tilt).toBeGreaterThan(0); // aiming downwards
  });

  it('is zero when the array centre is level with the target', () => {
    expect(
      tiltAngleFromGeometry({ arrayTopM: 3.6, cabinetHeightM: 0.5, count: 4, distanceM: 25, targetHeightM: 2.6 }),
    ).toBeCloseTo(0, 9);
  });
});

describe('the seam between the tilt tool and the steering field', () => {
  /** One cabinet of a flown column: the same omni source, stacked along Z. */
  function stacked(zM: number, delayS: number): EngineSource {
    return { ...omni(0, delayS), id: `c${zM}`, position: { x: 0, y: 0, z: zM } };
  }

  /**
   * SPL on a far arc at `elevationDeg` above the horizontal, in the Y/Z plane.
   *
   * The arc is centred on the COLUMN, not on the origin: a rig 7 m up reads 2
   * degrees low on an arc drawn from the floor, which is the same size as the
   * errors this test exists to catch.
   */
  function splAtElevation(
    sources: EngineSource[],
    centreZ: number,
    elevationDeg: number,
    f: number,
  ): number {
    const a = (elevationDeg * Math.PI) / 180;
    const r = 200;
    return computePoint(sources, { x: 0, y: r * Math.cos(a), z: centreZ + r * Math.sin(a) }, f, C).splDb;
  }

  /** Elevation of the strongest lobe, searched above and below the horizontal. */
  function mainLobeElevation(sources: EngineSource[], centreZ: number, f: number): number {
    let best = -Infinity;
    let bestEl = 0;
    for (let el = -60; el <= 60; el += 0.25) {
      const v = splAtElevation(sources, centreZ, el, f);
      if (v > best) { best = v; bestEl = el; }
    }
    return bestEl;
  }

  // A real flown column: 6 KS28 of 0.55 m, top face at 9 m, aimed at ears 1.6 m
  // up and 30 m out. This is the panel's own worked example.
  const H = 0.55;
  const COUNT = 6;
  const geometry = { arrayTopM: 9, cabinetHeightM: H, count: COUNT, distanceM: 30, targetHeightM: 1.6 };

  it('disagrees in sign, which is the whole reason the conversion exists', () => {
    const tilt = tiltAngleFromGeometry(geometry);
    expect(tilt).toBeGreaterThan(0); // positive is DOWN, the rigger's convention
    expect(steerDegForDownTilt(tilt)).toBeCloseTo(-tilt, 12);
  });

  it('aims the column DOWN at the angle the geometry asked for', () => {
    // The composition nothing tested: geometry -> down-tilt -> aim angle ->
    // delays -> real engine. Feeding the tilt straight into the aim steered this
    // column 10.9 degrees into the roof instead, an error of 21.7 degrees, under
    // a readout that went on saying "down-tilt".
    const tilt = tiltAngleFromGeometry(geometry);
    const centreZ = 9 - (COUNT * H) / 2;
    const centres = positionsFromSpacing(COUNT, H).map((p) => centreZ + p);
    const delays = steeringDelays({
      positions: positionsFromSpacing(COUNT, H),
      steerDeg: steerDegForDownTilt(tilt),
      speedOfSound: C,
    });
    const column = centres.map((z, i) => stacked(z, delays[i]));

    expect(mainLobeElevation(column, centreZ, 100)).toBeCloseTo(-tilt, 0);
    // and the cabinet at the top of the column fires FIRST, which is what tips
    // the wavefront downward
    expect(delays[delays.length - 1]).toBeCloseTo(0, 12);
    expect(delays[0]).toBeGreaterThan(delays[delays.length - 1]);
  });
});

describe('level taper', () => {
  it('is zero in the centre and reaches edgeDb at the outermost cabinet', () => {
    const pos = positionsFromSpacing(5, 2);
    const t = levelTaper(pos, -6);
    expect(t[2]).toBeCloseTo(0, 12);
    expect(t[0]).toBeCloseTo(-6, 12);
    expect(t[4]).toBeCloseTo(-6, 12);
    expect(Math.abs(t[1])).toBeLessThan(Math.abs(t[0]));
  });

  it('is a no-op at 0 dB', () => {
    expect(levelTaper(positionsFromSpacing(4, 1), 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('steering is frequency independent in aim', () => {
  it('keeps the same main-lobe angle across the sub band', () => {
    const pos = positionsFromSpacing(8, 1.2);
    const d = steeringDelays({ positions: pos, steerDeg: 25, speedOfSound: C });
    const sources = pos.map((p, i) => omni(p, d[i]));
    for (const f of [40, 63, 100]) expect(mainLobeAngle(sources, f)).toBeCloseTo(25, 0);
    // and the response at the aim point stays smooth
    const a = (25 * Math.PI) / 180;
    const spec = computeSpectrum(sources, { x: 200 * Math.sin(a), y: 200 * Math.cos(a), z: 0 }, [40, 63, 100], C);
    expect([...spec].every((v) => isFinite(v))).toBe(true);
  });
});

describe('overall footprint width', () => {
  it('measures across the outer faces of the end cabinets', () => {
    // 4 cabinets of 1.34 m at 2 m centres: 3 gaps of 2 m plus one cabinet width
    expect(overallWidth(4, 2, 1.34)).toBeCloseTo(7.34, 9);
    // a single cabinet's footprint is just its own width
    expect(overallWidth(1, 2, 1.34)).toBeCloseTo(1.34, 9);
  });

  it('inverts back to the spacing that produces it', () => {
    for (const [n, w] of [[4, 1.34], [8, 0.6], [16, 1.16], [2, 1.4]] as const) {
      for (const overall of [6, 12, 22.5, 40]) {
        const sp = spacingFromOverallWidth(n, overall, w);
        expect(overallWidth(n, sp, w)).toBeCloseTo(overall, 9);
      }
    }
  });

  it('never returns a negative spacing when the target is narrower than one cabinet', () => {
    expect(spacingFromOverallWidth(4, 0.5, 1.34)).toBe(0);
    expect(spacingFromOverallWidth(1, 10, 1.34)).toBe(0);
  });

  it('leaves an edge gap of spacing minus cabinet width', () => {
    const sp = spacingFromOverallWidth(5, 10, 1.2);
    expect(sp - 1.2).toBeCloseTo((10 - 1.2) / 4 - 1.2, 9);
  });

  it('redistributes rather than stretches when the count changes', () => {
    // The taped-out width is the fixed quantity on a deck: adding cabinets has to
    // tighten the pitch, not push the end boxes further apart. This is what the
    // SUBS panel holds constant when "No. of positions" changes.
    const w = 1.34;
    const overall = 20;
    let previous = Infinity;
    for (const n of [4, 6, 8, 12, 16]) {
      const sp = spacingFromOverallWidth(n, overall, w);
      expect(overallWidth(n, sp, w)).toBeCloseTo(overall, 9);
      expect(sp).toBeLessThan(previous);
      previous = sp;
    }
  });
});

describe('a vertical stack, placed by a face', () => {
  const H = 0.571; // KS21, manufacturer

  it('puts a ground stack on the floor when the deck height is zero', () => {
    const centre = stackCentreFromRef(4, H, 0, 'stacked');
    const { bottomM, topM, heightM } = stackExtent(4, H, centre);
    expect(bottomM).toBeCloseTo(0, 9);
    expect(topM).toBeCloseTo(4 * H, 9);
    expect(heightM).toBeCloseTo(4 * H, 9);
  });

  it('hangs a flown column from the height its top rigs at', () => {
    const centre = stackCentreFromRef(4, H, 9, 'flying');
    const { bottomM, topM } = stackExtent(4, H, centre);
    expect(topM).toBeCloseTo(9, 9);
    expect(bottomM).toBeCloseTo(9 - 4 * H, 9);
  });

  it('measures the faces, not the outermost centres', () => {
    // The distinction is half a cabinet at each end, which is exactly the error
    // you get by taping out a column from the centres of the end boxes.
    const centre = stackCentreFromRef(3, H, 0, 'stacked');
    const lowestCabinet = centre - ((3 - 1) * H) / 2;
    expect(lowestCabinet).toBeCloseTo(H / 2, 9);
    expect(stackExtent(3, H, centre).bottomM).toBeCloseTo(0, 9);
  });

  it('round-trips through the centre in both mounts', () => {
    for (const mount of ['stacked', 'flying'] as const) {
      for (const n of [1, 2, 3, 8]) {
        const ref = 7.25;
        const centre = stackCentreFromRef(n, H, ref, mount);
        expect(stackRefFromCentre(n, H, centre, mount)).toBeCloseTo(ref, 9);
      }
    }
  });

  it('places a single cabinet half a box from its own reference face', () => {
    expect(stackCentreFromRef(1, H, 0, 'stacked')).toBeCloseTo(H / 2, 9);
    expect(stackCentreFromRef(1, H, 9, 'flying')).toBeCloseTo(9 - H / 2, 9);
  });
});

describe('anchoring a block to one of its ends', () => {
  it('leaves everything alone when the anchor is the centre', () => {
    expect(centreFromAnchor(11.84, 3.2, 'centre')).toBe(3.2);
    expect(anchorFromCentre(11.84, 3.2, 'centre')).toBe(3.2);
  });

  it('measures to the outer faces, half a block either side', () => {
    expect(anchorFromCentre(11.84, 0, 'low')).toBeCloseTo(-5.92, 9);
    expect(anchorFromCentre(11.84, 0, 'high')).toBeCloseTo(5.92, 9);
    expect(centreFromAnchor(11.84, -5.92, 'low')).toBeCloseTo(0, 9);
    expect(centreFromAnchor(11.84, 5.92, 'high')).toBeCloseTo(0, 9);
  });

  it('round-trips through the centre for every anchor and width', () => {
    for (const anchor of ['low', 'centre', 'high'] as const) {
      for (const overall of [0, 1.34, 11.84, 40]) {
        const centre = centreFromAnchor(overall, 7.5, anchor);
        expect(anchorFromCentre(overall, centre, anchor)).toBeCloseTo(7.5, 9);
      }
    }
  });

  it('is the same arithmetic a vertical stack already uses', () => {
    // stackCentreFromRef is now this function with the column height worked out
    // for it, which is why a stack and a horizontal block cannot drift apart.
    const H = 0.571;
    expect(stackCentreFromRef(4, H, 0, 'stacked')).toBeCloseTo(
      centreFromAnchor(4 * H, 0, 'low'),
      9,
    );
    expect(stackCentreFromRef(4, H, 9, 'flying')).toBeCloseTo(
      centreFromAnchor(4 * H, 9, 'high'),
      9,
    );
  });
});
