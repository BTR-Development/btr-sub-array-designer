/**
 * Sub-array layout and beam steering.
 *
 * Everything here is a pure function over scalar positions along ONE array
 * axis, so the same maths drives a horizontal ground-stacked line and a flown
 * vertical column. No app state, no React — see steering.test.ts.
 *
 * THE CORE IDEA
 * -------------
 * Put a virtual point source (the "focus") a distance R behind the array,
 * offset by the aim angle. Delay every cabinet so its wavefront leaves exactly
 * when the virtual spherical wave would have reached it. The array then
 * radiates as if it were that virtual source.
 *
 *   r_i    = |focus -> cabinet_i| = sqrt(R^2 + p_i^2 + 2*R*p_i*sin(theta))
 *   delay_i = (r_i - min_j r_j) / c
 *
 * Two useful limits fall out of the same expression:
 *
 *   R -> infinity   the wavefront is planar, delay_i = p_i*sin(theta)/c.
 *                   This is straight beam steering, and it is also exactly the
 *                   formula a flown-column tilt calculator uses:
 *                   dt = boxHeight * sin(tilt) / c per element.
 *
 *   R finite        the wavefront is curved, so the array covers a wider
 *                   nominal angle. This is the "delay for nominal dispersion"
 *                   function: R is chosen so the array's span subtends the
 *                   requested angle at the focus, R = span / dispersion_rad.
 */

export type ArrayAxis = 'x' | 'y' | 'z';

/**
 * The two axes an array does NOT run along, in x/y/z order.
 *
 * A line of subs is described by one coordinate that varies and two that do not,
 * which is exactly how the SUBS panel labels its position fields: a line along Y
 * is placed by "At x =" and "Position z".
 */
export function crossAxes(axis: ArrayAxis): [ArrayAxis, ArrayAxis] {
  const rest = (['x', 'y', 'z'] as ArrayAxis[]).filter((a) => a !== axis);
  return [rest[0], rest[1]];
}

/** Positions along the array axis, centred on 0, for `count` cabinets. */
export function positionsFromSpacing(count: number, spacingM: number): number[] {
  const n = Math.max(1, Math.round(count));
  const start = -((n - 1) * spacingM) / 2;
  return Array.from({ length: n }, (_, i) => start + i * spacingM);
}

/** Positions spread evenly across a total span. */
export function positionsFromSpan(count: number, spanM: number): number[] {
  const n = Math.max(1, Math.round(count));
  if (n === 1) return [0];
  return positionsFromSpacing(n, spanM / (n - 1));
}

/** Centre-to-centre spacing implied by a centre-to-centre span. */
export function spacingFromSpan(count: number, spanM: number): number {
  return count > 1 ? spanM / (count - 1) : 0;
}

/**
 * Overall footprint of an array, measured across the OUTER faces of the two end
 * cabinets — the number you would tape out on the deck, not the centre-to-centre
 * span.
 *
 *   overall = (count - 1) * spacing + cabinetWidth
 */
export function overallWidth(count: number, spacingM: number, cabinetWidthM: number): number {
  const n = Math.max(1, Math.round(count));
  return (n - 1) * spacingM + cabinetWidthM;
}

/**
 * The centre-to-centre spacing that makes `count` cabinets span exactly
 * `overallWidthM` outer face to outer face. Returns 0 for a single cabinet, whose
 * footprint is fixed by its own width.
 */
export function spacingFromOverallWidth(
  count: number,
  overallWidthM: number,
  cabinetWidthM: number,
): number {
  const n = Math.max(1, Math.round(count));
  if (n < 2) return 0;
  return Math.max(0, (overallWidthM - cabinetWidthM) / (n - 1));
}

/**
 * How a vertical array is hung, which decides what its Z number means.
 *
 * The two ends are not interchangeable, because only one of them is the number
 * anybody actually knows. A ground stack is placed by the deck it stands on;
 * a flown column is placed by the height its top rigs at. Placing either by
 * the other end means arithmetic on site, which is where mistakes happen.
 */
export type StackMount = 'stacked' | 'flying';

/**
 * Which end of a block its position number refers to.
 *
 * `low` is the face toward the negative end of the layout axis (the left edge of
 * a line along X, the upstage edge of a line along Y), `high` is the other one,
 * and `centre` is the middle — which is what every array did before anchoring
 * existed, and still the default.
 *
 * The anchor decides two things at once, and the second is the useful one: which
 * face the number means, and therefore which face STAYS PUT when a cabinet is
 * added. Anchor a block to its left edge and it grows to the right.
 */
export type BlockAnchor = 'low' | 'centre' | 'high';

/**
 * Where a block's centre lands, given the position of the face it is anchored
 * by. `overallM` is the block's full outer extent along the layout axis, faces
 * included — not the span between the outermost cabinet centres, which is one
 * cabinet shorter.
 */
export function centreFromAnchor(overallM: number, refM: number, anchor: BlockAnchor): number {
  if (anchor === 'centre') return refM;
  return anchor === 'high' ? refM - overallM / 2 : refM + overallM / 2;
}

/** The inverse: which number an already-placed block shows for a given anchor. */
export function anchorFromCentre(overallM: number, centreM: number, anchor: BlockAnchor): number {
  if (anchor === 'centre') return centreM;
  return anchor === 'high' ? centreM + overallM / 2 : centreM - overallM / 2;
}

/**
 * A vertical array is cabinets resting on each other, so its pitch is not a
 * free parameter: it IS the cabinet height. There is nothing to space out.
 *
 * These three functions convert between the number the user gives (the height
 * of the face the array is placed by) and the number the layout needs (the
 * centre of the whole column). For `count` cabinets of height `h` the column is
 * `count * h` tall, so each face is half of that from the centre:
 *
 *   stacked   refZ = bottom face  ->  centre = refZ + count*h/2
 *   flying    refZ = top face     ->  centre = refZ - count*h/2
 *
 * Note it is `count * h`, not `(count - 1) * h`: the span between the outermost
 * CENTRES is one cabinet shorter than the column, and the faces are what a
 * rigger measures.
 */
export function stackCentreFromRef(
  count: number,
  cabinetHeightM: number,
  refZ: number,
  mount: StackMount,
): number {
  return centreFromAnchor(stackHeight(count, cabinetHeightM), refZ, anchorOf(mount));
}

/** The inverse: which face height a column centred at `centreZ` is placed by. */
export function stackRefFromCentre(
  count: number,
  cabinetHeightM: number,
  centreZ: number,
  mount: StackMount,
): number {
  return anchorFromCentre(stackHeight(count, cabinetHeightM), centreZ, anchorOf(mount));
}

/** A stack is anchored to a face like any block; the mount just names which. */
function anchorOf(mount: StackMount): BlockAnchor {
  return mount === 'flying' ? 'high' : 'low';
}

function stackHeight(count: number, cabinetHeightM: number): number {
  return Math.max(1, Math.round(count)) * cabinetHeightM;
}

/** Where the column's two faces land, and how tall it is. */
export function stackExtent(
  count: number,
  cabinetHeightM: number,
  centreZ: number,
): { bottomM: number; topM: number; heightM: number } {
  const n = Math.max(1, Math.round(count));
  const height = n * cabinetHeightM;
  return { bottomM: centreZ - height / 2, topM: centreZ + height / 2, heightM: height };
}

export function spanFromPositions(positions: number[]): number {
  if (positions.length < 2) return 0;
  return Math.max(...positions) - Math.min(...positions);
}

/**
 * Virtual focus distance for a requested nominal dispersion.
 *
 * The delays put a virtual point source at distance R BEHIND the array, so the
 * radiated wavefront diverges along the rays from that point through the
 * cabinets. The nominal dispersion is the angle of that ray fan: the outermost
 * cabinets sit half a span off axis, so tan(dispersion/2) = (span/2) / R and
 * R = (span/2) / tan(dispersion/2).
 *
 * This replaced R = span / dispersion_in_radians, which read the span as an
 * ARC LENGTH. For small angles the two agree, but the array is a chord, not an
 * arc, and the old convention overstated increasingly with angle: a nominal
 * 90 degrees produced a 76-degree fan, 130 produced 97, and 180 could not be
 * reached at all (R stayed at span/pi, a 115-degree fan). Measured on a 16 x 2
 * line 30 m across at 63 Hz, the -6 dB coverage between its outermost
 * crossings now tracks the number on the control instead of sitting a fifth
 * below it. Returns Infinity for a dispersion of 0,
 * which steeringDelays reads as the plane-wave branch.
 */
export function focusRadiusForDispersion(spanM: number, dispersionDeg: number): number {
  const rad = (Math.abs(dispersionDeg) * Math.PI) / 180;
  if (rad < 1e-6 || spanM <= 0) return Infinity;
  const half = Math.min(rad, Math.PI * 0.9999) / 2;
  return spanM / 2 / Math.tan(half);
}

export interface SteeringOptions {
  /** cabinet positions along the array axis, metres */
  positions: number[];
  /** aim angle off the array normal, degrees. Positive steers toward +axis. */
  steerDeg?: number;
  /** nominal dispersion, degrees. 0 = plane wave (pure steering). */
  dispersionDeg?: number;
  speedOfSound: number;
  /** explicit focus distance; overrides the one derived from dispersion */
  focusRadiusM?: number;
}

/**
 * Delays (SECONDS) implementing the requested steer/dispersion.
 * Always non-negative: the earliest cabinet gets 0.
 */
export function steeringDelays(opts: SteeringOptions): number[] {
  const { positions, speedOfSound: c } = opts;
  if (!positions.length) return [];
  const theta = ((opts.steerDeg ?? 0) * Math.PI) / 180;
  const sinT = Math.sin(theta);

  const R =
    opts.focusRadiusM !== undefined
      ? opts.focusRadiusM
      : focusRadiusForDispersion(spanFromPositions(positions), opts.dispersionDeg ?? 0);

  let path: number[];
  if (!isFinite(R)) {
    // plane wave — the p^2 term vanishes relative to R
    path = positions.map((p) => p * sinT);
  } else {
    path = positions.map((p) => Math.sqrt(Math.max(0, R * R + p * p + 2 * R * p * sinT)));
  }

  const min = Math.min(...path);
  return path.map((v) => (v - min) / c);
}

/**
 * End-fire: cabinets stacked along the aim axis, each one in front of the last
 * delayed by its own spacing so all wavefronts leave together going forward and
 * cancel going backward.
 *
 * `positions` are depth offsets; the REAR-most (most negative) fires first.
 */
export function endFireDelays(positions: number[], speedOfSound: number): number[] {
  if (!positions.length) return [];
  const rear = Math.min(...positions);
  return positions.map((p) => (p - rear) / speedOfSound);
}

/** Cabinet spacing that puts the end-fire rear null at `frequencyHz` (d = lambda/4). */
export function endFireSpacingFor(frequencyHz: number, speedOfSound: number): number {
  return speedOfSound / frequencyHz / 4;
}

/**
 * Highest frequency at which the array still controls its pattern.
 *
 * Grating lobes appear once the inter-cabinet path difference reaches one
 * wavelength, i.e. d*(1 + |sin(theta)|) >= lambda. Returns null when spacing is
 * zero.
 */
export function patternControlLimitHz(
  spacingM: number,
  speedOfSound: number,
  steerDeg = 0,
  dispersionDeg = 0,
): number | null {
  if (spacingM <= 0) return null;
  // the widest effective steer is the aim plus half the dispersion fan
  const worstDeg = Math.abs(steerDeg) + Math.abs(dispersionDeg) / 2;
  const s = Math.abs(Math.sin((Math.min(90, worstDeg) * Math.PI) / 180));
  return speedOfSound / (spacingM * (1 + s));
}

/**
 * The aim angle that produces a given DOWN-tilt on an array running along Z.
 *
 * Two conventions meet here and they disagree by a sign. `tiltAngleFromGeometry`
 * answers the rigger's question, so its positive means the array points DOWN,
 * the way every flown-column calculator quotes a tilt. `steeringDelays` answers
 * the array's own question, so its positive means toward the +axis, which along
 * Z is UP. Both are right and both are tested; what was missing was the
 * conversion between them, and feeding one straight into the other steered a
 * flown column into the roof by twice the angle it was given.
 */
export function steerDegForDownTilt(downTiltDeg: number): number {
  return -downTiltDeg;
}

/**
 * Down-tilt angle for a flown column, derived from geometry.
 *
 *   tilt = atan( (arrayCentreHeight - targetHeight) / horizontalDistance )
 *
 * where the array centre is half the total stack height below its top. This is
 * the "find the tilt angle from coordinates" helper found in flown-sub
 * steering calculators.
 */
export function tiltAngleFromGeometry(opts: {
  /** height of the top of the array, metres */
  arrayTopM: number;
  /** height of one cabinet, metres */
  cabinetHeightM: number;
  /** number of cabinets in the column */
  count: number;
  /** horizontal distance to the target, metres */
  distanceM: number;
  /** height of the target (ears / rear of audience), metres */
  targetHeightM: number;
}): number {
  const centre = opts.arrayTopM - (opts.cabinetHeightM * opts.count) / 2;
  if (opts.distanceM === 0) return 0;
  return (Math.atan((centre - opts.targetHeightM) / opts.distanceM) * 180) / Math.PI;
}

/**
 * Level taper across the array, in dB, applied symmetrically from the centre.
 *
 * `edgeDb` is the attenuation at the outermost cabinet. A gentle taper trades a
 * little on-axis level for reduced side lobes.
 */
export function levelTaper(positions: number[], edgeDb: number, exponent = 2): number[] {
  if (!positions.length || edgeDb === 0) return positions.map(() => 0);
  const maxAbs = Math.max(...positions.map(Math.abs));
  if (maxAbs <= 0) return positions.map(() => 0);
  return positions.map((p) => edgeDb * Math.pow(Math.abs(p) / maxAbs, exponent));
}

/**
 * The best rear rejection a reverse stack can reach, set purely by HOW MANY
 * cabinets face each way.
 *
 * A reverse stack cancels by subtraction: the boxes facing backwards radiate
 * rearward in antiphase with the ones facing forward, so the rear sum is the
 * DIFFERENCE of the two groups and the forward sum is their total. With equal
 * drive that is
 *
 *   rejection <= 20·log10( (nF + nR) / |nF - nR| )
 *
 * and the inequality matters. It is a ceiling the finite spacing stops the rig
 * from reaching, approached from below as frequency rises.
 *
 * The practical consequence is the whole reason this function exists, because
 * the arithmetic is brutal and not obvious: three cabinets forward and one
 * reversed cannot do better than 6 dB, and measures 2 dB at 40 Hz. It is not a
 * cardioid, it is a rig with a slightly quieter back. MATCHED groups are what
 * produce the deep null — a 2 + 2 stack of KS21 measures better than 30 dB
 * across the sub band — so null is returned for the matched case rather than a
 * number: nothing in the counts limits it, and quoting Infinity would read as a
 * promise the spacing does not keep.
 */
export function gradientRejectionDb(forward: number, reversed: number): number | null {
  if (forward <= 0 || reversed <= 0) return 0;
  if (forward === reversed) return null;
  return 20 * Math.log10((forward + reversed) / Math.abs(forward - reversed));
}

/** Delay in seconds expressed as the equivalent propagation distance. */
export function delayToDistance(delayS: number, speedOfSound: number): number {
  return delayS * speedOfSound;
}

export function distanceToDelay(distanceM: number, speedOfSound: number): number {
  return distanceM / speedOfSound;
}
