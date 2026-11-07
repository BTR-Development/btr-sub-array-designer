/**
 * Which data the map stands on.
 *
 * "Never invent speaker data" was kept in the code and nowhere in front of the
 * user: the grade of each model was shown in the library and the inspector, so
 * a map of sixteen cabinets said nothing about how far it could be believed
 * until somebody clicked one of them. The plot heading now carries the grade
 * the map is limited by — the WEAKEST model among the cabinets that sound. One
 * analytical approximation in a rig of measured balloons makes the whole map
 * an approximation where that cabinet contributes, so the best grade would
 * overstate it and an average would mean nothing.
 *
 * Muted cabinets (their own mute or their group's) are left out: they are not
 * in the solve, so their data cannot limit it.
 */
import type { Group, Source } from '../core/types';
import type { DataQuality } from '../speakers/schema';
import type { SpeakerDataProvider } from '../speakers/provider';
import { resolveAll } from './resolve';

const ORDER: DataQuality[] = ['A', 'B', 'C', 'D'];

export interface MapDataGrade {
  /** the weakest grade among the sounding cabinets */
  grade: DataQuality;
  /** how many different models sound — 1 means the grade is simply that model's */
  models: number;
}

export function mapDataGrade(
  sources: Source[],
  groups: Group[],
  provider: SpeakerDataProvider,
): MapDataGrade | null {
  const models = new Map<string, DataQuality>();
  for (const r of resolveAll(sources, groups, provider)) {
    if (r.muted || !r.model) continue;
    models.set(r.model.id, r.model.dataQuality);
  }
  if (!models.size) return null;
  let worst = 0;
  for (const q of models.values()) worst = Math.max(worst, ORDER.indexOf(q));
  return { grade: ORDER[worst], models: models.size };
}
