/**
 * End-fire arrays: pure functions over the containers and their member
 * cabinets.
 *
 * The one idea everything here follows: an end-fire block is described by
 * WHERE ITS CABINETS STAND. Rows are the cabinets' depths along the aim,
 * clustered; row 1 is the front row; the rear row plays first and every row in
 * front of it waits its distance from the rear row over the speed of sound.
 * Nothing about a row is stored, so nothing about a row can go stale: move a
 * row, change the temperature, turn the aim, and the delays follow.
 */
import { EF_ROW_TOL_M, type EfArray, type Group, type Source, type Vec3 } from '../core/types';
import { resolveAll, rotateXY, type ResolvedSource } from './resolve';
import type { SpeakerDataProvider } from '../speakers/provider';

/** The lowest free "EF n" name, so a deleted array frees its number. */
export function nextEfName(existing: Array<{ name: string }>): string {
  const used = new Set(existing.map((a) => a.name));
  let n = 1;
  while (used.has(`EF ${n}`)) n++;
  return `EF ${n}`;
}

/** Unit vector of an aim in plan, same convention as a cabinet's azimuth (0 = +Y). */
export function aimVector(aimDeg: number): { x: number; y: number } {
  const a = (aimDeg * Math.PI) / 180;
  return { x: Math.sin(a), y: Math.cos(a) };
}

/** Smallest angle between two headings, 0..180. */
export function headingDiffDeg(a: number, b: number): number {
  return Math.abs(((((a - b) % 360) + 540) % 360) - 180);
}

/** How far a point stands along the aim: larger is further forward. */
export function depthAlong(p: { x: number; y: number }, aimDeg: number): number {
  const v = aimVector(aimDeg);
  return p.x * v.x + p.y * v.y;
}

/**
 * Rows of points along an aim, FRONT row first. A point joins the row when it
 * stands within EF_ROW_TOL_M of that row's front-most point.
 */
export function rowsAlong<T extends { id: string; position: { x: number; y: number } }>(
  items: T[],
  aimDeg: number,
): Array<{ ids: string[]; depthM: number }> {
  const sorted = items
    .map((it) => ({ id: it.id, d: depthAlong(it.position, aimDeg) }))
    .sort((a, b) => b.d - a.d);
  const rows: Array<{ ids: string[]; first: number; sum: number }> = [];
  for (const p of sorted) {
    const cur = rows[rows.length - 1];
    if (cur && cur.first - p.d <= EF_ROW_TOL_M) {
      cur.ids.push(p.id);
      cur.sum += p.d;
    } else {
      rows.push({ ids: [p.id], first: p.d, sum: p.d });
    }
  }
  return rows.map((r) => ({ ids: r.ids, depthM: r.sum / r.ids.length }));
}

export interface EfRow {
  /** 1 = the front row, nearest the audience */
  n: number;
  ids: string[];
  /** mean depth along the aim, m */
  depthM: number;
  /** this row's end-fire delay: its distance in front of the rear row over c */
  delayS: number;
}

export interface EfLayout {
  ef: EfArray;
  rows: EfRow[];
  count: number;
  /** distances between neighbouring rows, front pair first */
  gapsM: number[];
  meanGapM: number | null;
  /** the frequency the measured spacing is a quarter wavelength of */
  tunedHz: number | null;
  /** neighbouring gaps differ by more than 15 %: the rear null is smeared */
  uneven: boolean;
  /** members (not polarity inverted) facing more than 45° away from the aim */
  offAimIds: string[];
}

/** One array, read off the resolved cabinets. */
export function efLayout(resolved: ResolvedSource[], ef: EfArray, speedOfSound: number): EfLayout {
  const members = resolved.filter((r) => r.source.ef?.arrayId === ef.id);
  const raw = rowsAlong(
    members.map((r) => ({ id: r.source.id, position: r.position })),
    ef.aimDeg,
  );
  const rear = raw.length ? raw[raw.length - 1].depthM : 0;
  const rows: EfRow[] = raw.map((r, i) => ({
    n: i + 1,
    ids: r.ids,
    depthM: r.depthM,
    delayS: (r.depthM - rear) / speedOfSound,
  }));
  const gapsM = rows.slice(1).map((r, i) => rows[i].depthM - r.depthM);
  const meanGapM = gapsM.length ? gapsM.reduce((a, b) => a + b, 0) / gapsM.length : null;
  const uneven =
    gapsM.length > 1 && Math.max(...gapsM) > Math.min(...gapsM) * 1.15;
  const offAimIds = members
    .filter((r) => !r.source.invertPolarity && headingDiffDeg(r.azimuthDeg, ef.aimDeg) > 45)
    .map((r) => r.source.id);
  return {
    ef,
    rows,
    count: members.length,
    gapsM,
    meanGapM,
    tunedHz: meanGapM && meanGapM > 0 ? speedOfSound / (4 * meanGapM) : null,
    uneven,
    offAimIds,
  };
}

export function efLayouts(
  resolved: ResolvedSource[],
  efArrays: EfArray[],
  speedOfSound: number,
): EfLayout[] {
  return efArrays.map((ef) => efLayout(resolved, ef, speedOfSound));
}

/** Per cabinet: which array, which row, what end-fire delay. For tables and the plan. */
export function efInfoBySource(
  layouts: EfLayout[],
): Map<string, { name: string; row: number; rows: number; delayS: number }> {
  const out = new Map<string, { name: string; row: number; rows: number; delayS: number }>();
  for (const l of layouts) {
    for (const r of l.rows) {
      for (const id of r.ids) out.set(id, { name: l.ef.name, row: r.n, rows: l.rows.length, delayS: r.delayS });
    }
  }
  return out;
}

/** What the tables print for a member, e.g. "EF 1 R2". */
export function efCellLabel(info: Map<string, { name: string; row: number }>, id: string): string {
  const i = info.get(id);
  return i ? `${i.name} R${i.row}` : '';
}

/**
 * The sources with every cabinet's `efDelayS` equal to what its array asks
 * for, or null when they already are (so a subscriber can call this after
 * every change without looping).
 */
export function syncEfDelays(
  sources: Source[],
  groups: Group[],
  provider: SpeakerDataProvider,
  efArrays: EfArray[],
  speedOfSound: number,
): Source[] | null {
  const anyMember = sources.some((s) => s.ef);
  const anyDelay = sources.some((s) => s.efDelayS !== undefined);
  if (!anyMember && !anyDelay) return null;

  const want = new Map<string, number>();
  if (anyMember) {
    const known = new Set(efArrays.map((e) => e.id));
    const resolved = resolveAll(sources, groups, provider);
    for (const l of efLayouts(resolved, efArrays.filter((e) => known.has(e.id)), speedOfSound)) {
      for (const r of l.rows) for (const id of r.ids) want.set(id, r.delayS);
    }
  }
  let changed = false;
  const next = sources.map((s) => {
    const w = want.get(s.id);
    const have = s.efDelayS;
    if (w === undefined) {
      if (have === undefined) return s;
      changed = true;
      return { ...s, efDelayS: undefined };
    }
    if (have !== undefined && Math.abs(have - w) < 1e-9) return s;
    changed = true;
    return { ...s, efDelayS: w };
  });
  return changed ? next : null;
}

/**
 * A movement expressed in the world, turned into the movement of a cabinet's
 * OWN stored position: a member of a yawed group moves in the group's frame.
 */
export function worldDeltaToLocal(delta: Vec3, group: Group | null): Vec3 {
  if (!group || !group.rotationOffsetDeg) return delta;
  const l = rotateXY(delta, { x: 0, y: 0, z: 0 }, -group.rotationOffsetDeg);
  return { x: l.x, y: l.y, z: delta.z };
}

/** The spacing whose quarter wavelength is `hz`. */
export function spacingForHz(hz: number, speedOfSound: number): number {
  return speedOfSound / hz / 4;
}

/** The frequency a spacing is the quarter wavelength of. */
export function hzForSpacing(spacingM: number, speedOfSound: number): number {
  return speedOfSound / (4 * spacingM);
}
