/**
 * The SPL map, rasterised once and shared by every view that draws it.
 *
 * Extracted when the 3D viewport arrived, because the alternative was a second
 * copy of the colouring call. The ramp anchors to the solve's own reference
 * level and the cache key names every input that changes a pixel — a second
 * copy would be one `splMode` away from two views disagreeing about what the
 * same solve looks like.
 */
import { useCallback, useRef } from 'react';
import { colorize } from '../render/colormap';
import type { GridResult } from '../engine/types';
import type { PaletteId } from '../render/colormap';

export interface HeatSettings {
  palette: PaletteId;
  dynamicRangeDb: number;
  dbPerDivision: number;
  /** only changes how the scale is LABELLED, but it is in the key so a switch repaints */
  splMode: string;
  /** przypięty refDb skali skalibrowanej; null = skala automatyczna */
  calibratedRefDb: number | null;
}

/** Returns a getter; the canvas is rebuilt only when something about it changes. */
export function useHeatCanvas(result: GridResult | null, cfg: HeatSettings) {
  const ref = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const { palette, dynamicRangeDb, dbPerDivision, splMode, calibratedRefDb } = cfg;

  return useCallback((): HTMLCanvasElement | null => {
    if (!result) return null;
    // Kalibracja przypina kotwicę rampy; wszystko ponad nią maluje się białym.
    const refDb = calibratedRefDb ?? result.refDb;
    const key = [
      result.nx, result.nv, result.xMin, result.vMin, refDb.toFixed(4),
      calibratedRefDb == null ? 'auto' : 'cal',
      palette, dynamicRangeDb, dbPerDivision, splMode,
    ].join('|');
    if (ref.current?.key === key) return ref.current.canvas;

    const img = colorize(result.spl, result.nx, result.nv, {
      palette,
      refDb,
      dynamicRangeDb,
      dbPerDivision,
      clipWhiteAboveRef: calibratedRefDb != null,
    });
    const c = document.createElement('canvas');
    c.width = result.nx;
    c.height = result.nv;
    c.getContext('2d')!.putImageData(img, 0, 0);
    ref.current = { key, canvas: c };
    return c;
  }, [result, palette, dynamicRangeDb, dbPerDivision, splMode, calibratedRefDb]);
}
