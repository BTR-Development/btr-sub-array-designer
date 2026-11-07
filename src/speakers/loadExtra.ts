/**
 * Library expansion pipeline (stage C).
 *
 * SOURCING POLICY: figures may be taken from a manufacturer DATASHEET (PDF) or
 * from a product page, whichever states them. The datasheet is preferred — it is
 * versioned, it usually states the measurement basis behind a max-SPL number,
 * and it does not change under its own URL the way a product page does. What is
 * recorded is the FACT plus where it was read; the document itself is never
 * bundled into the repo.
 *
 * The rule that did not change: a figure nobody publishes stays `null`. Never
 * guess, never interpolate from a similar model.
 *
 * `extra.json` is a plain data file so the library can grow without touching
 * TypeScript. Records are added with:
 *
 *     node scripts/add-speaker.mjs path/to/record.json
 *
 * which validates strictly and refuses anything without provenance. This module
 * is the lenient runtime half: a malformed record is skipped with a warning
 * rather than taking the whole app down.
 *
 * Nothing here can produce quality A or B — imported manufacturer prediction
 * data would arrive through a separate importer, not this file.
 */

import raw from './extra.json';
import {
  analyticCardioidDataset,
  type SpeakerModel,
  type SpeakerType,
} from './schema';

export interface RawSpeakerRecord {
  id: string;
  manufacturer: string;
  model: string;
  /** millimetres, or null when the manufacturer does not publish it */
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
  weightKg?: number | null;
  type: SpeakerType;
  construction?: string;
  radiation?: string;
  maxSpl?: number | null;
  minHz?: number | null;
  maxHz?: number | null;
  sourceUrl: string;
  /**
   * Where `sourceUrl` points. A datasheet PDF is the preferred source: it is
   * versioned, it states the measurement basis for max SPL, and it does not
   * silently change under the URL the way a product page does.
   */
  sourceType?: SourceKind;
  /** page in the datasheet the figures were read from, when it has several */
  sourcePage?: number | null;
  retrieved: string;
  note?: string;
}

export type SourceKind = 'manufacturer-datasheet' | 'manufacturer-website';

const SOURCE_KINDS: SourceKind[] = ['manufacturer-datasheet', 'manufacturer-website'];

const TYPES: SpeakerType[] = ['omnidirectional', 'cardioid', 'infra', 'other'];

export function validateRecord(r: unknown): string[] {
  const errs: string[] = [];
  const o = r as Partial<RawSpeakerRecord>;
  const req = (k: keyof RawSpeakerRecord) => {
    if (!o[k] || typeof o[k] !== 'string') errs.push(`"${String(k)}" is required and must be a non-empty string`);
  };
  req('id'); req('manufacturer'); req('model'); req('sourceUrl'); req('retrieved');

  if (!o.type || !TYPES.includes(o.type)) errs.push(`"type" must be one of ${TYPES.join(' | ')}`);

  for (const k of ['widthMm', 'heightMm', 'depthMm'] as const) {
    const v = o[k];
    if (v === undefined) {
      errs.push(`"${k}" must be present (use null when the value is not published, never guess)`);
    } else if (v !== null && (typeof v !== 'number' || v <= 20 || v > 4000)) {
      errs.push(`"${k}" must be null or a plausible millimetre value (20-4000)`);
    }
  }
  if (o.maxSpl != null && (o.maxSpl < 80 || o.maxSpl > 170)) errs.push('"maxSpl" is outside 80-170 dB');
  // The gradient model's element separation IS the cabinet depth, and its rear
  // delay is d/c. A record that asks for a cardioid without publishing a depth
  // used to get `?? 0.7`, i.e. a separation and a delay invented for it, so it
  // is refused instead: the omni record alone is honest, a guessed cardioid is not.
  if (o.type === 'cardioid' && o.depthMm == null) {
    errs.push(
      '"depthMm" must be published for a cardioid model: ' +
        'the two-element separation and its delay are the cabinet depth',
    );
  }
  if (o.sourceUrl && !/^https?:\/\//.test(o.sourceUrl)) errs.push('"sourceUrl" must be an http(s) URL');
  if (o.sourceType !== undefined && !SOURCE_KINDS.includes(o.sourceType)) {
    errs.push(`"sourceType" must be one of ${SOURCE_KINDS.join(' | ')}`);
  }
  if (o.sourcePage != null && (typeof o.sourcePage !== 'number' || o.sourcePage < 1)) {
    errs.push('"sourcePage" must be null or a page number of 1 or more');
  }
  return errs;
}

/**
 * The published depth in metres of a record that `validateRecord` has passed as
 * a cardioid, so a missing one is a programming error rather than bad data.
 */
function depthM(r: RawSpeakerRecord): number {
  if (r.depthMm == null) {
    throw new Error(`speaker "${r.id}": a cardioid needs a published depth`);
  }
  return r.depthMm / 1000;
}

function toModel(r: RawSpeakerRecord): SpeakerModel {
  const mm = (v: number | null | undefined) => (v == null ? null : v / 1000);
  const kind: SourceKind = r.sourceType ?? 'manufacturer-website';
  const cite = {
    type: kind,
    url: r.sourceUrl,
    retrieved: r.retrieved,
    note: [r.sourcePage != null ? `p. ${r.sourcePage}` : null, r.note]
      .filter(Boolean)
      .join(' · ') || undefined,
  };
  return {
    id: r.id,
    manufacturer: r.manufacturer,
    model: r.model,
    dimensions: { widthM: mm(r.widthMm), heightM: mm(r.heightMm), depthM: mm(r.depthMm) },
    weightKg: r.weightKg ?? null,
    type: r.type,
    construction: r.construction,
    radiation: r.radiation,
    maxSpl: r.maxSpl ?? null,
    frequencyRange:
      r.minHz == null && r.maxHz == null ? null : { minHz: r.minHz ?? null, maxHz: r.maxHz ?? null },
    // validateRecord has already refused a cardioid without a depth, so this
    // asks the gradient model only for a separation the manufacturer published.
    predictionData:
      r.type === 'cardioid' ? analyticCardioidDataset(depthM(r)) : { kind: 'omni' },
    dataQuality: 'C',
    source: {
      dimensions: cite,
      general: { type: kind, url: r.sourceUrl, retrieved: r.retrieved },
      prediction: {
        type: 'analytical',
        note:
          r.type === 'cardioid'
            ? 'Two-element pressure-gradient model. Not manufacturer data.'
            : 'Ideal omnidirectional point source. Not manufacturer data.',
      },
    },
  };
}

/**
 * Validate and convert a batch of raw records. Split out from
 * `loadExtraSpeakers` so the pipeline can be exercised on records that are not
 * in `extra.json` — which is how the sourcing policy is tested.
 */
export function buildModels(records: unknown[]): SpeakerModel[] {
  const out: SpeakerModel[] = [];
  for (const rec of records) {
    const errs = validateRecord(rec);
    if (errs.length) {
      const id = (rec as Partial<RawSpeakerRecord>).id ?? '<no id>';
      console.warn(`[BTR] skipping speaker "${id}" in extra.json: ${errs.join('; ')}`);
      continue;
    }
    const r = rec as RawSpeakerRecord;
    // Dawny `cardioidVariant` dostawiał tu bliźniaka "(cardioid)" z modelu
    // gradientowego. Usunięte: skrzynia frontowa z dorobioną kardioidą to nie
    // jest produkt z karty katalogowej, a kardioidalne naprawdę suby wchodzą
    // do biblioteki wprost, z type: 'cardioid'.
    out.push(toModel(r));
  }
  return out;
}

export function loadExtraSpeakers(): SpeakerModel[] {
  return buildModels(raw as unknown[]);
}
