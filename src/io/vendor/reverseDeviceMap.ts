/**
 * Vendor product -> BTR speaker.
 *
 * The forward map (deviceMap.ts) is many-to-one — everything without an equivalent
 * becomes KS28 or B2-SUB — so it cannot be inverted mechanically. This is the
 * explicit reverse table.
 *
 * A vendor model we do not stock is NOT guessed at. It becomes a project-local
 * placeholder whose dimensions are `unknown`, which the app already renders as a
 * nominal box with a visible "dimensions unknown" note. Inventing a size would
 * silently corrupt array pitch and therefore the prediction.
 */

import type { SpeakerModel } from '../../speakers/schema';
import type { VendorTarget } from './deviceMap';

/** Vendor model string -> BTR speaker id, for cabinets we actually stock. */
const REVERSE: Record<string, string> = {
  // L-Acoustics
  KS28: 'la-ks28',
  KS21: 'la-ks21',
  SB18: 'la-sb18',
  SB28: 'la-ks28', // discontinued predecessor; closest stocked cabinet
  // d&b
  'SL-SUB': 'db-sl-sub',
  'KSL-SUB': 'db-ksl-sub',
  'J-SUB': 'db-j-sub',
  'V-SUB': 'db-v-sub',
  'B22-SUB': 'db-b22-sub',
};

/** Substitutions worth telling the user about, because they are not exact. */
const INEXACT = new Set(['SB28']);

export interface ResolvedDevice {
  speakerId: string;
  /** set when the vendor model is not in the BTR library and a placeholder was made */
  placeholder?: SpeakerModel;
  note?: string;
}

let placeholderCounter = 0;

/**
 * Build a project-local speaker for a vendor model BTR does not stock.
 *
 * Dimensions are left `null` on purpose: the file carries a model name, not a
 * cabinet size, and the BTR library has no verified entry for it.
 */
export function placeholderSpeaker(vendorModel: string, target: VendorTarget): SpeakerModel {
  const manufacturer = target === 'soundvision' ? 'L-Acoustics' : 'd&b audiotechnik';
  return {
    id: `imported-${vendorModel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${(placeholderCounter++).toString(36)}`,
    manufacturer,
    model: vendorModel,
    dimensions: { widthM: null, heightM: null, depthM: null },
    weightKg: null,
    type: 'omnidirectional',
    construction: 'imported: no verified data in the BTR library',
    radiation: 'unknown; simulated as an ideal omnidirectional point source',
    maxSpl: null,
    frequencyRange: null,
    predictionData: { kind: 'omni' },
    dataQuality: 'D',
    isCustom: true,
    proxyNote:
      `Imported from ${target === 'soundvision' ? 'Soundvision' : 'ArrayCalc'}. ` +
      'Only the model name was in the file: dimensions and radiation are unknown, so ' +
      'the cabinet is drawn at a nominal size and simulated as an omnidirectional point ' +
      'source. Pick a library model to get real geometry.',
    source: {
      dimensions: { type: 'imported', note: `Model name "${vendorModel}" taken from the imported file; no dimensions available.` },
      prediction: { type: 'analytical', note: 'Ideal omnidirectional point source. Not manufacturer data.' },
    },
  };
}

/**
 * Resolve one vendor model. `known` is the set of speaker ids available in this
 * project (library + already-created placeholders), so repeated models reuse one
 * placeholder instead of making a new one per cabinet.
 */
export function resolveVendorModel(
  vendorModel: string | null,
  target: VendorTarget,
  known: (id: string) => boolean,
  placeholderCache: Map<string, SpeakerModel>,
): ResolvedDevice {
  const name = (vendorModel || '').trim();
  if (!name) {
    const cached = placeholderCache.get('__unnamed__');
    const ph = cached ?? placeholderSpeaker('Unknown cabinet', target);
    if (!cached) placeholderCache.set('__unnamed__', ph);
    return { speakerId: ph.id, placeholder: cached ? undefined : ph, note: 'Cabinet had no model name in the file.' };
  }

  const mapped = REVERSE[name];
  if (mapped && known(mapped)) {
    return {
      speakerId: mapped,
      note: INEXACT.has(name) ? `"${name}" is not stocked; using the closest BTR cabinet.` : undefined,
    };
  }

  const cached = placeholderCache.get(name);
  if (cached) return { speakerId: cached.id };
  const ph = placeholderSpeaker(name, target);
  placeholderCache.set(name, ph);
  return {
    speakerId: ph.id,
    placeholder: ph,
    note: `"${name}" is not in the BTR library: imported with unknown dimensions.`,
  };
}

export function reverseMapEntries(): Array<[string, string]> {
  return Object.entries(REVERSE);
}
