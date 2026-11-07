/**
 * Import of measured / manufacturer directivity balloons into BTR's normalized
 * SpeakerModel.
 *
 * WHY THIS EXISTS, AND WHY IT DOES NOT READ .GLL
 * ----------------------------------------------
 * A `.GLL` is a compiled binary produced by EASE SpeakerLab under an
 * authorization file. AFMG publishes no specification for it and no third-party
 * reader, and the data inside is licensed by manufacturers to AFMG for use in
 * AFMG's own applications. Parsing it here would mean reverse-engineering a
 * protected format and redistributing licensed data.
 *
 * The licence-clean route, which is what this module implements, is the one the
 * architecture was built around from the start:
 *
 *   licensed source data
 *     -> the USER exports it, locally, from software they are licensed for
 *     -> this importer
 *     -> SpeakerModel { predictionData: balloon }   (stays in their project)
 *
 * Nothing imported this way is bundled or redistributed: it lands in the
 * project's own customSpeakers list.
 *
 * THE LEVEL CONTRACT
 * ------------------
 * The engine multiplies a source's amplitude (from refSplDb + levelDb) by the
 * balloon's complex value, so the balloon must be RELATIVE directivity, not
 * absolute SPL — otherwise the level is counted twice. Import therefore
 * normalises the whole dataset by the on-axis (0 deg, 0 deg) value at a
 * reference frequency, and hands the subtracted level back so the caller can
 * put it into refSplDb where it belongs.
 *
 * Normalising by ONE frequency rather than per-frequency is deliberate: it makes
 * the data independent of whether the export was absolute or relative, while
 * keeping the on-axis frequency response — which for a subwoofer is real
 * information, not something to flatten away.
 */

import type { BalloonDataset, DataQuality, SpeakerModel } from '../../speakers/schema';

/** A balloon as read off the file, before normalisation. */
export interface RawBalloon {
  frequenciesHz: number[];
  azimuthDeg: number[];
  elevationDeg: number[];
  /** index = (fi * nAz + ai) * nEl + ei */
  magnitudeDb: Float32Array;
  phaseDeg: Float32Array;
  /** true when the file carried no phase column at all */
  phaseAssumed: boolean;
}

export interface BalloonMeta {
  manufacturer?: string;
  model?: string;
  widthM?: number | null;
  heightM?: number | null;
  depthM?: number | null;
  maxSpl?: number | null;
  /** where this data came from — recorded, never guessed */
  sourceNote?: string;
  sourceUrl?: string;
  retrieved?: string;
}

export interface ParsedBalloonFile {
  raw: RawBalloon;
  meta: BalloonMeta;
  warnings: string[];
}

export class BalloonImportError extends Error {}

/* ══════════════════════════════════════════════════════════ dispatch ═══ */

const JSON_EXT = ['.json', '.btrballoon', '.balloon'];
const TEXT_EXT = ['.csv', '.tsv', '.txt'];

/** Extensions this importer offers in the file picker. */
export const BALLOON_EXTENSIONS = [...JSON_EXT, ...TEXT_EXT];

/**
 * Formats that are recognisable but cannot be read, with the reason and the
 * route out. Returning a real explanation beats "no importer accepts this file",
 * which is what a licensed GLL holder would otherwise hit.
 */
export function describeUnreadableSpeakerFile(name: string): string | null {
  const n = name.toLowerCase();
  if (n.endsWith('.gll')) {
    return (
      'A .GLL is a compiled binary that only AFMG\'s own applications (EASE, EASE Focus, ' +
      'SpeakerLab) can read, and the data inside is licensed to AFMG rather than released. ' +
      'BTR will not reverse-engineer it. If you hold a licence for this GLL, export its ' +
      'balloon from SpeakerLab or EASE Focus as text and import that here, one row per ' +
      'frequency / azimuth / elevation with magnitude and phase.'
    );
  }
  if (n.endsWith('.xgll')) {
    return (
      'An .XGLL is the SpeakerLab authoring source, not a prediction dataset. It describes ' +
      'how to build a GLL rather than containing the compiled balloon. Export the balloon ' +
      'itself as text and import that instead.'
    );
  }
  return null;
}

export async function parseBalloonFile(file: File): Promise<ParsedBalloonFile> {
  const refusal = describeUnreadableSpeakerFile(file.name);
  if (refusal) throw new BalloonImportError(refusal);

  const text = await file.text();
  const name = file.name.toLowerCase();
  const looksJson = JSON_EXT.some((e) => name.endsWith(e)) || text.trimStart().startsWith('{');
  return looksJson ? parseBalloonJson(text) : parseBalloonText(text);
}

/* ══════════════════════════════════════════════════════════════ JSON ═══ */

/**
 * BTR's own documented balloon format. This is the target every converter
 * should aim at, and the only one whose layout BTR defines rather than infers.
 */
export function parseBalloonJson(text: string): ParsedBalloonFile {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new BalloonImportError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const nums = (key: string): number[] => {
    const v = doc[key];
    if (!Array.isArray(v) || !v.length) {
      throw new BalloonImportError(`"${key}" must be a non-empty array of numbers.`);
    }
    const out = v.map(Number);
    if (out.some((x) => !isFinite(x))) throw new BalloonImportError(`"${key}" holds a non-numeric value.`);
    return out;
  };

  const frequenciesHz = nums('frequenciesHz');
  const azimuthDeg = nums('azimuthDeg');
  const elevationDeg = nums('elevationDeg');
  const expected = frequenciesHz.length * azimuthDeg.length * elevationDeg.length;

  const magnitudeDb = nums('magnitudeDb');
  if (magnitudeDb.length !== expected) {
    throw new BalloonImportError(
      `"magnitudeDb" has ${magnitudeDb.length} values but the axes describe ${expected} ` +
        `(${frequenciesHz.length} × ${azimuthDeg.length} × ${elevationDeg.length}).`,
    );
  }

  const warnings: string[] = [];
  let phase: number[];
  let phaseAssumed = false;
  if (doc.phaseDeg === undefined) {
    phase = new Array(expected).fill(0);
    phaseAssumed = true;
  } else {
    phase = nums('phaseDeg');
    if (phase.length !== expected) {
      throw new BalloonImportError(
        `"phaseDeg" has ${phase.length} values but the axes describe ${expected}.`,
      );
    }
  }

  const meta: BalloonMeta = {
    manufacturer: str(doc.manufacturer),
    model: str(doc.model),
    ...readDimensions(doc.dimensions),
    maxSpl: numOrNull(doc.maxSpl ?? doc.refSplDb),
    sourceNote: str(readPath(doc, ['source', 'note']) ?? readPath(doc, ['source', 'origin'])),
    sourceUrl: str(readPath(doc, ['source', 'url'])),
    retrieved: str(readPath(doc, ['source', 'retrieved'])),
  };

  const raw = assembleGrid(
    frequenciesHz,
    azimuthDeg,
    elevationDeg,
    Float32Array.from(magnitudeDb),
    Float32Array.from(phase),
    phaseAssumed,
    warnings,
  );
  return { raw, meta, warnings };
}

/* ═══════════════════════════════════════════════════════ delimited ═══ */

const COLUMN_ALIASES: Record<'f' | 'az' | 'el' | 'mag' | 'phase', string[]> = {
  f: ['freq_hz', 'frequency_hz', 'frequency', 'freq', 'hz', 'f'],
  az: ['az_deg', 'azimuth_deg', 'azimuth', 'az', 'horizontal', 'hor', 'phi'],
  el: ['el_deg', 'elevation_deg', 'elevation', 'el', 'vertical', 'ver', 'theta'],
  mag: ['mag_db', 'magnitude_db', 'magnitude', 'spl_db', 'level_db', 'spl', 'mag', 'db', 'level'],
  phase: ['phase_deg', 'phase', 'ph', 'arg'],
};

/**
 * One row per (frequency, azimuth, elevation) cell. The HEADER names the
 * columns, so BTR never has to assume a column order it has not been told —
 * which is what keeps this honest for exports whose layout we have not seen.
 */
export function parseBalloonText(text: string): ParsedBalloonFile {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
  if (lines.length < 2) throw new BalloonImportError('The file has no header and data rows.');

  const delim = pickDelimiter(lines[0]);
  const header = lines[0].split(delim).map((h) => normaliseHeader(h));

  // Match on letters and digits only, on both sides, so "SPL (dB)", "spl_db"
  // and "SPLdB" are the same column without needing an alias for each spelling.
  const col = (kind: keyof typeof COLUMN_ALIASES): number => {
    const wanted = COLUMN_ALIASES[kind].map(bare);
    return header.findIndex((h) => wanted.includes(bare(h)));
  };

  const iF = col('f'), iAz = col('az'), iEl = col('el'), iMag = col('mag');
  const iPhase = col('phase');

  const missing = (['f', 'az', 'el', 'mag'] as const).filter(
    (k) => col(k) < 0,
  );
  if (missing.length) {
    throw new BalloonImportError(
      `The header is missing a column for: ${missing.join(', ')}. ` +
        `Expected something like "freq_hz, az_deg, el_deg, mag_db, phase_deg". ` +
        `Found: ${header.join(', ') || '(nothing)'}.`,
    );
  }

  const warnings: string[] = [];
  const phaseAssumed = iPhase < 0;
  if (phaseAssumed) {
    warnings.push(
      'No phase column found: phase is taken as 0°. Magnitude-only data cannot reproduce ' +
        'a cardioid null or the summation between cabinets correctly, so this model is graded B, not A.',
    );
  }

  interface Row { f: number; az: number; el: number; mag: number; ph: number; }
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(delim);
    const num = (idx: number): number => Number(String(parts[idx] ?? '').trim().replace(',', '.'));
    const r = {
      f: num(iF), az: num(iAz), el: num(iEl), mag: num(iMag),
      ph: phaseAssumed ? 0 : num(iPhase),
    };
    if (!isFinite(r.f) || !isFinite(r.az) || !isFinite(r.el) || !isFinite(r.mag) || !isFinite(r.ph)) {
      throw new BalloonImportError(`Row ${i + 1} has a value that is not a number: "${lines[i]}".`);
    }
    rows.push(r);
  }

  const uniq = (vals: number[]) => [...new Set(vals.map((v) => round6(v)))].sort((a, b) => a - b);
  const frequenciesHz = uniq(rows.map((r) => r.f));
  const azimuthDeg = uniq(rows.map((r) => r.az));
  const elevationDeg = uniq(rows.map((r) => r.el));
  const nF = frequenciesHz.length, nAz = azimuthDeg.length, nEl = elevationDeg.length;
  const expected = nF * nAz * nEl;

  if (rows.length !== expected) {
    throw new BalloonImportError(
      `The grid is not complete: ${frequenciesHz.length} frequencies × ${nAz} azimuths × ` +
        `${nEl} elevations needs ${expected} rows, but the file has ${rows.length}. ` +
        'Every combination must appear exactly once.',
    );
  }

  const fi = indexMap(frequenciesHz), ai = indexMap(azimuthDeg), ei = indexMap(elevationDeg);
  const magnitudeDb = new Float32Array(expected).fill(NaN);
  const phaseDeg = new Float32Array(expected);
  for (const r of rows) {
    const n = (fi.get(round6(r.f))! * nAz + ai.get(round6(r.az))!) * nEl + ei.get(round6(r.el))!;
    if (!Number.isNaN(magnitudeDb[n])) {
      throw new BalloonImportError(
        `Duplicate row for ${r.f} Hz, az ${r.az}°, el ${r.el}°.`,
      );
    }
    magnitudeDb[n] = r.mag;
    phaseDeg[n] = r.ph;
  }

  const raw = assembleGrid(
    frequenciesHz, azimuthDeg, elevationDeg, magnitudeDb, phaseDeg, phaseAssumed, warnings,
  );
  return { raw, meta: {}, warnings };
}

/* ═══════════════════════════════════════════════════ normalisation ═══ */

export interface NormalisedBalloon {
  dataset: BalloonDataset;
  /** the on-axis magnitude that was divided out, dB — belongs in refSplDb */
  onAxisDb: number;
  /** the frequency the normalisation was taken at */
  refHz: number;
  warnings: string[];
}

/**
 * Divide the balloon through by its on-axis value at one frequency, so what the
 * engine multiplies by is pure directivity. See the level contract at the top.
 */
export function normaliseBalloon(raw: RawBalloon, refHz?: number): NormalisedBalloon {
  const { frequenciesHz, azimuthDeg, elevationDeg } = raw;
  const nAz = azimuthDeg.length, nEl = elevationDeg.length;

  const fIdx = refHz === undefined
    ? nearestIndex(frequenciesHz, geometricMiddle(frequenciesHz))
    : nearestIndex(frequenciesHz, refHz);
  const aIdx = nearestIndex(azimuthDeg, 0);
  const eIdx = nearestIndex(elevationDeg, 0);

  const warnings: string[] = [];
  if (Math.abs(azimuthDeg[aIdx]) > 1 || Math.abs(elevationDeg[eIdx]) > 1) {
    warnings.push(
      `The grid has no on-axis cell: the nearest is az ${azimuthDeg[aIdx]}°, ` +
        `el ${elevationDeg[eIdx]}°, which is what the normalisation used.`,
    );
  }

  const at = (fi: number, ai: number, ei: number) => (fi * nAz + ai) * nEl + ei;
  const refMag = raw.magnitudeDb[at(fIdx, aIdx, eIdx)];
  const refPhase = raw.phaseDeg[at(fIdx, aIdx, eIdx)];

  const n = raw.magnitudeDb.length;
  const magnitudeDb = new Float32Array(n);
  const phaseDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    magnitudeDb[i] = raw.magnitudeDb[i] - refMag;
    phaseDeg[i] = raw.phaseDeg[i] - refPhase;
  }

  return {
    dataset: {
      kind: 'balloon',
      frequenciesHz: [...frequenciesHz],
      azimuthDeg: [...azimuthDeg],
      elevationDeg: [...elevationDeg],
      magnitudeDb,
      phaseDeg,
    },
    onAxisDb: refMag,
    refHz: frequenciesHz[fIdx],
    warnings,
  };
}

/* ════════════════════════════════════════════════════ model building ═══ */

export interface BuildOptions {
  id: string;
  /** what the user asserts about the provenance — never inferred */
  meta: BalloonMeta;
  /** A only when the data carries real phase and the user confirms the licence */
  quality: Extract<DataQuality, 'A' | 'B'>;
  refHz?: number;
}

export function buildBalloonModel(
  raw: RawBalloon,
  opts: BuildOptions,
): { model: SpeakerModel; warnings: string[] } {
  const norm = normaliseBalloon(raw, opts.refHz);
  const m = opts.meta;
  const warnings = [...norm.warnings];

  // Phase-less data cannot be grade A no matter what the user selects: without
  // phase the summation between cabinets is wrong, which is the whole point.
  const quality: DataQuality = raw.phaseAssumed ? 'B' : opts.quality;

  return {
    model: {
      id: opts.id,
      manufacturer: m.manufacturer?.trim() || 'Unknown',
      model: m.model?.trim() || 'Imported balloon',
      dimensions: {
        widthM: m.widthM ?? null,
        heightM: m.heightM ?? null,
        depthM: m.depthM ?? null,
      },
      type: 'other',
      maxSpl: m.maxSpl ?? (isFinite(norm.onAxisDb) && norm.onAxisDb > 60 ? norm.onAxisDb : null),
      predictionData: norm.dataset,
      dataQuality: quality,
      isCustom: true,
      source: {
        prediction: {
          type: 'user-import',
          url: m.sourceUrl,
          retrieved: m.retrieved ?? new Date().toISOString().slice(0, 10),
          note:
            (m.sourceNote ? m.sourceNote + ' · ' : '') +
            `normalised on axis at ${norm.refHz.toFixed(1)} Hz ` +
            `(${norm.onAxisDb.toFixed(1)} dB divided out)` +
            (raw.phaseAssumed ? ' · no phase in source, taken as 0°' : ''),
        },
      },
    },
    warnings,
  };
}

/* ════════════════════════════════════════════════════════ helpers ═══ */

function assembleGrid(
  frequenciesHz: number[],
  azimuthDeg: number[],
  elevationDeg: number[],
  magnitudeDb: Float32Array,
  phaseDeg: Float32Array,
  phaseAssumed: boolean,
  warnings: string[],
): RawBalloon {
  requireIncreasing(frequenciesHz, 'frequenciesHz');
  requireIncreasing(azimuthDeg, 'azimuthDeg');
  requireIncreasing(elevationDeg, 'elevationDeg');
  if (frequenciesHz[0] <= 0) throw new BalloonImportError('Frequencies must be greater than zero.');

  for (let i = 0; i < magnitudeDb.length; i++) {
    if (!isFinite(magnitudeDb[i])) throw new BalloonImportError('The grid has a missing or non-finite magnitude.');
  }

  const span = azimuthDeg[azimuthDeg.length - 1] - azimuthDeg[0];
  if (span < 180) {
    warnings.push(
      `The azimuth grid only spans ${span.toFixed(0)}°: directions outside it are clamped ` +
        'to the edge value rather than interpolated.',
    );
  }
  if (elevationDeg.length === 1) {
    warnings.push(
      'Only one elevation is present, so the pattern is treated as constant with elevation. ' +
        'That is fine for a horizontal-plane dataset in a top view, but the side view will be flat.',
    );
  }
  return { frequenciesHz, azimuthDeg, elevationDeg, magnitudeDb, phaseDeg, phaseAssumed };
}

function requireIncreasing(v: number[], name: string): void {
  for (let i = 1; i < v.length; i++) {
    if (v[i] <= v[i - 1]) {
      throw new BalloonImportError(`"${name}" must increase; found ${v[i - 1]} then ${v[i]}.`);
    }
  }
}

/** Whichever separator actually splits the header into the most fields. */
function pickDelimiter(headerLine: string): string | RegExp {
  const candidates: Array<[string, number]> = [
    ['\t', headerLine.split('\t').length],
    [';', headerLine.split(';').length],
    [',', headerLine.split(',').length],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 1 ? candidates[0][0] : /\s+/;
}

function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s()[\]°"']+/g, '').replace(/[-.]/g, '_');
}

function indexMap(vals: number[]): Map<number, number> {
  return new Map(vals.map((v, i) => [v, i]));
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** A header or alias reduced to its letters and digits. */
const bare = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function nearestIndex(grid: number[], target: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < grid.length; i++) {
    const d = Math.abs(grid[i] - target);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function geometricMiddle(v: number[]): number {
  return Math.sqrt(v[0] * v[v.length - 1]);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * A number the file actually states, or null.
 *
 * `Number()` is the trap here: it maps null, an empty string and a whitespace
 * string to 0, so `"dimensions": { "widthM": null }` used to arrive as a
 * CONFIRMED 0 m and `boxSize` reported 0 x 0 x 0 mm as a measurement rather
 * than as "dimensions unknown". The same coercion turned an absent max SPL into
 * a 0 dB drive level. Only a real number, or a string that spells one, counts.
 */
function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }
  return null;
}

function readPath(doc: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = doc;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function readDimensions(v: unknown): Pick<BalloonMeta, 'widthM' | 'heightM' | 'depthM'> {
  if (typeof v !== 'object' || v === null) return {};
  const d = v as Record<string, unknown>;
  return {
    widthM: numOrNull(d.widthM),
    heightM: numOrNull(d.heightM),
    depthM: numOrNull(d.depthM),
  };
}
