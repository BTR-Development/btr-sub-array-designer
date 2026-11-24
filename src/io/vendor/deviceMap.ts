/**
 * BTR speaker model -> vendor device, per export target.
 *
 * Neither target can be given an arbitrary model string:
 *
 *  - Soundvision resolves `<model>` + `<preset>` against its own device library.
 *    Every reference file we have is KS28 / KS28_60, and no other preset string has
 *    ever been observed, so KS28 is the only VERIFIED device.
 *  - ArrayCalc resolves `Cabinets.SpeakerId` against a loudspeaker database that is
 *    not in the project file. Only two ids were ever read out of a real project.
 *
 * So the map has two tiers. `verified` entries are backed by a real vendor file;
 * `native` entries are the correct product name but carry a derived preset string
 * that nobody has confirmed. Anything with no entry at all is SUBSTITUTED by the
 * target's fallback, and the exporter reports every substitution it made.
 */

export type VendorTarget = 'soundvision' | 'arraycalc';

export interface SoundvisionDevice {
  model: string;
  preset: string;
  /** true only when a real Soundvision file with this model/preset exists */
  verified: boolean;
}

export interface ArrayCalcDevice {
  model: string;
  /** Cabinets.SpeakerId — a foreign key into ArrayCalc's own library */
  speakerId: number;
  /** true only when this id was read out of a real ArrayCalc project */
  verified: boolean;
}

/** The only Soundvision device backed by a reference file. */
export const SV_FALLBACK: SoundvisionDevice = { model: 'KS28', preset: 'KS28_60', verified: true };

/**
 * The only ArrayCalc devices whose SpeakerId was read from a real project are
 * B2-SUB (24) and SL-SUB (114). B2-SUB is the fallback because it is the generic
 * large sub in the shipped template.
 */
export const AC_FALLBACK: ArrayCalcDevice = { model: 'B2-SUB', speakerId: 24, verified: true };

/**
 * L-Acoustics equivalents. Only KS28 is verified; the others are the correct
 * product name with a preset string derived from the KS28_60 pattern, which is a
 * guess. They are used ONLY when the caller opts into "native models".
 */
const SOUNDVISION_NATIVE: Record<string, SoundvisionDevice> = {
  'la-ks28': { model: 'KS28', preset: 'KS28_60', verified: true },
  'la-ks28-cardioid': { model: 'KS28', preset: 'KS28_60', verified: true },
  'la-ks21': { model: 'KS21', preset: 'KS21_60', verified: false },
  'la-ks21-cardioid': { model: 'KS21', preset: 'KS21_60', verified: false },
  'la-sb18': { model: 'SB18', preset: 'SB18_60', verified: false },
  'la-sb18-cardioid': { model: 'SB18', preset: 'SB18_60', verified: false },
};

/**
 * BTR models whose cardioid behaviour cannot survive the trip.
 *
 * A BTR cardioid is one cabinet with a modelled rear element. On the vendor side
 * a cardioid sub is an ARRANGEMENT of cabinets with their own delays and
 * polarity, so there is no single preset that means the same thing. The nearest
 * device is written, and it radiates omnidirectionally in the vendor's own
 * prediction: the pattern the user designed is simply not in the exported file.
 *
 * That is a substitution, and it has to be reported as one whatever the
 * native-models flag says. Before this list existed a cardioid exported as a
 * plain preset with a green "equivalent" beside it and no warning at all.
 */
const NO_VENDOR_CARDIOID = new Set([
  'la-ks28-cardioid',
  'la-ks21-cardioid',
  'la-sb18-cardioid',
]);

/**
 * Does this model have a Soundvision entry that is being withheld because its
 * preset string was never confirmed? The export dialog needs to tell that case
 * apart from a model with no equivalent at all: the first is a checkbox away,
 * the second does not exist.
 */
export function gatedBehindNativeModels(
  target: VendorTarget,
  btrSpeakerId: string,
  nativeModels: boolean,
): boolean {
  if (target !== 'soundvision' || nativeModels) return false;
  const native = SOUNDVISION_NATIVE[btrSpeakerId];
  return !!native && !native.verified && !NO_VENDOR_CARDIOID.has(btrSpeakerId);
}

/** d&b equivalents whose ArrayCalc SpeakerId is known. */
const ARRAYCALC_NATIVE: Record<string, ArrayCalcDevice> = {
  'db-sl-sub': { model: 'SL-SUB', speakerId: 114, verified: true },
};

export interface DeviceChoice<T> {
  device: T;
  /**
   * True only when the device written IS the BTR model. False whenever the
   * target's fallback went out in its place, or when the model's defining
   * behaviour (a cardioid pattern) cannot be carried by the device that did.
   *
   * The looser reading this once had — "the model has an equivalent somewhere" —
   * is what let a KS21 be written as a KS28 and reported as no substitution.
   * Having an equivalent and writing it are different facts.
   */
  isEquivalent: boolean;
}

/**
 * Pick the Soundvision device for a BTR speaker id.
 *
 * `nativeModels: false` (the default) always returns KS28 — the only device with a
 * reference file behind it — which is also the behaviour the brief asks for:
 * "if it has an L-Acoustics equivalent, great; if not, export it as KS28".
 */
export function soundvisionDeviceFor(
  btrSpeakerId: string,
  nativeModels = false,
): DeviceChoice<SoundvisionDevice> {
  const native = SOUNDVISION_NATIVE[btrSpeakerId];
  if (!native) return { device: SV_FALLBACK, isEquivalent: false };
  // A cardioid has no single-device equivalent at all, so whatever goes out is a
  // substitution even when the cabinet name matches. See NO_VENDOR_CARDIOID.
  const cardioid = NO_VENDOR_CARDIOID.has(btrSpeakerId);
  // A verified native (KS28) is always safe to emit; an unverified one only on request.
  if (native.verified || nativeModels) return { device: native, isEquivalent: !cardioid };
  // Having an entry is not the same as being exported as itself. This branch DID
  // emit the fallback while calling it equivalent, so a KS21 left as KS28 and the
  // dialog said nothing was substituted. Whether a model has a native entry is
  // irrelevant here: what got written is a different cabinet.
  return { device: SV_FALLBACK, isEquivalent: false };
}

export function arraycalcDeviceFor(btrSpeakerId: string): DeviceChoice<ArrayCalcDevice> {
  const native = ARRAYCALC_NATIVE[btrSpeakerId];
  if (native) return { device: native, isEquivalent: true };
  return { device: AC_FALLBACK, isEquivalent: false };
}

/** Everything the UI needs to explain what a target will do to the project. */
export function describeMapping(
  target: VendorTarget,
  speakerIds: string[],
  nativeModels = false,
): Array<{ btrSpeakerId: string; model: string; substituted: boolean; verified: boolean }> {
  return [...new Set(speakerIds)].map((id) => {
    if (target === 'soundvision') {
      const { device, isEquivalent } = soundvisionDeviceFor(id, nativeModels);
      return { btrSpeakerId: id, model: device.model, substituted: !isEquivalent, verified: device.verified };
    }
    const { device, isEquivalent } = arraycalcDeviceFor(id);
    return { btrSpeakerId: id, model: device.model, substituted: !isEquivalent, verified: device.verified };
  });
}
