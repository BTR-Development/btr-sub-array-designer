/**
 * Several cabinets at ONE position: ten places on the deck with four subs on
 * top of each other at each of them, the bottom one turned round.
 *
 * Two things in this file were latent bugs before the grid existed, and they
 * are the reason it is not just a loop. A position is not a cabinet, so every
 * number derived from "how many" — pitch, footprint, pattern-control limit —
 * had to learn the difference; and a rig that deliberately contains cabinets
 * facing backwards breaks every measurement that assumed one heading.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  axisPositions,
  cabinetsPerPosition,
  countPositions,
  currentSpacing,
  detectAxis,
  dominantAzimuth,
  layoutSources,
  measureReversal,
  planDelays,
  reversedFlags,
} from './arrayTools';
import {
  arrayModuleReducer,
  derive,
  forwardAzimuthOf,
  INITIAL_ARRAY_MODULE,
  measure,
  orientationOf,
  reverseDelayOffsets,
} from './arrayModule';
import type { ArrayModuleState } from './arrayModule';
import { useStore } from './store';
import { orientedDimensions } from '../speakers/schema';
import { builtinProvider } from '../speakers/provider';
import type { Source } from '../core/types';

const st = () => useStore.getState();
const KS21 = () => {
  const m = builtinProvider.get('la-ks21');
  if (!m) throw new Error('the KS21 record is gone');
  return m;
};
const H = () => orientedDimensions(KS21(), 0).heightM!;

const src = (over: Partial<Source> = {}): Source => ({
  id: over.id ?? 's',
  label: over.label ?? 'SUB',
  speakerId: 'la-ks21',
  position: { x: 0, y: 0, z: 0 },
  rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
  levelDb: 0,
  delayS: 0,
  invertPolarity: false,
  mute: false,
  groupId: null,
  ...over,
});

/** A grid of `n` positions x `per` cabinets, as the layout tool would build it. */
const grid = (n: number, per: number, spacing = 1, h = 0.571): Source[] => {
  const out: Source[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < per; j++) {
      out.push(
        src({
          id: `s${i}_${j}`,
          position: { x: i * spacing, y: 0, z: h / 2 + j * h },
        }),
      );
    }
  }
  return out;
};

describe('a position is not a cabinet', () => {
  it('counts the places on the deck, not the boxes standing on them', () => {
    const g = grid(10, 4);
    expect(g).toHaveLength(40);
    expect(axisPositions(g, 'x')).toHaveLength(10);
    expect(countPositions(g, 'x')).toBe(10);
    expect(cabinetsPerPosition(g, 'x')).toBe(4);
  });

  it('measures the pitch between positions and not across the cabinets', () => {
    // Forty cabinets across 9 m of deck: per cabinet that reads 9/39 = 0.23 m,
    // which is not a spacing anybody taped out, and the pattern-control limit
    // quoted from it is four times too high.
    expect(currentSpacing(grid(10, 4, 1), 'x')).toBeCloseTo(1, 9);
    expect(currentSpacing(grid(10, 1, 1), 'x')).toBeCloseTo(1, 9);
  });

  it('refuses to average a rig that does not divide evenly', () => {
    const uneven = [...grid(2, 2), src({ id: 'extra', position: { x: 0, y: 0, z: 2 } })];
    expect(countPositions(uneven, 'x')).toBe(2);
    expect(cabinetsPerPosition(uneven, 'x')).toBeNull();
  });
});

describe('finding the way a rig faces when some of it faces backwards', () => {
  it('takes the heading most of the cabinets share, not the mean of them', () => {
    const rig = [
      src({ id: 'a', rotation: { azimuthDeg: 180, elevationDeg: 0, rollDeg: 0 } }),
      src({ id: 'b' }),
      src({ id: 'c' }),
      src({ id: 'd' }),
    ];
    // The mean of 180, 0, 0, 0 is 45, which is a heading nothing in the rig has.
    expect(dominantAzimuth(rig)).toBe(0);
    expect(reversedFlags(rig)).toEqual([true, false, false, false]);
  });

  it('breaks an even split toward the audience rather than toward the first box', () => {
    // Ten positions of two with the bottom one reversed is exactly half and
    // half, and the first cabinet in the list is one of the REVERSED ones.
    // Settled by the first cabinet, an Apply layout would turn the whole rig
    // round, and the press after that would turn it back.
    const rig = [
      src({ id: 'a', rotation: { azimuthDeg: 180, elevationDeg: 0, rollDeg: 0 } }),
      src({ id: 'b' }),
    ];
    expect(dominantAzimuth(rig)).toBe(0);
    expect(reversedFlags(rig)).toEqual([true, false]);
  });

  it('does not mistake a wide fan for a cabinet turned round', () => {
    const fanned = [
      src({ id: 'a', rotation: { azimuthDeg: -40, elevationDeg: 0, rollDeg: 0 } }),
      src({ id: 'b', rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 } }),
      src({ id: 'c', rotation: { azimuthDeg: 40, elevationDeg: 0, rollDeg: 0 } }),
    ];
    expect(reversedFlags(fanned)).toEqual([false, false, false]);
  });
});

describe('laying out positions of stacked cabinets', () => {
  const build = (opts: Partial<Parameters<typeof layoutSources>[1]> = {}, members: Source[] = []) => {
    let n = 0;
    return layoutSources(
      members,
      {
        count: 10,
        spacingM: 1,
        axis: 'x',
        centreM: 0,
        cross: { y: 0, z: (4 * 0.571) / 2 },
        perPosition: 4,
        stackPitchM: 0.571,
        template: src({ id: 'tpl' }),
        ...opts,
      },
      () => `id${n++}`,
      (i) => `SUB ${i + 1}`,
    );
  };

  it('produces positions x cabinets, position-major and bottom-up', () => {
    const out = build();
    expect(out).toHaveLength(40);
    // the first four share an x and climb in z
    const first = out.slice(0, 4);
    expect(new Set(first.map((s) => s.position.x.toFixed(6))).size).toBe(1);
    const zs = first.map((s) => s.position.z);
    expect(zs[0]).toBeCloseTo(0.2855, 6);
    for (let i = 1; i < 4; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(0.571, 9);
    // and the fifth starts the next position
    expect(out[4].position.x).not.toBeCloseTo(out[0].position.x, 6);
    expect(out[4].position.z).toBeCloseTo(zs[0], 9);
  });

  it('turns the named end round, inverts it and delays it', () => {
    const out = build({ reverseAt: 'bottom', forwardAzimuthDeg: 0 });
    const pos = out.slice(0, 4);
    expect(pos[0].rotation.azimuthDeg).toBe(180);
    expect(pos[0].invertPolarity).toBe(true);
    // and NOT a delay: the layout does not write one. The delay column has a
    // single owner, the plan, and an assignment here replaced the reversed
    // cabinet's steering delay with a flat gradient figure on every press.
    expect(pos[0].delayS).toBe(0);
    for (const forward of pos.slice(1)) {
      expect(forward.rotation.azimuthDeg).toBe(0);
      // A reverse stack in which everything is inverted is not a reverse stack.
      expect(forward.invertPolarity).toBe(false);
    }
  });

  it('reverses from the top when asked, and as many as asked', () => {
    const out = build({ reverseAt: 'top', reverseCount: 2, forwardAzimuthDeg: 0 });
    const pos = out.slice(0, 4);
    expect(pos.map((p) => p.rotation.azimuthDeg)).toEqual([0, 0, 180, 180]);
  });

  it('never turns every cabinet of a position round', () => {
    // That is not a gradient, it is the rig pointing upstage, and it has no
    // forward group left to cancel against.
    const out = build({ reverseAt: 'bottom', reverseCount: 9, forwardAzimuthDeg: 0 });
    const pos = out.slice(0, 4);
    expect(pos.filter((p) => p.invertPolarity)).toHaveLength(3);
    expect(pos[3].rotation.azimuthDeg).toBe(0);
  });

  it('survives being applied twice', () => {
    // The forward heading has to come from the MODULE. Read off each cabinet, a
    // second press would add another half turn to the box that was already
    // round and hand it back to the front.
    const once = build({ reverseAt: 'bottom', forwardAzimuthDeg: 0 });
    const twice = build(
      { reverseAt: 'bottom', forwardAzimuthDeg: dominantAzimuth(once) },
      once,
    );
    expect(twice).toHaveLength(40);
    expect(twice.map((s) => s.rotation.azimuthDeg)).toEqual(once.map((s) => s.rotation.azimuthDeg));
    expect(twice.map((s) => s.invertPolarity)).toEqual(once.map((s) => s.invertPolarity));
    expect(twice[0].rotation.azimuthDeg).toBe(180);
  });

  it('says nothing about headings or polarity when the option is omitted', () => {
    const hand = grid(10, 4).map((s, i) =>
      i === 0
        ? { ...s, invertPolarity: true, rotation: { ...s.rotation, azimuthDeg: 17 } }
        : s,
    );
    const out = build({}, hand);
    expect(out[0].invertPolarity).toBe(true);
    expect(out[0].rotation.azimuthDeg).toBe(17);
  });

  it("straightens the rig when the option says 'none'", () => {
    // 'none' is an instruction, not silence. Without the distinction, setting
    // the control back to None left boxes pointing upstage, inverted, inside
    // what the panel was now calling a plain row.
    const reversed = build({ reverseAt: 'bottom', forwardAzimuthDeg: 0 });
    expect(reversed[0].rotation.azimuthDeg).toBe(180);
    const straight = build({ reverseAt: 'none', forwardAzimuthDeg: 0 }, reversed);
    expect(straight.every((c) => c.rotation.azimuthDeg === 0)).toBe(true);
    expect(straight.every((c) => !c.invertPolarity)).toBe(true);
  });

  it('writes the roll onto every cabinet when one is chosen', () => {
    const out = build({ rollDeg: 90 });
    expect(out.every((s) => s.rotation.rollDeg === 90)).toBe(true);
    // and leaves it alone when it is not
    expect(build({}).every((s) => s.rotation.rollDeg === 0)).toBe(true);
  });

  it('does not stack a column, which already is one', () => {
    const out = build({ axis: 'z', perPosition: 4, count: 4 });
    expect(out).toHaveLength(4);
  });
});

describe('steering a rig that contains a gradient', () => {
  it('adds the gradient delay to the aim instead of replacing it', () => {
    const members = grid(4, 1, 1.5);
    const extra = [0.00175, 0, 0, 0.00175];
    const plain = planDelays(members, {
      mode: 'steer',
      steerDeg: 20,
      dispersionDeg: 0,
      axis: 'x',
      speedOfSound: 343,
    });
    const composed = planDelays(members, {
      mode: 'steer',
      steerDeg: 20,
      dispersionDeg: 0,
      axis: 'x',
      speedOfSound: 343,
      extraDelaysS: extra,
    });
    for (let i = 0; i < members.length; i++) {
      expect(composed.delaysS[i]).toBeCloseTo(plain.delaysS[i] + extra[i], 12);
    }
    // the spread the panel reports is the spread of what will be written
    expect(composed.maxDelayS).toBeCloseTo(Math.max(...composed.delaysS), 12);
  });
});

describe('what the editor offers over a stacked rig', () => {
  const state = (over: Partial<ArrayModuleState> = {}): ArrayModuleState => ({
    ...INITIAL_ARRAY_MODULE,
    ...over,
  });

  it('turns the Z field into a face, both ways round', () => {
    const g = grid(10, 4);
    const live = measure(g, 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571 });
    const v = derive(state({ edit: { perPosition: 4 } }), live);
    expect(v.perPosition).toBe(4);
    expect(v.cabinets).toBe(40);
    // the rig is on the deck, so the field reads 0 and not the column centre
    expect(v.posC).toBeCloseTo(0, 6);
    expect(v.stackCentreZ).toBeCloseTo((4 * 0.571) / 2, 6);
    // flown by its top instead, the same rig reads its top face
    const flying = derive(state({ mount: 'flying', edit: { perPosition: 4 } }), live);
    expect(flying.posC).toBeCloseTo(4 * 0.571, 6);
    expect(flying.stackCentreZ).toBeCloseTo((4 * 0.571) / 2, 6);
  });

  it('withholds stacking when there is no confirmed height to stack by', () => {
    const live = measure(grid(10, 1), 'x', { publishedWidthM: 0.764, publishedHeightM: 0 });
    const v = derive(state({ edit: { perPosition: 4 } }), live);
    expect(v.canStack).toBe(false);
    // the edit is ignored, because the control was never on offer...
    expect(v.perPosition).toBe(1);
    expect(v.reverseAt).toBe('none');
  });

  it('keeps a rig that is already stacked even when it cannot offer the control', () => {
    // ...but what the rig HAS is preserved, measured pitch and all. Collapsing
    // it to one per position made `count * perPosition` smaller than the rig,
    // and one Apply layout deleted the difference with no confirmation.
    const live = measure(grid(10, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0 });
    const v = derive(state(), live);
    expect(v.perPosition).toBe(4);
    expect(v.cabinets).toBe(40);
    expect(v.stackPitchM).toBeCloseTo(0.571, 6);
  });

  it('never plans fewer cabinets than the rig has, for any shape, untouched', () => {
    // The invariant behind the two tests above. An editor nobody has touched
    // must never produce a layout that deletes a cabinet.
    const shapes: Array<[number, number, number]> = [
      [10, 4, 0.571], [10, 4, 0], [2, 4, 0.571], [3, 4, 0.571],
      [1, 4, 0.571], [6, 1, 0.571], [1, 1, 0.571],
    ];
    for (const [n, per, h] of shapes) {
      const g = grid(n, per);
      const live = measure(g, 'x', { publishedWidthM: 0.764, publishedHeightM: h });
      const v = derive(state(), live);
      expect(v.cabinets, `${n}x${per} h=${h}`).toBe(g.length);
    }
    // and an uneven rig, which has no cabinets-per-position at all
    const uneven = [...grid(3, 2), src({ id: 'x', position: { x: 0, y: 0, z: 3 } })];
    const v = derive(state(), measure(uneven, 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571 }));
    expect(v.cabinets).toBe(uneven.length);
  });

  it('withholds the reversal when the cabinet publishes no depth', () => {
    // No depth, no separation; no separation, no gradient. Offering the control
    // would mean a delay of zero and a rejection figure describing nothing.
    const v = derive(
      state({ pendingReverseAt: 'bottom', edit: { perPosition: 4 } }),
      measure(grid(10, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0 }),
    );
    expect(v.canReverse).toBe(false);
    expect(v.reverseAt).toBe('none');
  });

  it('drops the reversal when a position is back to a single cabinet', () => {
    const live = measure(grid(10, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601 });
    const after = arrayModuleReducer(
      state({ pendingReverseAt: 'bottom', edit: { perPosition: 4 } }),
      { type: 'setPerPosition', count: 1 },
      live,
    );
    expect(after.pendingReverseAt).toBe('none');
  });

  it('reports the ceiling the ratio puts on rear rejection', () => {
    const live = measure(grid(10, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601 });
    const three = derive(state({ pendingReverseAt: 'bottom', pendingReverseCount: 1, edit: { perPosition: 4 } }), live);
    expect(three.forwardCount).toBe(3);
    expect(three.reverseCount).toBe(1);
    expect(three.rejectionCeilingDb).toBeCloseTo(6.02, 2);
    const matched = derive(state({ pendingReverseAt: 'bottom', pendingReverseCount: 2, edit: { perPosition: 4 } }), live);
    expect(three.canReverse).toBe(true);
    expect(matched.forwardCount).toBe(2);
    expect(matched.rejectionCeilingDb).toBeNull();
  });
});

describe('the store builds the rig end to end', () => {
  beforeEach(() => {
    st().newProject();
    useStore.setState({ undoStack: [], redoStack: [] });
  });

  it('turns one cabinet into ten positions of four with the bottom reversed', () => {
    st().addSource('la-ks21', { x: 0, y: 0, z: 0 });
    const h = H();
    st().applyArrayLayout(
      st().sources.map((x) => x.id),
      {
        count: 10,
        spacingM: 1,
        axis: 'x',
        centreM: 0,
        cross: { y: 0, z: (4 * h) / 2 },
        perPosition: 4,
        stackPitchM: h,
        reverseAt: 'bottom',
        forwardAzimuthDeg: 0,
          speakerId: 'la-ks21',
      },
    );
    const s = st();
    expect(s.sources).toHaveLength(40);
    expect(new Set(s.sources.map((x) => x.label)).size).toBe(40);
    expect(countPositions(s.sources, 'x')).toBe(10);
    expect(s.sources.filter((x) => x.invertPolarity)).toHaveLength(10);
    // every reversed cabinet is the bottom of its position
    for (const rev of s.sources.filter((x) => x.invertPolarity)) {
      expect(rev.position.z).toBeCloseTo(h / 2, 6);
      expect(rev.rotation.azimuthDeg).toBe(180);
    }
  });

  it('clones new cabinets from a forward one, not from the turned-round one', () => {
    // The first member of a reverse-stack rig is the box with the gradient
    // delay on it. Cloned as the template, every cabinet the rig grew by
    // carried a delay only the reversed box is supposed to have.
    st().addSource('la-ks21', { x: 0, y: 0, z: 0.2855 });
    const h = H();
    const opts = {
      spacingM: 1,
      axis: 'x' as const,
      centreM: 0,
      cross: { y: 0, z: (4 * h) / 2 },
      perPosition: 4,
      stackPitchM: h,
      reverseAt: 'bottom' as const,
      forwardAzimuthDeg: 0,
      speakerId: 'la-ks21',
    };
    st().applyArrayLayout(st().sources.map((x) => x.id), { ...opts, count: 2 });
    expect(st().sources).toHaveLength(8);
    // Give the turned-round box at the bottom of position 1 a hand-set delay
    // and trim. Cloned as the template, every cabinet the rig grows by carries
    // settings that belong to one specific cabinet.
    const bottom = st().sources.find((x) => x.invertPolarity)!;
    st().patchSources([bottom.id], { delayS: 0.0042, levelDb: -7 });

    st().applyArrayLayout(st().sources.map((x) => x.id), { ...opts, count: 4 });
    const s = st();
    expect(s.sources).toHaveLength(16);
    const grown = s.sources.filter((x) => !x.invertPolarity);
    expect(grown).toHaveLength(12);
    for (const f of grown) {
      expect(f.delayS).toBeCloseTo(0, 12);
      expect(f.levelDb).toBe(0);
    }
  });
});

/**
 * The second round. Every case below is a defect the first implementation
 * shipped and an adversarial review found, which is why each one names what it
 * used to do.
 */
describe('describing a rig must never move it', () => {
  const state = (over: Partial<ArrayModuleState> = {}): ArrayModuleState => ({
    ...INITIAL_ARRAY_MODULE,
    ...over,
  });
  /** 10 positions of 4 KS21 standing on the deck: bottom face at z = 0. */
  const onTheDeck = () => measure(grid(10, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601 });

  it('reads the deck height of a rig that is on the deck, whatever roll is pending', () => {
    const live = onTheDeck();
    expect(derive(state({ edit: { perPosition: 4 } }), live).posC).toBeCloseTo(0, 9);
    // Choosing "On end" must not change where the rig IS. Measured against the
    // pending orientation instead of the held one, this read -0.386 m, and one
    // Apply layout buried the rig that far into the stage.
    const rolled = derive(state({ edit: { perPosition: 4, roll: 90 } }), live);
    expect(rolled.posC).toBeCloseTo(0, 9);
    // ...and the rig it WRITES stands on its end face in a ROW: the pitch is
    // the cabinet's width in that orientation, not its height, and a row is
    // one cabinet tall however many cabinets are in it. Four KS21 on end,
    // stacked, would be a column 3.06 m high, which is not what "On end"
    // means to anybody who has lifted one.
    expect(rolled.stackPitchM).toBeCloseTo(0.571, 9);
    expect(rolled.stackCentreZ).toBeCloseTo(0.764 / 2, 9);
    expect(rolled.acrossM).toBeCloseTo(0.571, 9);
  });

  it('keeps a vertical column on the deck when it is turned on its end face', () => {
    const column = grid(1, 4).map((s) => ({ ...s, position: { ...s.position, x: 0 } }));
    const live = measure(column, 'z', { publishedWidthM: 0.764, publishedHeightM: 0.571 });
    expect(derive(state(), live).refZ).toBeCloseTo(0, 9);
    const rolled = derive(state({ edit: { roll: 90 } }), live);
    expect(rolled.refZ).toBeCloseTo(0, 9);
    expect(rolled.centre).toBeCloseTo((4 * 0.764) / 2, 9);
  });

  it('leaves a row on the deck when a stack is flattened back to one cabinet', () => {
    const live = onTheDeck();
    const after = arrayModuleReducer(state(), { type: 'setPerPosition', count: 1 }, live);
    const v = derive(after, live);
    expect(v.perPosition).toBe(1);
    // The Z field means a cabinet CENTRE again, and the cabinet is on the deck.
    // Read as though it were still a face, the row floated (4-1)*0.571/2 up.
    expect(v.stackCentreZ).toBeCloseTo(0.571 / 2, 9);
  });

  it('does not move a stack when the mount is switched', () => {
    const live = onTheDeck();
    const typed = arrayModuleReducer(state(), { type: 'setGeom', field: 'posC', value: 1 }, live);
    const before = derive(typed, live).stackCentreZ;
    const flown = arrayModuleReducer(typed, { type: 'setMount', mount: 'flying' }, live);
    expect(derive(flown, live).stackCentreZ).toBeCloseTo(before, 9);
    // the number in the box changes instead, because it now names the other face
    expect(derive(flown, live).posC).toBeCloseTo(1 + 4 * 0.571, 9);
  });
});

describe('reading the axis of a rig that is stacked', () => {
  it('calls a line of stacks horizontal however tall the stacks are', () => {
    // 3 positions of 4 touching KS21: 1.53 m across the deck, 1.71 m up. Ranked
    // by raw extent this read as a vertical column, the editor reported four
    // cabinets instead of twelve, and the next Apply layout deleted eight.
    expect(detectAxis(grid(3, 4, 0.764))).toBe('x');
    expect(detectAxis(grid(2, 4, 1))).toBe('x');
    expect(countPositions(grid(3, 4, 0.764), detectAxis(grid(3, 4, 0.764)))).toBe(3);
  });

  it('still calls a column a column', () => {
    const column = grid(1, 6).map((s) => ({ ...s, position: { ...s.position, x: 0 } }));
    expect(detectAxis(column)).toBe('z');
    // and tolerates the drift an imported one carries, with or without a
    // published cabinet size to measure it against
    const drifted = column.map((s, i) => ({
      ...s,
      position: { ...s.position, x: i * 0.005 },
    }));
    expect(detectAxis(drifted)).toBe('z');
    expect(detectAxis(drifted, 0.764)).toBe('z');
  });

  it('calls two positions a grid at any stack depth, which a ratio could not', () => {
    // Two positions of on-end KS21 touching: the spread is exactly one cabinet
    // width, so a threshold scaled to the stack height crossed it from four
    // cabinets up and the editor planned five for a ten-cabinet rig.
    for (const per of [2, 3, 4, 5, 8]) {
      expect(detectAxis(grid(2, per, 0.571), 0.571), `2x${per}`).toBe('x');
    }
  });
});

describe('which cabinets are facing backwards', () => {
  const rig = (azForward: number, per: number, nRev: number, positions = 4) => {
    const out: Source[] = [];
    for (let i = 0; i < positions; i++) {
      for (let j = 0; j < per; j++) {
        const reversed = j < nRev;
        out.push(
          src({
            id: `s${i}_${j}`,
            position: { x: i * 1.2, y: 0, z: 0.2855 + j * 0.571 },
            rotation: {
              azimuthDeg: reversed ? azForward + 180 : azForward,
              elevationDeg: 0,
              rollDeg: 0,
            },
            invertPolarity: reversed,
          }),
        );
      }
    }
    return out;
  };

  it('takes the heading from the end that is not designated, not from a vote', () => {
    // A module aimed across the stage with matched 2+2 stacks: the vote is a
    // tie, and broken either way it was a coin toss. It returned 270 and one
    // Apply delay aimed the rejection at the audience.
    expect(forwardAzimuthOf(rig(90, 4, 2))).toBe(90);
    expect(forwardAzimuthOf(rig(180, 4, 2))).toBe(180);
    // and with MORE reversed than forward, where the majority is simply wrong
    expect(forwardAzimuthOf(rig(0, 4, 3))).toBe(0);
  });

  it('puts the gradient delay only on the cabinets that are actually reversed', () => {
    const r = rig(0, 4, 3);
    const fwd = forwardAzimuthOf(r);
    const offsets = reverseDelayOffsets(r, 0.00175, fwd);
    for (let i = 0; i < r.length; i++) {
      expect(offsets[i], `${r[i].id}`).toBeCloseTo(i % 4 < 3 ? 0.00175 : 0, 9);
    }
  });

  it('gives no gradient delay to a cabinet with nothing to form a gradient with', () => {
    // Six main subs downstage plus two rear-fills turned round 25 m upstage:
    // no reverse stack anywhere. One flat Apply delay used to write 1.75 ms of
    // delay the rear-fills must not have.
    const main = Array.from({ length: 6 }, (_, i) =>
      src({ id: `m${i}`, position: { x: i * 1.2, y: 0, z: 0.2855 } }),
    );
    const fills = Array.from({ length: 2 }, (_, i) =>
      src({
        id: `f${i}`,
        position: { x: i * 1.2, y: -25, z: 0.2855 },
        rotation: { azimuthDeg: 180, elevationDeg: 0, rollDeg: 0 },
      }),
    );
    const all = [...main, ...fills];
    expect(reverseDelayOffsets(all, 0.00175, forwardAzimuthOf(all))).toEqual(all.map(() => 0));
  });
});

describe('the small rules the controls depend on', () => {
  const state = (over: Partial<ArrayModuleState> = {}): ArrayModuleState => ({
    ...INITIAL_ARRAY_MODULE,
    ...over,
  });

  it('reads a roll the other way round as the same orientation', () => {
    expect(orientationOf(0)).toBe(0);
    expect(orientationOf(90)).toBe(90);
    // -90 % 180 is -90 in JavaScript, so the control matched neither button and
    // pressing "On end" on such a cabinet added a further half turn.
    expect(orientationOf(-90)).toBe(90);
    expect(orientationOf(270)).toBe(90);
    // upside down is still upright, because the extents are unchanged
    expect(orientationOf(180)).toBe(0);
    expect(orientationOf(-180)).toBe(0);
  });

  it('says when a reversal is being built out of an already directional box', () => {
    const live = measure(grid(4, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601, isCardioid: true });
    const v = derive(state({ pendingReverseAt: 'bottom', pendingReverseCount: 2, edit: { perPosition: 4 } }), live);
    // Four analytic cardioids in a column measure 74 dB front to back; the same
    // four as a 2+2 reverse stack measure 0.0 dB and lose 6 dB forward.
    expect(v.reversingACardioid).toBe(true);
    const omni = measure(grid(4, 4), 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601, isCardioid: false });
    expect(derive(state({ pendingReverseAt: 'bottom', edit: { perPosition: 4 } }), omni).reversingACardioid)
      .toBe(false);
  });

  it('keeps each cabinet in its own position when a stack is deepened', () => {
    // Matched by a flat running index, member k went to position floor(k/per),
    // so deepening a position shuffled the rig: cabinets kept their label,
    // level and delay and swapped physical place, and two interleaved modules
    // ended up spliced through each other.
    const two = grid(3, 2).map((s, i) => ({ ...s, label: `L${i}`, levelDb: -i }));
    let n = 0;
    const three = layoutSources(
      two,
      {
        count: 3,
        spacingM: 1,
        axis: 'x',
        centreM: 1,
        cross: { y: 0, z: (3 * 0.571) / 2 },
        perPosition: 3,
        stackPitchM: 0.571,
        template: two[0],
      },
      () => `new${n++}`,
      (i) => `N${i}`,
    );
    expect(three).toHaveLength(9);
    // the two cabinets that were at position 1 are still at position 1
    const atPos1 = three.filter((c) => Math.abs(c.position.x - 1) < 1e-9);
    expect(atPos1.map((c) => c.label).filter((l) => l.startsWith('L')).sort()).toEqual(['L2', 'L3']);
  });
});

/**
 * The third round. The second round's fixes introduced two blockers of their
 * own, both from the same hole: the editor had no measurement of the reversal
 * the rig already had, so a control that was only ever an instruction kept
 * describing a rig it had never looked at.
 */
describe('the reversal a rig already has', () => {
  const state = (over: Partial<ArrayModuleState> = {}): ArrayModuleState => ({
    ...INITIAL_ARRAY_MODULE,
    ...over,
  });
  /** positions x (nRev reversed at the bottom + the rest forward) */
  const built = (positions: number, per: number, nRev: number, az = 0) => {
    const out: Source[] = [];
    for (let i = 0; i < positions; i++) {
      for (let j = 0; j < per; j++) {
        const rev = j < nRev;
        out.push(
          src({
            id: `s${i}_${j}`,
            position: { x: i * 1.2, y: 0, z: 0.2855 + j * 0.571 },
            rotation: { azimuthDeg: rev ? az + 180 : az, elevationDeg: 0, rollDeg: 0 },
            invertPolarity: rev,
          }),
        );
      }
    }
    return out;
  };
  const facts = { publishedWidthM: 0.764, publishedHeightM: 0.571, gradientSpanM: 0.601 };

  it('is read off the cabinets, not assumed to be none', () => {
    expect(measureReversal(built(4, 4, 2), 'x')).toEqual({
      at: 'bottom',
      count: 2,
      describable: true,
      // Nazwa „dolna” to skrót; prawdą o rigu jest wzór, bo tylko on opisuje
      // też obudowę odwróconą w środku.
      pattern: [true, true, false, false],
    });
    expect(measureReversal(built(4, 4, 0), 'x').at).toBe('none');
    const top = built(4, 4, 0).map((c, i) =>
      i % 4 === 3
        ? { ...c, invertPolarity: true, rotation: { ...c.rotation, azimuthDeg: 180 } }
        : c,
    );
    expect(measureReversal(top, 'x')).toEqual({
      at: 'top', count: 1, describable: true, pattern: [false, false, false, true],
    });
  });

  it('refuses to describe a rig whose positions disagree', () => {
    const mixed = [...built(1, 4, 2), ...built(1, 4, 1).map((c) => ({
      ...c,
      id: `b${c.id}`,
      position: { ...c.position, x: 1.2 },
    }))];
    const r = measureReversal(mixed, 'x');
    expect(r.at).toBe('none');
    expect(r.describable).toBe(false);
    expect(derive(state(), measure(mixed, 'x', facts)).canRebuild).toBe(false);
  });

  it('shows what the rig has and writes only what was asked', () => {
    const live = measure(built(4, 4, 2), 'x', facts);
    const untouched = derive(state(), live);
    expect(untouched.reverseAt).toBe('bottom');
    expect(untouched.reverseCount).toBe(2);
    // ...and WRITES nothing, so an Apply layout over a cardioid somebody built
    // by hand cannot straighten it.
    expect(untouched.reverseAtTyped).toBeNull();
    const asked = derive(state({ pendingReverseAt: 'top' }), live);
    expect(asked.reverseAt).toBe('top');
    expect(asked.reverseAtTyped).toBe('top');
  });

  it('keeps the forward heading off the cabinets when the end is switched', () => {
    // Clicking Bottom -> Top used to read the heading off the cabinets that
    // were still turned round, put the gradient delay on the ones facing the
    // audience, and with live steering armed wrote it 180 ms later.
    const rig = built(4, 4, 2, 90);
    expect(forwardAzimuthOf(rig)).toBe(90);
    const offsets = reverseDelayOffsets(rig, 0.00175, forwardAzimuthOf(rig));
    for (let i = 0; i < rig.length; i++) {
      expect(offsets[i] > 0, rig[i].id).toBe(i % 4 < 2);
    }
  });

  it('keeps the gradient in the hidden field, and the user column untouched', () => {
    const rig = built(2, 4, 2).map((c, i) => ({ ...c, delayS: 0.001 * i }));
    let n = 0;
    const out = layoutSources(
      rig,
      {
        count: 2,
        spacingM: 1.2,
        axis: 'x',
        centreM: 0.6,
        cross: { y: 0, z: (4 * 0.571) / 2 },
        perPosition: 4,
        stackPitchM: 0.571,
        reverseAt: 'top',
        reverseCount: 2,
        forwardAzimuthDeg: 0,
        reverseDelayS: 0.00175,
        template: rig[2],
      },
      () => `n${n++}`,
      (i) => `N${i}`,
    );
    // The user's own delays survive a reversal flip UNCHANGED — the gradient
    // is not their column's business any more. It lives in the hidden field,
    // absolutely: on the two now-reversed boxes and off the two released ones.
    expect(out.slice(0, 4).map((o) => o.delayS)).toEqual([0.0, 0.001, 0.002, 0.003]);
    expect(out[0].gradientDelayS).toBeUndefined();
    expect(out[1].gradientDelayS).toBeUndefined();
    expect(out[2].gradientDelayS).toBeCloseTo(0.00175, 12);
    expect(out[3].gradientDelayS).toBeCloseTo(0.00175, 12);
  });
});

describe('a rig the editor cannot describe', () => {
  const state = (over: Partial<ArrayModuleState> = {}): ArrayModuleState => ({
    ...INITIAL_ARRAY_MODULE,
    ...over,
  });

  it('is counted in cabinets, measured in cabinets, and not rebuilt', () => {
    // 7 cabinets over 3 positions 1 m apart: a cabinet count beside a POSITION
    // pitch printed a 2.76 m rig as 6.76 m wide and an untouched Apply layout
    // would have spread it to match.
    const uneven = [
      ...grid(2, 2, 1),
      src({ id: 'x1', position: { x: 2, y: 0, z: 0.2855 } }),
      src({ id: 'x2', position: { x: 2, y: 0, z: 0.8565 } }),
      src({ id: 'x3', position: { x: 2, y: 0, z: 1.4275 } }),
    ];
    const live = measure(uneven, 'x', { publishedWidthM: 0.764, publishedHeightM: 0.571 });
    expect(live.count).toBe(7);
    expect(live.perPosition).toBe(1);
    // The pitch is measured over CABINETS to match, so count x spacing still
    // describes the rig that is there: 6 x 0.333 + 0.764 = 2.76 m, not 6.76.
    expect(live.spacing).toBeCloseTo(2 / 6, 9);
    const v = derive(state(), live);
    expect(v.cabinets).toBe(7);
    expect(v.overall).toBeCloseTo(2 + 0.764, 9);
    expect(v.canRebuild).toBe(false);
  });

  it('does not delete half a grid when the axis is forced to Z by hand', () => {
    // The axis control lets an operator override the detection. Pointed at Z,
    // a 2 x 5 grid has five z-positions of two cabinets each, which divides
    // perfectly — so without the axis clause the editor planned 5 x 2 while
    // `layoutSources` forces one cabinet per position on Z and returns 5.
    const g = grid(2, 5, 1.2);
    const live = measure(g, 'z', { publishedWidthM: 0.764, publishedHeightM: 0.571 });
    expect(live.count * live.perPosition).toBe(g.length);
    expect(derive(state(), live).cabinets).toBe(g.length);
  });

  it('counts cabinets per position by uniformity, not by divisibility', () => {
    // 6 over 3 positions divides as 2 each and also as 3 + 2 + 1.
    const lumpy = [
      src({ id: 'a1', position: { x: 0, y: 0, z: 0.3 } }),
      src({ id: 'a2', position: { x: 0, y: 0, z: 0.9 } }),
      src({ id: 'a3', position: { x: 0, y: 0, z: 1.5 } }),
      src({ id: 'b1', position: { x: 1, y: 0, z: 0.3 } }),
      src({ id: 'b2', position: { x: 1, y: 0, z: 0.9 } }),
      src({ id: 'c1', position: { x: 2, y: 0, z: 0.3 } }),
    ];
    expect(cabinetsPerPosition(lumpy, 'x')).toBeNull();
    expect(cabinetsPerPosition(grid(3, 2), 'x')).toBe(2);
  });

  it('never gives a Z layout a stack to convert, so its Y is left alone', () => {
    // On a Z layout the cross axis is Y, and a face-to-centre conversion there
    // would be moving the rig sideways. The guard that makes it impossible is
    // in `measure`: along Z every cabinet IS a position, so perPosition is 1
    // and there is no stack to have faces.
    const column = grid(1, 4).map((s) => ({ ...s, position: { x: 0, y: 3, z: s.position.z } }));
    const live = measure(column, 'z', { publishedWidthM: 0.764, publishedHeightM: 0.571 });
    expect(live.perPosition).toBe(1);
    expect(live.count).toBe(4);
    expect(live.count * live.perPosition).toBe(column.length);
    const v = derive(state(), live);
    expect(v.posC).toBeCloseTo(3, 9);
    expect(v.stackCentreZ).toBeCloseTo(3, 9);
  });

  it('does not move a rig just because another cabinet was picked in the dropdown', () => {
    // `held` comes from the cabinet the rig is MADE of; only what is WRITTEN
    // uses the one chosen in the System dropdown.
    const live = measure(grid(10, 4), 'x', {
      publishedWidthM: 0.764,
      publishedHeightM: 0.571,
      plannedWidthM: 1.34,
      plannedHeightM: 0.76,
    });
    const v = derive(state(), live);
    expect(v.posC).toBeCloseTo(0, 9);
    expect(v.stackPitchM).toBeCloseTo(0.76, 9);
    expect(v.stackCentreZ).toBeCloseTo((4 * 0.76) / 2, 9);
  });
});

/**
 * Cabinets on their end face stand SIDE BY SIDE, not on each other.
 *
 * Four KS28 on end, one on another, is a tower 5.36 m high. Nobody builds
 * that; on end they go next to each other, touching on the largest face they
 * have — the one that was the top before the roll.
 *
 * The hard half is not writing the row, it is READING it back. A position used
 * to be one coordinate on the layout axis, so a row of four broke into four
 * positions, the spacing came out uneven, and the editor refused to describe
 * the rig it had just built. The round trip below is the case that catches it.
 */
describe('a position of cabinets standing on their end face', () => {
  const W = 0.764, HT = 0.571;           // KS21 published: 0.764 wide, 0.571 tall
  const acrossM = HT;                    // on end, the cabinet is 0.571 across
  const tall = W;                        // ...and 0.764 tall

  let rid = 0;
  const row = (n: number, per: number, spacing: number) =>
    layoutSources([], {
      count: n,
      spacingM: spacing,
      axis: 'x',
      centreM: 0,
      cross: { y: 0, z: tall / 2 },
      perPosition: per,
      stackPitchM: acrossM,
      acrossM,
      rollDeg: 90,
      template: src({ id: 'tpl', rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } }),
    }, () => `r${rid++}`, (i) => `SUB ${i + 1}`);

  it('puts them next to each other, touching, at one height', () => {
    const out = row(3, 4, 6);
    expect(out).toHaveLength(12);
    // every cabinet at the same height: a row is one cabinet tall
    for (const s of out) expect(s.position.z).toBeCloseTo(tall / 2, 9);
    // and the four of the middle position touch, at the cabinet's own width
    const middle = out.filter((s) => Math.abs(s.position.x) < 2).map((s) => s.position.x).sort((a, b) => a - b);
    expect(middle).toHaveLength(4);
    for (let i = 1; i < middle.length; i++) {
      expect(middle[i] - middle[i - 1]).toBeCloseTo(acrossM, 9);
    }
    // centred on the position, so the block does not drift off its place
    expect((middle[0] + middle[3]) / 2).toBeCloseTo(0, 9);
  });

  it('is read back as the positions it was built from', () => {
    // The round trip. Measured with the old exact grouping this came back as
    // twelve positions of one, the spacing as uneven, and Apply layout was
    // refused on the program's own output.
    const out = row(3, 4, 6);
    const live = measure(out, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.601 });
    expect(live.count).toBe(3);
    expect(live.perPosition).toBe(4);
    expect(live.positionsUniform).toBe(true);
    expect(live.spacing).toBeCloseTo(6, 9);
    expect(live.stackPitchM).toBeCloseTo(acrossM, 9);
    expect(live.positionAcross).toBe(true);
  });

  it('rebuilds itself unchanged, which is what an untouched Apply must do', () => {
    const first = row(3, 4, 6);
    const live = measure(first, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.601 });
    const again = layoutSources(first, {
      count: live.count,
      spacingM: live.spacing,
      axis: 'x',
      centreM: live.centre,
      cross: { y: live.posB, z: live.posC },
      perPosition: live.perPosition,
      stackPitchM: live.stackPitchM,
      acrossM: live.stackPitchM,
      template: src({ id: 'tpl', rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } }),
    }, () => `a${rid++}`, (i) => `SUB ${i + 1}`);
    expect(again).toHaveLength(first.length);
    const xs = (v: Source[]) => v.map((s) => s.position.x).sort((a, b) => a - b);
    const zs = (v: Source[]) => v.map((s) => s.position.z).sort((a, b) => a - b);
    for (const [a, b] of xs(again).map((v, i) => [v, xs(first)[i]])) expect(a).toBeCloseTo(b, 9);
    for (const [a, b] of zs(again).map((v, i) => [v, zs(first)[i]])) expect(a).toBeCloseTo(b, 9);
  });

  it('still reads a TOWER of on-end cabinets as a tower', () => {
    // Built before this program laid rows, or imported. Both a row and a tower
    // are rolled 90, so the roll cannot tell them apart and the reading has to
    // come from where the cabinets actually are. Calling this a row would put
    // its vertical extent at one cabinet and drop it two boxes into the stage.
    const tower: Source[] = [];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 4; j++)
        tower.push(src({ id: `t${i}_${j}`, position: { x: i * 6, y: 0, z: tall / 2 + j * tall },
                         rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } }));
    const live = measure(tower, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.601 });
    expect(live.count).toBe(3);
    expect(live.perPosition).toBe(4);
    expect(live.positionAcross).toBe(false);
    expect(live.stackPitchM).toBeCloseTo(tall, 9);
  });

  it('leaves an upright rig alone in every reading', () => {
    // The clustering must not reach an upright rig: there a position IS one
    // coordinate, and merging touching positions would read ten places as one
    // and let Apply layout stack them into a column.
    const upright = grid(10, 4, W, HT);   // positions one cabinet WIDTH apart: touching
    const live = measure(upright, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.601 });
    expect(live.count).toBe(10);
    expect(live.perPosition).toBe(4);
    expect(live.positionAcross).toBe(false);
    expect(live.stackPitchM).toBeCloseTo(HT, 9);
  });
});

/**
 * A row of cabinets on their end face must stay DESCRIBABLE.
 *
 * This came up on a rig the program had built itself: four positions of
 * three KS28 on end, one turned round at each, and "Apply layout" went grey
 * with "this layout does not divide into equal positions, or its reversed
 * cabinets do not form a cardioid this editor can describe".
 *
 * Every other reading had been taught that a position can be a ROW; the
 * reversal reading had not. It still grouped by exact coordinate, so it saw
 * twelve positions holding one cabinet each — and a position with one cabinet
 * can express no reversal pattern, so it declared the rig indescribable and
 * the editor refused to rebuild what it had just made.
 */
describe('a reversal inside a row of cabinets on their end face', () => {
  const W = 1.34, HT = 0.55;
  const acrossM = HT;

  const row = (n: number, per: number, spacing: number) => {
    let rid = 0;
    return layoutSources([], {
      count: n, spacingM: spacing, axis: 'x', centreM: 0,
      cross: { y: 0, z: W / 2 },
      perPosition: per, stackPitchM: acrossM, acrossM,
      reverseAt: 'bottom', reverseCount: 1, forwardAzimuthDeg: 0, reverseDelayS: 0.002,
      template: src({ id: 'tpl', rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } }),
    }, () => `r${rid++}`, (i) => `SUB ${i + 1}`);
  };

  it('is read as a cardioid the editor can rebuild', () => {
    const rig = row(4, 3, 2.8167);
    expect(rig.filter((s) => s.invertPolarity)).toHaveLength(4); // jedna na pozycję
    const live = measure(rig, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.719 });
    expect(live.count).toBe(4);
    expect(live.perPosition).toBe(3);
    expect(live.positionsUniform).toBe(true);
    // to jest asercja, o którą chodzi: bez niej przycisk Zastosuj jest szary
    expect(live.reversalDescribable).toBe(true);
    expect(live.reverseAt).toBe('bottom');
    expect(live.reverseCount).toBe(1);
    expect(derive(INITIAL_ARRAY_MODULE, live).canRebuild).toBe(true);
  });

  it('names the same end of the row each time it is read', () => {
    // Uporządkowanie rzędu po WYSOKOŚCI zostawiało kolejność przypadkowi, bo
    // wszystkie obudowy rzędu stoją na jednej wysokości — „dolna” i „górna”
    // wskazywały wtedy raz jedną, raz drugą skrajną obudowę.
    const rig = row(3, 4, 4);
    const a = measure(rig, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.719 });
    const shuffled = [...rig].reverse();
    const b = measure(shuffled, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.719 });
    expect(a.reverseAt).toBe(b.reverseAt);
    expect(a.reverseCount).toBe(b.reverseCount);
    expect(a.reversalDescribable).toBe(true);
    expect(b.reversalDescribable).toBe(true);
  });
});

/**
 * Ile naprawdę zajmuje rząd obudów na krótszej krawędzi.
 *
 * Właściciel zobaczył pod osiemnastoma KS28 stojącymi w jednym rzędzie odczyt
 * „1 pozycji × 18 = 18 obudów · szerokość zewn. 0.55 m · −4.28 m do 5.62 m”.
 * Rig jest szeroki na 9.9 m i wysoki na jedną obudowę; edytor opisał go
 * odwrotnie — szeroki na jedną obudowę i wysoki na 9.9 m. Właściwy wymiar
 * trafiał na niewłaściwą oś, bo i szerokość, i wysokość liczyły pozycję jako
 * pojedynczą obudowę stojącą w stosie.
 */
describe('obrys rzędu obudów na krótszej krawędzi', () => {
  const W = 1.34, HT = 0.55;
  const acrossM = HT;

  const row = (n: number, per: number, spacing: number) => {
    let rid = 0;
    return layoutSources([], {
      count: n, spacingM: spacing, axis: 'x', centreM: 0,
      cross: { y: 0, z: W / 2 },
      perPosition: per, stackPitchM: acrossM, acrossM,
      template: src({ id: 'tpl', rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 90 } }),
    }, () => `r${rid++}`, (i) => `SUB ${i + 1}`);
  };

  it('jest szeroki na cały rząd, nie na jedną obudowę', () => {
    const rig = row(1, 18, 0);
    const live = measure(rig, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.719 });
    const v = derive(INITIAL_ARRAY_MODULE, live);
    // naprawdę taki szeroki: 18 x 0.55
    const xs = rig.map((s) => s.position.x);
    expect(Math.max(...xs) - Math.min(...xs) + acrossM).toBeCloseTo(18 * acrossM, 6);
    expect(v.overall).toBeCloseTo(18 * acrossM, 6);
    expect(v.overall).toBeGreaterThan(9);          // nie 0.55
  });

  it('jest wysoki na JEDNĄ obudowę, choćby stało ich osiemnaście', () => {
    const rig = row(1, 18, 0);
    const live = measure(rig, 'x', { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.719 });
    const v = derive(INITIAL_ARRAY_MODULE, live);
    // wysokość obudowy na boku to jej opublikowana SZEROKOŚĆ
    expect(v.cabinetHeightM).toBeCloseTo(W, 9);
    // a wszystkie obudowy rzędu stoją na jednej wysokości
    const zs = new Set(rig.map((s) => s.position.z.toFixed(6)));
    expect(zs.size).toBe(1);
  });

  it('nie rusza obrysu zwykłego stosu', () => {
    // Stos ma być nadal liczony jak dotąd: szerokość to jedna obudowa na
    // pozycję, wysokość to liczba obudów razy ich wysokość.
    const upright = grid(4, 3, 1.34, 0.55);
    const live = measure(upright, 'x', { publishedWidthM: 1.34, publishedHeightM: 0.55, gradientSpanM: 0.719 });
    const v = derive(INITIAL_ARRAY_MODULE, live);
    expect(live.positionAcross).toBe(false);
    expect(v.overall).toBeCloseTo(4 * 1.34, 6);
  });
});

/**
 * Odwrócona obudowa w ŚRODKU pozycji.
 *
 * „Dolna” i „Górna” nazywają grupę przy jednym albo drugim końcu i nic poza
 * tym. Bloki KS28 zawierają F B F (NO.2.1) i F F B F
 * (NO.1.1) — odwrócona obudowa stoi w środku, a edytor na taki rig odpowiadał
 * „nie tworzą kardioidy, którą umiem opisać” i wyłączał przebudowę.
 */
describe('wzór odwrócenia, nie tylko koniec', () => {
  const W = 0.764, HT = 0.571;
  const facts = { publishedWidthM: W, publishedHeightM: HT, gradientSpanM: 0.601 };

  const build = (pattern: boolean[], positions = 3) => {
    let n = 0;
    return layoutSources([], {
      count: positions, spacingM: 4, axis: 'x', centreM: 0,
      cross: { y: 0, z: (pattern.length * HT) / 2 },
      perPosition: pattern.length, stackPitchM: HT,
      reversePattern: pattern, forwardAzimuthDeg: 0, reverseDelayS: 0.0018,
      template: src({ id: 'tpl' }),
    }, () => `w${n++}`, (i) => `SUB ${i + 1}`);
  };

  it('odwraca tę obudowę, o którą chodzi, i tylko ją', () => {
    const rig = build([false, true, false]);          // F B F
    const byPlace = rig.filter((s) => Math.abs(s.position.x) < 1e-6)
      .sort((a, b) => a.position.z - b.position.z);
    expect(byPlace.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FBF');
    // odwrócona dostaje też obrót i ZASZYTY delay gradientu; kolumna
    // użytkownika zostaje czysta — gradient żyje poza nią
    expect(byPlace[1].rotation.azimuthDeg).toBe(180);
    expect(byPlace[1].gradientDelayS).toBeCloseTo(0.0018, 9);
    expect(byPlace[1].delayS).toBe(0);
    expect(byPlace[0].gradientDelayS).toBeUndefined();
    expect(byPlace[0].delayS).toBe(0);
  });

  it('jest odczytywany z powrotem i NIE blokuje przebudowy', () => {
    for (const pat of [[false, true, false], [false, false, true, false], [true, false, true]]) {
      const live = measure(build(pat), 'x', facts);
      expect(live.reversalDescribable, pat.join('')).toBe(true);
      expect(live.reversePattern, pat.join('')).toEqual(pat);
      expect(derive(INITIAL_ARRAY_MODULE, live).canRebuild, pat.join('')).toBe(true);
    }
  });

  it('odbudowuje się bez zmian', () => {
    const first = build([false, true, false]);
    const live = measure(first, 'x', facts);
    let n = 0;
    const again = layoutSources(first, {
      count: live.count, spacingM: live.spacing, axis: 'x', centreM: live.centre,
      cross: { y: live.posB, z: live.posC },
      perPosition: live.perPosition, stackPitchM: live.stackPitchM,
      reversePattern: live.reversePattern ?? undefined,
      forwardAzimuthDeg: 0, reverseDelayS: 0.0018,
      template: src({ id: 'tpl' }),
    }, () => `a${n++}`, (i) => `SUB ${i + 1}`);
    const sig = (v: Source[]) => v.map((x) => `${x.position.x.toFixed(4)}/${x.invertPolarity ? 'B' : 'F'}`).sort().join(',');
    expect(sig(again)).toBe(sig(first));
  });

  it('nie pozwala odwrócić wszystkich — to nie gradient, tylko rig tyłem', () => {
    const rig = build([true, true, true]);
    // wzór bez ani jednej obudowy z przodu jest pomijany, rig zostaje prosty
    expect(rig.every((s) => !s.invertPolarity)).toBe(true);
  });

  it('pozycje muszą mieć TEN SAM wzór, inaczej modułu nie da się opisać', () => {
    const rig = build([false, true, false], 2);
    // Jedna obudowa odwrócona ręcznie poza wzorem. Odwrócenie czyta się
    // z AZYMUTU, nie z samej polaryzacji — `reversedFlags` porównuje heading
    // z kierunkiem rigu — więc obrót jest tu istotny, nie ozdobny.
    const odd = rig.map((s, i) =>
      i === 0
        ? { ...s, invertPolarity: true, rotation: { ...s.rotation, azimuthDeg: 180 } }
        : s,
    );
    const live = measure(odd, 'x', facts);
    expect(live.reversalDescribable).toBe(false);
    expect(live.reversePattern).toBeNull();
  });
});
