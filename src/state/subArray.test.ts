import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import type { SpeakerModel } from '../speakers/schema';

const st = () => useStore.getState();

/** btr-ref-omni-18, the library default: a 0.6 m cube of a reference cabinet. */
const REF_H = 0.6;

/** What a vendor import leaves behind: a cabinet with no confirmed dimensions. */
const NO_DIMS: SpeakerModel = {
  id: 'ph-no-dimensions',
  manufacturer: 'Unknown',
  model: 'IMPORTED SUB',
  dimensions: { widthM: null, heightM: null, depthM: null },
  type: 'other',
  maxSpl: null,
  predictionData: { kind: 'omni' },
  dataQuality: 'D',
  isCustom: true,
};

describe('a project can hold more than one sub array', () => {
  beforeEach(() => {
    st().newProject();
    useStore.setState({ undoStack: [], redoStack: [] });
  });

  const makeFirst = () =>
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 8, spacingM: 1.5, axis: 'x' });

  it('creates the array as its own module and selects it', () => {
    const gid = makeFirst();
    expect(gid).toBeTruthy();

    const s = st();
    expect(s.sources).toHaveLength(8);
    expect(s.groups).toHaveLength(1);
    expect(s.selectedGroupId).toBe(gid);
    // every cabinet belongs to the new group and to nothing else
    expect(s.sources.every((x) => x.groupId === gid)).toBe(true);
    expect(s.selectedSourceIds).toHaveLength(8);
  });

  it('lays the cabinets out on the requested axis at the requested spacing', () => {
    makeFirst();
    const xs = st().sources.map((x) => x.position.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(1.5, 9);
    // centred on its own placement, not creeping off in one direction
    expect((xs[0] + xs[xs.length - 1]) / 2).toBeCloseTo(0, 9);
    // only the layout axis varies — the other two stay put
    const ys = new Set(st().sources.map((x) => x.position.y));
    const zs = new Set(st().sources.map((x) => x.position.z));
    expect(ys.size).toBe(1);
    expect(zs.size).toBe(1);
  });

  it('puts the second array clear of the first instead of on top of it', () => {
    makeFirst();
    const firstIds = new Set(st().sources.map((x) => x.id));
    const secondId = st().createSubArray({
      speakerId: DEFAULT_SPEAKER_ID, count: 6, spacingM: 1.2, axis: 'x',
    });

    const s = st();
    expect(s.groups).toHaveLength(2);
    expect(s.sources).toHaveLength(14);
    expect(s.selectedGroupId).toBe(secondId);

    const first = s.sources.filter((x) => firstIds.has(x.id));
    const second = s.sources.filter((x) => !firstIds.has(x.id));
    expect(second.every((x) => x.groupId === secondId)).toBe(true);

    // Offset on the axis the array does NOT run along: continuing along the
    // layout axis would read as one longer array, and would often land outside
    // the prediction area.
    const firstY = first[0].position.y;
    expect(second.every((x) => x.position.y < firstY - 1)).toBe(true);

    // and no cabinet of the second lands on a cabinet of the first
    for (const a of second) {
      for (const b of first) {
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        expect(d).toBeGreaterThan(0.5);
      }
    }
  });

  it('steps the second array along an axis the CURRENT VIEW draws', () => {
    // A flown column is laid out on Z and designed in the side view, which draws
    // Y and Z. Stepping the second one along X would put it out of the drawn
    // section and off the plane the map is computed on: no cabinets, no change
    // to the map, no error either.
    useStore.setState({ sim: { ...st().sim, plane: 'side' } });
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: 0.6, axis: 'z' });
    const firstIds = new Set(st().sources.map((x) => x.id));
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: 0.6, axis: 'z' });

    const s = st();
    const first = s.sources.filter((x) => firstIds.has(x.id));
    const second = s.sources.filter((x) => !firstIds.has(x.id));

    // it moved on a drawn axis, and stayed put on the one that is out of plane
    expect(new Set(s.sources.map((x) => x.position.x)).size).toBe(1);
    const firstY = first[0].position.y;
    expect(second.every((x) => x.position.y !== firstY)).toBe(true);
  });

  it('never puts a second array underground when the only spare axis is height', () => {
    // side view + a layout axis of Y leaves Z as the only drawn cross axis, and
    // 4 m below a ground-stacked sub is below the floor.
    useStore.setState({ sim: { ...st().sim, plane: 'side' } });
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 3, spacingM: 1.4, axis: 'y' });
    const firstIds = new Set(st().sources.map((x) => x.id));
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 3, spacingM: 1.4, axis: 'y' });

    const second = st().sources.filter((x) => !firstIds.has(x.id));
    expect(second.every((x) => x.position.z > 0)).toBe(true);
  });

  it('gives each array its own name, and steers them independently', () => {
    const a = makeFirst();
    const aIds = st().sources.map((x) => x.id);
    const b = st().createSubArray({
      speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: 2, axis: 'x',
    });

    const names = st().groups.map((g) => g.name);
    expect(names).toEqual(['SUB ARRAY 1', 'SUB ARRAY 2']);
    expect(new Set(names).size).toBe(2);

    // a delay written to one module must not touch the other
    st().applyDelayPlan(aIds, {
      delaysS: aIds.map((_, i) => i * 0.001),
      levelsDb: null,
      maxDelayS: 0.007,
    });

    const s = st();
    const inA = s.sources.filter((x) => x.groupId === a);
    const inB = s.sources.filter((x) => x.groupId === b);
    expect(inA.some((x) => x.delayS > 0)).toBe(true);
    expect(inB.every((x) => x.delayS === 0)).toBe(true);
  });

  it('is one undo step', () => {
    makeFirst();
    expect(st().sources).toHaveLength(8);
    st().undo();
    expect(st().sources).toHaveLength(0);
    expect(st().groups).toHaveLength(0);
  });

  it('counts loose cabinets when numbering, so the second array is not called 1', () => {
    // the demo case: sources already on the canvas that were never grouped
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: 1.5, axis: 'x' });
    expect(st().groups.map((g) => g.name)).toEqual(['SUB ARRAY 2']);
  });

  it('never reuses a name a group already has', () => {
    makeFirst();
    st().patchGroup(st().groups[0].id, { name: 'SUB ARRAY 2' });
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: 1.5, axis: 'x' });
    const names = st().groups.map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stands the first array ON the deck, not half through it', () => {
    // A position is the cabinet's GEOMETRIC CENTRE, so a block on the deck is
    // half a box up. An empty canvas has nothing to step off and the fallback
    // centre was z = 0, which buried the bottom half of every cabinet.
    makeFirst();
    expect(st().sources.every((x) => x.position.z === REF_H / 2)).toBe(true);
  });

  it('seats a column by its lowest cabinet', () => {
    st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 4, spacingM: REF_H, axis: 'z' });
    const zs = st().sources.map((x) => x.position.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(REF_H / 2, 9);
    expect(zs[zs.length - 1]).toBeCloseTo(REF_H * 3 + REF_H / 2, 9);
  });

  it('does not halve a height nobody published', () => {
    // Half of an unknown box is unknown. The array stays at z = 0 rather than
    // being placed off a face that was never measured.
    st().addCustomSpeaker(NO_DIMS);
    st().createSubArray({ speakerId: NO_DIMS.id, count: 4, spacingM: 1.5, axis: 'x' });
    expect(st().sources.every((x) => x.position.z === 0)).toBe(true);
  });

  it('refuses to build an array out of no speaker', () => {
    expect(st().createSubArray({ speakerId: '', count: 4, spacingM: 1.5, axis: 'x' })).toBeNull();
    expect(st().sources).toHaveLength(0);
  });
});
