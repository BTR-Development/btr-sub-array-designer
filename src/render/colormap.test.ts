/**
 * The colour scale, which had no importer in the whole suite.
 *
 * Every pixel of the heatmap and every segment of the legend comes out of this
 * file, and nothing held any of it: not the ramp's two ends, not the row flip
 * that decides which way up the map is drawn, not the fade below the floor, and
 * not the agreement between the bar the user reads a level off and the pixels
 * they read it for.
 *
 * The assertions below are against hand-computed values and against the
 * declared ends of each ramp, never against "whatever the LUT currently
 * contains" — a test that photographs the palette would pass through every
 * mutation that matters and fail on a deliberate recolour, which is backwards.
 *
 * jsdom does not implement `ImageData` (it belongs to the canvas package), so
 * the constructor is stood in for. It is a stub of the PLATFORM and of nothing
 * of ours: a Uint8ClampedArray of the right length, which is all `colorize`
 * touches and, crucially, which clamps and rounds exactly as the real one does.
 */
import { describe, expect, it } from 'vitest';
import {
  colorForFraction,
  colorize,
  legendTicks,
  paletteLut,
  quantise,
  type PaletteId,
} from './colormap';

class StubImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
globalThis.ImageData ??= StubImageData as unknown as typeof ImageData;

/** The RGB the LUT holds at one of its 256 steps. */
function lutAt(id: PaletteId, i: number): [number, number, number] {
  const l = paletteLut(id);
  return [l[i * 3], l[i * 3 + 1], l[i * 3 + 2]];
}

/** One pixel of a colorize() result, as [r, g, b, a]. Row 0 is the TOP row. */
function px(img: ImageData, x: number, y: number): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/** Every step of the ramp that is exactly this colour. */
function lutIndicesOf(id: PaletteId, rgb: number[]): number[] {
  const l = paletteLut(id);
  const out: number[] = [];
  for (let i = 0; i < 256; i++) {
    if (l[i * 3] === rgb[0] && l[i * 3 + 1] === rgb[1] && l[i * 3 + 2] === rgb[2]) out.push(i);
  }
  return out;
}

/** One row of SPL values laid out the way the engine hands them over. */
function grid(rows: number[][]): { spl: Float32Array; nx: number; nv: number } {
  const nx = rows[0].length;
  const nv = rows.length;
  const spl = new Float32Array(nx * nv);
  rows.forEach((r, j) => r.forEach((v, i) => (spl[j * nx + i] = v)));
  return { spl, nx, nv };
}

const REF = 100;
const RANGE = 30;
const opts = { palette: 'grayscale' as PaletteId, refDb: REF, dynamicRangeDb: RANGE };

describe('the ramp itself', () => {
  it('reaches both declared ends, at the first and last step', () => {
    // An off-by-one in the 0..1 sweep (i/256 rather than i/255) leaves the top
    // step short of the last stop, which is invisible on screen and wrong
    // everywhere the legend and the map are compared.
    expect(lutAt('spl', 0)).toEqual([24, 16, 48]);
    expect(lutAt('spl', 255)).toEqual([226, 52, 52]);
    expect(lutAt('grayscale', 0)).toEqual([24, 24, 26]);
    expect(lutAt('grayscale', 255)).toEqual([245, 245, 245]);
  });

  it('interpolates between stops rather than snapping to the nearer one', () => {
    // Grayscale is two stops, 24 -> 245, so the step at t = 127/255 = 0.4980
    // must be 24 + 221*0.4980 = 134.1. Nearest-stop rounding would give 24.
    const [r, g] = lutAt('grayscale', 127);
    expect(r).toBeGreaterThanOrEqual(133);
    expect(r).toBeLessThanOrEqual(135);
    expect(g).toBe(r);
  });

  it('rises without ever turning back, on a ramp defined to be monotone', () => {
    // Grayscale is the only palette whose ordering is a fact rather than a
    // taste, which makes it the one that can catch a segment-search error: a
    // wrong upper stop makes the ramp saw-tooth between the nodes.
    const l = paletteLut('grayscale');
    for (let i = 1; i < 256; i++) {
      expect(l[i * 3], `step ${i}`).toBeGreaterThanOrEqual(l[(i - 1) * 3]);
      expect(l[i * 3 + 1], `step ${i} is grey`).toBe(l[i * 3]);
    }
    expect(l[255 * 3]).toBeGreaterThan(l[0]);
  });

  it('lands each declared stop of a multi-stop palette on its own position', () => {
    // Viridis, whose five stops are evenly spaced, so the node positions are
    // arithmetic rather than a copy of the table.
    const nodes: Array<[number, [number, number, number]]> = [
      [0, [68, 1, 84]],
      [0.25, [59, 82, 139]],
      [0.5, [33, 145, 140]],
      [0.75, [94, 201, 98]],
      [1, [253, 231, 37]],
    ];
    for (const [pos, rgb] of nodes) {
      const got = lutAt('viridis', Math.round(pos * 255));
      // within one 8-bit count: the node falls between two of the 256 steps
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(got[k] - rgb[k]), `viridis at ${pos}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is built once and handed out again, so a recolour is not a recomputation', () => {
    expect(paletteLut('spl')).toBe(paletteLut('spl'));
  });
});

describe('contour banding', () => {
  it('leaves the ramp alone when there are no bands to snap to', () => {
    expect(quantise(0.3, 0)).toBe(0.3);
    expect(quantise(0.3, 1)).toBe(0.3);
  });

  it('snaps to the centre of the band, not to its edge', () => {
    // Four bands over 0..1: centres at 0.125, 0.375, 0.625, 0.875. Snapping to
    // the lower edge would put the first band at the very bottom of the ramp,
    // where the floor colour and the first contour become the same colour.
    expect(quantise(0, 4)).toBeCloseTo(0.125, 12);
    expect(quantise(0.249, 4)).toBeCloseTo(0.125, 12);
    expect(quantise(0.251, 4)).toBeCloseTo(0.375, 12);
    expect(quantise(1, 4)).toBeCloseTo(0.875, 12);
  });

  it('keeps the top value inside the last band instead of one past it', () => {
    // floor(1 * bands) is bands, which indexes off the end of the LUT.
    for (const bands of [2, 4, 5, 10]) {
      expect(quantise(1, bands)).toBeLessThan(1);
      expect(quantise(1, bands)).toBeGreaterThan(1 - 1 / bands);
    }
  });

  it('draws exactly as many colours as the division asks for', () => {
    // 30 dB of range at 6 dB per division is five bands, so a sweep across the
    // whole range must contain five distinct colours and no more.
    const row = Array.from({ length: 120 }, (_, i) => REF - RANGE + (i * RANGE) / 119);
    const g = grid([row]);
    const img = colorize(g.spl, g.nx, g.nv, { ...opts, dbPerDivision: 6 });
    const seen = new Set<number>();
    for (let i = 0; i < g.nx; i++) seen.add(px(img, i, 0)[0]);
    expect(seen.size).toBe(5);
  });
});

describe('turning a solve into pixels', () => {
  it('draws the far side of the room at the top of the image', () => {
    // Row 0 of `spl` is vMin. In a plan view that is the front of the audience,
    // which is drawn at the BOTTOM. Losing the flip mirrors the whole map about
    // the depth axis, which looks plausible and is wrong.
    const g = grid([
      [REF - RANGE], // vMin, quiet
      [REF], // vMax, loud
    ]);
    const img = colorize(g.spl, g.nx, g.nv, opts);
    expect(px(img, 0, 0).slice(0, 3)).toEqual(lutAt('grayscale', 255));
    expect(px(img, 0, 1).slice(0, 3)).toEqual(lutAt('grayscale', 0));
  });

  it('puts refDb at the top of the ramp and refDb minus the range at the bottom', () => {
    const g = grid([[REF - RANGE, REF - RANGE / 2, REF]]);
    const img = colorize(g.spl, g.nx, g.nv, opts);
    expect(px(img, 0, 0).slice(0, 3)).toEqual(lutAt('grayscale', 0));
    expect(px(img, 2, 0).slice(0, 3)).toEqual(lutAt('grayscale', 255));
    // and the half-way level lands half way along the ramp
    expect(px(img, 1, 0)[0]).toBeGreaterThanOrEqual(133);
    expect(px(img, 1, 0)[0]).toBeLessThanOrEqual(136);
  });

  it('clamps the near field to the top of the ramp instead of past the end of it', () => {
    // refDb is the loudest cell OUTSIDE the exclusion zone, so cells inside it
    // are routinely above the top of the ramp. Without the clamp the LUT is
    // indexed past its end and the hottest part of the map reads as black.
    const g = grid([[REF, REF + 20, REF + 200]]);
    const img = colorize(g.spl, g.nx, g.nv, opts);
    const top = lutAt('grayscale', 255);
    for (let i = 0; i < 3; i++) {
      expect(px(img, i, 0).slice(0, 3), `cell ${i}`).toEqual(top);
      expect(px(img, i, 0)[3]).toBe(255);
    }
  });

  it('never colours a quieter cell brighter than a louder one', () => {
    const row = Array.from({ length: 200 }, (_, i) => REF - 1.5 * RANGE + (i * 2 * RANGE) / 199);
    const g = grid([row]);
    const img = colorize(g.spl, g.nx, g.nv, opts);
    for (let i = 1; i < g.nx; i++) {
      expect(px(img, i, 0)[0], `cell ${i}`).toBeGreaterThanOrEqual(px(img, i - 1, 0)[0]);
    }
  });
});

describe('what happens below the bottom of the ramp', () => {
  it('fades to nothing half a range under the floor, and is still solid at it', () => {
    // alpha = 255 + t*510 for t < 0, so it reaches 0 at t = -0.5: half the
    // dynamic range below the floor. Anything else either makes the floor
    // itself translucent or leaves a hard edge where the ramp runs out.
    const g = grid([[REF - RANGE, REF - 1.25 * RANGE, REF - 1.5 * RANGE, REF - 3 * RANGE]]);
    const img = colorize(g.spl, g.nx, g.nv, opts);
    expect(px(img, 0, 0)[3]).toBe(255);
    expect(px(img, 1, 0)[3]).toBeGreaterThanOrEqual(127);
    expect(px(img, 1, 0)[3]).toBeLessThanOrEqual(128);
    expect(px(img, 2, 0)[3]).toBe(0);
    expect(px(img, 3, 0)[3]).toBe(0);
  });

  it('holds the floor colour at full opacity when the fade is turned off', () => {
    const g = grid([[REF - 3 * RANGE]]);
    const img = colorize(g.spl, g.nx, g.nv, { ...opts, fadeFloor: false });
    expect(px(img, 0, 0)).toEqual([...lutAt('grayscale', 0), 255]);
  });
});

describe('the legend and the map are the same scale', () => {
  it('starts at the peak and finishes exactly at the bottom of the range', () => {
    // A legend whose last tick is not the floor of the ramp mislabels every
    // colour under it. The presets are hand-written, so this is the check that
    // a new one has not been mistyped.
    for (const range of [20, 30, 40, 60, 24, 25, 50]) {
      const ticks = legendTicks(range);
      expect(ticks[0], `${range} dB`).toBeCloseTo(0, 12);
      expect(ticks[ticks.length - 1], `${range} dB`).toBe(-range);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i], `${range} dB, tick ${i}`).toBeLessThan(ticks[i - 1]);
      }
    }
  });

  it('gives a tick the colour the map gives a cell that far below the peak', () => {
    // The bar is drawn top-down as colorForFraction(1 - heightFromTop) and a
    // tick of -d sits at d/range from the top, so its colour is
    // colorForFraction(1 - d/range). That has to be the colour colorize paints
    // on a cell at refDb - d, or the operator reads a level off the wrong band.
    for (const palette of ['spl', 'viridis', 'grayscale'] as PaletteId[]) {
      for (const d of legendTicks(RANGE).map((t) => -t)) {
        const g = grid([[REF - d]]);
        const mapped = px(colorize(g.spl, g.nx, g.nv, { ...opts, palette }), 0, 0);
        const bar = colorForFraction(palette, 1 - d / RANGE)
          .slice(4, -1)
          .split(',')
          .map(Number);
        // Compared as positions on the ramp rather than as RGB, because a
        // difference of one step is 4 counts of red in the steep part of the
        // SPL palette and nothing at all in the flat part. colorForFraction
        // rounds to the nearest step where colorize truncates, so one step is
        // the tolerance; two would be a scale that disagrees with itself.
        const onBar = lutIndicesOf(palette, bar);
        const onMap = lutIndicesOf(palette, [...mapped].slice(0, 3));
        const apart = Math.min(...onBar.flatMap((i) => onMap.map((j) => Math.abs(i - j))));
        expect(apart, `${palette} at -${d} dB`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('the calibrated scale paints "louder than red" white', () => {
  const one = (db: number, opts: Partial<import('./colormap').ColorizeOptions> = {}) => {
    const img = colorize(new Float32Array([db]), 1, 1, {
      palette: 'spl',
      refDb: 100,
      dynamicRangeDb: 30,
      ...opts,
    });
    return [img.data[0], img.data[1], img.data[2]];
  };

  it('uniformly: +10 dB over the pin looks exactly like +30 dB', () => {
    expect(one(110, { clipWhiteAboveRef: true })).toEqual([255, 255, 255]);
    expect(one(130, { clipWhiteAboveRef: true })).toEqual([255, 255, 255]);
    // at and below the pin the ramp is untouched: red stays the top colour
    expect(one(100, { clipWhiteAboveRef: true })).toEqual(one(100));
    expect(one(94, { clipWhiteAboveRef: true })).toEqual(one(94));
  });

  it('the self-scaling ramp never whites out — red is its own ceiling', () => {
    // without the pin, above-ref clamps to the ramp top, as always
    expect(one(110)).toEqual(one(100));
    expect(one(100)).not.toEqual([255, 255, 255]);
  });
});
