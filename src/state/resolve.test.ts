import { describe, it, expect } from 'vitest';
import { referenceLevels, resolveAll, toEngineSources, UNGRADED_REF_SPL_DB } from './resolve';
import { builtinProvider, CompositeSpeakerDataProvider } from '../speakers/provider';
import type { SpeakerModel } from '../speakers/schema';
import { useStore } from './store';
import { polarResponse } from '../engine/polar';
import type { Group, Source } from '../core/types';

function src(over: Partial<Source> = {}): Source {
  return {
    id: 's1',
    label: 'SUB 01',
    speakerId: 'la-ks28',
    position: { x: 2, y: 0, z: 0 },
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: -3,
    delayS: 0.002,
    invertPolarity: false,
    mute: false,
    groupId: 'g1',
    ...over,
  };
}

function grp(over: Partial<Group> = {}): Group {
  return {
    id: 'g1',
    name: 'MAIN',
    offset: { x: 0, y: 0, z: 0 },
    rotationOffsetDeg: 0,
    anchor: { x: 0, y: 0, z: 0 },
    levelOffsetDb: 0,
    delayOffsetS: 0,
    mute: false,
    ...over,
  };
}

describe('group transforms are offsets, not rewrites', () => {
  it('adds translation, level and delay without touching the source', () => {
    const s = src();
    const g = grp({ offset: { x: 1, y: 5, z: 0.5 }, levelOffsetDb: -6, delayOffsetS: 0.003 });
    const [r] = resolveAll([s], [g], builtinProvider);

    expect(r.position).toEqual({ x: 3, y: 5, z: 0.5 });
    expect(r.levelDb).toBeCloseTo(-9, 9);
    expect(r.delayS).toBeCloseTo(0.005, 9);
    // the stored source is untouched
    expect(s.position).toEqual({ x: 2, y: 0, z: 0 });
    expect(s.levelDb).toBe(-3);
    expect(s.delayS).toBe(0.002);
  });

  it('rotates members about the group anchor and carries their yaw with it', () => {
    // +90 is clockwise, because that is what azimuth means here: az 90 points
    // the front along +X. So a cabinet standing at +X on the anchor swings to
    // -Y, and its heading follows from 10 to 100.
    const s = src({ position: { x: 2, y: 0, z: 0 }, rotation: { azimuthDeg: 10, elevationDeg: 0, rollDeg: 0 } });
    const [r] = resolveAll([s], [grp({ rotationOffsetDeg: 90 })], builtinProvider);
    expect(r.position.x).toBeCloseTo(0, 9);
    expect(r.position.y).toBeCloseTo(-2, 9);
    expect(r.azimuthDeg).toBeCloseTo(100, 9);
  });

  it('is a rigid rotation: the bearing to a member turns by exactly the yaw', () => {
    // The invariant the old code broke, and the reason it broke silently. A
    // group yaw moves two things — where a cabinet stands and which way it
    // faces — and they have to turn by the same angle in the same sense. The
    // bearing from the anchor to a cabinet is atan2(x, y), the same expression
    // azimuth uses, so this comparison ties the position convention directly to
    // the heading convention. The previous matrix was the transpose, so the
    // bearing turned by MINUS the yaw and nothing said so.
    const bearing = (x: number, y: number) => (Math.atan2(x, y) * 180) / Math.PI;
    const start = { x: 3, y: 4, z: 0 };
    const b0 = bearing(start.x, start.y);

    for (const yaw of [0, 15, 30, 45, 90, -35, 180]) {
      const s = src({ position: { ...start }, rotation: { azimuthDeg: 25, elevationDeg: 0, rollDeg: 0 } });
      const [r] = resolveAll([s], [grp({ rotationOffsetDeg: yaw })], builtinProvider);

      const wrap = (d: number) => ((d + 540) % 360) - 180;
      expect(wrap(bearing(r.position.x, r.position.y) - b0)).toBeCloseTo(wrap(yaw), 9);
      expect(wrap(r.azimuthDeg - 25)).toBeCloseTo(wrap(yaw), 9);
      // and a rotation about the anchor cannot change the distance to it
      expect(Math.hypot(r.position.x, r.position.y)).toBeCloseTo(5, 9);
    }
  });

  it('ungrouping bakes in the same rotation resolving applies', () => {
    // ungroup writes the transform permanently, so a mismatch between the two is
    // not recoverable by regrouping. Both halves are asserted: that they agree
    // with each other, AND that they agree with hand-computed coordinates. The
    // agreement alone would survive a revert of both, since they now share one
    // function — which is exactly the trap the original yaw bug was hiding in.
    const members = [
      src({ id: 'a', position: { x: -1.5, y: 0, z: 0.3 } }),
      src({ id: 'b', position: { x: 1.5, y: 2, z: 0.3 } }),
    ];
    const group = grp({ rotationOffsetDeg: 37, offset: { x: 4, y: -2, z: 0.5 }, anchor: { x: 0.5, y: 1, z: 0 } });
    const resolved = resolveAll(members, [group], builtinProvider);

    useStore.setState({ sources: members.map((m) => ({ ...m })), groups: [group] });
    useStore.getState().ungroup('g1');
    const baked = useStore.getState().sources;

    for (let i = 0; i < members.length; i++) {
      expect(baked[i].position.x).toBeCloseTo(resolved[i].position.x, 9);
      expect(baked[i].position.y).toBeCloseTo(resolved[i].position.y, 9);
      expect(baked[i].position.z).toBeCloseTo(resolved[i].position.z, 9);
      expect(baked[i].rotation.azimuthDeg).toBeCloseTo(resolved[i].azimuthDeg, 9);
    }

    // computed by hand from x' = dx·cos37 + dy·sin37, y' = -dx·sin37 + dy·cos37
    // about the anchor (0.5, 1), then translated by the group offset.
    expect(baked[0].position.x).toBeCloseTo(2.300913957, 6);
    expect(baked[0].position.y).toBeCloseTo(-0.595005464, 6);
    expect(baked[1].position.x).toBeCloseTo(5.900450533, 6);
    expect(baked[1].position.y).toBeCloseTo(-0.803179513, 6);
    expect(baked[0].position.z).toBeCloseTo(0.8, 9);
  });

  it('swings the radiated beam by the yaw, not by minus the yaw', () => {
    // The consequence, measured rather than reasoned about. This is the test
    // that was missing: both halves of the transform had coverage, the seam
    // between them did not, and the seam is where the array ended up steered to
    // roughly minus the angle the user typed.
    const members = Array.from({ length: 8 }, (_, i) =>
      src({
        id: `s${i}`,
        speakerId: 'btr-ref-cardioid-218',
        position: { x: (i - 3.5) * 1.4, y: 0, z: 0.5 },
        rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
        levelDb: 0,
        delayS: 0,
      }),
    );

    for (const yaw of [0, 15, 30, 45]) {
      const resolved = resolveAll(members, [grp({ rotationOffsetDeg: yaw })], builtinProvider);
      const { traces } = polarResponse({
        sources: toEngineSources(resolved),
        frequencies: [63],
        speedOfSound: 343,
        radiusM: 3000,
        stepDeg: 0.5,
      });
      // within half a degree of grid resolution of the angle that was asked for
      expect(traces[0].peakAngleDeg).toBeCloseTo(yaw, 0);
    }
  });

  it('a muted group silences its members without muting them individually', () => {
    const s = src();
    const [r] = resolveAll([s], [grp({ mute: true })], builtinProvider);
    expect(r.muted).toBe(true);
    expect(s.mute).toBe(false);
    expect(toEngineSources([r])).toHaveLength(0);
  });

  it('an ungrouped source is unaffected', () => {
    const [r] = resolveAll([src({ groupId: null })], [grp({ offset: { x: 99, y: 99, z: 99 } })], builtinProvider);
    expect(r.position).toEqual({ x: 2, y: 0, z: 0 });
  });
});

describe('engine source conversion', () => {
  it('uses the model max SPL as the 1 m reference', () => {
    const [e] = toEngineSources(resolveAll([src({ groupId: null })], [], builtinProvider));
    expect(e.refSplDb).toBe(143); // KS28
  });

  it('falls back to a documented placeholder when max SPL is unknown', () => {
    const [e] = toEngineSources(
      resolveAll([src({ groupId: null, speakerId: 'does-not-exist' })], [], builtinProvider),
    );
    expect(e.refSplDb).toBe(130);
    expect(e.elements).toBeNull();
  });

  it('passes cardioid elements through for a cardioid model', () => {
    const [e] = toEngineSources(
      resolveAll([src({ groupId: null, speakerId: 'btr-ref-cardioid-218' })], [], builtinProvider),
    );
    expect(e.elements).toHaveLength(2);
    expect(e.normaliseOnAxis).toBe(true);
  });
});

/**
 * The reference is a DRIVE LEVEL, so a difference between two sources is an
 * amplitude ratio that moves nulls. A vendor-imported placeholder used to be
 * driven at a flat 130 dB next to a 143 dB KS28, which is a 13 dB trim nobody
 * asked for.
 */
describe('reference level of an ungraded cabinet', () => {
  /** What a vendor import produces for a cabinet the library does not know. */
  const placeholder: SpeakerModel = {
    id: 'ph-unknown',
    manufacturer: 'Unknown',
    model: 'IMPORTED SUB',
    dimensions: { widthM: null, heightM: null, depthM: null },
    type: 'other',
    maxSpl: null,
    predictionData: { kind: 'omni' },
    dataQuality: 'D',
    isCustom: true,
  };
  const withPlaceholder = new CompositeSpeakerDataProvider(builtinProvider, [placeholder]);

  const graded = src({ id: 'graded', groupId: null, speakerId: 'la-ks28', levelDb: 0 });
  const ungraded = src({ id: 'ungraded', groupId: null, speakerId: 'ph-unknown', levelDb: 0 });

  it('drives it at the loudest graded reference in the same project', () => {
    const resolved = resolveAll([graded, ungraded], [], withPlaceholder);
    const [a, b] = toEngineSources(resolved);
    expect(a.refSplDb).toBe(143); // KS28, published
    expect(b.refSplDb).toBe(143); // borrowed, not a 13 dB trim
    expect(referenceLevels(resolved).substitutedSourceIds).toEqual(['ungraded']);
  });

  it('shares one arbitrary scale when the project grades nothing at all', () => {
    const resolved = resolveAll([ungraded], [], withPlaceholder);
    expect(toEngineSources(resolved)[0].refSplDb).toBe(UNGRADED_REF_SPL_DB);
    expect(referenceLevels(resolved).substituteDb).toBe(UNGRADED_REF_SPL_DB);
  });

  it('does not let muting one cabinet change what another is driven at', () => {
    const resolved = resolveAll([{ ...graded, mute: true }, ungraded], [], withPlaceholder);
    const [b] = toEngineSources(resolved);
    expect(b.id).toBe('ungraded'); // the muted KS28 is not in the engine list
    expect(b.refSplDb).toBe(143);
  });
});
