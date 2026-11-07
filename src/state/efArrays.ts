/**
 * End-fired array helpers: pure functions over the EF containers and the
 * sources assigned to their rows. The store owns the rules (no overwriting an
 * occupied row, release before reassigning); these only read.
 */
import type { EfArray, Source } from '../core/types';

/** The lowest free "EF n" name, so a deleted array frees its number. */
export function nextEfName(existing: EfArray[]): string {
  const used = new Set(existing.map((a) => a.name));
  let n = 1;
  while (used.has(`EF ${n}`)) n++;
  return `EF ${n}`;
}

/** How many cabinets each row of this array holds. Rows not present hold 0. */
export function efRowCounts(sources: Source[], efId: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const s of sources) {
    if (s.ef?.arrayId === efId) counts.set(s.ef.row, (counts.get(s.ef.row) ?? 0) + 1);
  }
  return counts;
}

/** The ids of the cabinets in one row. */
export function efRowIds(sources: Source[], efId: string, row: number): string[] {
  return sources.filter((s) => s.ef?.arrayId === efId && s.ef.row === row).map((s) => s.id);
}

/** What the tables print for an assigned cabinet, e.g. "EF 1 R2". */
export function efCellLabel(efArrays: EfArray[], source: Source): string {
  if (!source.ef) return '';
  const ef = efArrays.find((a) => a.id === source.ef!.arrayId);
  return ef ? `${ef.name} R${source.ef.row}` : '';
}

/**
 * Mean audience-ward (Y) coordinate of every occupied row, from RESOLVED
 * positions, so group offsets count. Sorted by row number.
 */
export function efRowMeansY(
  resolved: Array<{ source: Source; position: { y: number } }>,
  efId: string,
): Array<{ row: number; ids: string[]; y: number }> {
  const rows = new Map<number, { ids: string[]; sum: number }>();
  for (const r of resolved) {
    const e = r.source.ef;
    if (e?.arrayId !== efId) continue;
    const g = rows.get(e.row) ?? { ids: [], sum: 0 };
    g.ids.push(r.source.id);
    g.sum += r.position.y;
    rows.set(e.row, g);
  }
  return [...rows]
    .map(([row, g]) => ({ row, ids: g.ids, y: g.sum / g.ids.length }))
    .sort((a, b) => a.row - b.row);
}

/**
 * True when the row numbering disagrees with the geometry: row 1 is defined as
 * the row nearest the audience (largest Y), so mean Y must fall as the row
 * number climbs.
 */
export function efRowsOutOfOrder(means: Array<{ row: number; y: number }>): boolean {
  for (let i = 1; i < means.length; i++) if (means[i].y >= means[i - 1].y) return true;
  return false;
}
