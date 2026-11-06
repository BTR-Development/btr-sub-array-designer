/**
 * Projection tests.
 *
 * The pairing of world axes with screen axes was wrong once already (side view
 * drew X/Z, a front elevation, instead of Y/Z, a section along the room) and the
 * fix left two hand-written copies behind that kept the old pairing. Nothing
 * crashed: a click just probed somewhere else. These tests pin the mapping in
 * both directions so a silent rotation of the world cannot come back.
 */
import { describe, expect, it } from 'vitest';
import { areaSize, scaleAreaTo, drawnAxes, fromPlaneAxes, planeAxes, planeDelta, pointOnPlane,
  planeImageCorners,
} from './view';
import type { Vec3 } from '../core/types';

const P: Vec3 = { x: 3, y: 7, z: 2 };

describe('plane projection', () => {
  it('top view draws X across and Y up', () => {
    expect(planeAxes('top', P)).toEqual([3, 7]);
  });

  it('side view draws Y across and Z up, never X', () => {
    // A section ALONG the room: horizontal is depth. X across would be a front
    // elevation, which shows a stage-wide sub line end-on.
    expect(planeAxes('side', P)).toEqual([7, 2]);
  });

  it('round trips through the screen axes', () => {
    for (const plane of ['top', 'side'] as const) {
      const [h, v] = planeAxes(plane, P);
      expect(fromPlaneAxes(plane, h, v, P)).toEqual(P);
    }
  });

  it('keeps the untouched coordinate when a point is dragged', () => {
    expect(fromPlaneAxes('top', 10, 20, P)).toEqual({ x: 10, y: 20, z: 2 });
    expect(fromPlaneAxes('side', 10, 20, P)).toEqual({ x: 3, y: 10, z: 20 });
  });

  it('drags never move the fixed axis', () => {
    expect(planeDelta('top', 1, 2)).toEqual({ x: 1, y: 2, z: 0 });
    expect(planeDelta('side', 1, 2)).toEqual({ x: 0, y: 1, z: 2 });
  });
});

describe('pointOnPlane', () => {
  it('places a fresh point on the drawn section', () => {
    expect(pointOnPlane('top', 4, 9, 1.7)).toEqual({ x: 4, y: 9, z: 1.7 });
    expect(pointOnPlane('side', 4, 9, 1.7)).toEqual({ x: 1.7, y: 4, z: 9 });
  });

  it('lands where the click was, on both planes', () => {
    // The regression it exists to stop: the old side branch put the horizontal
    // click value into X, so the probe read a point the cursor never touched.
    for (const plane of ['top', 'side'] as const) {
      expect(planeAxes(plane, pointOnPlane(plane, 4, 9, 1.7))).toEqual([4, 9]);
    }
  });
});

describe('drawnAxes', () => {
  it('names the axes each plane actually shows', () => {
    expect(drawnAxes('top')).toEqual(['x', 'y']);
    expect(drawnAxes('side')).toEqual(['y', 'z']);
  });

  it('agrees with the projection it describes', () => {
    // Anything that decides WHERE to place something reads this; if it drifted
    // from planeAxes, things would be placed off the visible section.
    for (const plane of ['top', 'side'] as const) {
      const [ha, va] = drawnAxes(plane);
      const p: Vec3 = { x: 1, y: 2, z: 3 };
      expect(planeAxes(plane, p)).toEqual([p[ha], p[va]]);
    }
  });
});

describe('laying the SPL image onto its plane', () => {
  it('puts image row 0 at the HIGH end of the vertical axis, in both planes', () => {
    // The 2D views draw the image from (xMin, vMax) to (xMax, vMin), and the
    // 3D viewport lays the same bitmap in with an affine transform. Disagree
    // and the same solve comes out mirrored in one of the two views, with
    // nothing on screen to say which one is lying.
    const r = { xMin: -8, xMax: 12, vMin: -2, vMax: 30 };

    const top = planeImageCorners('top', r, 1.6);
    expect(top.origin).toEqual({ x: -8, y: 30, z: 1.6 });
    expect(top.alongX).toEqual({ x: 12, y: 30, z: 1.6 });
    expect(top.alongY).toEqual({ x: -8, y: -2, z: 1.6 });

    const side = planeImageCorners('side', r, 3);
    expect(side.origin).toEqual({ x: 3, y: -8, z: 30 });
    expect(side.alongX).toEqual({ x: 3, y: 12, z: 30 });
    expect(side.alongY).toEqual({ x: 3, y: -8, z: -2 });
  });
});

describe('scaling the prediction plane about the rig', () => {
  const area = { xMin: -25, xMax: 25, vMin: -5, vMax: 45, planeOffset: 0 };

  it('keeps the rig where it was on the map, not the area centre', () => {
    // rig at the origin, 10 % up from the bottom edge of a 50 m square
    const small = scaleAreaTo(area, 20, [0, 0]);
    expect(areaSize(small)).toBeCloseTo(20, 9);
    // the rig is still INSIDE, and still 10 % from the bottom
    expect(small.vMin).toBeCloseTo(-2, 9);
    expect(small.vMax).toBeCloseTo(18, 9);
    expect(small.xMin).toBeCloseTo(-10, 9);
    expect(small.xMax).toBeCloseTo(10, 9);
    // scaling about the AREA centre instead left y 10..30 — rig off the map
    expect(small.vMin).toBeLessThan(0);
  });

  it('grows the same way, and keeps the proportions', () => {
    const wide = { ...area, vMax: 20 }; // 50 x 25
    const big = scaleAreaTo(wide, 200, [0, 0]);
    expect(big.xMax - big.xMin).toBeCloseTo(200, 9);
    expect(big.vMax - big.vMin).toBeCloseTo(100, 9);
  });

  it('a pivot outside the area is pulled onto it, so the map grows instead of sliding', () => {
    const out = scaleAreaTo(area, 100, [0, -40]);
    // pivot clamped to the bottom edge (-5): that edge stays put
    expect(out.vMin).toBeCloseTo(-5, 9);
    expect(out.vMax).toBeCloseTo(95, 9);
  });
});
