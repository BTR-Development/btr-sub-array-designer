/**
 * The behaviour of the array editor, tested without a screen.
 *
 * Every rule here used to be an unwritten property of one React component. The
 * BTR Portal build rewrites the interface layer, so these are the things that
 * would otherwise be reimplemented from a screenshot and quietly come out
 * different: same engine, same maths, different answer to "what happens when I
 * add a cabinet".
 */
import { describe, expect, it } from 'vitest';
import {
  INITIAL_ARRAY_MODULE,
  aimForPatternLimit,
  arrayModuleReducer as run,
  derive,
  heldKeyOf,
  measure,
  isVerticalStack,
  moduleNameFor,
  planKeyOf,
  resolveAxis,
  shouldRestee,
  type ArrayModuleLive,
  type ArrayModuleState,
} from './arrayModule';
import type { DelayPlan } from './arrayTools';
import { patternControlLimitHz } from '../engine/steering';
import type { Source } from '../core/types';

const KS28_W = 1.34;
const KS28_H = 0.6;

const live = (over: Partial<ArrayModuleLive> = {}): ArrayModuleLive => ({
  detectedAxis: 'x',
  axis: 'x',
  count: 8,
  cabinets: 8,
  perPosition: 1,
  // Upright by default, like every rig this factory builds.
  positionAcross: false,
  reversePattern: null,
  roll: 0,
  spacing: 1.5,
  centre: 0,
  posB: 0,
  posC: 0,
  elevation: 0,
  splay: 0,
  publishedWidthM: KS28_W,
  publishedHeightM: KS28_H,
  stackPitchM: 0,
  gradientSpanM: 0,
  cabinetIsCardioid: false,
  cabinetIsOmni: true,
  positionsUniform: true,
  reverseAt: 'none',
  reverseCount: 0,
  reversalDescribable: true,
  ...over,
  // A test that overrides the cabinet SIZE is not a test about swapping the
  // model, so the planned pair follows the published one unless it is set too.
  plannedWidthM: over.plannedWidthM ?? over.publishedWidthM ?? KS28_W,
  plannedHeightM: over.plannedHeightM ?? over.publishedHeightM ?? KS28_H,
});

const src = (over: Partial<Source> = {}): Source =>
  ({
    id: 's', label: 'S', speakerId: 'la-ks28',
    position: { x: 0, y: 0, z: 0 },
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: 0, delayS: 0, invertPolarity: false, muted: false,
    groupId: null,
    ...over,
  }) as Source;

const plan = (delays: number[], levels: number[] | null = null): DelayPlan =>
  ({ delaysS: delays, levelsDb: levels, maxDelayS: Math.max(0, ...delays) }) as DelayPlan;

describe('the footprint leads', () => {
  it('adding cabinets keeps the taped-out width and tightens the pitch', () => {
    const l = live({ count: 8, spacing: 1.5 });
    const before = derive(INITIAL_ARRAY_MODULE, l);

    const s = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, l);
    const after = derive(s, l);

    expect(after.count).toBe(12);
    // the deck does not get any longer
    expect(after.overall).toBeCloseTo(before.overall, 9);
    // so the cabinets have to move closer together
    expect(after.spacing).toBeLessThan(before.spacing);
  });

  it('removing cabinets keeps it too, and opens the pitch out', () => {
    const l = live({ count: 8, spacing: 1.5 });
    const before = derive(INITIAL_ARRAY_MODULE, l);
    const after = derive(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 4 }, l), l);

    expect(after.overall).toBeCloseTo(before.overall, 9);
    expect(after.spacing).toBeGreaterThan(before.spacing);
  });

  it('freezes the width once, not once per keystroke', () => {
    // 8 -> 12 -> 6 must still describe the ORIGINAL footprint, otherwise every
    // edit re-freezes a width that was itself derived and the array creeps.
    const l = live({ count: 8, spacing: 1.5 });
    const start = derive(INITIAL_ARRAY_MODULE, l).overall;

    let s: ArrayModuleState = INITIAL_ARRAY_MODULE;
    s = run(s, { type: 'setCount', count: 12 }, l);
    s = run(s, { type: 'setCount', count: 6 }, l);

    expect(derive(s, l).overall).toBeCloseTo(start, 9);
  });

  it('typing a pitch hands the lead back to pitch', () => {
    const l = live();
    let s = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, l);
    s = run(s, { type: 'setSpacing', metres: 2 }, l);

    const v = derive(s, l);
    expect(s.spanMode).toBe('spacing');
    expect(v.spacing).toBe(2);
    // and now the footprint is whatever that pitch implies, not the frozen one
    expect(v.overall).toBeCloseTo(11 * 2 + KS28_W, 9);
  });

  it('pitch leads when the cabinet width is unknown', () => {
    // No confirmed width means no outer face to measure from. Guessing one is
    // exactly the invented dimension this project refuses to produce.
    const l = live({ publishedWidthM: 0 });
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, l), l);

    expect(v.canDeriveSpacing).toBe(false);
    expect(v.spacing).toBe(l.spacing);
  });

  it('a single cabinet has no footprint to hold', () => {
    expect(derive(INITIAL_ARRAY_MODULE, live({ count: 1 })).canDeriveSpacing).toBe(false);
  });

  it('reports the centre-to-centre span, not the outer width', () => {
    const v = derive(INITIAL_ARRAY_MODULE, live({ count: 8, spacing: 1.5 }));
    expect(v.plannedSpan).toBeCloseTo(7 * 1.5, 9);
    expect(v.overall).toBeCloseTo(7 * 1.5 + KS28_W, 9);
  });
});

describe('a frozen footprint outlives a pitch edit', () => {
  it('pins the behaviour rather than claiming it is right', () => {
    // Sequence: change the count (freezes 23.84 m), then type a pitch, which
    // hands the lead to pitch and shows a 15.34 m array, then change the count
    // again. The width jumps back to 23.84, because the frozen value is still
    // sitting in `edit.overall` from the first step.
    //
    // This is exactly what the panel did before the logic moved out here, so it
    // is pinned, not silently changed. It is also arguably wrong: the width the
    // user last saw was 15.34. Fixing it is one line in `setSpacing` (drop
    // `edit.overall`), and that is a product decision, not a refactor.
    const l = live({ count: 16, spacing: 1.5, publishedWidthM: 1.34 });
    let s: ArrayModuleState = INITIAL_ARRAY_MODULE;

    s = run(s, { type: 'setCount', count: 8 }, l);
    const frozen = derive(s, l).overall;

    s = run(s, { type: 'setSpacing', metres: 2 }, l);
    expect(derive(s, l).overall).toBeCloseTo(7 * 2 + 1.34, 9);

    s = run(s, { type: 'setCount', count: 12 }, l);
    expect(derive(s, l).overall).toBeCloseTo(frozen, 9);
  });
});

describe('pending edits', () => {
  it('shows what is on the canvas until a field is touched', () => {
    const l = live({ centre: 3, posB: -2, elevation: 4 });
    const v = derive(INITIAL_ARRAY_MODULE, l);
    expect([v.centre, v.posB, v.elevation]).toEqual([3, -2, 4]);
  });

  it('keeps a zero the user typed, rather than falling back to the canvas', () => {
    // "At x = 0" is the commonest value there is, so ?? and not ||
    const l = live({ centre: 5 });
    const s = run(INITIAL_ARRAY_MODULE, { type: 'setGeom', field: 'centre', value: 0 }, l);
    expect(derive(s, l).centre).toBe(0);
  });

  it('goes back to reporting the canvas once the layout is applied', () => {
    const l = live();
    let s = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, l);
    s = run(s, { type: 'layoutApplied' }, l);
    expect(s.edit).toEqual({});
    expect(derive(s, l).count).toBe(l.count);
  });

  it('drops everything when the editor is pointed at another module', () => {
    const l = live();
    let s = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, l);
    s = run(s, { type: 'setAxis', axis: 'z' }, l);
    s = run(s, { type: 'setSpeaker', id: 'db-b22' }, l);
    s = run(s, { type: 'setSteer', deg: 20 }, l);

    const next = run(s, { type: 'moduleChanged' }, l);

    expect(next.edit).toEqual({});
    expect(next.axisOverride).toBeNull();
    expect(next.speakerId).toBe('');
    expect(next.spanMode).toBe('overall');
    // and above all: it must not fire live steering at the array it just met
    expect(next.armed).toBe(false);
  });
});

describe('the axis', () => {
  it('follows the geometry until the user overrides it', () => {
    const along = [src({ id: 'a', position: { x: 0, y: 0, z: 0 } }), src({ id: 'b', position: { x: 3, y: 0, z: 0 } })];
    expect(resolveAxis(INITIAL_ARRAY_MODULE, along)).toBe('x');
    expect(resolveAxis({ ...INITIAL_ARRAY_MODULE, axisOverride: 'z' }, along)).toBe('z');
  });

  it('measures along the axis in force, not the detected one', () => {
    const column = [
      src({ id: 'a', position: { x: 0, y: 0, z: 0 } }),
      src({ id: 'b', position: { x: 0, y: 0, z: 2 } }),
    ];
    const m = measure(column, 'z', { publishedWidthM: KS28_W });
    expect(m.spacing).toBeCloseTo(2, 9);
    expect(m.detectedAxis).toBe('z');
  });
});

describe('arming', () => {
  const l = live();

  it('starts disarmed, so opening the editor cannot overwrite hand-set delays', () => {
    expect(INITIAL_ARRAY_MODULE.armed).toBe(false);
    expect(shouldRestee(INITIAL_ARRAY_MODULE, [src()], plan([0.001]))).toBe(false);
  });

  it('geometry edits do not arm it', () => {
    // moving cabinets is not a statement about the delay taper
    for (const a of [
      { type: 'setCount', count: 4 },
      { type: 'setSpacing', metres: 2 },
      { type: 'setGeom', field: 'centre', value: 1 },
    ] as const) {
      expect(run(INITIAL_ARRAY_MODULE, a, l).armed).toBe(false);
    }
  });

  it('every steering field arms it', () => {
    for (const a of [
      { type: 'setMode', mode: 'endfire' },
      { type: 'setSteer', deg: -12 },
      { type: 'setBeamWidth', deg: 60 },
      { type: 'setTaper', db: -6 },
      { type: 'armed' },
    ] as const) {
      expect(run(INITIAL_ARRAY_MODULE, a, l).armed).toBe(true);
    }
  });

  it('the beam width control also picks the arc mode', () => {
    const s = run({ ...INITIAL_ARRAY_MODULE, mode: 'flat' }, { type: 'setBeamWidth', deg: 60 }, l);
    expect(s.mode).toBe('dispersion');
    expect(s.dispersionDeg).toBe(60);
  });
});

describe('live re-steer', () => {
  const armed = { ...INITIAL_ARRAY_MODULE, armed: true };
  const cabinets = [src({ id: 'a', delayS: 0 }), src({ id: 'b', delayS: 0.002 })];

  it('writes a plan the cabinets do not already hold', () => {
    expect(shouldRestee(armed, cabinets, plan([0, 0.004]))).toBe(true);
  });

  it('stops once the cabinets hold it, so it cannot re-apply its own result', () => {
    expect(shouldRestee(armed, cabinets, plan([0, 0.002]))).toBe(false);
  });

  it('compares levels only when the plan sets them', () => {
    const withLevels = plan([0, 0.002], [0, 0]);
    expect(planKeyOf(withLevels)).toContain('|');
    expect(heldKeyOf(cabinets, withLevels)).toBe(heldKeyOf(cabinets, withLevels));
    expect(shouldRestee(armed, cabinets, withLevels)).toBe(false);
    expect(shouldRestee(armed, cabinets, plan([0, 0.002], [0, -3]))).toBe(true);
  });

  it('does nothing while live is switched off', () => {
    const off = run(armed, { type: 'toggleLive' }, live());
    expect(off.live).toBe(false);
    expect(shouldRestee(off, cabinets, plan([0, 0.009]))).toBe(false);
  });

  it('does nothing on an empty module', () => {
    expect(shouldRestee(armed, [], plan([]))).toBe(false);
  });
});

describe('the name a tool gives a module', () => {
  it('says what was asked for', () => {
    const s = INITIAL_ARRAY_MODULE;
    expect(moduleNameFor({ ...s, mode: 'dispersion', dispersionDeg: 90 })).toBe('ARC 90°');
    expect(moduleNameFor({ ...s, mode: 'endfire' })).toBe('END-FIRE');
    expect(moduleNameFor({ ...s, mode: 'steer', steerDeg: -25 })).toBe('SUB -25°');
    expect(moduleNameFor({ ...s, mode: 'flat', steerDeg: 0 })).toBe('SUB 0°');
  });
});

describe('vertical array: cabinet on cabinet', () => {
  const H = 0.571; // KS21, manufacturer
  // A column of 4, sitting on the floor: centres at H/2, 3H/2, 5H/2, 7H/2.
  const column = (over: Partial<ArrayModuleLive> = {}) =>
    live({ axis: 'z', count: 4, spacing: H, centre: 2 * H, publishedHeightM: H, ...over });

  const stacked: ArrayModuleState = { ...INITIAL_ARRAY_MODULE, mount: 'stacked' };
  const flying: ArrayModuleState = { ...INITIAL_ARRAY_MODULE, mount: 'flying' };

  it('is only a stack when the height is confirmed', () => {
    expect(isVerticalStack(column())).toBe(true);
    expect(isVerticalStack(column({ publishedHeightM: 0 }))).toBe(false);
    expect(isVerticalStack(live({ axis: 'x' }))).toBe(false);
  });

  it('pins the pitch to the cabinet height, whatever was typed before', () => {
    const typed = run(stacked, { type: 'setSpacing', metres: 2.5 }, column());
    const v = derive(typed, column());
    expect(v.spacing).toBeCloseTo(H, 9);
    expect(v.vertical).toBe(true);
  });

  it('reads the deck height off a stack that is already on the floor', () => {
    expect(derive(stacked, column()).refZ).toBeCloseTo(0, 9);
    expect(derive(stacked, column()).stackBottomM).toBeCloseTo(0, 9);
    expect(derive(stacked, column()).stackTopM).toBeCloseTo(4 * H, 9);
  });

  it('reads the rig height off the same column when it is flown', () => {
    // Same cabinets, same place; only which face the number refers to changes.
    expect(derive(flying, column()).refZ).toBeCloseTo(4 * H, 9);
  });

  it('grows a ground stack upwards when a cabinet is added', () => {
    const s = run(stacked, { type: 'setCount', count: 5 }, column());
    const v = derive(s, column());
    expect(v.stackBottomM).toBeCloseTo(0, 9); // the deck does not move
    expect(v.stackTopM).toBeCloseTo(5 * H, 9);
  });

  it('grows a flown column downwards when a cabinet is added', () => {
    // The motor stays where it is; the column gets longer underneath it. Getting
    // this backwards lifts a rigged array through the roof.
    const s = run(flying, { type: 'setCount', count: 5 }, column());
    const v = derive(s, column());
    expect(v.stackTopM).toBeCloseTo(4 * H, 9); // the rig point does not move
    expect(v.stackBottomM).toBeCloseTo(4 * H - 5 * H, 9);
  });

  it('does not redistribute a fixed footprint the way a horizontal line does', () => {
    const s = run(stacked, { type: 'setCount', count: 8 }, column());
    expect(derive(s, column()).spacing).toBeCloseTo(H, 9);
    expect(s.edit.overall).toBeUndefined();
  });

  it('moves the column to the height that was typed', () => {
    const s = run(flying, { type: 'setRefZ', metres: 9 }, column());
    const v = derive(s, column());
    expect(v.stackTopM).toBeCloseTo(9, 9);
    expect(v.centre).toBeCloseTo(9 - (4 * H) / 2, 9);
  });

  it('switching the mount re-reads the height without moving the cabinets', () => {
    const typed = run(flying, { type: 'setRefZ', metres: 9 }, column());
    const before = derive(typed, column());
    const switched = run(typed, { type: 'setMount', mount: 'stacked' }, column());
    const after = derive(switched, column());
    expect(after.centre).toBeCloseTo(before.centre, 9);
    expect(after.stackBottomM).toBeCloseTo(before.stackBottomM, 9);
    expect(after.refZ).toBeCloseTo(before.stackBottomM, 9);
  });

  it('falls back to a freely spaced line when the height is unknown', () => {
    // The project does not invent cabinet sizes, so an unconfirmed height means
    // the stack controls are simply not offered.
    const unknown = column({ publishedHeightM: 0, spacing: 1.2 });
    const v = derive(run(stacked, { type: 'setSpacing', metres: 1.2 }, unknown), unknown);
    expect(v.vertical).toBe(false);
    expect(v.spacing).toBeCloseTo(1.2, 9);
  });

  it('leaves horizontal arrays completely alone', () => {
    const l = live();
    const before = derive(INITIAL_ARRAY_MODULE, l);
    expect(before.vertical).toBe(false);
    expect(before.spacing).toBeCloseTo(l.spacing, 9);
    expect(derive(flying, l).centre).toBeCloseTo(l.centre, 9);
  });
});

describe('horizontal block: cabinet against cabinet', () => {
  const touching = run(INITIAL_ARRAY_MODULE, { type: 'setSpanMode', mode: 'touching' }, live());

  it('is the mode, not the default: nothing changes until it is chosen', () => {
    const before = derive(INITIAL_ARRAY_MODULE, live());
    expect(before.touching).toBe(false);
    expect(before.spacing).toBeCloseTo(1.5, 9);
    expect(before.canTouch).toBe(true);
  });

  it('pins the pitch to the cabinet width and closes the edge gap', () => {
    const v = derive(touching, live());
    expect(v.touching).toBe(true);
    expect(v.spacing).toBeCloseTo(KS28_W, 9);
    expect(v.spacing - KS28_W).toBeCloseTo(0, 9);
  });

  it('reports the footprint the block actually takes up on the deck', () => {
    expect(derive(touching, live()).overall).toBeCloseTo(8 * KS28_W, 9);
  });

  it('widens the block when a cabinet is added, instead of tightening the pitch', () => {
    // The opposite of the spaced default, and the whole reason this is a choice:
    // a taped-out width is a constraint, a wall of subs is a build.
    const wider = run(touching, { type: 'setCount', count: 12 }, live());
    const v = derive(wider, live());
    expect(v.spacing).toBeCloseTo(KS28_W, 9);
    expect(v.overall).toBeCloseTo(12 * KS28_W, 9);

    const spaced = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, live());
    expect(derive(spaced, live()).spacing).toBeLessThan(1.5);
  });

  it('lets a typed pitch break straight back out of it', () => {
    // The end-fire "Use it" button sets a spacing, and it has to be obeyed
    // rather than silently swallowed by the pinned pitch.
    const out = run(touching, { type: 'setSpacing', metres: 1.36 }, live());
    const v = derive(out, live());
    expect(v.touching).toBe(false);
    expect(v.spacing).toBeCloseTo(1.36, 9);
  });

  it('does not resurrect a footprint frozen under the old rule', () => {
    const frozen = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 12 }, live());
    expect(frozen.edit.overall).toBeDefined();
    const off = run(frozen, { type: 'setSpanMode', mode: 'touching' }, live());
    expect(off.edit.overall).toBeUndefined();
    expect(derive(off, live()).overall).toBeCloseTo(12 * KS28_W, 9);
  });

  it('is not offered without a confirmed cabinet width', () => {
    const noWidth = live({ publishedWidthM: 0 });
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setSpanMode', mode: 'touching' }, noWidth), noWidth);
    expect(v.canTouch).toBe(false);
    expect(v.touching).toBe(false);
    expect(v.spacing).toBeCloseTo(1.5, 9);
  });

  it('describes a vertical stack too, since those always touch', () => {
    const H = 0.571;
    const column = live({ axis: 'z', count: 4, spacing: H, publishedHeightM: H });
    const v = derive(INITIAL_ARRAY_MODULE, column);
    expect(v.touching).toBe(true);
    expect(v.vertical).toBe(true);
  });
});

describe('anchoring a horizontal block to an edge', () => {
  // The default module: 8 cabinets at 1.5 m centred on 0, so the block is
  // 7 * 1.5 + 1.34 = 11.84 m wide and its left face sits at -5.92.
  const LIVE_OVERALL = 7 * 1.5 + KS28_W;
  const LEFT = -LIVE_OVERALL / 2;
  const left = (from = INITIAL_ARRAY_MODULE) => run(from, { type: 'setAnchor', anchor: 'low' }, live());
  const leftEdge = (v: { centre: number; overall: number }) => v.centre - v.overall / 2;
  const rightEdge = (v: { centre: number; overall: number }) => v.centre + v.overall / 2;

  it('defaults to the centre, so nothing changes for anyone who ignores it', () => {
    const v = derive(INITIAL_ARRAY_MODULE, live());
    expect(v.anchor).toBe('centre');
    expect(v.refA).toBeCloseTo(v.centre, 9);
    expect(v.centre).toBeCloseTo(live().centre, 9);
  });

  it('reads the edge off the block that is actually on the canvas', () => {
    expect(derive(left(), live()).refA).toBeCloseTo(LEFT, 9);
    const right = run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor: 'high' }, live());
    expect(derive(right, live()).refA).toBeCloseTo(-LEFT, 9);
  });

  it('does not move the cabinets when the anchor changes', () => {
    const before = derive(INITIAL_ARRAY_MODULE, live());
    for (const anchor of ['low', 'high', 'centre'] as const) {
      const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor }, live()), live());
      expect(v.centre).toBeCloseTo(before.centre, 9);
      expect(leftEdge(v)).toBeCloseTo(leftEdge(before), 9);
    }
  });

  it('holds the left edge and grows right when the footprint is widened', () => {
    const wider = run(left(), { type: 'setOverall', metres: 20 }, live());
    const v = derive(wider, live());
    expect(leftEdge(v)).toBeCloseTo(LEFT, 9);
    expect(rightEdge(v)).toBeCloseTo(LEFT + 20, 9);
  });

  it('holds the right edge and grows left instead, when anchored that way', () => {
    const right = run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor: 'high' }, live());
    const v = derive(run(right, { type: 'setOverall', metres: 20 }, live()), live());
    expect(rightEdge(v)).toBeCloseTo(-LEFT, 9);
    expect(leftEdge(v)).toBeCloseTo(-LEFT - 20, 9);
  });

  it('still grows symmetrically about the centre by default', () => {
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setOverall', metres: 20 }, live()), live());
    expect(v.centre).toBeCloseTo(0, 9);
    expect(leftEdge(v)).toBeCloseTo(-10, 9);
  });

  it('holds the anchored edge while a touching block gets longer', () => {
    // The two features together: boxes against boxes, growing out of one end.
    // This is what building a wall from the stage-left edge looks like.
    const wall = run(left(), { type: 'setSpanMode', mode: 'touching' }, live());
    const before = derive(wall, live());
    expect(leftEdge(before)).toBeCloseTo(LEFT, 9);

    const v = derive(run(wall, { type: 'setCount', count: 12 }, live()), live());
    expect(leftEdge(v)).toBeCloseTo(LEFT, 9);
    expect(v.overall).toBeCloseTo(12 * KS28_W, 9);
    expect(rightEdge(v)).toBeCloseTo(LEFT + 12 * KS28_W, 9);
  });

  it('puts the block where the edge is typed', () => {
    const v = derive(run(left(), { type: 'setRefA', metres: 4 }, live()), live());
    expect(leftEdge(v)).toBeCloseTo(4, 9);
    expect(v.centre).toBeCloseTo(4 + LIVE_OVERALL / 2, 9);
  });

  it('is not offered without a confirmed cabinet width', () => {
    // No width means no outer face, and anchoring to the outermost cabinet
    // CENTRE would build in the half-a-box error the faces exist to avoid.
    const noWidth = live({ publishedWidthM: 0 });
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor: 'low' }, noWidth), noWidth);
    expect(v.canAnchor).toBe(false);
    expect(v.anchor).toBe('centre');
    expect(v.centre).toBeCloseTo(noWidth.centre, 9);
  });

  it('leaves vertical stacks to their mount', () => {
    const H = 0.571;
    const column = live({ axis: 'z', count: 4, spacing: H, centre: 2 * H, publishedHeightM: H });
    const anchored = run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor: 'high' }, column);
    const v = derive(anchored, column);
    expect(v.canAnchor).toBe(false);
    expect(v.stackBottomM).toBeCloseTo(0, 9);
    expect(v.refZ).toBeCloseTo(0, 9);
  });
});

describe('growing a single cabinet into an array', () => {
  // One cabinet on the canvas, which is where every first array starts. Its
  // measured pitch is 0 and its footprint is its own width, so the frozen-width
  // rule had nothing real to redistribute and handed six cabinets a pitch of 0.
  const one = (over: Partial<ArrayModuleLive> = {}) => live({ count: 1, spacing: 0, ...over });

  it('spaces the cabinets instead of landing them all on one point', () => {
    const l = one();
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 6 }, l), l);

    expect(v.count).toBe(6);
    // cabinet against cabinet: the tightest layout that is physically real
    expect(v.spacing).toBeCloseTo(KS28_W, 9);
    expect(v.overall).toBeCloseTo(6 * KS28_W, 9);
    expect(v.plannedSpan).toBeCloseTo(5 * KS28_W, 9);
  });

  it('does not freeze a footprint that is one cabinet wide', () => {
    expect(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 6 }, one()).edit.overall).toBeUndefined();
  });

  it('still obeys a pitch or a footprint the operator types', () => {
    const l = one();
    const grown = run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 6 }, l);

    expect(derive(run(grown, { type: 'setSpacing', metres: 2 }, l), l).spacing).toBeCloseTo(2, 9);
    expect(derive(run(grown, { type: 'setOverall', metres: 20 }, l), l).spacing).toBeCloseTo(
      (20 - KS28_W) / 5,
      9,
    );
  });

  it('has nothing to fall back on when the cabinet width is unknown', () => {
    // The fallback pitch IS the cabinet width, so without one there is no pitch
    // to offer and the spacing field has to lead. Pinned rather than papered
    // over: inventing a box size here is exactly what this project refuses.
    const l = one({ publishedWidthM: 0 });
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 6 }, l), l);

    expect(v.canDeriveSpacing).toBe(false);
    expect(v.spacing).toBe(0);
  });

  it('leaves a vertical stack to the mount, as before', () => {
    const H = 0.571;
    const column = one({ axis: 'z', publishedHeightM: H, centre: H / 2 });
    const v = derive(run(INITIAL_ARRAY_MODULE, { type: 'setCount', count: 4 }, column), column);
    expect(v.spacing).toBeCloseTo(H, 9);
    expect(v.stackBottomM).toBeCloseTo(0, 9);
  });
});

describe('changing the layout axis', () => {
  it('drops the coordinates that were typed against the old axis', () => {
    // A line along X at y = 24. "Position Z = 1.2" is a Z coordinate; set the
    // layout axis to Z and the same field is now labelled Y, so applying the
    // layout would move the array from y = 24 to y = 1.2.
    const l = live({ posB: 0, posC: 24 });
    let s: ArrayModuleState = run(INITIAL_ARRAY_MODULE, { type: 'setGeom', field: 'posC', value: 1.2 }, l);
    s = run(s, { type: 'setGeom', field: 'centre', value: 5 }, l);
    s = run(s, { type: 'setCount', count: 6 }, l);

    const next = run(s, { type: 'setAxis', axis: 'z' }, l);

    expect(next.axisOverride).toBe('z');
    expect(next.edit.posC).toBeUndefined();
    expect(next.edit.centre).toBeUndefined();
    // the magnitudes mean the same thing on any axis, so they survive
    expect(next.edit.count).toBe(6);
  });

  it('drops the anchored edge and the stack height for the same reason', () => {
    const l = live();
    let s: ArrayModuleState = run(INITIAL_ARRAY_MODULE, { type: 'setAnchor', anchor: 'low' }, l);
    s = run(s, { type: 'setRefA', metres: 4 }, l);
    s = run(s, { type: 'setRefZ', metres: 9 }, l);

    const next = run(s, { type: 'setAxis', axis: 'y' }, l);
    expect(next.edit.refA).toBeUndefined();
    expect(next.edit.refZ).toBeUndefined();
  });

  it('keeps them when the axis is only pinned to the one already in force', () => {
    // Nothing about the coordinates changes meaning, so nothing is dropped.
    const l = live({ axis: 'x' });
    const s = run(INITIAL_ARRAY_MODULE, { type: 'setGeom', field: 'posC', value: 1.2 }, l);
    const next = run(s, { type: 'setAxis', axis: 'x' }, l);

    expect(next.axisOverride).toBe('x');
    expect(next.edit.posC).toBe(1.2);
  });
});

describe('a live steering session is one undo entry', () => {
  const l = live();

  it('opens the entry on the first write and stays inside it after that', () => {
    let s = run(INITIAL_ARRAY_MODULE, { type: 'setBeamWidth', deg: 60 }, l);
    expect(s.liveWrote).toBe(false); // so this write carries the snapshot

    s = run(s, { type: 'liveApplied' }, l);
    expect(s.liveWrote).toBe(true);

    // every settling point of the rest of the drag lands in the same entry
    s = run(s, { type: 'setBeamWidth', deg: 55 }, l);
    expect(s.liveWrote).toBe(true);
  });

  it('starts a new one after a deliberate apply, which took its own', () => {
    const wrote: ArrayModuleState = { ...INITIAL_ARRAY_MODULE, liveWrote: true };
    expect(run(wrote, { type: 'armed' }, l).liveWrote).toBe(false);
    expect(run(wrote, { type: 'moduleChanged' }, l).liveWrote).toBe(false);
  });
});

describe('the pattern-control limit describes the array, not the panel default', () => {
  it('quotes no aim until a steering field is touched', () => {
    expect(aimForPatternLimit(INITIAL_ARRAY_MODULE)).toEqual({ steerDeg: 0, dispersionDeg: 0 });
  });

  it('reports 229 Hz for a 1.5 m array, not the 139 Hz of an unapplied 80 arc', () => {
    const fresh = aimForPatternLimit(INITIAL_ARRAY_MODULE);
    expect(patternControlLimitHz(1.5, 343, fresh.steerDeg, fresh.dispersionDeg)).toBeCloseTo(228.7, 1);
  });

  it('quotes the aim once one is dialled in', () => {
    const l = live();
    expect(aimForPatternLimit(run(INITIAL_ARRAY_MODULE, { type: 'setBeamWidth', deg: 80 }, l))).toEqual({
      steerDeg: 0,
      dispersionDeg: 80,
    });
    const steered = run({ ...INITIAL_ARRAY_MODULE, mode: 'steer' }, { type: 'setSteer', deg: 30 }, l);
    expect(aimForPatternLimit(steered)).toEqual({ steerDeg: 30, dispersionDeg: 0 });
  });
});

describe('the fan and the tilt', () => {
  const aimed = (x: number, azimuthDeg: number, elevationDeg = 0) =>
    src({
      id: `s${x}`,
      position: { x, y: 0, z: 0 },
      rotation: { azimuthDeg, elevationDeg, rollDeg: 0 },
    });

  it('reads the fan off the cabinets instead of always showing 0', () => {
    const fanned = [aimed(-2, -15), aimed(0, 0), aimed(2, 15)];
    const l = measure(fanned, 'x', { publishedWidthM: KS28_W });

    expect(l.splay).toBeCloseTo(30, 9);
    expect(derive(INITIAL_ARRAY_MODULE, l).splay).toBeCloseTo(30, 9);
  });

  it('offers nothing to WRITE until one is typed', () => {
    // What the fields show is a reading. Applying a layout must not hand that
    // reading back as an instruction, or every rebuild re-aims the cabinets.
    const l = live({ splay: 30, elevation: -4 });
    const v = derive(INITIAL_ARRAY_MODULE, l);
    expect([v.splay, v.elevation]).toEqual([30, -4]);
    expect([v.splayTyped, v.elevationTyped]).toEqual([null, null]);

    let s = run(INITIAL_ARRAY_MODULE, { type: 'setGeom', field: 'splay', value: 0 }, l);
    s = run(s, { type: 'setGeom', field: 'elevation', value: -6 }, l);
    const w = derive(s, l);
    // a typed 0 is an instruction to unfan the block, not the absence of one
    expect(w.splayTyped).toBe(0);
    expect(w.elevationTyped).toBe(-6);
  });
});
