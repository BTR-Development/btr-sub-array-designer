/**
 * A cabinet drawn as a solid, and the one claim the drawing has to keep: that
 * it points where the prediction says it points.
 *
 * `cabinetFaces` takes its orientation from the engine's own `localFrame`
 * rather than from a second copy of the arithmetic. These cases pin the
 * consequences of that — front at azimuth 0 faces the audience, a reversed box
 * faces the stage, a rolled one lies on its side — because a picture that
 * disagrees with the prediction about which way a box points is the most
 * expensive kind of wrong this program can be: a reverse stack looks identical
 * to a plain one until somebody measures it on site.
 */
import { describe, it, expect } from 'vitest';
import {
  cabinetCorners,
  cabinetFaces,
  DEFAULT_LIGHT,
  facesCamera,
  shadeOf,
  type Face3D,
} from './box3d';
import { basisOf } from './camera3d';
import type { Vec3 } from '../core/types';
import { boxSize } from '../speakers/schema';
import { builtinProvider } from '../speakers/provider';

const KS21 = { widthM: 0.764, heightM: 0.571, depthM: 0.601 };
const at = { x: 0, y: 0, z: 0 };
const upright = { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 };

const faceOf = (faces: Face3D[], kind: Face3D['kind']) => {
  const f = faces.find((x) => x.kind === kind);
  if (!f) throw new Error(`no ${kind} face`);
  return f;
};
const close = (v: Vec3, x: number, y: number, z: number, p = 9) => {
  expect(v.x).toBeCloseTo(x, p);
  expect(v.y).toBeCloseTo(y, p);
  expect(v.z).toBeCloseTo(z, p);
};
/** Extent of a set of points on one world axis. */
const span = (ps: Vec3[], k: 'x' | 'y' | 'z') =>
  Math.max(...ps.map((p) => p[k])) - Math.min(...ps.map((p) => p[k]));

describe('which way the box points', () => {
  it('faces the audience at azimuth 0 and the stage at 180', () => {
    close(faceOf(cabinetFaces(at, upright, KS21), 'front').normal, 0, 1, 0);
    const reversed = cabinetFaces(at, { ...upright, azimuthDeg: 180 }, KS21);
    close(faceOf(reversed, 'front').normal, 0, -1, 0);
    // and the front face is on the far side of the box from where it was,
    // which is the whole reason a reverse stack is a gradient at all
    const y = (f: Face3D) => f.corners.reduce((a, c) => a + c.y, 0) / 4;
    expect(y(faceOf(cabinetFaces(at, upright, KS21), 'front'))).toBeCloseTo(0.601 / 2, 9);
    expect(y(faceOf(reversed, 'front'))).toBeCloseTo(-0.601 / 2, 9);
  });

  it('swings to +X at azimuth 90, the way the app measures azimuth', () => {
    close(faceOf(cabinetFaces(at, { ...upright, azimuthDeg: 90 }, KS21), 'front').normal, 1, 0, 0);
  });

  it('tilts the front up at positive elevation', () => {
    const f = faceOf(cabinetFaces(at, { ...upright, elevationDeg: 30 }, KS21), 'front');
    expect(f.normal.z).toBeCloseTo(Math.sin((30 * Math.PI) / 180), 9);
    expect(f.normal.y).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 9);
  });
});

describe('a cabinet on its end face', () => {
  it('stands as tall as it was wide, and vice versa', () => {
    const flat = cabinetCorners(at, upright, KS21);
    expect(span(flat, 'x')).toBeCloseTo(0.764, 9);
    expect(span(flat, 'z')).toBeCloseTo(0.571, 9);

    const onEnd = cabinetCorners(at, { ...upright, rollDeg: 90 }, KS21);
    expect(span(onEnd, 'x')).toBeCloseTo(0.571, 9);
    expect(span(onEnd, 'z')).toBeCloseTo(0.764, 9);
    // roll is about the FRONT axis, so the depth is the one side it cannot touch
    expect(span(onEnd, 'y')).toBeCloseTo(0.601, 9);
  });

  it('still points the same way, which is the point of rolling rather than turning', () => {
    close(faceOf(cabinetFaces(at, { ...upright, rollDeg: 90 }, KS21), 'front').normal, 0, 1, 0);
  });

  it('takes the PUBLISHED sides, so a rolled box is not rolled twice', () => {
    // `orientedDimensions` is the axis-aligned box a rolled cabinet OCCUPIES.
    // Handing that to a frame that also rotates squares the swap and the
    // cabinet draws upright again. Fed BOTH ways here, from the real library
    // record, so the case covers the call the viewport actually makes rather
    // than a hand-written pair that happens to be swapped.
    const m = builtinProvider.get('la-ks21');
    if (!m) throw new Error('the KS21 record is gone');
    const published = boxSize(m, 0);
    const alreadyRolled = boxSize(m, 90);

    const right = cabinetCorners(at, { ...upright, rollDeg: 90 }, published);
    expect(span(right, 'x')).toBeCloseTo(0.571, 9);
    expect(span(right, 'z')).toBeCloseTo(0.764, 9);

    const twice = cabinetCorners(at, { ...upright, rollDeg: 90 }, alreadyRolled);
    expect(span(twice, 'z')).toBeCloseTo(0.571, 9);
    expect(span(twice, 'z')).not.toBeCloseTo(span(right, 'z'), 3);
  });
});

describe('the solid itself', () => {
  it('is eight corners and six faces that all sit on the box', () => {
    const faces = cabinetFaces({ x: 2, y: -3, z: 1.4 }, { azimuthDeg: 33, elevationDeg: 7, rollDeg: 12 }, KS21);
    expect(faces).toHaveLength(6);
    expect(cabinetCorners({ x: 2, y: -3, z: 1.4 }, { azimuthDeg: 33, elevationDeg: 7, rollDeg: 12 }, KS21))
      .toHaveLength(8);
    const half = Math.hypot(0.764, 0.571, 0.601) / 2;
    for (const f of faces) {
      expect(Math.hypot(f.normal.x, f.normal.y, f.normal.z)).toBeCloseTo(1, 9);
      for (const c of f.corners) {
        expect(Math.hypot(c.x - 2, c.y + 3, c.z - 1.4)).toBeCloseTo(half, 9);
      }
    }
  });

  it('points every normal outward', () => {
    const centre = { x: 1, y: 2, z: 3 };
    for (const f of cabinetFaces(centre, { azimuthDeg: 50, elevationDeg: -11, rollDeg: 90 }, KS21)) {
      const mid = f.corners.reduce(
        (a, c) => ({ x: a.x + c.x / 4, y: a.y + c.y / 4, z: a.z + c.z / 4 }),
        { x: 0, y: 0, z: 0 },
      );
      const out = { x: mid.x - centre.x, y: mid.y - centre.y, z: mid.z - centre.z };
      expect(out.x * f.normal.x + out.y * f.normal.y + out.z * f.normal.z).toBeGreaterThan(0);
    }
  });

  it('shades between the ambient floor and full light, never outside', () => {
    // The light is normalised, so a face pointing straight at it is EXACTLY 1
    // — asserting "<= 1" against the raw vector passed by 0.0007 because the
    // vector is not a unit vector, which would have hidden a shade of 1.3 just
    // as happily.
    const light = DEFAULT_LIGHT;
    expect(Math.hypot(light.x, light.y, light.z)).toBeCloseTo(1, 12);
    expect(shadeOf(light)).toBeCloseTo(1, 12);
    expect(shadeOf({ x: -light.x, y: -light.y, z: -light.z })).toBeCloseTo(0.45, 12);
    // and nothing in between can escape the two
    for (const n of [
      { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 },
      { x: -1, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: -1 },
    ]) {
      const k = shadeOf(n);
      expect(k).toBeGreaterThanOrEqual(0.45);
      expect(k).toBeLessThanOrEqual(1);
    }
  });
});

describe('which faces get painted', () => {
  it('keeps the ones turned toward the camera and drops the rest', () => {
    // A sign error here hides the front of every cabinet and shows the inside
    // of the back, which on a reverse stack reads as the opposite rig.
    const dirFromAudience = { x: 0, y: -1, z: 0 }; // looking from +Y toward the stage
    const faces = cabinetFaces(at, upright, KS21);
    const visible = faces.filter((f) => facesCamera(f.normal, dirFromAudience)).map((f) => f.kind);
    expect(visible).toContain('front');
    expect(visible).not.toContain('back');

    // from behind, the other way round
    const fromStage = { x: 0, y: 1, z: 0 };
    const back = faces.filter((f) => facesCamera(f.normal, fromStage)).map((f) => f.kind);
    expect(back).toContain('back');
    expect(back).not.toContain('front');
  });

  it('never keeps a face and its opposite at once', () => {
    for (const yaw of [0, 37, 90, 143, 180, 250, 311]) {
      for (const pitch of [-60, -10, 15, 50]) {
        const dir = basisOf({ yawDeg: yaw, pitchDeg: pitch, scale: 10, target: at }).dir;
        const kept = new Set(
          cabinetFaces(at, { azimuthDeg: 21, elevationDeg: 5, rollDeg: 90 }, KS21)
            .filter((f) => facesCamera(f.normal, dir))
            .map((f) => f.kind),
        );
        for (const [a, b] of [['front', 'back'], ['left', 'right'], ['top', 'bottom']]) {
          expect(kept.has(a as never) && kept.has(b as never), `${yaw}/${pitch} ${a}+${b}`).toBe(false);
        }
      }
    }
  });
});
