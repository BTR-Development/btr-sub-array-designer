/**
 * BTR built-in speaker library.
 *
 * ------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING A PREDICTION
 * ------------------------------------------------------------------------
 * DIMENSIONS, WEIGHT, FREQUENCY RANGE and MAX SPL below were taken from the
 * manufacturers' own published product pages on the dates recorded in
 * `source`. Where a value could not be confirmed it is `null` — nothing here
 * is estimated or reconstructed from memory.
 *
 * ACOUSTIC PREDICTION DATA is a different matter. Real per-model directivity
 * lives in AFMG GLL files, which are compiled binaries produced by EASE
 * SpeakerLab and licensed for use inside AFMG's own applications. BTR therefore
 * ships NO manufacturer prediction data. Entries are dataQuality 'C', an
 * analytical model:
 *
 *   - omni entries   : ideal point source (a good first-order model for a
 *                      single sub over most of 20-200 Hz in free field)
 *   - cardioid entries: physical two-element pressure-gradient model, using
 *                      the cabinet's real depth as the element spacing
 *
 * The interference physics between cabinets is exact regardless; what is
 * approximate is the radiation pattern of one cabinet on its own.
 */

import {
  analyticCardioidDataset,
  type DataProvenance,
  type SpeakerModel,
} from './schema';
import { loadExtraSpeakers } from './loadExtra';

const RETRIEVED = '2026-08-17';

function mfgSource(url: string, note?: string): DataProvenance {
  return { type: 'manufacturer-website', url, retrieved: RETRIEVED, note };
}

const ANALYTIC_OMNI: DataProvenance = {
  type: 'analytical',
  note: 'Ideal omnidirectional point source. No measured directivity applied.',
};

const ANALYTIC_CARDIOID: DataProvenance = {
  type: 'analytical',
  note:
    'Two-element pressure-gradient model (rear element at one cabinet depth, ' +
    'delayed by d/c, polarity inverted), normalised on axis. Approximates the ' +
    'cabinet\'s documented cardioid mode; it is not the manufacturer\'s data.',
};

const dbB22: SpeakerModel = {
  id: 'db-b22-sub',
  manufacturer: 'd&b audiotechnik',
  model: 'B22-SUB',
  dimensions: { widthM: 1.16, heightM: 0.585, depthM: 0.92 },
  weightKg: 106,
  type: 'omnidirectional',
  construction: 'bandpass horn, 2 x 18" neodymium',
  radiation: 'omnidirectional (ground stacked); CSA/cardioid built from multiple cabinets',
  maxSpl: 143,
  frequencyRange: { minHz: 37, maxHz: 90 },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource(
      'https://www.dbaudio.com/global/en/products/subwoofers/b22-sub/',
      '585 x 1160 x 920 mm (H x W x D); 1046 mm depth incl. wheelboard',
    ),
    general: mfgSource(
      'https://www.dbaudio.com/global/en/products/subwoofers/b22-sub/',
      'Frequency response 37-90 Hz (-5 dB); max SPL 143 dB with D40/D80/D90/40D',
    ),
    prediction: ANALYTIC_OMNI,
  },
};

const laKs28: SpeakerModel = {
  id: 'la-ks28',
  manufacturer: 'L-Acoustics',
  model: 'KS28',
  dimensions: { widthM: 1.34, heightM: 0.55, depthM: 0.719 },
  weightKg: 79,
  type: 'omnidirectional',
  construction: 'bass-reflex with L-Vents, 2 x 18" neodymium',
  radiation: 'standard (omni) or cardioid configuration',
  maxSpl: 143,
  frequencyRange: { minHz: 25, maxHz: null },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource('https://www.l-acoustics.com/products/ks28/', '1340 (W) x 550 (H) x 719 (D) mm'),
    general: mfgSource('https://www.l-acoustics.com/products/ks28/', 'LF limit 25 Hz (-10 dB); max SPL 143 dB half-space, pink noise'),
    prediction: ANALYTIC_OMNI,
  },
};

const laKs21: SpeakerModel = {
  id: 'la-ks21',
  manufacturer: 'L-Acoustics',
  model: 'KS21',
  dimensions: { widthM: 0.764, heightM: 0.571, depthM: 0.601 },
  weightKg: 49,
  type: 'omnidirectional',
  construction: 'bass-reflex with L-Vents, 1 x 21" neodymium',
  radiation: 'standard (omni) or cardioid configuration',
  maxSpl: 138,
  frequencyRange: { minHz: 29, maxHz: null },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource('https://www.l-acoustics.com/products/ks21/', '764 (W) x 571 (H) x 601 (D) mm'),
    general: mfgSource('https://www.l-acoustics.com/products/ks21/', 'LF limit 29 Hz (-10 dB); max SPL 138 dB'),
    prediction: ANALYTIC_OMNI,
  },
};

const laSb18: SpeakerModel = {
  id: 'la-sb18',
  manufacturer: 'L-Acoustics',
  model: 'SB18',
  dimensions: { widthM: 0.75, heightM: 0.553, depthM: 0.707 },
  weightKg: 52,
  type: 'omnidirectional',
  construction: 'dual bass-reflex with L-Vents, 1 x 18"',
  radiation: 'standard (omni) or cardioid configuration',
  maxSpl: 138,
  frequencyRange: { minHz: 32, maxHz: null },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource('https://www.l-acoustics.com/products/sb18/', '750 (W) x 553 (H) x 707 (D) mm'),
    general: mfgSource('https://www.l-acoustics.com/products/sb18/', 'LF limit 32 Hz (-10 dB); max SPL 138 dB'),
    prediction: ANALYTIC_OMNI,
  },
};

const nexoRs18: SpeakerModel = {
  id: 'nexo-rs18',
  manufacturer: 'NEXO',
  model: 'RS18 Ray Sub',
  dimensions: { widthM: 1.403, heightM: 0.52, depthM: 0.732 },
  weightKg: 105,
  type: 'omnidirectional',
  construction: '2 x 18" long-excursion neodymium, Baltic birch',
  radiation: 'omni mode or directional (cardioid) mode',
  maxSpl: 146,
  frequencyRange: { minHz: 30, maxHz: 100 },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource(
      'https://www.nexo-sa.com/products/rs18/',
      '1403 x 520 x 732 mm (W x H x D), touring version with handles; install version 1238 mm wide',
    ),
    general: mfgSource(
      'https://www.nexo-sa.com/products/rs18/',
      'Omni mode 30-100 Hz (-3 dB); 143-146 dB peak depending on amplifier; 105 kg with handles',
    ),
    prediction: ANALYTIC_OMNI,
  },
};

const adamsonE219: SpeakerModel = {
  id: 'adamson-e219',
  manufacturer: 'Adamson',
  model: 'E219',
  dimensions: { widthM: 1.44, heightM: 0.597, depthM: 0.889 },
  weightKg: 106.6,
  type: 'omnidirectional',
  construction: '2 x 19" Kevlar neodymium (SD19), marine grade birch',
  radiation: 'omnidirectional; cardioid built from multiple cabinets',
  maxSpl: 144,
  frequencyRange: { minHz: 28, maxHz: 90 },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource(
      'https://adamson.ai/products/loudspeakers/e-series/e219',
      'Width 1440 mm, front height 597 mm, depth 889 mm',
    ),
    general: mfgSource(
      'https://adamson.ai/products/loudspeakers/e-series/e219',
      '28-90 Hz (+/-3 dB); 144 dB peak; 106.6 kg',
    ),
    prediction: ANALYTIC_OMNI,
  },
};

const jblVtxB28: SpeakerModel = {
  id: 'jbl-vtx-b28',
  manufacturer: 'JBL Professional',
  model: 'VTX B28',
  dimensions: { widthM: 1.324, heightM: 0.508, depthM: 0.75 },
  weightKg: 87,
  type: 'omnidirectional',
  construction: '2 x 18" JBL 2288H-M Differential Drive, Finnish birch',
  radiation: 'omnidirectional or cardioid mode',
  maxSpl: 141,
  frequencyRange: { minHz: 25, maxHz: 80 },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: mfgSource('https://jblpro.com/en/products/vtx-b28', '508 mm H x 1324 mm W x 750 mm D'),
    general: mfgSource('https://jblpro.com/en/products/vtx-b28', '25-80 Hz (-10 dB); 141 dB peak; 87 kg'),
    prediction: ANALYTIC_OMNI,
  },
};

/**
 * Generic reference cabinets. These are NOT real products — they exist so the
 * physics can be exercised without attributing anything to a manufacturer.
 */
const refOmni18: SpeakerModel = {
  id: 'btr-ref-omni-18',
  manufacturer: 'BTR Reference',
  model: 'Omni 18"',
  dimensions: { widthM: 0.6, heightM: 0.6, depthM: 0.7 },
  weightKg: null,
  type: 'omnidirectional',
  construction: 'generic single-18 reference cabinet (not a real product)',
  radiation: 'ideal omnidirectional point source',
  maxSpl: 136,
  frequencyRange: { minHz: 30, maxHz: 120 },
  predictionData: { kind: 'omni' },
  dataQuality: 'C',
  source: {
    dimensions: { type: 'synthetic', note: 'Nominal reference geometry, not a manufactured product.' },
    prediction: ANALYTIC_OMNI,
  },
};

/** One number, so the reference cabinet's box and its element spacing cannot drift apart. */
const REF_CARDIOID_DEPTH_M = 0.7;

const refCardioid218: SpeakerModel = {
  id: 'btr-ref-cardioid-218',
  manufacturer: 'BTR Reference',
  model: 'Cardioid 2x18"',
  dimensions: { widthM: 1.2, heightM: 0.6, depthM: REF_CARDIOID_DEPTH_M },
  weightKg: null,
  type: 'cardioid',
  construction: 'generic dual-18 reference cabinet (not a real product)',
  radiation: 'analytical pressure-gradient cardioid',
  maxSpl: 140,
  frequencyRange: { minHz: 30, maxHz: 120 },
  predictionData: analyticCardioidDataset(REF_CARDIOID_DEPTH_M),
  dataQuality: 'C',
  source: {
    dimensions: { type: 'synthetic', note: 'Nominal reference geometry, not a manufactured product.' },
    prediction: ANALYTIC_CARDIOID,
  },
};

/** Hand-curated core set. A null is a cardioid variant we have no depth for. */
// Bez bliźniaków "(cardioid)". Skrzynia frontowa z doklejonym analitycznym
// gradientem udawała produkt, którego nie ma: jako źródła kardioidalne program
// pokazuje suby, które naprawdę są kardioidalne (db-j-sub, db-ksl-sub,
// db-sl-sub, db-v-sub w extra.json) oraz jawnie syntetyczny BTR Reference.
// Kardioidę z frontowych skrzyń buduje się tak, jak na podeście: odwracając
// obudowy w pozycji (wzór F/B), nie wybierając inny głośnik z listy.
const CURATED: SpeakerModel[] = [
  dbB22,
  laKs28,
  laKs21,
  laSb18,
  nexoRs18,
  adamsonE219,
  jblVtxB28,
  refOmni18,
  refCardioid218,
].filter((m): m is SpeakerModel => m !== null);

/**
 * Curated models plus anything added through the data-driven pipeline
 * (src/speakers/extra.json — see scripts/add-speaker.mjs). Curated entries win
 * on an id clash so a bad bulk import cannot silently shadow a verified model.
 */
const curatedIds = new Set(CURATED.map((m) => m.id));
export const BUILTIN_SPEAKERS: SpeakerModel[] = [
  ...CURATED,
  ...loadExtraSpeakers().filter((m) => !curatedIds.has(m.id)),
];

export const DEFAULT_SPEAKER_ID = 'btr-ref-omni-18';

/**
 * The models the program OFFERS, in this order: the six subs the users work
 * with. Everything else stays in BUILTIN_SPEAKERS, so a project saved with a
 * B22 or a V-SUB still opens and still predicts, but it is not proposed in the Add subwoofer dialog or in the model lists, except where a
 * project already uses it (state/store.ts, allSpeakers).
 */
export const OFFERED_SPEAKER_IDS = ['la-ks28', 'la-ks21', 'la-sb18', 'db-j-sub', 'db-sl-sub', 'db-ksl-sub'];
