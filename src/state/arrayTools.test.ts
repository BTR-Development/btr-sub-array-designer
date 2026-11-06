/**
 * The Array panel's write path.
 *
 * Everything the panel does to the cabinets goes through this file, and it had
 * no test file at all: the delay plan, the level taper, the axis choice and the
 * rebuilt geometry all reached the project unchecked. The two defects pinned
 * first each lived in a single character — a truthiness test standing in for a
 * presence test — and each of them silently threw away something the operator
 * had set by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  currentCentre,
  currentSpacing,
  currentSplay,
  detectAxis,
  layoutSources,
  planDelays,
  positionBlocks,
  type DelayOptions,
} from './arrayTools';
import { levelTaper } from '../engine/steering';
import type { Source } from '../core/types';

const C = 343;

function src(over: Partial<Source> = {}): Source {
  return {
    id: 's',
    label: 'SUB 01',
    speakerId: 'la-ks28',
    position: { x: 0, y: 0, z: 0 },
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: 0,
    delayS: 0,
    invertPolarity: false,
    mute: false,
    groupId: null,
    ...over,
  };
}

/** Three cabinets along X, 2 m apart, so the taper has a centre and two edges. */
const line = [-2, 0, 2].map((x) => src({ id: `s${x}`, position: { x, y: 0, z: 0 } }));

/** The same three cabinets, each tilted by hand to a different angle. */
const tilted = [-1, -2, -4].map((el, i) =>
  src({ ...line[i], rotation: { azimuthDeg: 0, elevationDeg: el, rollDeg: 0 } }),
);

/** And fanned by hand, ends out. */
const fanned = [-15, 0, 15].map((az, i) =>
  src({ ...line[i], rotation: { azimuthDeg: az, elevationDeg: 0, rollDeg: 0 } }),
);

const steerFlat: DelayOptions = {
  mode: 'steer',
  steerDeg: 0,
  dispersionDeg: 0,
  axis: 'x',
  speedOfSound: C,
};

describe('the level taper in a delay plan', () => {
  it('trims the outer cabinets by the angle asked for', () => {
    expect(planDelays(line, { ...steerFlat, edgeTaperDb: -6 }).levelsDb).toEqual(
      levelTaper([-2, 0, 2], -6),
    );
  });

  it('takes the taper OFF again when it is set back to 0', () => {
    // 0 dB at the edge is how an operator removes a taper, so the plan has to
    // carry the zeros that overwrite the trimmed levels. Treating the number as
    // a flag instead left every trimmed cabinet trimmed for the life of the
    // project, with the control reading 0 and nothing on screen to say so.
    const plan = planDelays(line, { ...steerFlat, edgeTaperDb: 0 });
    expect(plan.levelsDb).toEqual([0, 0, 0]);
  });

  it('leaves the level column alone when no taper is mentioned at all', () => {
    expect(planDelays(line, steerFlat).levelsDb).toBeNull();
  });

  it('never tapers an end-fire array, which needs every cabinet at full level', () => {
    expect(planDelays(line, { ...steerFlat, mode: 'endfire', edgeTaperDb: -6 }).levelsDb).toBeNull();
  });
});

describe('rebuilding a layout', () => {
  const rebuild = (members: Source[], opts: Partial<Parameters<typeof layoutSources>[1]> = {}) =>
    layoutSources(
      members,
      {
        count: members.length,
        spacingM: 1.5,
        axis: 'x',
        centreM: 0,
        template: members[0],
        ...opts,
      },
      () => 'new-id',
      (i) => `SUB ${i + 2}`,
    );

  it('puts the cabinets at the requested pitch about the requested centre', () => {
    const out = rebuild(line, { count: 4, spacingM: 2, centreM: 10 });
    expect(out.map((x) => x.position.x)).toEqual([7, 9, 11, 13]);
  });

  it('leaves individual tilts alone when no tilt was typed', () => {
    // A column tilted cabinet by cabinet is somebody's aiming session. Moving
    // the boxes is not a statement about where they point, and "Apply layout"
    // used to flatten all of them to the first cabinet's angle on every press.
    expect(rebuild(tilted).map((x) => x.rotation.elevationDeg)).toEqual([-1, -2, -4]);
  });

  it('writes the tilt that was typed, including a typed 0', () => {
    expect(rebuild(tilted, { elevationDeg: -5 }).map((x) => x.rotation.elevationDeg)).toEqual([
      -5, -5, -5,
    ]);
    for (const x of rebuild(tilted, { elevationDeg: 0 })) {
      expect(x.rotation.elevationDeg).toBeCloseTo(0, 12);
    }
  });

  it('keeps a hand-set fan, and unfans it only when 0 is typed', () => {
    expect(rebuild(fanned).map((x) => x.rotation.azimuthDeg)).toEqual([-15, 0, 15]);
    for (const x of rebuild(fanned, { splayDeg: 0 })) {
      expect(x.rotation.azimuthDeg).toBeCloseTo(0, 12);
    }
    // and a typed fan puts the ends at +-splay/2
    expect(rebuild(fanned, { splayDeg: 30 }).map((x) => x.rotation.azimuthDeg)).toEqual([-15, 0, 15]);
  });

  it('reuses existing members, so level, delay and polarity survive a move', () => {
    const set = [
      src({ ...line[0], levelDb: -3, delayS: 0.004, invertPolarity: true }),
      src({ ...line[1] }),
      src({ ...line[2] }),
    ];
    const out = rebuild(set, { count: 2 });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe(set[0].id);
    expect([out[0].levelDb, out[0].delayS, out[0].invertPolarity]).toEqual([-3, 0.004, true]);
  });
});

describe('the fan a block is already aimed at', () => {
  const aimed = (x: number, azimuthDeg: number) =>
    src({ id: `s${x}`, position: { x, y: 0, z: 0 }, rotation: { azimuthDeg, elevationDeg: 0, rollDeg: 0 } });

  it('is the angle between the two end cabinets, signed along the axis', () => {
    expect(currentSplay([aimed(-2, -15), aimed(0, 0), aimed(2, 15)], 'x')).toBeCloseTo(30, 9);
    // the same block read from the other end is the same fan, not its mirror
    expect(currentSplay([aimed(2, 15), aimed(0, 0), aimed(-2, -15)], 'x')).toBeCloseTo(30, 9);
    // a fan that opens the other way reads negative
    expect(currentSplay([aimed(-2, 15), aimed(2, -15)], 'x')).toBeCloseTo(-30, 9);
  });

  it('is 0 for a block that is not fanned, and for a single cabinet', () => {
    expect(currentSplay([aimed(-2, 4), aimed(2, 4)], 'x')).toBe(0);
    expect(currentSplay([aimed(0, 12)], 'x')).toBe(0);
    expect(currentSplay([], 'x')).toBe(0);
  });
});

describe('the delays a plan actually carries', () => {
  /**
   * The existing cases above check what the plan does to the LEVEL column. The
   * delay column, which is the reason the panel exists, went out unchecked.
   *
   * Every expected value here is the closed form for its mode, evaluated by
   * hand: a plane wave is p*sin(theta)/c, an arc is the distance from the
   * virtual focus, and end-fire is the offset from the rear-most cabinet. None
   * of them is a reading taken off `steeringDelays`.
   */
  const SIN20 = Math.sin((20 * Math.PI) / 180);

  it('is the plane-wave taper, referenced to the earliest cabinet', () => {
    // p*sin(20)/c, shifted so the -X end leaves at 0: 0, 2*sin20/c, 4*sin20/c.
    const plan = planDelays(line, { ...steerFlat, steerDeg: 20 });
    expect(plan.delaysS[0]).toBeCloseTo(0, 12);
    expect(plan.delaysS[1]).toBeCloseTo((2 * SIN20) / C, 12);
    expect(plan.delaysS[2]).toBeCloseTo((4 * SIN20) / C, 12);
    // the +X end leaves last, which is what aims the beam at +X
    expect(plan.maxDelayS).toBeCloseTo(plan.delaysS[2], 15);
  });

  it('mirrors when the aim is mirrored, and flattens at 0', () => {
    const right = planDelays(line, { ...steerFlat, steerDeg: 20 }).delaysS;
    const left = planDelays(line, { ...steerFlat, steerDeg: -20 }).delaysS;
    expect(left).toEqual([...right].reverse());
    expect(planDelays(line, steerFlat).delaysS).toEqual([0, 0, 0]);
  });

  it('bends the wavefront into an arc only in dispersion mode', () => {
    // A 4 m span asked to fan 60 deg puts the virtual focus at
    // R = (span/2)/tan(30 deg) = 3.4641 m behind the array — the rays through
    // the end cabinets then diverge by exactly 60 deg — so the two ends run
    // sqrt(R^2+4) - R further from the focus than the centre does.
    const R = 2 / Math.tan((30 * Math.PI) / 180);
    const edge = (Math.sqrt(R * R + 4) - R) / C;
    const arc = planDelays(line, { ...steerFlat, mode: 'dispersion', dispersionDeg: 60 });
    expect(arc.delaysS[0]).toBeCloseTo(edge, 12);
    expect(arc.delaysS[1]).toBeCloseTo(0, 12);
    expect(arc.delaysS[2]).toBeCloseTo(edge, 12);
    expect(arc.maxDelayS).toBeCloseTo(edge, 12);

    // Steer mode does not read the field at all: the same dispersion number
    // left over from a previous mode must not curve a plain steer.
    expect(planDelays(line, { ...steerFlat, dispersionDeg: 60 }).delaysS).toEqual([0, 0, 0]);
  });

  it('fires an end-fire stack from the back, one spacing at a time', () => {
    // Four cabinets 0.86 m apart — a quarter wavelength at 100 Hz — so each one
    // waits exactly the time sound takes to cover the box behind it.
    const d = 0.86;
    const stack = [0, 1, 2, 3].map((i) =>
      src({ id: `e${i}`, position: { x: 0, y: i * d, z: 0 } }),
    );
    const plan = planDelays(stack, { ...steerFlat, mode: 'endfire', axis: 'y' });
    plan.delaysS.forEach((t, i) => expect(t).toBeCloseTo((i * d) / C, 12));
    expect(plan.maxDelayS).toBeCloseTo((3 * d) / C, 12);
  });

  it('has nothing to say about an empty selection', () => {
    // Math.max of no arguments is -Infinity, and a -Infinity spread in the
    // panel's read-out is how this used to show up.
    expect(planDelays([], steerFlat)).toEqual({ delaysS: [], levelsDb: null, maxDelayS: 0 });
  });
});

describe('the axis the plan is computed along', () => {
  /**
   * The axis is the one input to this file that cannot be seen in the result
   * until the cabinets move. Get it wrong and every delay is zero, the panel
   * reports a spread of 0.00 ms, and the array radiates broadside while the
   * field says it is aimed 15 degrees down.
   */
  const column = [1, 2, 3].map((z) => src({ id: `c${z}`, position: { x: 0, y: 0, z } }));

  it('is a different plan for the same cabinets', () => {
    const alongZ = planDelays(column, { ...steerFlat, axis: 'z', steerDeg: 15 });
    const alongX = planDelays(column, { ...steerFlat, axis: 'x', steerDeg: 15 });
    // 1 m pitch, so the taper is sin(15)/c per box: 0, 0.7545 ms, 1.509 ms
    const step = Math.sin((15 * Math.PI) / 180) / C;
    alongZ.delaysS.forEach((t, i) => expect(t).toBeCloseTo(i * step, 12));
    // the same column spans nothing along X, so planning along X is silence
    expect(alongX.delaysS).toEqual([0, 0, 0]);
  });

  it('is detected from the geometry as the axis the block spans most', () => {
    expect(detectAxis(column)).toBe('z');
    expect(detectAxis(line)).toBe('x');
    // a flown column is never perfectly plumb in a project file
    const leaning = column.map((s, i) => src({ ...s, position: { ...s.position, x: i * 0.001 } }));
    expect(detectAxis(leaning)).toBe('z');
  });

  it('falls back to X when there is no line to read', () => {
    // One cabinet, or several in the same place: there is no axis, and the
    // panel still has to offer one rather than crash or pick at random.
    expect(detectAxis([])).toBe('x');
    expect(detectAxis([line[0]])).toBe('x');
    expect(detectAxis([line[0], src({ id: 'b', position: { x: 0, y: 0, z: 0 } })])).toBe('x');
  });

  it('is what the panel reads the block back through', () => {
    // detectAxis -> planDelays is the whole write path for an array nobody told
    // the panel about, so the seam is worth one assertion of its own.
    const axis = detectAxis(column);
    expect(planDelays(column, { ...steerFlat, axis, steerDeg: 15 }).maxDelayS).toBeGreaterThan(0);
  });
});

describe('where the block is measured from', () => {
  /**
   * Positions are taken relative to the MIDPOINT OF THE EXTREMES, not to the
   * mean. For an evenly spaced array the two are the same number, which is why
   * this can be got wrong and not noticed; for a block with a gap in it they
   * are not, and the level taper is computed from them.
   */
  const gapped = [0, 1, 9].map((x) => src({ id: `g${x}`, position: { x, y: 0, z: 0 } }));

  it('tapers about the centre of the block, not about its centre of mass', () => {
    // Midpoint of 0 and 9 is 4.5, so the outer cabinets sit at +-4.5 and the
    // middle one at -3.5: -6 dB, (3.5/4.5)^2 * -6 = -3.63 dB, -6 dB.
    // A mean-centred block would put the taper's zero at 3.33 and trim the
    // cabinet at x=0 by 2.07 dB instead.
    const levels = planDelays(gapped, { ...steerFlat, edgeTaperDb: -6 }).levelsDb!;
    expect(levels[0]).toBeCloseTo(-6, 12);
    expect(levels[1]).toBeCloseTo(-6 * (3.5 / 4.5) ** 2, 12);
    expect(levels[2]).toBeCloseTo(-6, 12);
  });

  it('halves the trim to a quarter of it half way out', () => {
    // The taper is squared, so a cabinet at half the half-span takes a quarter
    // of the edge attenuation. Five boxes, 1 m apart, -6 dB at the ends.
    const five = [-2, -1, 0, 1, 2].map((x) => src({ id: `f${x}`, position: { x, y: 0, z: 0 } }));
    const levels = planDelays(five, { ...steerFlat, edgeTaperDb: -6 }).levelsDb!;
    expect(levels).toHaveLength(5);
    [-6, -1.5, 0, -1.5, -6].forEach((v, i) => expect(levels[i]).toBeCloseTo(v, 12));
  });

  it('reports the pitch and the centre a gapped block implies', () => {
    // 9 m between the ends over two gaps is an average pitch of 4.5 m, and the
    // centre is the midpoint of the ends. Both are what the panel's fields show
    // when an array is selected, and both would read 3 m and 3.33 m if they
    // were derived from the mean instead.
    expect(currentSpacing(gapped, 'x')).toBeCloseTo(4.5, 12);
    expect(currentCentre(gapped, 'x')).toBeCloseTo(4.5, 12);
    expect(currentSpacing([gapped[0]], 'x')).toBe(0);
    expect(currentCentre([], 'x')).toBe(0);
  });
});

describe('the coordinates a layout does not lay out', () => {
  /**
   * A line along Y is placed by two numbers the layout axis knows nothing
   * about: "At x =" and "Position z". They come in as `cross`, and anything
   * the panel leaves out has to keep the template's value rather than
   * collapsing to zero.
   */
  const seed = src({ position: { x: 7, y: -1, z: 2.5 } });

  const layout = (cross?: Partial<Record<'x' | 'y' | 'z', number>>) =>
    layoutSources(
      [],
      { count: 3, spacingM: 2, axis: 'y', centreM: 0, cross, template: seed },
      () => 'id',
      (i) => `SUB ${i + 1}`,
    );

  it('keeps the template coordinates when the panel says nothing', () => {
    for (const s of layout()) {
      expect([s.position.x, s.position.z]).toEqual([7, 2.5]);
    }
    expect(layout().map((s) => s.position.y)).toEqual([-2, 0, 2]);
  });

  it('writes the cross coordinates it is given, including a typed 0', () => {
    const out = layout({ x: 0, z: 1.2 });
    for (const s of out) expect([s.position.x, s.position.z]).toEqual([0, 1.2]);
    expect(out.map((s) => s.position.y)).toEqual([-2, 0, 2]);
  });

  it('ignores a cross coordinate for the axis it is laying out along', () => {
    // The panel holds one set of position fields and swaps which of them are
    // live when the axis changes. A stale Y left in `cross` must not overwrite
    // the pitch that was just computed.
    expect(layout({ y: 99, x: 0 }).map((s) => s.position.y)).toEqual([-2, 0, 2]);
  });
});

describe('a position is a stored fact, not a measurement', () => {
  /**
   * 4 positions x 4 on-end cabinets, KEYED, laid out at `pitch` between
   * position centres. Within a position the cabinets touch at 0.555 m — the
   * KS28 on its end face — whatever the pitch does.
   */
  function keyedRows(pitch: number) {
    const out: Source[] = [];
    for (let p = 0; p < 4; p++) {
      for (let j = 0; j < 4; j++) {
        out.push(
          src({
            id: `p${p}c${j}`,
            positionKey: `pos${p}`,
            position: { x: (p - 1.5) * pitch + (j - 1.5) * 0.555, y: 0, z: 0 },
          }),
        );
      }
    }
    return out;
  }

  it('does not merge positions that a bad spread has pushed into each other', () => {
    // 1.2 m pitch against a 2.22 m footprint: the rows physically overlap, and
    // the geometric reading has one cabinet 0.045 m from its neighbour's —
    // which the old clustering called ONE position of sixteen.
    const rig = keyedRows(1.2);
    expect(currentSpacing(rig, 'x', 0.555 + 1e-3)).toBeCloseTo(1.2, 6);
    const blocks = positionBlocks(rig, 'x');
    expect(blocks.map((b) => b.count)).toEqual([4, 4, 4, 4]);
  });

  it('gives every cabinet of a position the ONE arc delay of its centre', () => {
    const rig = keyedRows(1.2);
    const plan = planDelays(rig, {
      mode: 'dispersion',
      steerDeg: 0,
      dispersionDeg: 60,
      axis: 'x',
      speedOfSound: C,
      // the tolerance the panel passes for touching rows — the stored keys
      // must win over it, or the overlapped rig collapses to one delay
      placeTolM: 0.555 + 1e-3,
    });
    const perPosition = [0, 1, 2, 3].map((p) => plan.delaysS.slice(p * 4, p * 4 + 4));
    for (const d of perPosition) {
      // one master sub, one time
      expect(Math.max(...d) - Math.min(...d)).toBeLessThan(1e-12);
    }
    // and the arc is still an arc: the outer positions are later than the inner
    expect(perPosition[0][0]).toBeGreaterThan(perPosition[1][0]);
    expect(perPosition[3][0]).toBeGreaterThan(perPosition[2][0]);
    // symmetric about the centre
    expect(perPosition[0][0]).toBeCloseTo(perPosition[3][0], 12);
  });

  it('a rebuild keeps the stored structure and stamps fresh keys', () => {
    const rig = keyedRows(4);
    // a hand-set level marks one cabinet, so the rebuild can be caught
    // moving it to another position
    rig.find((x) => x.id === 'p2c3')!.levelDb = -7;
    const rebuilt = layoutSources(
      rig,
      {
        count: 4,
        spacingM: 1.2, // shrink INTO overlap
        axis: 'x',
        centreM: 0,
        template: rig[0],
        perPosition: 4,
        stackPitchM: 0.555,
        acrossM: 0.555,
      },
      () => `id${Math.round(Math.random() * 1e9)}`,
      (i) => `SUB ${i}`,
    );
    expect(rebuilt).toHaveLength(16);
    const keys = new Set(rebuilt.map((r) => r.positionKey));
    expect(keys.size).toBe(4);
    // the overlapped result still reads as 4 x 4
    expect(positionBlocks(rebuilt, 'x').map((b) => b.count)).toEqual([4, 4, 4, 4]);
    // and the keys are FRESH: reusing the old ones would let a copy of the
    // module claim membership of the original's positions
    for (const r of rebuilt) expect(r.positionKey?.startsWith('pos')).toBe(false);
    // membership survived the shrink INTO overlap: the marked cabinet still
    // sits in the third position, not wherever the merged geometry put it
    const marked = rebuilt.find((x) => x.levelDb === -7)!;
    const ordered = [...new Set(rebuilt.map((r) => r.positionKey))];
    expect(ordered.indexOf(marked.positionKey)).toBe(2);
  });

  it('falls back to geometry the moment one cabinet has no key', () => {
    const rig = keyedRows(1.2);
    delete rig[7].positionKey;
    // half-stored grouping would describe a rig nobody has; all-or-nothing
    const blocks = positionBlocks(rig, 'x', 0.555 + 1e-3);
    expect(blocks.length).toBe(1); // the honest geometric reading of an overlap
  });
});
