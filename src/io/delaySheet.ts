/**
 * The delay and position sheet.
 *
 * A sub array job does not end on the screen. It ends when the crew has put
 * every cabinet where it belongs and the system tech has typed every delay
 * into the processor — and this module turns the project
 * into that sheet: one row per cabinet, grouped by array and by position, with
 * the numbers in the form they are used in.
 *
 * Two rules decide what a row says:
 *
 *  - The delay is the RESULTANT one: the cabinet's own delay, plus the hidden
 *    cardioid gradient, plus the array's offset. That is the number that goes
 *    into the processor; the parts it is made of are what goes wrong when they
 *    are copied separately. The array heading still states its offset, so the
 *    sum can be checked.
 *  - Coordinates and angles are in the WORLD, after the array's move and turn,
 *    because the crew measures on the floor, not in the array's own frame.
 *
 * Levels are the relative gains the processor takes (the program never shows absolute SPL), and the data grade is carried to the
 * heading because a sheet that outlives the screen has to say how far its map
 * can be believed.
 *
 * Pure: the store, the language and the date come in as arguments, so the
 * same sheet is what the preview draws, what is printed and what the CSV and
 * clipboard carry.
 */
import type { Group, ProjectMeta, SimulationSettings, Source } from '../core/types';
import { orientedDimensions, type DataQuality } from '../speakers/schema';
import type { SpeakerDataProvider } from '../speakers/provider';
import { resolveAll, type ResolvedSource } from '../state/resolve';
import { reversedFlags } from '../state/arrayTools';
import { mapDataGrade } from '../state/dataGrade';
import type { Lang, MessageKey, Vars } from '../i18n';

export interface SheetCabinet {
  id: string;
  label: string;
  model: string;
  /** turned round against the array: the B of a cardioid F/B */
  reversed: boolean;
  /** world position of the cabinet's geometric centre, metres */
  x: number;
  y: number;
  z: number;
  /** world azimuth, (-180, 180], 0 = towards the audience (+Y), clockwise */
  azimuthDeg: number;
  /** resultant delay: own + cardioid gradient + array offset */
  delayMs: number;
  inverted: boolean;
  /** resultant relative gain: own + array offset */
  levelDb: number;
  muted: boolean;
  /** footprint as it stands (a cabinet on its side swaps width and height); null = not published */
  widthM: number | null;
  depthM: number | null;
}

export interface SheetPosition {
  /** 1-based, along the array */
  number: number;
  cabinets: SheetCabinet[];
}

export interface SheetArray {
  name: string;
  /** null for the cabinets that belong to no array */
  groupId: string | null;
  delayOffsetMs: number;
  levelOffsetDb: number;
  muted: boolean;
  positions: SheetPosition[];
}

export interface DelaySheet {
  projectName: string;
  author: string;
  notes: string;
  /** local date, YYYY-MM-DD */
  date: string;
  temperatureC: number;
  speedOfSound: number;
  models: Array<{ name: string; grade: DataQuality }>;
  /** weakest grade among the cabinets that sound, null when nothing does */
  grade: DataQuality | null;
  arrays: SheetArray[];
  cabinetCount: number;
  /** the most negative resultant delay, when there is one: processors take none */
  negativeMinMs: number | null;
}

export interface SheetInput {
  project: ProjectMeta;
  sources: Source[];
  groups: Group[];
  sim: Pick<SimulationSettings, 'temperatureC' | 'speedOfSound'>;
  provider: SpeakerDataProvider;
  /** for tests; defaults to now */
  now?: Date;
}

const fold180 = (deg: number) => {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
};

const modelName = (r: ResolvedSource) => (r.model ? `${r.model.manufacturer} ${r.model.model}` : r.source.speakerId);

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Positions of one array, numbered along it.
 *
 * A position is what the layout tools wrote as one (`positionKey`); a cabinet
 * placed by hand is a position of its own. They are numbered along the
 * direction the array spreads in — left to right across the stage for a row,
 * front to back for an end-fire line — so position 1 is the same box on the
 * sheet, on the screen and on the floor.
 */
function positionsOf(resolved: ResolvedSource[], reversed: Map<string, boolean>): SheetPosition[] {
  const byKey = new Map<string, ResolvedSource[]>();
  for (const r of resolved) {
    const key = r.source.positionKey ?? `solo:${r.source.id}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const blocks = [...byKey.values()].map((members) => ({
    members,
    x: members.reduce((t, m) => t + m.position.x, 0) / members.length,
    y: members.reduce((t, m) => t + m.position.y, 0) / members.length,
  }));
  const spread = (k: 'x' | 'y') =>
    blocks.length ? Math.max(...blocks.map((b) => b[k])) - Math.min(...blocks.map((b) => b[k])) : 0;
  const along: 'x' | 'y' = spread('x') >= spread('y') ? 'x' : 'y';
  const across: 'x' | 'y' = along === 'x' ? 'y' : 'x';
  blocks.sort((a, b) => a[along] - b[along] || a[across] - b[across]);

  return blocks.map((b, i) => ({
    number: i + 1,
    // bottom box first in a stack, then across the row
    cabinets: [...b.members]
      .sort((p, q) => p.position.z - q.position.z || p.position.x - q.position.x || p.position.y - q.position.y)
      .map((r) => {
        const dims = r.model ? orientedDimensions(r.model, r.rollDeg) : null;
        return {
          id: r.source.id,
          label: r.source.label,
          model: modelName(r),
          reversed: reversed.get(r.source.id) ?? false,
          x: r.position.x,
          y: r.position.y,
          z: r.position.z,
          azimuthDeg: fold180(r.azimuthDeg),
          delayMs: r.delayS * 1000,
          inverted: r.source.invertPolarity,
          levelDb: r.levelDb,
          muted: r.muted,
          widthM: dims?.widthM ?? null,
          depthM: dims?.depthM ?? null,
        };
      }),
  }));
}

export function buildDelaySheet(input: SheetInput, ungroupedName: string): DelaySheet {
  const { sources, groups, provider } = input;
  const resolved = resolveAll(sources, groups, provider);
  const byId = new Map(resolved.map((r) => [r.source.id, r]));

  const sets: Array<{ group: Group | null; members: Source[] }> = groups
    .map((g) => ({ group: g as Group | null, members: sources.filter((s) => s.groupId === g.id) }))
    .filter((x) => x.members.length > 0);
  const loose = sources.filter((s) => !s.groupId || !groups.some((g) => g.id === s.groupId));
  if (loose.length) sets.push({ group: null, members: loose });

  const arrays: SheetArray[] = sets.map(({ group, members }) => {
    // Reversal is a relation to the rest of the array, read the way the array
    // panel reads it, on the cabinets' own headings.
    const flags = reversedFlags(members);
    const reversed = new Map(members.map((m, i) => [m.id, flags[i]]));
    return {
      name: group ? group.name : ungroupedName,
      groupId: group?.id ?? null,
      delayOffsetMs: (group?.delayOffsetS ?? 0) * 1000,
      levelOffsetDb: group?.levelOffsetDb ?? 0,
      muted: group?.mute ?? false,
      positions: positionsOf(members.map((m) => byId.get(m.id)!), reversed),
    };
  });

  const models = new Map<string, { name: string; grade: DataQuality }>();
  for (const r of resolved) {
    if (r.model) models.set(r.model.id, { name: modelName(r), grade: r.model.dataQuality });
  }
  const audible = resolved.filter((r) => !r.muted).map((r) => r.delayS * 1000);
  const min = audible.length ? Math.min(...audible) : 0;

  return {
    projectName: input.project.name,
    author: input.project.author ?? '',
    notes: input.project.notes ?? '',
    date: localDate(input.now ?? new Date()),
    temperatureC: input.sim.temperatureC,
    speedOfSound: input.sim.speedOfSound,
    models: [...models.values()],
    grade: mapDataGrade(sources, groups, provider)?.grade ?? null,
    arrays,
    cabinetCount: sources.length,
    negativeMinMs: min < -1e-9 ? min : null,
  };
}

// ── numbers in the operator's notation ─────────────────────────────────────

/** Decimal comma where the language writes one, so a spreadsheet reads numbers as numbers. */
export function decimalComma(lang: Lang): boolean {
  return lang !== 'en';
}

export function fmt(n: number, decimals: number, lang: Lang, signed = false): string {
  const v = Math.abs(n) < 0.5 * 10 ** -decimals ? 0 : n;
  let s = v.toFixed(decimals);
  if (signed && v > 0) s = `+${s}`;
  return decimalComma(lang) ? s.replace('.', ',') : s;
}

export interface SheetColumns {
  array: string;
  position: string;
  cabinet: string;
  model: string;
  fb: string;
  x: string;
  y: string;
  z: string;
  azimuth: string;
  delay: string;
  polarity: string;
  level: string;
  mute: string;
  /** the words for the F/B cell, the inverted cell and the muted cell */
  front: string;
  back: string;
  inverted: string;
  yes: string;
}

/** The column words in the interface language. */
export function sheetColumns(t: (key: MessageKey, vars?: Vars) => string): SheetColumns {
  return {
    array: t('sheet.col.array'),
    position: t('sheet.col.position'),
    cabinet: t('sheet.col.cabinet'),
    model: t('sheet.col.model'),
    fb: t('sheet.col.fb'),
    x: 'X [m]',
    y: 'Y [m]',
    z: 'Z [m]',
    azimuth: t('sheet.col.azimuth'),
    delay: t('sheet.col.delay'),
    polarity: t('sheet.col.polarity'),
    level: t('sheet.col.level'),
    mute: t('sheet.col.mute'),
    // F and B read the same in every language
    front: 'F',
    back: 'B',
    inverted: 'Ø',
    yes: t('sheet.yes'),
  };
}

/** The sheet as a table of strings, header first: what CSV and the clipboard carry. */
export function sheetRows(sheet: DelaySheet, cols: SheetColumns, lang: Lang): string[][] {
  const out: string[][] = [
    [cols.array, cols.position, cols.cabinet, cols.model, cols.fb, cols.x, cols.y, cols.z, cols.azimuth, cols.delay, cols.polarity, cols.level, cols.mute],
  ];
  for (const a of sheet.arrays) {
    for (const p of a.positions) {
      for (const c of p.cabinets) {
        out.push([
          a.name,
          String(p.number),
          c.label,
          c.model,
          c.reversed ? cols.back : cols.front,
          fmt(c.x, 2, lang),
          fmt(c.y, 2, lang),
          fmt(c.z, 2, lang),
          fmt(c.azimuthDeg, 1, lang),
          fmt(c.delayMs, 2, lang),
          c.inverted ? cols.inverted : '',
          fmt(c.levelDb, 1, lang),
          c.muted ? cols.yes : '',
        ]);
      }
    }
  }
  return out;
}

/**
 * CSV for a spreadsheet in the operator's locale: a semicolon where the
 * decimal mark is a comma (as Excel and Numbers expect in Poland and Italy),
 * a comma otherwise, and a byte-order mark so the diacritics survive Excel.
 */
export function toCsv(rows: string[][], lang: Lang): string {
  const sep = decimalComma(lang) ? ';' : ',';
  // quoted only when it has to be: a decimal comma under a semicolon separator is just a number
  const cell = (v: string) => (v.includes(sep) || /["\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}

/** Tab-separated, which is what a paste into any spreadsheet splits into cells. */
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n') + '\n';
}
