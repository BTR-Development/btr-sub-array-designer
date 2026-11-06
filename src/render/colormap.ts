/**
 * Heatmap colouring.
 *
 * Deliberately separated from the engine: recolouring is a pure lookup over a
 * cached Float32Array of SPL values, so changing the palette, the dynamic range or
 * the band size never triggers an acoustic recomputation.
 *
 * Levels here are RELATIVE only. The map shows how energy is distributed, not how
 * loud anything is, so the ramp is anchored to the loudest point of the current
 * solve and everything else is read as dB below it. No absolute SPL is displayed
 * anywhere in the app.
 */

export type PaletteId = 'spl' | 'viridis' | 'grayscale';

type Stop = [pos: number, r: number, g: number, b: number];

/** Smooth prediction ramp: deep violet -> blue -> cyan -> green -> yellow -> red. */
const SPL_STOPS: Stop[] = [
  [0.0, 24, 16, 48],
  [0.14, 40, 34, 120],
  [0.3, 30, 110, 190],
  [0.45, 26, 178, 178],
  [0.6, 74, 190, 90],
  [0.74, 214, 200, 62],
  [0.87, 226, 122, 44],
  [1.0, 226, 52, 52],
];

const VIRIDIS_STOPS: Stop[] = [
  [0.0, 68, 1, 84],
  [0.25, 59, 82, 139],
  [0.5, 33, 145, 140],
  [0.75, 94, 201, 98],
  [1.0, 253, 231, 37],
];

const GRAY_STOPS: Stop[] = [
  [0.0, 24, 24, 26],
  [1.0, 245, 245, 245],
];

const STOPS: Record<PaletteId, Stop[]> = {
  spl: SPL_STOPS,
  viridis: VIRIDIS_STOPS,
  grayscale: GRAY_STOPS,
};

export const PALETTE_LABEL: Record<PaletteId, string> = {
  spl: 'SPL',
  viridis: 'Viridis',
  grayscale: 'Grayscale',
};

const LUT_SIZE = 256;
const lutCache = new Map<PaletteId, Uint8ClampedArray>();

export function paletteLut(id: PaletteId): Uint8ClampedArray {
  const cached = lutCache.get(id);
  if (cached) return cached;
  const stops = STOPS[id];
  const lut = new Uint8ClampedArray(LUT_SIZE * 3);
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [p0, r0, g0, b0] = stops[k];
    const [p1, r1, g1, b1] = stops[k + 1];
    const u = p1 > p0 ? (t - p0) / (p1 - p0) : 0;
    lut[i * 3] = r0 + (r1 - r0) * u;
    lut[i * 3 + 1] = g0 + (g1 - g0) * u;
    lut[i * 3 + 2] = b0 + (b1 - b0) * u;
  }
  lutCache.set(id, lut);
  return lut;
}

/**
 * Snap a 0..1 ramp position to the centre of its band.
 * `bands` <= 1 means no quantisation.
 */
export function quantise(t: number, bands: number): number {
  if (bands <= 1) return t;
  const i = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
  return (i + 0.5) / bands;
}

export function colorForFraction(id: PaletteId, t: number, bands = 0): string {
  const lut = paletteLut(id);
  const q = quantise(Math.max(0, Math.min(1, t)), bands);
  const i = Math.max(0, Math.min(LUT_SIZE - 1, Math.round(q * (LUT_SIZE - 1)))) * 3;
  return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
}

export interface ColorizeOptions {
  palette: PaletteId;
  /** dB value mapped to the top of the ramp */
  refDb: number;
  /** how many dB below refDb the ramp spans */
  dynamicRangeDb: number;
  /** dB per colour division; 0 draws a smooth gradient instead of contour bands */
  dbPerDivision?: number;
  /** below the ramp, fade out instead of clamping to the floor colour */
  fadeFloor?: boolean;
  /**
   * Wszystko GŁOŚNIEJSZE od refDb maluje się białym — jednolicie, bez
   * gradientu: +10 dB i +30 dB ponad kalibrację wyglądają tak samo.
   *
   * Tylko dla skali SKALIBROWANEJ (przypiętej dwuklikiem w słupek). Skala
   * automatyczna kotwiczy czerwień w najgłośniejszym punkcie rozwiązania,
   * więc nic nie może być ponad nią i biel nie ma czego oznaczać. Po
   * kalibracji czerwień stoi w miejscu, a biel mówi jedno: "głośniej niż
   * było, gdy kalibrowano" — ile głośniej, mówi już tylko silnik, nie kolor.
   */
  clipWhiteAboveRef?: boolean;
}

/**
 * Turn a grid of SPL values into RGBA pixels. `spl` is row-major with row 0 at
 * vMin, which is the BOTTOM of the drawn image, so rows are flipped here.
 */
export function colorize(
  spl: Float32Array,
  nx: number,
  nv: number,
  opts: ColorizeOptions,
): ImageData {
  const lut = paletteLut(opts.palette);
  const img = new ImageData(nx, nv);
  const px = img.data;
  const range = Math.max(1e-6, opts.dynamicRangeDb);
  const bands = opts.dbPerDivision && opts.dbPerDivision > 0 ? Math.round(range / opts.dbPerDivision) : 0;
  const fade = opts.fadeFloor !== false;

  for (let j = 0; j < nv; j++) {
    const srcRow = (nv - 1 - j) * nx;
    const dstRow = j * nx;
    for (let i = 0; i < nx; i++) {
      const db = spl[srcRow + i];
      let t = (db - opts.refDb + range) / range; // 0 at the floor, 1 at refDb
      let alpha = 255;
      const o = (dstRow + i) * 4;
      if (t > 1 && opts.clipWhiteAboveRef) {
        // ponad kalibracją: jednolita biel, nie szczyt rampy
        px[o] = 255;
        px[o + 1] = 255;
        px[o + 2] = 255;
        px[o + 3] = 255;
        continue;
      }
      if (t < 0) {
        if (fade) alpha = Math.max(0, 255 + t * 255 * 2);
        t = 0;
      } else if (t > 1) {
        t = 1;
      }
      const k = ((quantise(t, bands) * (LUT_SIZE - 1)) | 0) * 3;
      px[o] = lut[k];
      px[o + 1] = lut[k + 1];
      px[o + 2] = lut[k + 2];
      px[o + 3] = alpha;
    }
  }
  return img;
}

/** dB tick values shown on a relative legend, from the top of the ramp downwards. */
export function legendTicks(dynamicRangeDb: number): number[] {
  const presets: Record<number, number[]> = {
    20: [0, -3, -6, -9, -12, -16, -20],
    30: [0, -3, -6, -9, -12, -18, -24, -30],
    40: [0, -5, -10, -15, -20, -25, -30, -35, -40],
    60: [0, -6, -12, -18, -24, -30, -40, -50, -60],
  };
  if (presets[dynamicRangeDb]) return presets[dynamicRangeDb];
  const step = dynamicRangeDb / 6;
  return Array.from({ length: 7 }, (_, i) => -Math.round(i * step));
}
