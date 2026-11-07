/**
 * What a reverse stack actually achieves, measured rather than assumed.
 *
 * The configuration an operator asks for is usually "a stack of four with the
 * bottom one turned round", and the number that matters about it is not in the
 * delay — it is in the COUNTS. The rear field is the difference between the two
 * groups and the forward field is their sum, so three forward against one
 * reversed cannot beat 6 dB however perfectly it is delayed. Matched groups
 * null deeply. Everything in this file exists so that distinction is a measured
 * fact in the suite and a sentence on screen, instead of a surprise on site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computePoint, prepareSources, pressureAt, toDb } from './engine';
import { distanceToDelay, gradientRejectionDb } from './steering';
import { useStore } from '../state/store';
import { resolveAll, toEngineSources } from '../state/resolve';
import { planDelays } from '../state/arrayTools';
import { forwardAzimuthOf, reverseDelayOffsets } from '../state/arrayModule';
import { acousticOrigin, orientedDimensions } from '../speakers/schema';
import { builtinProvider } from '../speakers/provider';
import type { Source } from '../core/types';

const C = 343;
const st = () => useStore.getState();

const ks21 = () => {
  const m = builtinProvider.get('la-ks21');
  if (!m) throw new Error('the KS21 record is gone');
  return m;
};
/** 0.601 m: the distance between a forward baffle and a reversed one. */
const gradientSpanM = () => 2 * Math.abs(acousticOrigin(ks21()).y);

function spl(p: [number, number, number], f: number): number {
  const srcs = toEngineSources(resolveAll(st().sources, st().groups, st().provider));
  const prepared = prepareSources(srcs, f, C);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  pressureAt(prepared, p[0], p[1], p[2], f, C, out, scratch);
  return toDb(out[0], out[1]);
}

const frontToBack = (f: number) => spl([0, 30, 1.7], f) - spl([0, -30, 1.7], f);

/**
 * `positions` places on the deck, each `nF + nR` cabinets tall with the bottom
 * `nR` turned round, delayed and inverted — the rig the layout tool builds.
 */
function build(positions: number, nF: number, nR: number, spacingM = 1) {
  st().newProject();
  const h = orientedDimensions(ks21(), 0).heightM!;
  const delay = distanceToDelay(gradientSpanM(), C);
  const per = nF + nR;
  for (let i = 0; i < positions; i++) {
    for (let j = 0; j < per; j++) {
      st().addSource('la-ks21', {
        x: (i - (positions - 1) / 2) * spacingM,
        y: 0,
        z: h / 2 + j * h,
      });
      const id = st().sources[st().sources.length - 1].id;
      const reversed = j < nR;
      st().patchSources([id], {
        rotation: { azimuthDeg: reversed ? 180 : 0 },
        invertPolarity: reversed,
        delayS: reversed ? delay : 0,
      });
    }
  }
}

describe('the ceiling the counts put on rear rejection', () => {
  it('is 6 dB for three forward against one reversed', () => {
    expect(gradientRejectionDb(3, 1)).toBeCloseTo(6.02, 2);
    expect(gradientRejectionDb(2, 1)).toBeCloseTo(9.54, 2);
    // 4 + 2 is the SAME ratio as 2 + 1, which is the point of expressing it as
    // one: doubling a rig does not improve its rear rejection.
    expect(gradientRejectionDb(4, 2)).toBeCloseTo(9.54, 2);
  });

  it('is not a number at all when the groups are matched', () => {
    // Nothing in the counts limits it then; the spacing does. Quoting Infinity
    // would read as a promise the spacing does not keep.
    expect(gradientRejectionDb(2, 2)).toBeNull();
    expect(gradientRejectionDb(1, 1)).toBeNull();
  });

  it('is zero when nothing is turned round', () => {
    expect(gradientRejectionDb(4, 0)).toBe(0);
  });
});

describe('what the rig measures', () => {
  beforeEach(() => {
    st().newProject();
    useStore.setState({ undoStack: [], redoStack: [] });
  });

  it('gives a three-plus-one stack a slightly quieter back, not a cardioid', () => {
    // Ten positions of four KS21 with the bottom one reversed, which is the
    // configuration people actually describe. It stays under its own 6 dB
    // ceiling everywhere in the sub band, and at the bottom of it there is
    // barely anything: calling this a cardioid is the mistake the readout in
    // the panel exists to prevent.
    build(10, 3, 1);
    expect(st().sources).toHaveLength(40);
    const ceiling = gradientRejectionDb(3, 1)!;
    for (const f of [31.5, 40, 63, 100, 125]) {
      expect(frontToBack(f)).toBeLessThan(ceiling + 0.5);
    }
    expect(frontToBack(40)).toBeLessThan(3);
    expect(frontToBack(125)).toBeLessThan(7);
  });

  it('nulls deeply as soon as the groups are matched', () => {
    // The same forty cabinets, two forward and two reversed per position.
    build(10, 2, 2);
    expect(st().sources).toHaveLength(40);
    for (const f of [40, 63, 100, 125]) {
      expect(frontToBack(f)).toBeGreaterThan(25);
    }
  });
});

describe('steering a rig that contains a gradient', () => {
  beforeEach(() => {
    st().newProject();
    useStore.setState({ undoStack: [], redoStack: [] });
  });

  it('keeps the rear null when the gradient delay is carried in the plan', () => {
    build(6, 2, 2, 1.2);
    const before = frontToBack(63);
    expect(before).toBeGreaterThan(25);

    const ids = st().sources.map((x) => x.id);
    const offsets = reverseDelayOffsets(st().sources, distanceToDelay(gradientSpanM(), C));
    const plan = planDelays(st().sources, {
      mode: 'steer',
      steerDeg: 20,
      dispersionDeg: 0,
      axis: 'x',
      speedOfSound: C,
      extraDelaysS: offsets,
    });
    st().applyDelayPlan(ids, plan);
    expect(frontToBack(63)).toBeGreaterThan(25);
  });

  it('loses it when the plan does not carry the offsets', () => {
    // This is the failure the composition exists to prevent, and it is the same
    // one the level taper had: applying a plan owns the whole delay column, so
    // a steering pass that knows nothing about the gradient flattens it. If this
    // test ever passes with the offsets left in, the composition is not doing
    // anything.
    build(6, 2, 2, 1.2);
    expect(frontToBack(63)).toBeGreaterThan(25);

    const ids = st().sources.map((x) => x.id);
    const plan = planDelays(st().sources, {
      mode: 'steer',
      steerDeg: 20,
      dispersionDeg: 0,
      axis: 'x',
      speedOfSound: C,
    });
    st().applyDelayPlan(ids, plan);
    expect(frontToBack(63)).toBeLessThan(10);
  });
});

describe('re-applying a layout over a steered reverse stack', () => {
  beforeEach(() => {
    st().newProject();
    useStore.setState({ undoStack: [], redoStack: [] });
  });

  it('leaves the delays alone, so the rear null survives a second Apply layout', () => {
    // The layout used to write the gradient delay as an ASSIGNMENT. Over a rig
    // that had been steered, that replaced every reversed cabinet's steering
    // delay with the flat gradient figure while the forward cabinets kept their
    // ramp — measured at -8.7 dB front to back on a rig that had been +32, i.e.
    // the rejection pointing at the audience.
    build(6, 2, 2, 1.2);
    const ids = st().sources.map((x) => x.id);
    const fwd = forwardAzimuthOf(st().sources);
    const plan = planDelays(st().sources, {
      mode: 'steer',
      steerDeg: 20,
      dispersionDeg: 0,
      axis: 'x',
      speedOfSound: C,
      extraDelaysS: reverseDelayOffsets(
        st().sources,
        distanceToDelay(gradientSpanM(), C),
        fwd,
      ),
    });
    st().applyDelayPlan(ids, plan);
    const steered = st().sources.map((x) => x.delayS);
    expect(frontToBack(63)).toBeGreaterThan(25);

    const h = orientedDimensions(ks21(), 0).heightM!;
    st().applyArrayLayout(st().sources.map((x) => x.id), {
      count: 6,
      spacingM: 1.2,
      axis: 'x',
      centreM: 0,
      cross: { y: 0, z: (4 * h) / 2 },
      perPosition: 4,
      stackPitchM: h,
      reverseAt: 'bottom',
      reverseCount: 2,
      forwardAzimuthDeg: fwd,
    });
    expect(st().sources.map((x) => x.delayS)).toEqual(steered);
    expect(frontToBack(63)).toBeGreaterThan(25);
  });
});

describe('the gradient lives outside the user delay column', () => {
  /**
   * A reported case, reproduced: an ON-END ROW with an F/B pattern. The
   * reversed box stands BESIDE its partner (0.555 m away on the layout axis),
   * not on top of it, so the coordinate "nose-to-tail" partner test found
   * nothing, Apply delay rewrote the column with the bare arc, and the
   * reversed cabinet ended up with THE SAME delay as the forward one — a
   * cardioid that looked configured and did not work.
   */
  const C = 343.2;
  const D = 0.719; // KS28 depth: the gradient span
  const dOverC = D / C;

  function rowPair(): Source[] {
    const mk = (x: number, reversed: boolean): Source => ({
      id: `rp${x}${reversed ? 'b' : 'f'}`,
      label: 'SUB',
      speakerId: 'la-ks28',
      position: { x, y: 0, z: 0.2775 },
      rotation: { azimuthDeg: reversed ? 180 : 0, elevationDeg: 0, rollDeg: 90 },
      levelDb: 0,
      delayS: 0,
      invertPolarity: reversed,
      mute: false,
      groupId: null,
      positionKey: 'row-pos-1',
      gradientDelayS: reversed ? dOverC : undefined,
    });
    return [mk(0, false), mk(0.555, true)];
  }

  it('side-by-side partners earn the offset through their position, not their coordinates', () => {
    const offs = reverseDelayOffsets(rowPair(), dOverC, 0);
    expect(offs[0]).toBe(0);
    expect(offs[1]).toBeCloseTo(dOverC, 12);

    // and WITHOUT stored membership the coordinate test still refuses a lone
    // rear-fill 25 m upstage — the case the coincidence rule existed for
    const strays = rowPair().map((s) => ({ ...s, positionKey: undefined }));
    strays[1].position = { x: 0, y: -25, z: 0.2775 };
    expect(reverseDelayOffsets(strays, dOverC, 0)[1]).toBe(0);
  });

  it('the engine hears the hidden gradient the user column does not carry', () => {
    const rig = rowPair();
    // the USER column is identical for both boxes — which is the whole point
    expect(rig[0].delayS).toBe(rig[1].delayS);

    const engine = toEngineSources(resolveAll(rig, [], builtinProvider));
    const f = engine.find((e) => !e.invertPolarity)!;
    const b = engine.find((e) => e.invertPolarity)!;
    expect(b.delayS - f.delayS).toBeCloseTo(dOverC, 12);

    // and it is audible: rear rejection well beyond what equal delays give
    const FRONT = { x: 0.28, y: 30, z: 0.2775 };
    const REAR = { x: 0.28, y: -30, z: 0.2775 };
    const withGradient =
      computePoint(engine, FRONT, 50, C).splDb - computePoint(engine, REAR, 50, C).splDb;
    const flat = toEngineSources(
      resolveAll(rig.map((s) => ({ ...s, gradientDelayS: undefined })), [], builtinProvider),
    );
    const withoutGradient =
      computePoint(flat, FRONT, 50, C).splDb - computePoint(flat, REAR, 50, C).splDb;
    expect(withGradient).toBeGreaterThan(withoutGradient + 10);
    expect(withGradient).toBeGreaterThan(11);
  });
});
