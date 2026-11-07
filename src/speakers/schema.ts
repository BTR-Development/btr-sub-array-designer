/**
 * BTR normalized speaker model.
 *
 * This format is deliberately NOT tied to GLL / EASE / any vendor format.
 * External data is expected to be converted into this shape by an importer:
 *
 *   GLL / vendor data  ->  authorized importer / preprocessing  ->  SpeakerModel
 *
 * See docs/SPEAKER-DATA.md.
 */

/** How much the prediction for this model can be trusted. */
export type DataQuality =
  | 'A' // Manufacturer prediction data (balloon incl. phase) imported under licence
  | 'B' // Verified directivity data from a measured/published dataset, or fitted to the manufacturer's prediction tool
  | 'C' // Analytical approximation (physics model, not measured)
  | 'D'; // Proxy model (another cabinet's acoustics stands in)

export const DATA_QUALITY_LABEL: Record<DataQuality, string> = {
  A: 'Manufacturer prediction data',
  B: 'Verified directivity data',
  C: 'Analytical approximation',
  D: 'Proxy model',
};

export type SpeakerType = 'omnidirectional' | 'cardioid' | 'infra' | 'other';

/**
 * A radiating element inside the cabinet, expressed in the cabinet's LOCAL
 * frame: local +Y = front, local +X = right, local +Z = up. This is how both
 * the analytical cardioid and any future multi-driver model are described.
 */
export interface RadiatingElement {
  /** metres, relative to the cabinet's acoustic centre */
  position: { x: number; y: number; z: number };
  /** linear gain (1 = reference) */
  gain: number;
  /** seconds; internal processing delay of this element */
  delayS: number;
  /** true => this element is wired in reverse polarity */
  invert: boolean;
}

/**
 * Balloon data: magnitude and phase over frequency x azimuth x elevation.
 * Reserved for imported (quality A/B) datasets. Arrays are laid out as
 *   index = (fi * nAz + ai) * nEl + ei
 */
export interface BalloonDataset {
  kind: 'balloon';
  frequenciesHz: number[];
  /** degrees, monotonically increasing, local azimuth (0 = on axis) */
  azimuthDeg: number[];
  /** degrees, monotonically increasing, local elevation (0 = on axis) */
  elevationDeg: number[];
  magnitudeDb: Float32Array;
  phaseDeg: Float32Array;
}

/** Point source, no directivity. Correct to first order for a single sub. */
export interface OmniDataset {
  kind: 'omni';
}

/**
 * Physically-modelled multi-element source. The far-field directivity is the
 * complex sum of the elements, so it is frequency dependent and geometrically
 * consistent — not a hand-drawn "-15 dB behind" curve.
 */
export interface ElementDataset {
  kind: 'elements';
  elements: RadiatingElement[];
  /**
   * If true, the complex sum is normalised by its own on-axis magnitude at each
   * frequency, which models the processor EQ a real cardioid preset applies.
   */
  normaliseOnAxis: boolean;
}

export type PredictionDataset = OmniDataset | ElementDataset | BalloonDataset;

export interface DataProvenance {
  /** e.g. 'manufacturer-datasheet', 'manufacturer-website', 'vendor-prediction', 'analytical', 'user' */
  type: string;
  url?: string;
  retrieved?: string;
  note?: string;
}

export interface SpeakerModel {
  id: string;
  manufacturer: string;
  model: string;

  dimensions: {
    /** metres. `null` means unknown — never invent a number. */
    widthM: number | null;
    heightM: number | null;
    depthM: number | null;
  };
  weightKg?: number | null;

  type: SpeakerType;
  /** free text, e.g. 'bandpass horn, 2 x 18"' */
  construction?: string;
  /** free text, e.g. 'omnidirectional / cardioid switchable' */
  radiation?: string;

  /** dB SPL at 1 m, free field, as published by the manufacturer. */
  maxSpl?: number | null;
  /** Either bound may be null when the manufacturer only publishes one of them. */
  frequencyRange?: { minHz: number | null; maxHz: number | null } | null;

  predictionData: PredictionDataset;
  /**
   * The same cabinet playing the REAR of a cardioid block (BTR's reverse
   * pattern: a hidden gradient delay is set on it), when its processing is
   * known to differ from the front cabinets'. Absent:
   * the rear cabinet is the front one turned round, delayed and inverted.
   */
  cardioidRearData?: PredictionDataset;
  /** Quality of the ACOUSTIC prediction data (not of the dimensions). */
  dataQuality: DataQuality;

  source?: {
    dimensions?: DataProvenance;
    prediction?: DataProvenance;
    general?: DataProvenance;
  };

  /**
   * Where the cabinet actually radiates from, in its LOCAL frame
   * (x = right, y = front, z = up), relative to the position handle — which
   * everywhere else in BTR is the cabinet's geometric CENTRE, because that is
   * what the plan view draws a box around.
   *
   * Absent means "derive it from the depth": the front baffle, at y = depth/2.
   * See `acousticOrigin` below for why that default is not a detail.
   */
  acousticOriginM?: { x: number; y: number; z: number } | null;

  /** set on user-created models */
  isCustom?: boolean;
  /** for custom models: id of the library model whose acoustics are borrowed */
  proxyOfId?: string;
  /** human readable reason a proxy was chosen */
  proxyNote?: string;
}

/**
 * The point a cabinet radiates from, in its own local frame, relative to the
 * geometric centre the user positions on the plan.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT COSMETIC
 * ------------------------------------------------------------------------
 * Until this was added, a cabinet was a dimensionless point at its handle, so
 * rotating one changed only its directivity — never WHERE it radiated from.
 * For an omnidirectional sub, whose directivity is 1 in every direction, that
 * made a 180 degree rotation a no-op. Stack two subs, turn the top one round,
 * delay it and flip its polarity — the textbook reverse-stack cardioid — and
 * the model returned two coincident sources: identical level in front and
 * behind at every delay, a front-to-back ratio of exactly 0.0 dB. The
 * cardioid was not weak, it was arithmetically impossible.
 *
 * A reversed cabinet radiates from what is now the BACK of the stack. Putting
 * the origin on the front baffle makes that fall out of the geometry: two
 * cabinets nose to tail are one cabinet depth apart, which is the separation
 * the whole industry tunes its cardioid delay to, and the same separation
 * `analyticCardioidDataset` already assumes for a single-cabinet cardioid.
 *
 * The front baffle is an ANALYTICAL choice, not a measured acoustic centre: a
 * real 21 inch cone sits some way behind its baffle, so the true separation of
 * a reverse stack is slightly less than the cabinet depth. No manufacturer
 * publishes that offset, so BTR does not invent one — it uses the convention
 * the delay figures in the field are quoted against, and lets a model override
 * it via `acousticOriginM` when better data exists.
 *
 * Unknown depth yields a zero offset rather than a guess.
 */
export function acousticOrigin(m: SpeakerModel): { x: number; y: number; z: number } {
  if (m.acousticOriginM) return m.acousticOriginM;
  const d = m.dimensions.depthM;
  return { x: 0, y: d == null ? 0 : d / 2, z: 0 };
}

/**
 * THE FLOOR CONVENTION
 *
 * Where the centre of a cabinet goes when a FACE of it is what you know.
 *
 * A source's position in BTR is the cabinet's geometric centre — that is what
 * the plan view draws its box around and what `acousticOrigin` above is measured
 * from — so "on the deck" is not z = 0, it is z = height/2. Three places place a
 * cabinet by a face and all three go through this one rule now:
 *
 *   - "+ Add" in the speaker dialog, which used to drop the box at z = 0 and
 *     bury its lower half under the deck;
 *   - the vertical stack control, which places the bottom face of a whole column
 *     — the same arithmetic one count wider, see `stackCentreFromRef`.
 *
 * Null when the height is unpublished: half of an unknown box is unknown, and a
 * nominal drawing height here would move the cabinet in the PREDICTION, not just
 * in the picture. The caller has to say so instead.
 */
export function centreZFromBottomFace(
  m: SpeakerModel,
  bottomFaceZ = 0,
  rollDeg = 0,
): number | null {
  const h = orientedDimensions(m, rollDeg).heightM;
  return h == null ? null : bottomFaceZ + h / 2;
}

/**
 * CABINET ORIENTATION
 *
 * `rollDeg` turns the cabinet about its FRONT axis, which is the axis a sub is
 * laid on its side about: a KS21 is 0.76 wide and 0.57 tall standing normally,
 * and 0.57 wide and 0.76 tall stood on its end face. The engine has always
 * honoured roll — `localFrame` rotates the radiating elements and the acoustic
 * origin with the box — but every piece of GEOMETRY read the published numbers
 * straight, so a rolled cabinet predicted correctly and then sat on the deck at
 * the wrong height, stacked at the wrong pitch and drew the wrong box.
 *
 * Roll is about the front axis, so the DEPTH is untouched and only the width and
 * the height trade places. This returns the axis-aligned extents, which is the
 * right answer for every question the layout asks ("how tall is the column",
 * "how wide is the footprint", "where is the bottom face"):
 *
 *   width'  = |w·cos r| + |h·sin r|
 *   height' = |w·sin r| + |h·cos r|
 *   depth'  = d
 *
 * At 0 and 180 degrees that is the published box; at +-90 it is the box with
 * width and height swapped; in between it is the bounding box of the turned
 * cabinet, which is what fits on a deck.
 *
 * A dimension is only required when it actually contributes. An unpublished
 * height does not stop a 90 degree roll from knowing its new WIDTH, because at
 * 90 degrees the new width is the old height... which is unpublished — but the
 * new HEIGHT is the old width, which may well be known. Null propagates per
 * output rather than across the whole box, so a model that publishes only one
 * of the two is not written off entirely.
 */
export function orientedDimensions(
  m: SpeakerModel,
  rollDeg = 0,
): { widthM: number | null; heightM: number | null; depthM: number | null } {
  const { widthM: w, heightM: h, depthM: d } = m.dimensions;
  const e = rollExtents(w, h, rollDeg);
  return { widthM: e.widthM, heightM: e.heightM, depthM: d };
}

/**
 * The same rule over two loose numbers, for callers holding dimensions rather
 * than a model — the array editor needs the extents of BOTH the roll the
 * cabinets are standing in and the roll it is about to write, and it must not
 * have to go back to the library for the second one.
 */
export function rollExtents(
  widthM: number | null,
  heightM: number | null,
  rollDeg: number,
): { widthM: number | null; heightM: number | null } {
  const w = widthM;
  const h = heightM;
  if (!rollDeg) return { widthM: w, heightM: h };
  const r = (rollDeg * Math.PI) / 180;
  // Snap the vanishing term to a true zero. Without it |cos 90°| is 6e-17 and a
  // 90 degree roll would demand a dimension it does not use, so a cabinet with
  // one unpublished side would report its whole turned box as unknown.
  const ca = snap(Math.abs(Math.cos(r)));
  const sa = snap(Math.abs(Math.sin(r)));
  return {
    widthM: mix(w, ca, h, sa),
    heightM: mix(w, sa, h, ca),
  };
}

function snap(v: number): number {
  return Math.abs(v) < 1e-12 ? 0 : v;
}

/** `a*ka + b*kb`, where a term with a zero coefficient needs no dimension. */
function mix(a: number | null, ka: number, b: number | null, kb: number): number | null {
  const ta = ka === 0 ? 0 : a == null ? null : a * ka;
  const tb = kb === 0 ? 0 : b == null ? null : b * kb;
  return ta == null || tb == null ? null : ta + tb;
}

/** Fallback box size used only for drawing when dimensions are unknown. */
export const UNKNOWN_BOX = { widthM: 0.6, heightM: 0.6, depthM: 0.6 };

export function boxSize(m: SpeakerModel, rollDeg = 0) {
  // Drawing is the one caller allowed a nominal box, because a picture has to
  // have a size. It still goes through the orientation layer first, so a
  // cabinet turned on its side is DRAWN on its side.
  const o = orientedDimensions(m, rollDeg);
  return {
    widthM: o.widthM ?? UNKNOWN_BOX.widthM,
    heightM: o.heightM ?? UNKNOWN_BOX.heightM,
    depthM: o.depthM ?? UNKNOWN_BOX.depthM,
    unknown: o.widthM == null || o.heightM == null || o.depthM == null,
  };
}

/**
 * Builds the standard analytical cardioid: a front element plus a rear element
 * one cabinet-depth behind, delayed by d/c and inverted. This is the classic
 * pressure-gradient construction and yields a real, frequency-dependent
 * cardioid with a rear null — NOT a fixed dB offset.
 *
 * `depthM` must be a published depth. It is the element separation AND, through
 * d/c, the rear element's delay, so it decides the whole pattern: there is no
 * such thing as a gradient cardioid with a substituted spacing. The old
 * `Math.max(0.15, depthM)` floor silently replaced any smaller declared depth
 * with a separation the cabinet does not have, and turned an unknown depth of 0
 * into an invented 0.15 m. A caller with no depth has no cardioid to offer and
 * must say so instead of asking for one.
 */
export function analyticCardioidDataset(
  depthM: number,
  speedOfSound = 343,
): ElementDataset {
  if (!(depthM > 0) || !isFinite(depthM)) {
    throw new Error(
      `analyticCardioidDataset needs a published cabinet depth in metres, got ${depthM}. ` +
        'A model without one must not be given a cardioid dataset.',
    );
  }
  const d = depthM;
  return {
    kind: 'elements',
    elements: [
      { position: { x: 0, y: 0, z: 0 }, gain: 1, delayS: 0, invert: false },
      { position: { x: 0, y: -d, z: 0 }, gain: 1, delayS: d / speedOfSound, invert: true },
    ],
    normaliseOnAxis: true,
  };
}
