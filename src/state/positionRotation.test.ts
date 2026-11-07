// @vitest-environment jsdom
/**
 * Two rules for positions:
 *
 *   1. A position turns as ONE enclosure: four subs on a position swing round
 *      the position centre and stay touching, instead of each turning in place.
 *   2. The F/B pattern is symmetric about the array centre: F B F F on the left
 *      is F F B F on the right.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { measureReversal } from './arrayTools';
import type { Source } from '../core/types';

const st = () => useStore.getState();
const D = 0.719;

/** count positions x 4 KS28 on their side, touching, pattern as given */
function rig(count: number, pattern: string, spacingM = 3.3) {
  st().createSubArray({ speakerId: 'la-ks28', count, spacingM, axis: 'x' });
  st().applyArrayLayout(st().sources.map((x) => x.id), layout(count, pattern, spacingM));
}
function layout(count: number, pattern: string, spacingM: number) {
  return {
    count, spacingM, axis: 'x' as const, centreM: 0, cross: { y: 0, z: 0.67 },
    perPosition: 4, stackPitchM: 0.55, acrossM: 0.55, rollDeg: 90,
    reversePattern: [...pattern].map((c) => c === 'B'), forwardAzimuthDeg: 0,
    reverseDelayS: D / st().sim.speedOfSound,
  };
}
function positions(): Source[][] {
  const by = new Map<string, Source[]>();
  for (const s of st().sources) by.set(s.positionKey!, [...(by.get(s.positionKey!) ?? []), s]);
  const centre = (m: Source[]) => m.reduce((t, s) => t + s.position.x, 0) / m.length;
  return [...by.values()].sort((a, b) => centre(a) - centre(b));
}
/** a position read along its own row (rotation taken out), left to right */
function fb(members: Source[]): string {
  const a = ((members[0].positionYawDeg ?? 0) * Math.PI) / 180;
  const key = (s: Source) => s.position.x * Math.cos(a) - s.position.y * Math.sin(a);
  return [...members].sort((p, q) => key(p) - key(q)).map((s) => (s.invertPolarity ? 'B' : 'F')).join('');
}
const dist = (a: Source, b: Source) =>
  Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('the F/B pattern is symmetric about the array centre', () => {
  it('writes F B F F on the left half and F F B F on the right', () => {
    rig(6, 'FBFF');
    expect(positions().map(fb)).toEqual(['FBFF', 'FBFF', 'FBFF', 'FFBF', 'FFBF', 'FFBF']);
  });

  it('plays the written pattern at the centre position of an odd count', () => {
    rig(3, 'FBFF');
    expect(positions().map(fb)).toEqual(['FBFF', 'FBFF', 'FFBF']);
  });

  it('mirrors the one-click pattern too, and reads the rig back as the left half', () => {
    rig(4, 'FFFF');
    st().setReversalPattern(st().sources.map((x) => x.id), [false, true, false, false], {
      axis: 'x', placeTolM: 0.56, forwardAzimuthDeg: 0, reverseDelayS: D / st().sim.speedOfSound,
    });
    expect(positions().map(fb)).toEqual(['FBFF', 'FBFF', 'FFBF', 'FFBF']);
    const r = measureReversal(st().sources, 'x', 0.56);
    expect(r.describable).toBe(true);
    expect(r.pattern).toEqual([false, true, false, false]);
  });

  it('leaves a stack alone: bottom-up has no left and right', () => {
    st().createSubArray({ speakerId: 'la-ks28', count: 4, spacingM: 3, axis: 'x' });
    st().applyArrayLayout(st().sources.map((x) => x.id), {
      count: 4, spacingM: 3, axis: 'x', centreM: 0, cross: { y: 0, z: 0.55 },
      perPosition: 2, stackPitchM: 0.55, acrossM: 0, rollDeg: 0,
      reversePattern: [false, true], forwardAzimuthDeg: 0, reverseDelayS: D / st().sim.speedOfSound,
    });
    for (const p of positions()) {
      const [lo, hi] = [...p].sort((a, b) => a.position.z - b.position.z);
      expect([lo.invertPolarity, hi.invertPolarity]).toEqual([false, true]);
    }
  });
});

describe('a position turns as one enclosure', () => {
  it('swings its cabinets round the position centre, touching, all by the same angle', () => {
    rig(4, 'FBFF');
    const [p0, p1] = positions();
    const before = p1.map((s) => ({ ...s }));
    useStore.setState({ undoStack: [], redoStack: [] });
    st().rotatePositions([p1[0].id], 30);
    const after = positions()[1];
    // the centre stays, the row stays rigid (still touching), every heading +30
    const cx = (m: Source[]) => m.reduce((t, s) => t + s.position.x, 0) / m.length;
    const cy = (m: Source[]) => m.reduce((t, s) => t + s.position.y, 0) / m.length;
    expect(cx(after)).toBeCloseTo(cx(before), 9);
    expect(cy(after)).toBeCloseTo(cy(before), 9);
    for (let i = 0; i < after.length; i++) {
      for (let j = 0; j < after.length; j++) {
        expect(dist(after[i], after[j])).toBeCloseTo(dist(before[i], before[j]), 9);
      }
      const was = before.find((s) => s.id === after[i].id)!;
      expect(after[i].rotation.azimuthDeg - was.rotation.azimuthDeg).toBeCloseTo(30, 9);
      expect(after[i].positionYawDeg).toBe(30);
    }
    // a row turned by 30 deg is no longer flat on X: it has depth now
    expect(Math.max(...after.map((s) => s.position.y)) - Math.min(...after.map((s) => s.position.y))).toBeGreaterThan(0.5);
    // the neighbour did not move
    expect(positions()[0].map((s) => s.position)).toEqual(p0.map((s) => s.position));
    // and it is one undo step
    expect(st().undoStack.length).toBe(1);
  });

  it('keeps its angle, its shape and its pattern through a re-layout', () => {
    rig(4, 'FBFF');
    const p1 = positions()[1];
    st().rotatePositions([p1[0].id], -40);
    // the spacing slider rebuilds every position from scratch
    st().applyArrayLayout(st().sources.map((x) => x.id), layout(4, 'FBFF', 4.0));
    const after = positions();
    expect(after[1].every((s) => s.positionYawDeg === -40)).toBe(true);
    expect(after[0].every((s) => !s.positionYawDeg)).toBe(true);
    // still touching, 0.55 m apart along its own row
    const gaps = after[1].map((s) => Math.min(...after[1].filter((o) => o !== s).map((o) => dist(s, o))));
    for (const g of gaps) expect(g).toBeCloseTo(0.55, 6);
    expect(after[1]).toHaveLength(4);
    // the same cabinet is still the B one, read along the turned row
    expect(after.map(fb)).toEqual(['FBFF', 'FBFF', 'FFBF', 'FFBF']);
    // headings: forward boxes at -40, the reversed one at 140
    for (const s of after[1]) expect(((s.rotation.azimuthDeg % 360) + 360) % 360).toBeCloseTo(s.invertPolarity ? 140 : 320, 6);
  });

  it('turned half way round, the B cabinet is still the one the pattern names', () => {
    rig(2, 'FBFF');
    const p0 = positions()[0];
    const bId = p0.find((s) => s.invertPolarity)!.id;
    st().rotatePositions([p0[0].id], 180);
    st().applyArrayLayout(st().sources.map((x) => x.id), layout(2, 'FBFF', 3.3));
    const again = positions()[0];
    expect(again.find((s) => s.invertPolarity)!.id).toBe(bId);
    expect(measureReversal(st().sources, 'x', 0.56).describable).toBe(true);
  });

});
