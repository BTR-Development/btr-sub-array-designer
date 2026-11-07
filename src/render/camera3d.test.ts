/**
 * The 3D camera, and the thing that matters most about it: that it agrees with
 * the two 2D views about which way the room faces.
 *
 * This program has already had one plane-convention bug — the side view drew a
 * front elevation for four days and showed a stage-wide sub line end-on — and
 * the fix left two hand-written copies of the old pairing behind. A third view
 * with its own idea of the axes would be the same bug with more places to
 * hide, so the first two cases below pin the 3D camera to the 2D views at the
 * angles where they are the same picture.
 */
import { describe, it, expect } from 'vitest';
import {
  affineForQuad,
  basisOf,
  clipSegment,
  DEFAULT_CAMERA,
  depthOf,
  fitCamera,
  orbit,
  pan,
  PITCH_RANGE,
  project,
  gridStepFor,
  SCALE_RANGE,
  zoom,
  zoomAt,
  type Camera3D,
  type Viewport3D,
} from './camera3d';
import { gridStep, worldToScreen, type Viewport } from './view';
import type { Vec3 } from '../core/types';

const cam = (over: Partial<Camera3D> = {}): Camera3D => ({
  yawDeg: 0,
  pitchDeg: 0,
  scale: 10,
  target: { x: 0, y: 0, z: 0 },
  ...over,
});
const vp = (c: Camera3D, width = 800, height = 600): Viewport3D => ({ width, height, cam: c });

const close = (v: Vec3, x: number, y: number, z: number, p = 9) => {
  expect(v.x).toBeCloseTo(x, p);
  expect(v.y).toBeCloseTo(y, p);
  expect(v.z).toBeCloseTo(z, p);
};

describe('the 3D camera agrees with the 2D views', () => {
  it('is the top view when it looks straight down', () => {
    const b = basisOf(cam({ yawDeg: 0, pitchDeg: 90 }));
    close(b.dir, 0, 0, -1);
    close(b.right, 1, 0, 0);
    close(b.up, 0, 1, 0);
  });

  it('is the side view when it looks along the stage width', () => {
    // The 2D side view draws horizontal = Y, vertical = Z: a section ALONG the
    // room, which is the only orientation that does not show a stage-wide sub
    // line end-on.
    const b = basisOf(cam({ yawDeg: 270, pitchDeg: 0 }));
    close(b.right, 0, 1, 0);
    close(b.up, 0, 0, 1);
    close(b.dir, -1, 0, 0);
  });

  it('puts the same pixels on the screen as the 2D top view does', () => {
    const c = cam({ yawDeg: 0, pitchDeg: 90, scale: 17, target: { x: 3, y: -2, z: 0 } });
    const flat: Viewport = { width: 800, height: 600, view: { scale: 17, cx: 3, cy: -2 } };
    for (const p of [
      { x: 0, y: 0, z: 0 },
      { x: 12, y: -5, z: 1.3 },
      { x: -4.25, y: 9.5, z: -2 },
    ]) {
      const [ax, ay] = project(vp(c), p);
      const [bx, by] = worldToScreen(flat, p.x, p.y);
      expect(ax).toBeCloseTo(bx, 9);
      expect(ay).toBeCloseTo(by, 9);
    }
  });
});

describe('the basis', () => {
  it('stays orthonormal all the way round', () => {
    for (let yaw = 0; yaw < 360; yaw += 23) {
      for (let pitch = -85; pitch <= 85; pitch += 17) {
        const b = basisOf(cam({ yawDeg: yaw, pitchDeg: pitch }));
        for (const v of [b.dir, b.right, b.up]) {
          expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 9);
        }
        const d = (a: Vec3, c: Vec3) => a.x * c.x + a.y * c.y + a.z * c.z;
        expect(d(b.dir, b.right)).toBeCloseTo(0, 9);
        expect(d(b.dir, b.up)).toBeCloseTo(0, 9);
        expect(d(b.right, b.up)).toBeCloseTo(0, 9);
      }
    }
  });

  it('keeps the screen horizontal horizontal, whatever the pitch', () => {
    // A tilted horizon on a measuring tool is a bug, not a style.
    for (const pitch of [-80, -30, 0, 22, 60, 89]) {
      expect(basisOf(cam({ yawDeg: 143, pitchDeg: pitch })).right.z).toBeCloseTo(0, 12);
    }
  });
});

describe('depth', () => {
  it('grows away from the camera', () => {
    const c = cam({ yawDeg: 180, pitchDeg: 0 });
    // yaw 180 looks along -Y, so smaller Y is further away
    expect(depthOf(c, { x: 0, y: -10, z: 0 })).toBeGreaterThan(depthOf(c, { x: 0, y: 10, z: 0 }));
  });

  it('ignores movement across the view axis', () => {
    const c = cam({ yawDeg: 0, pitchDeg: 30 });
    const b = basisOf(c);
    const base = { x: 1, y: 2, z: 3 };
    const sideways: Vec3 = {
      x: base.x + b.right.x * 5,
      y: base.y + b.right.y * 5,
      z: base.z + b.right.z * 5,
    };
    expect(depthOf(c, sideways)).toBeCloseTo(depthOf(c, base), 9);
  });
});

describe('laying an image into the scene', () => {
  it('maps the image corners exactly onto the projected world corners', () => {
    // The whole reason the camera is orthographic: a plane projects to a
    // parallelogram, so this is an affine transform and the SPL map goes in
    // without being resampled by hand.
    const v = vp(cam({ yawDeg: 143, pitchDeg: 27, scale: 9 }));
    const origin = { x: -8, y: 20, z: 1.6 };
    const alongX = { x: 8, y: 20, z: 1.6 };
    const alongY = { x: -8, y: 2, z: 1.6 };
    const w = 160;
    const h = 90;
    const t = affineForQuad(v, origin, alongX, alongY, w, h);
    if (!t) throw new Error('no transform');
    const [a, b, c, d, e, f] = t;
    const apply = (ix: number, iy: number): [number, number] => [
      a * ix + c * iy + e,
      b * ix + d * iy + f,
    ];
    expect(apply(0, 0)).toEqual(project(v, origin));
    const [ux, uy] = apply(w, 0);
    const [pux, puy] = project(v, alongX);
    expect(ux).toBeCloseTo(pux, 9);
    expect(uy).toBeCloseTo(puy, 9);
    const [vx, vy] = apply(0, h);
    const [pvx, pvy] = project(v, alongY);
    expect(vx).toBeCloseTo(pvx, 9);
    expect(vy).toBeCloseTo(pvy, 9);
    // and the fourth corner follows, which is what "parallelogram" means
    const [qx, qy] = apply(w, h);
    const [ex, ey] = project(v, {
      x: alongX.x + alongY.x - origin.x,
      y: alongX.y + alongY.y - origin.y,
      z: alongX.z + alongY.z - origin.z,
    });
    expect(qx).toBeCloseTo(ex, 9);
    expect(qy).toBeCloseTo(ey, 9);
  });

  it('refuses an image with no pixels rather than dividing by zero', () => {
    const v = vp(cam());
    const p = { x: 0, y: 0, z: 0 };
    expect(affineForQuad(v, p, p, p, 0, 10)).toBeNull();
    expect(affineForQuad(v, p, p, p, 10, 0)).toBeNull();
  });
});

describe('driving the camera', () => {
  it('clamps the pitch short of straight down and wraps the yaw', () => {
    expect(orbit(cam({ pitchDeg: 80 }), 0, 1000).pitchDeg).toBe(PITCH_RANGE[1]);
    expect(orbit(cam({ pitchDeg: -80 }), 0, -1000).pitchDeg).toBe(PITCH_RANGE[0]);
    expect(orbit(cam({ yawDeg: 10 }), 100, 0).yawDeg).toBeCloseTo(330, 9);
    expect(orbit(cam({ yawDeg: 350 }), -100, 0).yawDeg).toBeCloseTo(30, 9);
  });

  it('bounds the zoom at both ends', () => {
    expect(zoom(cam({ scale: 2 }), 0.001).scale).toBe(SCALE_RANGE[0]);
    expect(zoom(cam({ scale: 200 }), 1000).scale).toBe(SCALE_RANGE[1]);
  });

  it('pans so a point tracks the pointer', () => {
    const v = vp(cam({ yawDeg: 37, pitchDeg: 19, scale: 12 }));
    const p = { x: 2, y: 5, z: 1 };
    const before = project(v, p);
    const after = project({ ...v, cam: pan(v, 40, -25) }, p);
    expect(after[0] - before[0]).toBeCloseTo(40, 6);
    expect(after[1] - before[1]).toBeCloseTo(-25, 6);
  });
});

describe('framing a rig', () => {
  it('fits every point inside the viewport with its margin', () => {
    const points: Vec3[] = [
      { x: -12, y: 0, z: 0 },
      { x: 12, y: 0, z: 2.3 },
      { x: 0, y: 30, z: 0 },
    ];
    const v = vp(fitCamera(DEFAULT_CAMERA, points, 800, 600, 40), 800, 600);
    for (const p of points) {
      const [sx, sy] = project(v, p);
      expect(sx).toBeGreaterThanOrEqual(39);
      expect(sx).toBeLessThanOrEqual(761);
      expect(sy).toBeGreaterThanOrEqual(39);
      expect(sy).toBeLessThanOrEqual(561);
    }
  });

  it('fills the viewport rather than leaving the rig a speck', () => {
    const points: Vec3[] = [
      { x: -12, y: 0, z: 0 },
      { x: 12, y: 0, z: 0 },
      { x: 0, y: 30, z: 0 },
    ];
    const v = vp(fitCamera(DEFAULT_CAMERA, points, 800, 600, 40), 800, 600);
    const xs = points.map((p) => project(v, p)[0]);
    const ys = points.map((p) => project(v, p)[1]);
    const usedW = Math.max(...xs) - Math.min(...xs);
    const usedH = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(usedW / (800 - 80), usedH / (600 - 80))).toBeGreaterThan(0.98);
  });

  it('leaves the camera alone when there is nothing to frame', () => {
    expect(fitCamera(DEFAULT_CAMERA, [], 800, 600)).toEqual(DEFAULT_CAMERA);
    expect(fitCamera(DEFAULT_CAMERA, [{ x: 0, y: 0, z: 0 }], 0, 600)).toEqual(DEFAULT_CAMERA);
  });
});

describe('framing, after the fix', () => {
  /**
   * `fitCamera` scales for the bounding box, so it has to CENTRE on the
   * bounding box. Centred on the point-cloud centroid instead, a rig with many
   * cabinets at one end and a wide prediction plane at the other pulled the
   * camera toward the cabinets and pushed the far corners of the plane off the
   * bottom of a canvas that still had vertical slack. The case above did not
   * catch it because its three points happen to be symmetric.
   */
  const asymmetric: Vec3[] = [
    // eight cabinets bunched at one end...
    ...Array.from({ length: 8 }, (_, i) => ({ x: -10 + i * 0.3, y: 0, z: 0.3 })),
    // ...and the prediction plane spread across the room
    { x: -10, y: -2, z: 1.2 },
    { x: 10, y: -2, z: 1.2 },
    { x: -10, y: 28, z: 1.2 },
    { x: 10, y: 28, z: 1.2 },
  ];

  it('keeps a lopsided scene inside the viewport', () => {
    const v = vp(fitCamera(DEFAULT_CAMERA, asymmetric, 800, 600, 48), 800, 600);
    for (const p of asymmetric) {
      const [sx, sy] = project(v, p);
      expect(sx, `x of ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(0);
      expect(sx, `x of ${JSON.stringify(p)}`).toBeLessThanOrEqual(800);
      expect(sy, `y of ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(0);
      expect(sy, `y of ${JSON.stringify(p)}`).toBeLessThanOrEqual(600);
    }
  });

  it('centres it, rather than merely containing it', () => {
    const v = vp(fitCamera(DEFAULT_CAMERA, asymmetric, 800, 600, 48), 800, 600);
    const xs = asymmetric.map((p) => project(v, p)[0]);
    const ys = asymmetric.map((p) => project(v, p)[1]);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(400, 6);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(300, 6);
  });

  it('does not collapse into the scale floor in a short viewport', () => {
    // A fixed 48 px margin exceeds a 96 px canvas twice over, which drove the
    // scale to the clamp floor of 1 px/m and turned a 20 m array into 20 px.
    for (const [w, h] of [[800, 96], [800, 80], [120, 90]] as Array<[number, number]>) {
      const cam = fitCamera(DEFAULT_CAMERA, asymmetric, w, h);
      expect(cam.scale, `${w}x${h}`).toBeGreaterThan(SCALE_RANGE[0]);
    }
  });
});

describe('a plane seen edge-on', () => {
  it('is refused rather than drawn as a line with no explanation', () => {
    // A vertical prediction plane at the default camera is exactly edge-on,
    // so this is what the side-view plane does the moment the 3D view opens.
    const v = vp(cam({ yawDeg: 180, pitchDeg: 0 }));
    const edgeOn = affineForQuad(
      v,
      { x: 0, y: -5, z: 0 },
      { x: 0, y: 5, z: 0 },
      { x: 0, y: -5, z: 3 },
      100,
      60,
    );
    expect(edgeOn).toBeNull();
    // ...and a plane the camera can actually see still comes back
    expect(
      affineForQuad(v, { x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, { x: -5, y: 0, z: 3 }, 100, 60),
    ).not.toBeNull();
  });
});

describe('one grid ladder for the whole program', () => {
  it('gives the 3D floor exactly the squares the 2D views draw', () => {
    // Two ladders disagreed on 42% of the zoom range: at scale 30 one view
    // drew 5 m squares and the other 2 m, with no label on either.
    for (let scale = 1; scale <= 400; scale += 0.37) {
      expect(gridStepFor(scale), `scale ${scale}`).toBe(gridStep(scale));
    }
  });
});

describe('zooming about the cursor', () => {
  const vp = (cam: Camera3D): Viewport3D => ({ width: 800, height: 600, cam });

  it('keeps the world point under the pointer exactly where it was', () => {
    // Over a spread of camera angles, because the shift is along the camera's
    // own screen axes and a basis mix-up only shows up away from the cardinal
    // views. Zoomed BOTH ways: an in-zoom that pins the point and an out-zoom
    // that pushes it off would both pass a one-direction test.
    for (const cam of [
      { yawDeg: 180, pitchDeg: 22, scale: 14, target: { x: 0, y: 6, z: 1 } },
      { yawDeg: 37, pitchDeg: 61, scale: 30, target: { x: -3, y: 2, z: 0.5 } },
      { yawDeg: 295, pitchDeg: -14, scale: 8, target: { x: 11, y: -4, z: 2 } },
    ] as Camera3D[]) {
      for (const [px, py] of [[120, 90], [700, 540], [400, 300], [0, 0]]) {
        for (const factor of [1.25, 0.8, 2, 0.5]) {
          const before = vp(cam);
          // the world point the pointer is over, on the screen plane through
          // the target — reconstructed from the camera basis, not from the
          // function under test
          const b = basisOf(cam);
          const h = (px - 400) / cam.scale;
          const v = -(py - 300) / cam.scale;
          const world: Vec3 = {
            x: cam.target.x + b.right.x * h + b.up.x * v,
            y: cam.target.y + b.right.y * h + b.up.y * v,
            z: cam.target.z + b.right.z * h + b.up.z * v,
          };
          expect(project(before, world)[0]).toBeCloseTo(px, 6);

          const after = vp(zoomAt(before, factor, px, py));
          expect(after.cam.scale).toBeCloseTo(cam.scale * factor, 9);
          const [ax, ay] = project(after, world);
          expect(ax, `${cam.yawDeg}/${factor} at ${px},${py}`).toBeCloseTo(px, 6);
          expect(ay, `${cam.yawDeg}/${factor} at ${px},${py}`).toBeCloseTo(py, 6);
        }
      }
    }
  });

  it('matches plain centre zoom when the pointer IS the centre', () => {
    const cam: Camera3D = { yawDeg: 143, pitchDeg: 31, scale: 20, target: { x: 2, y: 5, z: 1 } };
    const a = zoomAt(vp(cam), 1.4, 400, 300);
    const b = zoom(cam, 1.4);
    expect(a.scale).toBeCloseTo(b.scale, 9);
    expect(a.target).toEqual(cam.target);
  });

  it('does not creep once it has hit the zoom stop', () => {
    // At the clamp the scale cannot move, so neither may the target: a shift
    // computed from the UNclamped scale slides the view sideways on every
    // further notch of the wheel, which is how a zoom limit turns into a
    // runaway pan.
    for (const scale of [SCALE_RANGE[0], SCALE_RANGE[1]]) {
      const cam: Camera3D = { yawDeg: 180, pitchDeg: 22, scale, target: { x: 0, y: 6, z: 1 } };
      const past = scale === SCALE_RANGE[0] ? 0.5 : 2;
      const out = zoomAt(vp(cam), past, 90, 120);
      expect(out.scale).toBe(scale);
      expect(out.target).toEqual(cam.target);
    }
  });

  it('still clamps, and pins the pointer at the clamped scale', () => {
    // A zoom that is PARTLY allowed: it must land on the stop and the point
    // under the pointer must hold, which is the case that catches a shift
    // computed from the requested scale rather than the granted one.
    const cam: Camera3D = { yawDeg: 180, pitchDeg: 22, scale: SCALE_RANGE[1] * 0.8, target: { x: 0, y: 6, z: 1 } };
    const before = vp(cam);
    const b = basisOf(cam);
    const h = (150 - 400) / cam.scale;
    const v = -(200 - 300) / cam.scale;
    const world: Vec3 = {
      x: cam.target.x + b.right.x * h + b.up.x * v,
      y: cam.target.y + b.right.y * h + b.up.y * v,
      z: cam.target.z + b.right.z * h + b.up.z * v,
    };
    const after = vp(zoomAt(before, 4, 150, 200));
    expect(after.cam.scale).toBe(SCALE_RANGE[1]);
    const [ax, ay] = project(after, world);
    expect(ax).toBeCloseTo(150, 6);
    expect(ay).toBeCloseTo(200, 6);
  });
});

describe('clipping a gridline to the canvas', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 80 };

  it('keeps a segment that is already inside, unchanged', () => {
    expect(clipSegment([10, 10], [90, 70], rect)).toEqual([[10, 10], [90, 70]]);
  });

  it('cuts a segment that runs out of the rectangle at the edge', () => {
    const out = clipSegment([-50, 40], [150, 40], rect);
    expect(out).not.toBeNull();
    expect(out![0][0]).toBeCloseTo(0, 9);
    expect(out![1][0]).toBeCloseTo(100, 9);
    expect(out![0][1]).toBeCloseTo(40, 9);
  });

  it('drops a segment that misses entirely', () => {
    expect(clipSegment([-10, -10], [-5, 90], rect)).toBeNull();
    expect(clipSegment([200, 0], [300, 80], rect)).toBeNull();
    // parallel to an edge and outside it, which is the case the degenerate
    // branch of the algorithm decides
    expect(clipSegment([10, -5], [90, -5], rect)).toBeNull();
    expect(clipSegment([-5, 10], [-5, 70], rect)).toBeNull();
  });

  it('keeps a line that runs along an edge', () => {
    expect(clipSegment([-10, 0], [110, 0], rect)).not.toBeNull();
  });

  it('puts both ends on the rectangle when the line crosses it corner to corner', () => {
    const out = clipSegment([-100, -80], [200, 160], rect);
    expect(out).not.toBeNull();
    for (const [x, y] of out!) {
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(x).toBeLessThanOrEqual(100 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(80 + 1e-9);
    }
  });

  it('is the real intersection, not a bounding box, over a spread of lines', () => {
    // Sampled against a brute-force walk of the segment: every point the clip
    // claims is inside must be inside, and no point the walk finds inside may
    // lie outside what the clip returned.
    let checked = 0;
    for (const a of [[-30, -20], [50, -40], [130, 30], [-10, 120]] as Array<[number, number]>) {
      for (const b of [[120, 100], [40, 130], [-40, 50], [60, 20]] as Array<[number, number]>) {
        const out = clipSegment(a, b, rect);
        const inside = (t: number) => {
          const x = a[0] + t * (b[0] - a[0]);
          const y = a[1] + t * (b[1] - a[1]);
          return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1;
        };
        const hits: number[] = [];
        for (let k = 0; k <= 2000; k++) if (inside(k / 2000)) hits.push(k / 2000);
        if (!hits.length) {
          expect(out, `${a}->${b}`).toBeNull();
          continue;
        }
        checked++;
        expect(out, `${a}->${b}`).not.toBeNull();
        const t = (p: [number, number]) =>
          Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])
            ? (p[0] - a[0]) / (b[0] - a[0])
            : (p[1] - a[1]) / (b[1] - a[1]);
        expect(t(out![0]), `${a}->${b} start`).toBeCloseTo(hits[0], 2);
        expect(t(out![1]), `${a}->${b} end`).toBeCloseTo(hits[hits.length - 1], 2);
      }
    }
    expect(checked).toBeGreaterThan(8);
  });
});
