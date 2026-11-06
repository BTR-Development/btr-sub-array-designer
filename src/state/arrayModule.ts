/**
 * The array module editor, without a user interface.
 *
 * WHY THIS FILE EXISTS
 *
 * `engine/steering.ts` holds the maths: positions, delays, the pattern-control
 * limit. Pure functions, no opinions. What it does NOT hold is the behaviour a
 * system engineer actually experiences when editing an array:
 *
 *   - that adding a cabinet keeps the taped-out width and tightens the pitch,
 *     rather than growing the array off the end of the deck;
 *   - that typing a pitch hands the lead back to pitch;
 *   - that opening the panel never overwrites delays somebody set by hand;
 *   - which cabinets a steering tool groups, and under what name.
 *
 * All of that used to live inside the panel component. That was fine while
 * there was one interface. It stops being fine the moment the same engine is
 * driven by a second one: the BTR Portal build rewrites the whole interface
 * layer in its own idiom, so anything left in a component gets reimplemented
 * from a screenshot. The maths would port perfectly and the behaviour would
 * quietly diverge, which is worse than an outright break because both products
 * keep working and disagree.
 *
 * So the rule is: a widget may decide how a control LOOKS. Everything about
 * what a change MEANS belongs here, behind a test.
 */
import type { Source } from '../core/types';
import {
  anchorFromCentre,
  centreFromAnchor,
  crossAxes,
  gradientRejectionDb,
  overallWidth,
  spacingFromOverallWidth,
  stackCentreFromRef,
  stackExtent,
  stackRefFromCentre,
  type ArrayAxis,
  type BlockAnchor,
  type StackMount,
} from '../engine/steering';
import { rollExtents } from '../speakers/schema';
import {
  blockMembers,
  POSITION_TOL_M,
  positionBlocks,
  cabinetsPerPosition,
  countPositions,
  currentCentre,
  currentSpacing,
  currentSplay,
  detectAxis,
  forwardHeadingOf,
  measureReversal,
  relativePositions,
  reversedFlags,
  spacingOverCabinets,
  type SteerMode,
  type StackReverse,
} from './arrayTools';
import type { DelayPlan } from './arrayTools';
import type { Source as SourceRecord } from '../core/types';

/** Geometry fields hold an edit until it is applied; steering fields act at once. */
export type GeomField =
  | 'count'
  | 'spacing'
  | 'overall'
  | 'centre'
  | 'posB'
  | 'posC'
  | 'splay'
  | 'elevation'
  /** cabinets at each position: a stack of four on each of ten places */
  | 'perPosition'
  /** roll about the front axis: 90 stands the cabinet on its end face */
  | 'roll'
  /** vertical arrays only: the height of the face the column is placed by */
  | 'refZ'
  /** horizontal arrays only: the position of the face the block is anchored by */
  | 'refA';

/**
 * The edits that are COORDINATES, and therefore mean a different thing on a
 * different layout axis. Everything else in `edit` is a magnitude.
 */
const AXIS_BOUND_EDITS: GeomField[] = ['centre', 'posB', 'posC', 'refZ', 'refA'];

/**
 * Footprint and pitch are two views of one geometry, so one of them has to lead.
 * The outer width leads by default: changing the cabinet count redistributes the
 * same taped-out width instead of stretching the array off the end of the deck.
 * Typing a spacing hands the lead back to spacing.
 *
 * `touching` is the third answer, and the only one where neither leads: the
 * cabinets are pushed against each other, so the pitch is the cabinet width and
 * the footprint is whatever that comes to. It is the horizontal twin of a
 * vertical stack, except that a stack has no choice about it and a horizontal
 * block does — which is why this is a mode and the vertical rule is not.
 */
export type SpanMode = 'overall' | 'spacing' | 'touching';

export interface ArrayModuleState {
  axisOverride: ArrayAxis | null;
  /**
   * How a vertical array is hung. Ignored on the horizontal axes, but kept
   * across a module change like the other rig-wide settings: somebody working
   * on a flown system is working on a flown system in every module.
   */
  mount: StackMount;
  /**
   * Which end a horizontal block is placed by. Kept across a module change for
   * the same reason as the mount: it describes how somebody is working, not
   * which array they happen to have selected.
   */
  anchor: BlockAnchor;
  /**
   * The reversal the operator has ASKED for, null until they touch the control.
   *
   * Pending, not persistent, and that distinction is the fix for half of this
   * feature's defects. Held as a plain setting it was both the instruction and
   * the description: its default of 'none' read as "nothing is reversed" over a
   * rig that was, so one Apply layout straightened a hand-built cardioid, and
   * the heading a reversal was written against came from whichever end the
   * control happened to name rather than from the cabinets. What the rig HAS is
   * measured (`ArrayModuleLive.reverseAt`); this is only what to change it to.
   */
  pendingReverseAt: StackReverse | null;
  /** How many cabinets of each position to turn round; null until asked. */
  pendingReverseCount: number | null;
  /** Wzór wpisany ręcznie przełącznikami przy obudowach; null = nie ruszano. */
  pendingReversePattern: boolean[] | null;
  edit: Partial<Record<GeomField, number>>;
  spanMode: SpanMode;
  mode: SteerMode;
  steerDeg: number;
  dispersionDeg: number;
  /**
   * Edge level taper in dB, null until somebody sets one.
   *
   * The same separation the layout fields make between what a field SHOWS and
   * what an apply WRITES, one panel section down. A taper OWNS the level column
   * — it overwrites every cabinet's level, which is how setting it back to 0
   * takes it off again — so the plan must carry a level column only once the
   * operator has actually reached for this control. Held as a plain number, it
   * could not: 0 is both "no taper" and "flatten the taper", the field starts at
   * 0, and every Apply delay therefore wrote 0 dB over levels that had been
   * trimmed by hand. Null is the absence of an instruction; a typed 0 is one.
   *
   * A typed taper survives a module change, the way the mode and the angles
   * beside it do: it is part of the aim being dialled in, and an apply that
   * created a group would otherwise re-point the editor at it and put the
   * control back to 0 over cabinets that are still tapered.
   */
  taperDb: number | null;
  /** empty string = keep whatever model the cabinets already are */
  speakerId: string;
  /** re-solve the taper as the beam width moves, instead of waiting for Apply */
  live: boolean;
  /**
   * Whether a steering field has been touched yet. Live steering stays disarmed
   * until it has, so merely opening the editor cannot overwrite hand-set delays.
   */
  armed: boolean;
  /**
   * Whether the live re-apply has already written during this steering session.
   *
   * A drag settles many times, and each settling point used to take its own undo
   * entry, so unwinding one slider movement took forty presses. The first write
   * of a session carries the snapshot and the rest land inside it, which makes
   * one undo return the cabinets to the taper they held before the control was
   * touched. A deliberate Apply, or a different module, starts a new session.
   */
  liveWrote: boolean;
}

export const INITIAL_ARRAY_MODULE: ArrayModuleState = {
  axisOverride: null,
  mount: 'stacked',
  anchor: 'centre',
  pendingReverseAt: null,
  pendingReverseCount: null,
  pendingReversePattern: null,
  edit: {},
  spanMode: 'overall',
  mode: 'dispersion',
  steerDeg: 0,
  dispersionDeg: 80,
  taperDb: null,
  speakerId: '',
  live: true,
  armed: false,
  liveWrote: false,
};

/** What the cabinets on the canvas currently are, measured along the live axis. */
export interface ArrayModuleLive {
  detectedAxis: ArrayAxis;
  /** the axis in force, which is the user's override when there is one */
  axis: ArrayAxis;
  /**
   * POSITIONS on the layout axis, not cabinets. Four subs on each of ten places
   * is a count of ten, and every number derived from it — pitch, footprint,
   * pattern-control limit — is about the ten.
   */
  count: number;
  /** cabinets in the module, which is `count * perPosition` when it divides */
  cabinets: number;
  /**
   * Cabinets at each position, 1 for a plain line. Falls back to 1 when the rig
   * does not divide evenly into its positions, because then there is no single
   * answer and an Apply layout must not invent one.
   */
  perPosition: number;
  /** roll the cabinets are standing in, degrees about the front axis */
  roll: number;
  spacing: number;
  centre: number;
  posB: number;
  posC: number;
  elevation: number;
  /** the fan the cabinets are actually aimed at, so the field can report it */
  splay: number;
  /**
   * The published width and height, upright, of the cabinet THE RIG IS MADE OF,
   * 0 when unconfirmed. Every reference face is read against these.
   *
   * Two orientations and two MODELS are in play at once: what is standing there
   * and what the layout is about to write. Collapsed into one pair, pressing
   * "On end" read the deck height of a rig standing on the deck as -0.19 m, and
   * picking a different box in the System dropdown did the same — in both cases
   * one Apply layout then made the wrong number true.
   */
  publishedWidthM: number;
  publishedHeightM: number;
  /** The same for the cabinet the layout will WRITE; defaults to the above. */
  plannedWidthM: number;
  plannedHeightM: number;
  /**
   * False when the rig does not hold the SAME number of cabinets at every
   * position. Such a rig has no cabinets-per-position, so there is no
   * description for a layout to rebuild it from.
   */
  positionsUniform: boolean;
  /** The reverse stack the rig ALREADY has, measured off the cabinets. */
  reverseAt: StackReverse;
  reverseCount: number;
  /**
   * False when the turned-round cabinets do not form a reverse stack this
   * editor can describe — different counts at different positions, or turned
   * cabinets in the middle of a column. The layout then refuses rather than
   * flattening a rig nobody can get back.
   */
  reversalDescribable: boolean;
  /**
   * Które obudowy pozycji są odwrócone, po kolei; null, gdy pozycje nie mają
   * wspólnego wzoru. „Dolna” i „Górna” to tylko nazwy dwóch jego kształtów —
   * wzór opisuje także obudowę odwróconą w środku, czego tamte nazwy nie umią.
   */
  reversePattern: boolean[] | null;
  /**
   * The vertical pitch the cabinets at one position ACTUALLY stand at, 0 when
   * there is only one of them. Measured, not derived, so a rig whose cabinet
   * height nobody publishes can still be rebuilt without collapsing its stacks
   * onto one point — and without this project inventing a box size to do it.
   */
  stackPitchM: number;
  /**
   * Whether the cabinets at a position stand SIDE BY SIDE along the layout
   * axis rather than on each other. Measured, because a rolled rig can be
   * either and the roll cannot tell them apart.
   */
  positionAcross: boolean;
  /**
   * Distance between a forward cabinet's radiating point and a turned-round
   * one's, metres; 0 when the model publishes no depth. A reverse stack with no
   * separation is not a gradient — the two boxes radiate from the same point —
   * so the control is withheld rather than offered with a delay of zero and a
   * rejection figure that describes nothing.
   */
  gradientSpanM: number;
  /**
   * Whether the cabinet is already a directional box. Turning one round inside
   * its own rig fights the pattern it came with: four analytic cardioids in a
   * column measure 74 dB front to back, and the same four as a 2+2 reverse
   * stack measure 0.0 dB and lose 6 dB forward.
   */
  cabinetIsCardioid: boolean;
  /**
   * The cabinet's model is an ideal point source. Only then does the count
   * ceiling hold: a box with real front-to-back lets a 3 + 1 block go well past
   * 6 dB, and quoting the ceiling would tell the operator something false.
   */
  cabinetIsOmni: boolean;
}

export type ArrayModuleAction =
  /** the editor was pointed at a different group, or at the whole project */
  | { type: 'moduleChanged' }
  | { type: 'setAxis'; axis: ArrayAxis }
  | { type: 'setCount'; count: number }
  | { type: 'setSpacing'; metres: number }
  | { type: 'setOverall'; metres: number }
  /** cabinet against cabinet, or back to choosing a footprint or a pitch */
  | { type: 'setSpanMode'; mode: SpanMode }
  | {
      type: 'setGeom';
      field: Exclude<GeomField, 'count' | 'spacing' | 'overall' | 'refZ' | 'perPosition'>;
      value: number;
    }
  /** cabinets at each position: four on top of each other at each of ten places */
  | { type: 'setPerPosition'; count: number }
  /** which cabinet of each position faces backwards; 'none' writes nothing */
  | { type: 'setReverseAt'; at: StackReverse }
  /** how many cabinets of each position face backwards */
  | { type: 'setReverseCount'; count: number }
  | { type: 'toggleReverseIndex'; index: number }
  /** vertical arrays: the deck height when stacked, the rig height when flying */
  | { type: 'setRefZ'; metres: number }
  | { type: 'setMount'; mount: StackMount }
  | { type: 'setAnchor'; anchor: BlockAnchor }
  /** horizontal arrays: the anchored edge, or the centre when that is the anchor */
  | { type: 'setRefA'; metres: number }
  | { type: 'setMode'; mode: SteerMode }
  | { type: 'setSteer'; deg: number }
  /** the beam-width control: picks the arc mode as well as the angle */
  | { type: 'setBeamWidth'; deg: number }
  | { type: 'setTaper'; db: number }
  | { type: 'setSpeaker'; id: string }
  | { type: 'toggleLive' }
  /** Apply delay pressed: an explicit apply arms live steering too */
  | { type: 'armed' }
  /** the live re-apply has written the plan, so the undo entry is open */
  | { type: 'liveApplied' }
  | { type: 'layoutApplied' };

/** The axis the module is laid out along: the user's choice, else the geometry. */
export function resolveAxis(state: ArrayModuleState, members: Source[]): ArrayAxis {
  return state.axisOverride ?? detectAxis(members);
}

/** Measure the module as it stands, along the axis currently in force. */
/** The cabinet facts the editor needs; everything else it measures itself. */
export interface CabinetFacts {
  /** published, upright, of the cabinet the rig is MADE OF */
  publishedWidthM?: number;
  publishedHeightM?: number;
  /** of the cabinet the layout will WRITE; defaults to the pair above */
  plannedWidthM?: number;
  plannedHeightM?: number;
  gradientSpanM?: number;
  isCardioid?: boolean;
  /** the model's prediction data is an ideal point source */
  isOmni?: boolean;
}

export function measure(
  members: Source[],
  axis: ArrayAxis,
  cab: CabinetFacts = {},
): ArrayModuleLive {
  const [axisB, axisC] = crossAxes(axis);
  const publishedWidthM = cab.publishedWidthM ?? 0;
  const publishedHeightM = cab.publishedHeightM ?? 0;

  // A rig that does not divide evenly into its positions has no cabinets-per-
  // position, and the old fallback of 1 was not neutral: `count * perPosition`
  // is what an Apply layout writes, so a 39-cabinet rig across 10 positions
  // reported 10 cabinets and one press deleted 29 of them with no confirmation.
  // Falling back to one position per CABINET keeps that product equal to the
  // rig, which is the invariant: an untouched editor must never delete anything.
  // How far apart two cabinets may stand and still be ONE position.
  //
  // A millimetre for an upright rig, where a position is a stack and its
  // cabinets share a coordinate. One cabinet width for a rig standing on its
  // end face, where a position is a row of touching cabinets — without it the
  // reading breaks a row of four into four positions, the spacing comes out
  // non-uniform, and the editor refuses to describe the rig it just built.
  const heldRoll = members[0]?.rotation.rollDeg ?? 0;
  const heldAcrossM = orientationOf(heldRoll) === 90
    ? extentsAt(publishedWidthM, publishedHeightM, heldRoll).widthM
    : 0;
  const placeTolM = heldAcrossM > 0 ? heldAcrossM + POSITION_TOL_M : POSITION_TOL_M;
  const rev = measureReversal(members, axis, placeTolM);
  const per = cabinetsPerPosition(members, axis, placeTolM);
  // On Z every cabinet IS a position, so counting positions and counting
  // cabinets must agree there; they only disagree when the axis has been
  // mis-detected, and then the difference is cabinets an Apply layout deletes.
  const describable = per != null && axis !== 'z';
  return {
    detectedAxis: detectAxis(members, Math.max(publishedWidthM, publishedHeightM)),
    axis,
    count: describable ? countPositions(members, axis, placeTolM) : members.length,
    cabinets: members.length,
    perPosition: describable ? (per ?? 1) : 1,
    stackPitchM: stackPitchOf(members, axis, placeTolM),
    positionAcross: positionRun(members, axis, placeTolM).across,
    roll: members[0]?.rotation.rollDeg ?? 0,
    positionsUniform: per != null,
    reverseAt: rev.at,
    reverseCount: rev.count,
    reversalDescribable: rev.describable,
    reversePattern: rev.pattern,
    // A cabinet count beside a POSITION pitch is two different rigs multiplied
    // together: it printed a 2.76 m row as 6.76 m wide, and an untouched Apply
    // layout would have spread the rig to match.
    spacing: describable ? currentSpacing(members, axis, placeTolM) : spacingOverCabinets(members, axis),
    centre: currentCentre(members, axis),
    posB: currentCentre(members, axisB),
    posC: currentCentre(members, axisC),
    elevation: members[0]?.rotation.elevationDeg ?? 0,
    splay: currentSplay(members, axis),
    publishedWidthM,
    publishedHeightM,
    plannedWidthM: cab.plannedWidthM ?? publishedWidthM,
    plannedHeightM: cab.plannedHeightM ?? publishedHeightM,
    gradientSpanM: cab.gradientSpanM ?? 0,
    cabinetIsCardioid: !!cab.isCardioid,
    cabinetIsOmni: cab.isOmni ?? true,
  };
}

/**
 * The vertical pitch inside one position, measured off the cabinets.
 *
 * The cabinets at a position are the ones sharing a coordinate on the layout
 * axis; their Z values are the stack. Zero when no position holds more than
 * one, and zero on a Z layout, where the column IS the array.
 */
function stackPitchOf(members: Source[], axis: ArrayAxis, placeTolM = POSITION_TOL_M): number {
  return positionRun(members, axis, placeTolM).pitchM;
}

/**
 * How the cabinets at the first position are arranged: the pitch, and whether
 * they run ACROSS the layout axis rather than up.
 *
 * Measured rather than taken from the roll, and that distinction is the point.
 * A rig standing on its end face may be a row — which is what this program now
 * builds — or a tower somebody built before it did, or imported. Both are
 * rolled 90, so the roll cannot tell them apart, and treating a tower as a row
 * puts its vertical extent at one cabinet and drops the rig three boxes into
 * the stage on the next Apply.
 */
function positionRun(
  members: Source[],
  axis: ArrayAxis,
  placeTolM = POSITION_TOL_M,
): { pitchM: number; across: boolean } {
  if (axis === 'z' || members.length < 2) return { pitchM: 0, across: false };
  const block = positionBlocks(members, axis, placeTolM)[0];
  if (block === undefined) return { pitchM: 0, across: false };
  const rel = relativePositions(members, axis);
  // Po przynależności, gdy blok ją niesie: pozycje zsunięte na siebie mają
  // wspólne współrzędne i filtr po nich zgarniałby obudowy sąsiada.
  const inBlock = blockMembers(block, rel).map((i) => ({ m: members[i], rel: rel[i] }));
  if (inBlock.length < 2) return { pitchM: 0, across: false };
  // A position built SIDEWAYS has its pitch along the layout axis; a stacked
  // one has it in z. Reading the wrong one gives 0 for a row of cabinets that
  // plainly has a pitch, and an Apply layout then collapses the row onto one
  // point.
  const sideways = block.to - block.from > POSITION_TOL_M;
  const v = inBlock
    .map((e) => (sideways ? e.rel : e.m.position.z))
    .sort((a, b) => a - b);
  return { pitchM: (v[v.length - 1] - v[0]) / (v.length - 1), across: sideways };
}

/**
 * Which upright-or-on-end orientation a roll corresponds to, 0 or 90.
 *
 * Folded into 0..180 rather than taken modulo, because `-90 % 180` is `-90` in
 * JavaScript: a cabinet rolled the other way matched neither of the two
 * buttons, so the control showed nothing selected and pressing "On end" on it
 * added a further half turn instead of being a no-op. 180 reads as upright,
 * because the extents are the published ones either way up.
 */
export function orientationOf(rollDeg: number): number {
  return ((Math.round(rollDeg) % 180) + 180) % 180;
}

/** The cabinet's extents in the orientation a given roll puts it in. */
function extentsAt(widthM: number, heightM: number, rollDeg: number): { widthM: number; heightM: number } {
  const e = rollExtents(widthM || null, heightM || null, rollDeg);
  return { widthM: e.widthM ?? 0, heightM: e.heightM ?? 0 };
}

/** What is standing there. */
function heldExtents(live: ArrayModuleLive) {
  return extentsAt(live.publishedWidthM, live.publishedHeightM, live.roll);
}

/**
 * Is this module a vertical stack rather than a freely spaced line?
 *
 * Both conditions are load-bearing. Along Z the cabinets rest on each other, so
 * "equally spaced along" describes nothing a user can choose: the pitch is the
 * cabinet height and the only free number is how high the column sits. But that
 * is only true when the height is CONFIRMED. An unknown height would have to be
 * guessed, and this project does not guess dimensions, so the editor stays in
 * its ordinary free-spacing mode and says why.
 */
export function isVerticalStack(live: ArrayModuleLive): boolean {
  return live.axis === 'z' && heldExtents(live).heightM > 0;
}

/**
 * Can this module be placed by one of its ends rather than by its centre?
 *
 * A vertical stack already is, by its mount. A horizontal block needs a
 * confirmed cabinet width, because without one it has no outer faces, and
 * anchoring to the outermost cabinet CENTRE instead would build in exactly the
 * half-a-box error the faces exist to avoid.
 */
export function canAnchorBlock(live: ArrayModuleLive): boolean {
  return !isVerticalStack(live) && heldExtents(live).widthM > 0;
}

export function arrayModuleReducer(
  state: ArrayModuleState,
  action: ArrayModuleAction,
  live: ArrayModuleLive,
): ArrayModuleState {
  switch (action.type) {
    case 'moduleChanged':
      // A different module is a different array. Pending edits belonged to the
      // old one and applying them here would move cabinets nobody was looking
      // at; the disarm is what stops live steering from firing on arrival.
      return {
        ...state,
        edit: {},
        axisOverride: null,
        armed: false,
        liveWrote: false,
        speakerId: '',
        spanMode: 'overall',
        pendingReverseAt: null,
        pendingReverseCount: null,
        pendingReversePattern: null,
      };

    case 'setAxis': {
      // Re-pinning the axis the module is already laid out along changes nothing
      // about what the pending numbers mean, so they survive it.
      if (action.axis === live.axis) return { ...state, axisOverride: action.axis };
      // Any other axis change re-labels the coordinates underneath the fields.
      // `posB`, `posC`, `centre`, `refA` and `refZ` are positions whose axis is
      // decided by this setting, so a pending "Position Z = 1.2" becomes a
      // pending Y of 1.2 the moment the layout axis is set to Z, and Apply layout
      // moves the array to a place nobody typed. They are dropped for the same
      // reason `moduleChanged` drops them. The magnitudes — count, pitch,
      // footprint, fan, tilt — mean the same thing on any axis and stay.
      const edit = { ...state.edit };
      for (const f of AXIS_BOUND_EDITS) delete edit[f];
      // The stack depth goes with them. Positions are counted ALONG the layout
      // axis, so a pending "four per position" means four different cabinets
      // once the axis changes, and the Z field it was paired with has just been
      // dropped — leaving it behind applied a face reading to a centre.
      delete edit.perPosition;
      return { ...state, axisOverride: action.axis, edit };
    }

    case 'setCount': {
      const count = Math.max(1, Math.round(action.count));
      // A vertical stack has no footprint to freeze and no pitch to redistribute:
      // the boxes sit on each other, so a fourth cabinet makes the column one
      // cabinet taller. Which END it grows from is the mount's business, and
      // `derive` settles it by holding the reference face still.
      if (isVerticalStack(live)) return { ...state, edit: { ...state.edit, count } };

      // Freeze the footprint across a count change: the outer width is what got
      // taped out on the deck, so more cabinets means tighter spacing, not a
      // wider array. Capturing the width HERE, before the count changes, is the
      // whole trick — derived afterwards it would already have grown.
      // Touching is the other case with no footprint to freeze: the boxes are
      // against each other, so a fifth cabinet makes the block one cabinet
      // wider. Same rule as the stack, one axis over.
      if (state.spanMode === 'touching') return { ...state, edit: { ...state.edit, count } };

      // And a single cabinet is the third: see `derive`'s singleton rule. Its
      // footprint is its own width and it has no pitch at all, so freezing that
      // width here spread the new cabinets across one box and landed all of them
      // on the same point — which is exactly how a first array gets built.
      if (live.count < 2) return { ...state, edit: { ...state.edit, count } };

      const frozen = state.edit.overall ?? derive(state, live).overall;
      return {
        ...state,
        edit: { ...state.edit, count, overall: frozen },
        spanMode: 'overall',
      };
    }

    case 'setSpacing':
      return {
        ...state,
        spanMode: 'spacing',
        edit: { ...state.edit, spacing: action.metres },
      };

    case 'setOverall':
      return {
        ...state,
        spanMode: 'overall',
        edit: { ...state.edit, overall: action.metres },
      };

    case 'setSpanMode':
      // Dropping the pending footprint is the point: it was measured under the
      // old rule. Leaving it behind is what makes a frozen width reappear two
      // edits later, which is a quirk this file already carries once and is not
      // going to grow a second time.
      return { ...state, spanMode: action.mode, edit: { ...state.edit, overall: undefined } };

    case 'setGeom':
      return { ...state, edit: { ...state.edit, [action.field]: action.value } };

    case 'setRefZ':
      return { ...state, edit: { ...state.edit, refZ: action.metres } };

    case 'setRefA':
      return { ...state, edit: { ...state.edit, refA: action.metres } };

    case 'setPerPosition': {
      const per = Math.max(1, Math.round(action.count));
      const v = derive(state, live);
      // The Z field means the cabinet CENTRE for a plain row and a FACE for a
      // stack, so crossing between them has to convert — exactly as switching
      // the mount does, and for the same reason: re-describing a rig must not
      // move it. Unconverted, going back to one cabinet per position read the
      // old STACK centre as a cabinet centre and left the row floating half a
      // column above the deck.
      // Converted with the pitch the cabinets are STANDING at, not the one the
      // layout plans to write: this is a reading of where the rig is.
      const heldPitch = heldExtents(live).heightM || live.stackPitchM;
      const posC =
        v.perPosition > 1 === per > 1 || live.axis === 'z'
          ? state.edit.posC
          : per > 1
            ? stackRefFromCentre(1, heldPitch, v.posC, state.mount)
            : stackCentreFromRef(1, heldPitch, v.posC, state.mount);
      // Deepening a stack does not redistribute anything: the cabinets rest on
      // each other, so a fourth one makes the position one cabinet taller, and
      // the mount decides which end it grows from. Same rule as a vertical
      // column's count, which is what each position IS.
      //
      // Dropping back to one cabinet per position also drops the reversal,
      // because there is nothing left to reverse against: a lone cabinet turned
      // round is not a cardioid, it is a sub pointed at the back wall.
      return {
        ...state,
        edit: { ...state.edit, perPosition: per, posC },
        // Flattening a position to one cabinet asks for the reversal to come
        // off, and that has to be SAID: left unsaid, the survivor of each
        // position was the turned-round box at the bottom and the whole row
        // ended up facing upstage, inverted.
        pendingReverseAt: per > 1 ? state.pendingReverseAt : 'none',
        pendingReverseCount: per > 1 ? state.pendingReverseCount : null,
        pendingReversePattern: per > 1 ? state.pendingReversePattern : null,
      };
    }

    case 'setReverseAt':
      // Skrót „Brak / Dolna / Górna” czyści wzór wpisany ręcznie: inaczej
      // kliknięcie Dolna nie robiłoby nic widocznego, bo wzór ma pierwszeństwo.
      return { ...state, pendingReverseAt: action.at, pendingReversePattern: null };

    case 'setReverseCount':
      return {
        ...state,
        pendingReverseCount: Math.max(1, Math.round(action.count)),
        pendingReversePattern: null,
      };

    case 'toggleReverseIndex': {
      // Przełącznik przy pojedynczej obudowie. Wzór startuje od tego, co rig
      // MA w tej chwili, żeby jedno kliknięcie zmieniało jedną skrzynię, a nie
      // przepisywało całą pozycję od zera.
      const v = derive(state, live);
      const next = v.reversePattern.slice();
      if (action.index < 0 || action.index >= next.length) return state;
      next[action.index] = !next[action.index];
      // Wszystkie odwrócone to nie gradient, tylko rig tyłem do widowni —
      // przynajmniej jedna musi zostać z przodu.
      if (next.every(Boolean)) return state;
      return { ...state, pendingReversePattern: next };
    }

    case 'setAnchor': {
      // The control is not offered when there are no faces to anchor to, and an
      // action that cannot be offered must not take effect either: converting a
      // position against an anchor `derive` will then ignore moves the block.
      if (!canAnchorBlock(live) || action.anchor === state.anchor) return state;
      // Same rule as the mount: re-describing a block against a different end
      // must not move it. The pending position is converted, not dropped.
      const v = derive(state, live);
      return {
        ...state,
        anchor: action.anchor,
        edit: { ...state.edit, refA: anchorFromCentre(v.overall, v.centre, action.anchor) },
      };
    }

    case 'setMount': {
      if (action.mount === state.mount) return state;
      // Switching between a ground stack and a flown one describes the SAME
      // column differently; it must not move it. The pending height is re-read
      // against the other face, so the cabinets stay exactly where the editor
      // was about to put them and only the number in the box changes.
      const v = derive(state, live);
      const refZ = stackRefFromCentre(v.count, v.stackPitchM, v.centre, action.mount);
      if (isVerticalStack(live)) return { ...state, mount: action.mount, edit: { ...state.edit, refZ } };
      // A horizontal rig of stacks is placed by a face as well, so it needs the
      // same conversion one axis over. Without it a typed deck height was read
      // against the other end and the rig jumped a whole stack height while the
      // field went on showing the number the operator had typed.
      const posC =
        v.perPosition > 1
          ? stackRefFromCentre(v.perPosition, v.stackPitchM, v.stackCentreZ, action.mount)
          : state.edit.posC;
      return { ...state, mount: action.mount, edit: { ...state.edit, posC } };
    }

    case 'setMode':
      return { ...state, mode: action.mode, armed: true };

    case 'setSteer':
      return { ...state, steerDeg: action.deg, armed: true };

    case 'setBeamWidth':
      // One control, two meanings: dragging the beam width is also a statement
      // that the array is being aimed by dispersion rather than by angle.
      return { ...state, mode: 'dispersion', dispersionDeg: action.deg, armed: true };

    case 'setTaper':
      return { ...state, taperDb: action.db, armed: true };

    case 'setSpeaker':
      return { ...state, speakerId: action.id };

    case 'toggleLive':
      return { ...state, live: !state.live };

    case 'armed':
      // A deliberate apply takes its own undo entry, so the live session that
      // may follow it needs a fresh one rather than joining that entry.
      return { ...state, armed: true, liveWrote: false };

    case 'liveApplied':
      return { ...state, liveWrote: true };

    case 'layoutApplied':
      // The edits are on the canvas now, so the fields go back to reporting it.
      return { ...state, edit: {}, pendingReverseAt: null, pendingReverseCount: null };
  }
}

export interface ArrayModuleView {
  count: number;
  /** outer face to outer face, which is what gets taped out on the deck */
  overall: number;
  spacing: number;
  centre: number;
  posB: number;
  posC: number;
  /** the fan, measured off the cabinets until somebody types one */
  splay: number;
  elevation: number;
  /**
   * The fan and the tilt to WRITE, null when nobody typed either.
   *
   * `splay` and `elevation` above are what the fields SHOW, which is the array as
   * it stands. Applying a layout must not turn that reading back into an
   * instruction. Re-fanning a hand-aimed block into an even fan, or levelling off
   * cabinets that were tilted one by one, throws away aiming that nothing else in
   * the program can reconstruct — and Apply layout was doing the second of those
   * on every press.
   */
  splayTyped: number | null;
  elevationTyped: number | null;
  /** centre-to-centre distance from one end cabinet to the other */
  plannedSpan: number;
  /**
   * False when the cabinet width is unknown or there is a single cabinet: with
   * no outer face to measure from there is no footprint, so pitch has to lead
   * whatever the user last chose.
   */
  canDeriveSpacing: boolean;
  /** cabinets on cabinets: the pitch is pinned and the column is placed by a face */
  vertical: boolean;
  /**
   * The cabinets are against each other on the layout axis, so the pitch is the
   * cabinet's own size and neither the footprint nor the pitch is editable.
   * Always true for a vertical stack, optional for a horizontal block.
   */
  touching: boolean;
  /** whether `touching` can be offered at all, which needs a confirmed size */
  canTouch: boolean;
  /** which end a horizontal block is placed by; `centre` is the old behaviour */
  anchor: BlockAnchor;
  /** the position of that end, which equals `centre` when the anchor is `centre` */
  refA: number;
  /**
   * False when the cabinet width is unknown. A block has no outer faces then,
   * and anchoring to the outermost cabinet CENTRE would build in exactly the
   * half-a-box error the faces exist to avoid, so only the centre is offered.
   */
  canAnchor: boolean;
  mount: StackMount;
  /** the height of the face the column is placed by; only meaningful when vertical */
  refZ: number;
  /** where the column's faces land, whatever it is placed by */
  stackBottomM: number;
  stackTopM: number;
  /** cabinets at each position; 1 is a plain line */
  perPosition: number;
  /** total cabinets the layout will produce: positions x perPosition */
  cabinets: number;
  /**
   * False when a position cannot be deepened: on a vertical axis, where the
   * column already is the stack, or without a confirmed cabinet height in the
   * orientation the cabinets are standing in. The height is the pitch and this
   * project does not guess a box size, so the control is withheld rather than
   * stacking four cabinets on one point.
   */
  canStack: boolean;
  /** the pitch of that stack, which is the cabinet's own oriented height */
  stackPitchM: number;
  /**
   * Cabinet width across the layout axis when a position is built SIDEWAYS,
   * 0 when it is a vertical stack. Both the pitch of the row and the distance
   * at which two cabinets still read as one position.
   */
  acrossM: number;
  /** ile zajmuje JEDNA pozycja na osi układu — rząd liczy się cały */
  posW: number;
  /**
   * False when the editor cannot describe the rig — uneven stacks, or turned
   * cabinets that form no recognisable reverse stack. Apply layout is withheld
   * rather than rebuilding something nobody has.
   */
  canRebuild: boolean;
  /** whether a reverse stack can be offered at all: needs a published depth */
  canReverse: boolean;
  /**
   * True when a reversal is in force over a cabinet that is already directional.
   * Not an error — somebody may mean it — but the rejection ceiling beside it
   * describes two omnidirectional groups and says nothing about this rig.
   */
  reversingACardioid: boolean;
  /** which end of each position faces backwards: what the rig has, or what was asked */
  reverseAt: StackReverse;
  /**
   * The reversal to WRITE, null when nobody has touched the control. Same
   * separation as `splayTyped`: a reading must not become an instruction, or
   * an Apply layout flattens a cardioid somebody built by hand.
   */
  reverseAtTyped: StackReverse | null;
  /** Wzór odwrócenia, który rig POKAZUJE: długość równa liczbie obudów na pozycję. */
  reversePattern: boolean[];
  /** Wzór, o który ktoś POPROSIŁ przełącznikami; null, gdy nie ruszano. */
  reversePatternTyped: boolean[] | null;
  /** how many cabinets of each position face backwards, after the clamp */
  reverseCount: number;
  /** how many of each position still face the audience */
  forwardCount: number;
  /**
   * The ceiling the forward/reversed RATIO puts on rear rejection, dB.
   *
   * Null when the two groups are matched, which is the case nothing in the
   * counts limits. 0 when there is no reversal at all. This is the number that
   * stops somebody shipping a three-plus-one stack believing it is a cardioid.
   * Undefined when the cabinet is directional (cabinetIsOmni false): the
   * ceiling is arithmetic for point sources only.
   */
  rejectionCeilingDb: number | null | undefined;
  /**
   * Where the stack's centre has to go, given the face height in the Z field.
   *
   * With one cabinet per position this is the Z field itself. With more, the
   * field becomes a FACE — the deck when stacked, the rigging height when
   * flying — because that is the number anybody actually knows, and this is the
   * centre it converts to. Same conversion a vertical column uses.
   */
  stackCentreZ: number;
  /**
   * The cabinet's extents in the orientation this layout will leave it in, 0
   * when the model does not publish the side in question. Everything on screen
   * that quotes a cabinet size reads these, so a rolled rig's footprint and
   * tilt tool describe the box the operator is actually looking at.
   */
  cabinetWidthM: number;
  cabinetHeightM: number;
  /** roll of the cabinets, degrees about the front axis */
  roll: number;
  /** the roll to WRITE, null when nobody has chosen one: see `splayTyped` */
  rollTyped: number | null;
}

/** Resolve pending edits against the cabinets on the canvas. */
export function derive(state: ArrayModuleState, live: ArrayModuleLive): ArrayModuleView {
  const { edit, spanMode } = state;
  const count = edit.count ?? live.count;
  const vertical = isVerticalStack(live);

  // TWO orientations, and keeping them apart is the whole of this block.
  //
  // `held` is the cabinet as it is standing on the canvas right now. Every
  // reference face — a deck height, a rigging height, an anchored edge — is
  // READ off the rig through it, so the number the field shows is true of what
  // is there. `planned` is the cabinet as this layout is about to leave it, and
  // only what gets WRITTEN uses it.
  //
  // One pair for both is the bug: pressing "On end" made the editor re-read a
  // rig standing on the deck as though it were already on its end face, the
  // deck height came out at -0.19 m, and Apply layout then made that true.
  const roll = edit.roll ?? live.roll;
  const held = heldExtents(live);
  const planned = extentsAt(live.plannedWidthM, live.plannedHeightM, roll);
  // Along Z the cabinet's extent on the layout axis is its HEIGHT. Keyed on
  // `vertical` instead of on the axis, a Z rig with no published height fell
  // through to the WIDTH and offered Touching at a pitch the cabinets do not
  // have.
  const onZ = live.axis === 'z';
  const w = onZ ? planned.heightM : planned.widthM;
  const heldW = onZ ? held.heightM : held.widthM;
  const canTouch = w > 0;
  const touching = vertical || (spanMode === 'touching' && canTouch);
  const canDeriveSpacing = !vertical && !touching && w > 0 && count > 1;
  const leadByWidth = spanMode === 'overall' && canDeriveSpacing;

  // The asymmetry is deliberate. The DEFAULT footprint is the one the cabinets
  // already occupy, measured from the live count and pitch, while the pitch is
  // derived from the EDITED count. That pairing is what makes a count change
  // redistribute a fixed width.
  //
  // Unless there is no pitch to measure. A single cabinet has no gap in it, so
  // its spacing is 0 and its footprint is its own width: spreading the edited
  // count across THAT gives a pitch of zero and lands every cabinet on the same
  // point, which is the most natural way there is to build a first array. The
  // fallback is the cabinets against each other — the tightest layout that is
  // physically real, and the only pitch the geometry implies — which the operator
  // can then widen by typing a footprint or a pitch. Without a confirmed cabinet
  // width there is no fallback pitch either, and the pitch field keeps the lead;
  // inventing a box size to fill the hole is the one thing not on offer.
  // Which way a position is BUILT, which the orientation decides.
  //
  // Upright, the cabinets at one position rest on each other and the pitch is
  // the cabinet's height. On their end face they do not: four KS28 on end, one
  // on another, is a tower 5.36 m high and nobody builds that. On end they
  // stand side by side, touching on the largest face they have — the one that
  // was the top before the roll — so the pitch is the cabinet's WIDTH in that
  // orientation and the offsets run along the layout axis.
  const heldOnEnd = orientationOf(live.roll) === 90;
  const plannedOnEnd = orientationOf(roll) === 90;
  const heldPitchM = (heldOnEnd ? held.widthM : held.heightM) || live.stackPitchM;
  const stackPitchM = (plannedOnEnd ? planned.widthM : planned.heightM) || live.stackPitchM;
  // Passed to the layout only when the position really is built sideways; 0
  // leaves the stack vertical and every reading of an upright rig untouched.
  const acrossM = plannedOnEnd ? stackPitchM : 0;
  // What a position occupies VERTICALLY, which a row and a stack answer
  // differently. The held side is measured (`positionAcross`) and the planned
  // side is chosen (`plannedOnEnd`), because one describes a rig and the other
  // describes an instruction.
  const heldVertCount = live.positionAcross ? 1 : live.perPosition;
  const heldVertPitchM = live.positionAcross ? held.heightM || heldPitchM : heldPitchM;
  // perPosition is NOT gated on being able to change it. What the rig already
  // has is preserved whatever the editor can offer, because `count *
  // perPosition` is what an Apply layout writes and it must never come out
  // smaller than the rig for an editor nobody has touched.
  const canStack = !onZ && stackPitchM > 0;
  // What the rig already HAS is always preserved; only the EDIT is gated. A
  // control that cannot be offered must not take effect either — the same rule
  // the anchor follows — but gating the live value instead silently collapsed
  // an imported stack to one cabinet per position and let Apply layout delete
  // the rest.
  const perPosition = onZ
    ? 1
    : Math.max(1, Math.round((canStack ? edit.perPosition : undefined) ?? live.perPosition));
  const plannedVertCount = plannedOnEnd ? 1 : perPosition;
  const plannedVertPitchM = plannedOnEnd ? planned.heightM || stackPitchM : stackPitchM;

  // Ile zajmuje JEDNA POZYCJA na osi układu.
  //
  // Dla stosu to jedna obudowa, bo stos rośnie w górę. Dla rzędu to cały rząd:
  // osiemnaście KS28 na boku zajmuje 9.9 m, a nie 0.55 m. Bez tego rozróżnienia
  // edytor opisywał rig szeroki na dziewięć metrów jako szeroki na pół metra
  // i wysoki na dziewięć — właściwy wymiar trafiał na niewłaściwą oś.
  const posW = acrossM > 0 ? perPosition * acrossM : w;

  // Ślad domyślny liczony z ROZSTAWU, który rig ma teraz, i z szerokości
  // pozycji, jaką rig BĘDZIE miał. Zmiana tego, CZYM jest pozycja —
  // orientacja, obudów na pozycję — nie może przesuwać pozycji: ich środki
  // to fakt rigu, a szerokość zewnętrzna idzie za nimi. Liczony z szerokości
  // pozycji, jaką rig MA, ślad zostawał stały, a rozstaw ściskał
  // się o różnicę szerokości: "Na boku" przy 4 obudowach na pozycję wciskało
  // rzędy w siebie (rozstaw 0.69 m przy 2.20 m na pozycję), a obudowy
  // sąsiednich pozycji stawały na przemian. Zmiana LICZBY pozycji nadal
  // zamraża szerokość — robi to setCount, jawnie, zanim liczba się zmieni.
  const defaultFootprint =
    live.count > 1 ? overallWidth(live.count, live.spacing, posW) : overallWidth(count, posW, posW);
  // Boxes against boxes: the taped-out width is not a choice, it is the count
  // times the cabinet. Derived anyway, because it is still the number that has
  // to fit on the deck, and because the anchor measures from its faces.
  const overall = touching
    ? overallWidth(count, posW, posW)
    : leadByWidth
      ? edit.overall ?? defaultFootprint
      : overallWidth(count, edit.spacing ?? live.spacing, posW);
  const spacing = touching
    ? posW
    : leadByWidth
      ? spacingFromOverallWidth(count, overall, posW)
      : edit.spacing ?? live.spacing;

  // The reference face is read off the array AS IT STANDS, then the centre is
  // rebuilt from it with the EDITED count. That is what makes adding a cabinet
  // grow a ground stack upwards and a flown column downwards, instead of
  // sliding the whole thing half a box either way.
  const refZ = vertical
    ? edit.refZ ?? stackRefFromCentre(live.count, heldW, live.centre, state.mount)
    : 0;
  // Horizontally the same idea as a stack, one axis over: read the anchored face
  // off the block AS IT STANDS, then rebuild the centre from it with the EDITED
  // count and width. That is what keeps a left-anchored block's left edge still
  // while it grows to the right. With the anchor at `centre` both conversions
  // are the identity, so nothing changes for anyone who never touches it.
  const canAnchor = canAnchorBlock(live);
  const anchor: BlockAnchor = canAnchor ? state.anchor : 'centre';
  const liveOverall = overallWidth(live.count, live.spacing, heldW);
  const refA = vertical
    ? 0
    : edit.refA ?? anchorFromCentre(liveOverall, edit.centre ?? live.centre, anchor);
  const centre = vertical
    ? stackCentreFromRef(count, w, refZ, state.mount)
    : centreFromAnchor(overall, refA, anchor);
  const faces = stackExtent(count, vertical ? w : 0, centre);

  // ---- cabinets at each position -------------------------------------------
  // The pitch of a position's stack is the cabinet's HEIGHT in the orientation
  // it is standing in. Along Z that is the same number as `w` above, which is
  // why a column cannot be deepened: it already is the stack.
  //
  // The measured pitch is the fallback, not a nominal box. A rig whose cabinet
  // height nobody publishes still stands at a pitch that can be READ off it,
  // and using it is what lets such a rig be rebuilt instead of collapsed onto
  // one point — a collapse an untouched Apply layout used to perform silently.
  // A gradient with no separation is not a gradient. Without a published depth
  // the delay would be zero, the rear null would not exist, and the ceiling
  // beside the control would describe a rig nobody has.
  const canReverse = canStack && perPosition > 1 && live.gradientSpanM > 0;
  // SHOWN is what the rig has until somebody asks for something else; WRITTEN
  // is only what they asked for. Exactly the split `splayTyped` makes one
  // section up, and for the same reason: a control that is only ever an
  // instruction describes a rig it has never looked at.
  const reverseAt: StackReverse = canReverse
    ? state.pendingReverseAt ?? live.reverseAt
    : 'none';
  const reverseAtTyped = canReverse ? state.pendingReverseAt : null;
  // At least one cabinet has to keep facing the audience: a position with every
  // box turned round is not a gradient, it is the rig pointing upstage.
  const reverseCount =
    reverseAt === 'none'
      ? 0
      : Math.min(
          perPosition - 1,
          Math.max(1, Math.round(state.pendingReverseCount ?? live.reverseCount ?? 1)),
        );
  const forwardCount = perPosition - reverseCount;
  // Wzór POKAZYWANY: ręcznie wpisany, jeżeli pasuje do liczby obudów; inaczej
  // ten, który rig ma; a jeśli i tego nie ma — zbudowany z „Dolna/Górna”.
  // Zawsze długości perPosition, żeby interfejs nie musiał tego pilnować.
  const fromEnds = Array.from({ length: perPosition }, (_, j) =>
    reverseAt === 'bottom' ? j < reverseCount : reverseAt === 'top' ? j >= perPosition - reverseCount : false,
  );
  const typedPattern =
    state.pendingReversePattern && state.pendingReversePattern.length === perPosition
      ? state.pendingReversePattern
      : null;
  const livePattern =
    live.reversePattern && live.reversePattern.length === perPosition ? live.reversePattern : null;
  const reversePattern = canReverse ? typedPattern ?? livePattern ?? fromEnds : fromEnds;
  const reversePatternTyped = canReverse ? typedPattern : null;
  // The Z field reads as a FACE once there is a stack to have faces and as the
  // cabinet CENTRE when there is not, and the conversion runs both ways: the
  // number shown is read back off the cabinets through the same rule, with the
  // count and the pitch the rig actually has, so opening the panel on an
  // existing stack never offers to move it. Crossing between the two meanings
  // is converted in the reducer, not here, for the same reason the mount is.
  // ...and none of it applies on a Z layout, where the cross axis is Y and a
  // face-to-centre conversion would be moving the rig sideways.
  const refFaceZ =
    edit.posC ??
    // The GATE stays on the cabinet count, so whether the Z field reads as a
    // face or as a cabinet centre is unchanged; only the extent it converts
    // through knows about rows.
    (!onZ && live.perPosition > 1
      ? stackRefFromCentre(heldVertCount, heldVertPitchM, live.posC, state.mount)
      : live.posC);
  // A row of cabinets is ONE cabinet tall however many of them there are, so
  // only a stack multiplies the vertical extent by the count. Reading a row as
  // a stack of four put its reference face three cabinets below the deck.
  //
  // Pojedyncza obudowa na pozycję: pole Z jest tu ŚRODKIEM, a obudowa stoi na
  // podeście (albo wisi). Zmiana orientacji albo modelu zmienia jej wysokość,
  // a trzymanie środka obracało skrzynię wokół niego — "Na boku" wpuszczało
  // połowę obudowy w podest, a kolejne kroki wiernie zachowywały ten błędny
  // podest (zmierzone: −0.3775 m dla KS28 na boku, z dokładnie tej ścieżki).
  // Trzymana jest więc ŚCIANA, na której rig stoi: dolna przy "Stos", górna
  // przy "Podwieszony". Wpisane Z wygrywa, a nieznana wysokość niczego nie
  // przesuwa — wymiaru się nie zgaduje.
  const singleCentreZ = (): number => {
    if (edit.posC !== undefined) return edit.posC;
    const hH = held.heightM;
    const pH = planned.heightM;
    if (!(hH > 0) || !(pH > 0) || Math.abs(hH - pH) < 1e-9) return refFaceZ;
    return state.mount === 'flying'
      ? live.posC + hH / 2 - pH / 2
      : live.posC - hH / 2 + pH / 2;
  };
  const stackCentreZ =
    !onZ && perPosition > 1
      ? stackCentreFromRef(plannedVertCount, plannedVertPitchM, refFaceZ, state.mount)
      : onZ
        ? refFaceZ
        : singleCentreZ();

  return {
    count,
    overall,
    spacing,
    centre,
    posB: edit.posB ?? live.posB,
    posC: refFaceZ,
    splay: edit.splay ?? live.splay,
    splayTyped: edit.splay ?? null,
    elevation: edit.elevation ?? live.elevation,
    elevationTyped: edit.elevation ?? null,
    plannedSpan: (count - 1) * spacing,
    canDeriveSpacing,
    vertical,
    touching,
    canTouch,
    anchor,
    refA,
    canAnchor,
    mount: state.mount,
    refZ,
    stackBottomM: faces.bottomM,
    stackTopM: faces.topM,
    perPosition,
    cabinets: count * perPosition,
    canStack,
    stackPitchM,
    acrossM,
    posW,
    canReverse,
    reversingACardioid: reverseAt !== 'none' && live.cabinetIsCardioid,
    reverseAt,
    reverseAtTyped,
    reversePattern,
    reversePatternTyped,
    reverseCount,
    forwardCount,
    // A rig whose stacking or whose reversal this editor cannot describe must
    // not be rebuilt from a description it does not have.
    canRebuild:
      live.reversalDescribable &&
      live.positionsUniform &&
      live.perPosition * live.count === live.cabinets,
    rejectionCeilingDb: !live.cabinetIsOmni
      ? undefined
      : reverseCount > 0
        ? gradientRejectionDb(forwardCount, reverseCount)
        : 0,
    stackCentreZ,
    cabinetWidthM: planned.widthM,
    cabinetHeightM: planned.heightM,
    roll,
    rollTyped: edit.roll ?? null,
  };
}

/**
 * The gradient delay each cabinet needs because of how it is TURNED, not where
 * it is aimed.
 *
 * A reverse stack is a pressure gradient: the box facing backwards radiates
 * from the other side of the cabinet, so its origin sits one cabinet depth
 * behind the forward boxes, and the rear null appears when that box is both
 * polarity-inverted and delayed by d/c. The polarity is geometry and the layout
 * writes it; the delay is a NUMBER IN THE DELAY COLUMN, and the delay column
 * belongs to whatever was applied last.
 *
 * Hence this, handed to `planDelays` as `extraDelaysS`: steering the rig adds
 * its aim on top of the gradient instead of overwriting it. Without it the rig
 * would lose its rear null the first time anybody touched the beam width, which
 * is the same failure the taper had and for the same reason.
 *
 * Which cabinets are turned round is measured off the canvas (`reversedFlags`),
 * so a rig built by hand gets the same treatment as one the layout tool built.
 */
export function reverseDelayOffsets(
  members: SourceRecord[],
  gradientDelayS: number,
  forwardAzimuthDeg?: number,
): number[] {
  if (!(gradientDelayS > 0)) return members.map(() => 0);
  const rev = reversedFlags(members, forwardAzimuthDeg);
  // A gradient needs a PARTNER. Facing upstage is not by itself a reverse
  // stack: a project with its main array downstage and two rear-fills turned
  // round 25 m behind it has no gradient anywhere, and handing those two a
  // 1.75 ms delay — which one flat Apply delay did — is simply wrong delay on
  // a cabinet nobody configured.
  //
  // Partnerem jest obudowa przednia w TEJ SAMEJ POZYCJI. Najpierw po
  // zapisanej przynależności (positionKey), bo rząd obudów na boku stoi OBOK
  // siebie, nie współrzędnie — test "nose-to-tail" po współrzędnych nie
  // znajdował tam partnera i odwrócona skrzynia zostawała bez gradientu,
  // choć akustycznie para jest parą: jej punkt promieniowania i tak leży
  // o głębokość skrzyni za punktem przedniej. Dla obudów bez klucza zostaje
  // test współrzędnych, porównywany jako ODLEGŁOŚĆ, nie przez zaokrąglenie:
  // 0.0004 i 0.0006 wpadają do różnych kubełków będąc 0.2 mm od siebie.
  const near = (a: SourceRecord, b: SourceRecord) =>
    Math.abs(a.position.x - b.position.x) <= POSITION_TOL_M &&
    Math.abs(a.position.y - b.position.y) <= POSITION_TOL_M;
  // Wspólny klucz LUB współrzędność — nie "klucz, a inaczej współrzędność".
  // Dwie osobne pozycje zsunięte ręcznie w jeden stos mają różne klucze,
  // a stoją na sobie: gałąź kluczowa nie może im odebrać partnerstwa, które
  // test odległości zawsze im dawał.
  const samePos = (a: SourceRecord, b: SourceRecord) =>
    (!!a.positionKey && a.positionKey === b.positionKey) || near(a, b);
  return members.map((m, i) =>
    rev[i] && members.some((o, k) => !rev[k] && samePos(m, o)) ? gradientDelayS : 0,
  );
}

/**
 * The heading a reversal is written against; see `LayoutOptions.forwardAzimuthDeg`.
 *
 * A property of the cabinets on the canvas and of nothing else — see
 * `forwardHeadingOf`. Taking it from the editor's PENDING designation instead
 * was the second blocker in a row here: clicking the control from Bottom to Top
 * read the heading off the cabinets that were still turned round, put the
 * gradient delay on the ones facing the audience, and with live steering armed
 * wrote that 180 ms later with no further action.
 */
export function forwardAzimuthOf(members: SourceRecord[]): number {
  return forwardHeadingOf(members);
}

/**
 * The aim the pattern-control limit is quoted against.
 *
 * The limit depends on how far off axis the array is steered, and the editor
 * opens holding a default 80 degree arc that nothing has applied. Quoting the
 * limit against that describes a plan nobody asked for: a freshly opened module
 * of 1.5 m spacing reported 139 Hz for cabinets whose real limit is 229 Hz, and
 * 139 Hz is the number an operator would go and choose a crossover from.
 *
 * Until a steering field is touched the readout therefore describes the ARRAY;
 * once one is, it describes the aim being dialled in, which is what every other
 * field in the panel does.
 */
export function aimForPatternLimit(state: ArrayModuleState): {
  steerDeg: number;
  dispersionDeg: number;
} {
  if (!state.armed) return { steerDeg: 0, dispersionDeg: 0 };
  return {
    steerDeg: state.mode === 'flat' ? 0 : state.steerDeg,
    dispersionDeg: state.mode === 'dispersion' ? state.dispersionDeg : 0,
  };
}

/**
 * The name a module gets when a steering tool has to create one.
 *
 * The angle is in the name on purpose: a group called "ARC 90" tells the next
 * person what was asked for, which "SUB ARRAY 2" does not.
 */
export function moduleNameFor(state: ArrayModuleState): string {
  switch (state.mode) {
    case 'dispersion':
      return `ARC ${state.dispersionDeg.toFixed(0)}°`;
    case 'endfire':
      return 'END-FIRE';
    default:
      return `SUB ${state.steerDeg.toFixed(0)}°`;
  }
}

/** What a plan asks for, as a comparable string. */
export function planKeyOf(plan: DelayPlan): string {
  return (
    plan.delaysS.map((v) => v.toFixed(7)).join(',') +
    '|' +
    (plan.levelsDb?.map((v) => v.toFixed(3)).join(',') ?? '')
  );
}

/** What the cabinets already hold, in the same shape, for comparison. */
export function heldKeyOf(members: Source[], plan: DelayPlan): string {
  return (
    members.map((m) => m.delayS.toFixed(7)).join(',') +
    '|' +
    (plan.levelsDb ? members.map((m) => m.levelDb.toFixed(3)).join(',') : '')
  );
}

/**
 * Should live steering write this plan to the cabinets?
 *
 * The key comparison is not an optimisation. Applying a plan changes the
 * cabinets, which produces a new plan, which would be applied again: without
 * this the live mode re-applies its own result forever.
 */
export function shouldRestee(
  state: ArrayModuleState,
  members: Source[],
  plan: DelayPlan,
): boolean {
  if (!state.live || !state.armed || members.length === 0) return false;
  return planKeyOf(plan) !== heldKeyOf(members, plan);
}
