/**
 * File → Save map image: the facts of the map in words, then the picture.
 * The composition itself is io/mapImage.ts; this is the part that knows the
 * store and the language.
 */
import type { AppState } from '../state/store';
import { mapDataGrade } from '../state/dataGrade';
import { mapImagePng } from '../io/mapImage';
import { downloadBlob } from '../io/registry';
import { cssVar } from '../render/cssTokens';
import { BRANDING } from '../branding';
import { QUALITY_KEY, type MessageKey, type Vars } from '../i18n';

type T = (key: MessageKey, vars?: Vars) => string;

/** The plot canvas on screen, 2D or 3D, or null when nothing is drawn. */
export function plotCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>('.plot canvas');
}

export function mapCaption(s: AppState, t: T): string[] {
  const sim = s.sim;
  const heading =
    sim.plane === 'top'
      ? t('plot.headingTop', { offset: sim.area.planeOffset })
      : t('plot.headingSide', { offset: sim.area.planeOffset });
  const signal =
    sim.signal === 'pink'
      ? `${t('right.pinkNoise')} ${sim.pinkLoHz.toFixed(0)}-${sim.pinkHiHz.toFixed(0)} Hz`
      : `${sim.frequencyHz.toFixed(1)} Hz` +
        (sim.bandOct > 0 ? ` · ${sim.bandOct >= 1 ? t('right.fullOctave') : t('right.thirdOctave')}` : '');
  const contours = sim.dbPerDivision ? t('plot.perDivision', { db: sim.dbPerDivision }) : t('plot.continuous');
  const window = t('img.window', { db: sim.dynamicRangeDb }) + (s.calibratedRefDb != null ? ` (${t('img.calibrated')})` : '');
  const grade = mapDataGrade(s.sources, s.groups, s.provider);
  const data = grade ? `${t('plot.data')} ${grade.grade}: ${t(QUALITY_KEY[grade.grade])}` : '';
  return [
    s.project.name ? `${s.project.name} · ${heading}` : heading,
    [signal, contours, window, data].filter(Boolean).join(' · '),
  ];
}

/** Returns false when there is no map on screen to save. */
export async function saveMapImage(s: AppState, t: T): Promise<boolean> {
  const canvas = plotCanvas();
  if (!canvas || !s.sources.length || !canvas.width) return false;
  const lines = mapCaption(s, t);
  const blob = await mapImagePng({
    canvas,
    lines,
    palette: s.palette,
    dynamicRangeDb: s.sim.dynamicRangeDb,
    dbPerDivision: s.sim.dbPerDivision ?? 0,
    metadata: {
      Title: lines[0],
      Description: lines[1],
      Software: BRANDING.productName,
      'Creation Time': new Date().toISOString(),
      // the whole calculation setup, so the picture can be traced back to it
      'btr:simulation': JSON.stringify(s.sim),
    },
    background: cssVar('--bg-app', '#1c1e22'),
    foreground: cssVar('--fg', '#e8eaed'),
    dim: cssVar('--fg-secondary', '#a3a9b1'),
    font: cssVar('--ui', 'sans-serif'),
  });
  const safe = (s.project.name || 'project').replace(/[^\w\-. ]+/g, '_');
  downloadBlob(blob, `${safe}-map.png`);
  return true;
}
