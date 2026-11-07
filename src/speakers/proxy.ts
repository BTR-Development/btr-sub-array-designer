/**
 * Acoustic proxy selection for custom (user-defined) speakers.
 *
 * A user can describe a cabinet we have never measured. We do NOT invent a
 * directivity for it. Instead we look through the verified library for the
 * closest acoustic analogue and borrow its prediction data, then label the
 * result loudly in the UI as approximate.
 *
 * Ranking (in the order the spec requires):
 *   1. type must match (omni vs cardioid) — a hard gate, not a soft score
 *   2. width      (dominant: sets horizontal source size / array pitch)
 *   3. height
 *   4. depth
 *   5. frequency range overlap, when both are known
 */

import {
  analyticCardioidDataset,
  type PredictionDataset,
  type SpeakerModel,
  type SpeakerType,
} from './schema';

export interface CustomSpeakerSpec {
  name: string;
  manufacturer?: string;
  /** metres, as the user measured the cabinet; a real positive length, never 0 */
  widthM: number;
  heightM: number;
  depthM: number;
  type: Extract<SpeakerType, 'omnidirectional' | 'cardioid'>;
  maxSpl?: number | null;
  frequencyRange?: { minHz: number | null; maxHz: number | null } | null;
}

export interface ProxyMatch {
  model: SpeakerModel;
  score: number;
  reason: string;
}

/** Relative dimension error, saturating so a wildly wrong size cannot dominate. */
function dimError(a: number, b: number | null): number {
  if (b == null || b <= 0 || a <= 0) return 0.5;
  return Math.min(1, Math.abs(a - b) / Math.max(a, b));
}

function rangeError(
  spec: CustomSpeakerSpec['frequencyRange'],
  model: SpeakerModel['frequencyRange'],
): number {
  if (!spec || !model) return 0.25;
  const sMin = spec.minHz, mMin = model.minHz;
  if (sMin == null || mMin == null) return 0.25;
  // an octave of disagreement on the LF corner = full error
  return Math.min(1, Math.abs(Math.log2(sMin / mMin)));
}

const W_WIDTH = 0.45;
const W_HEIGHT = 0.2;
const W_DEPTH = 0.15;
const W_RANGE = 0.2;

export function findProxy(
  spec: CustomSpeakerSpec,
  library: SpeakerModel[],
): ProxyMatch | null {
  const candidates = library.filter(
    (m) => !m.isCustom && (m.type === spec.type || (spec.type === 'omnidirectional' && m.type === 'infra')),
  );
  const pool = candidates.length ? candidates : library.filter((m) => !m.isCustom);
  if (!pool.length) return null;

  let best: ProxyMatch | null = null;
  for (const m of pool) {
    const ew = dimError(spec.widthM, m.dimensions.widthM);
    const eh = dimError(spec.heightM, m.dimensions.heightM);
    const ed = dimError(spec.depthM, m.dimensions.depthM);
    const er = rangeError(spec.frequencyRange, m.frequencyRange);
    const typePenalty = m.type === spec.type ? 0 : 1;
    const score = W_WIDTH * ew + W_HEIGHT * eh + W_DEPTH * ed + W_RANGE * er + typePenalty;

    if (!best || score < best.score) {
      best = {
        model: m,
        score,
        reason:
          `matched on ${spec.type === 'cardioid' ? 'cardioid' : 'omni'} radiation, ` +
          `width ${spec.widthM.toFixed(2)} m vs ${(m.dimensions.widthM ?? NaN).toFixed(2)} m` +
          (typePenalty ? ' (no same-type candidate available)' : ''),
      };
    }
  }
  return best;
}

/**
 * What the custom cabinet radiates with.
 *
 * A proxy lends its DIRECTIVITY. An element dataset is not directivity, it is
 * GEOMETRY: the rear element of a library cardioid sits one PROXY depth behind
 * the origin, so borrowing it wholesale placed a radiator at a distance the
 * user's cabinet does not have — a 0.4 m deep box inherited the Meyer 750-LFC's
 * 0.53 m separation and its rear element ended up 0.13 m behind its own back
 * baffle, outside the box the user drew, with the cardioid delay of a cabinet
 * they do not own. The gradient is therefore rebuilt from the user's own depth,
 * which is the one dimension of theirs we know.
 *
 * A balloon carries no geometry, only measured directivity, so it is borrowed as
 * it stands — that is exactly what a quality D proxy is for.
 */
function predictionFor(spec: CustomSpeakerSpec, match: ProxyMatch | null): PredictionDataset {
  const borrowed = match?.model.predictionData;
  if (!borrowed) return { kind: 'omni' };
  return borrowed.kind === 'elements' ? analyticCardioidDataset(spec.depthM) : borrowed;
}

let customCounter = 0;

/** Build a SpeakerModel for a user-defined cabinet, wired to its proxy. */
export function buildCustomSpeaker(
  spec: CustomSpeakerSpec,
  library: SpeakerModel[],
): SpeakerModel {
  const match = findProxy(spec, library);
  const prediction = predictionFor(spec, match);
  const id = `custom-${Date.now().toString(36)}-${customCounter++}`;
  return {
    id,
    manufacturer: spec.manufacturer?.trim() || 'Custom',
    model: spec.name.trim() || 'Custom subwoofer',
    dimensions: { widthM: spec.widthM, heightM: spec.heightM, depthM: spec.depthM },
    weightKg: null,
    type: spec.type,
    construction: 'user-defined',
    radiation: spec.type === 'cardioid' ? 'cardioid (proxied)' : 'omnidirectional (proxied)',
    // The proxy's rating is the proxy's. Inheriting it printed 130.5 dB in the
    // Inspector as if it were this cabinet's published figure, and — because
    // refSplDb is a drive level — it set the cabinet's amplitude in the sum too.
    maxSpl: spec.maxSpl ?? null,
    frequencyRange: spec.frequencyRange ?? null,
    predictionData: prediction,
    dataQuality: 'D',
    isCustom: true,
    proxyOfId: match?.model.id,
    proxyNote: match
      ? `${match.model.manufacturer} ${match.model.model}: ${match.reason}`
      : 'no proxy found; using ideal omnidirectional point source',
    source: {
      dimensions: { type: 'user', note: 'Entered by the user.' },
      prediction:
        prediction.kind === 'elements'
          ? {
              // Say what the pattern actually came from: the proxy chose the
              // MODEL, the separation is the user's own depth, not the proxy's.
              type: 'analytical',
              note:
                'Two-element pressure-gradient model built from the depth you entered, ' +
                `matched to ${match?.model.manufacturer} ${match?.model.model}. Not manufacturer data.`,
            }
          : {
              type: 'proxy',
              note: match
                ? `Acoustic prediction borrowed from ${match.model.manufacturer} ${match.model.model}. Approximate.`
                : 'Ideal omnidirectional point source. Approximate.',
            },
    },
  };
}
