/**
 * Module bookkeeping in the store: what happens to a GROUP when the tools that
 * do not primarily edit groups run over it.
 *
 * Every case here was a real defect. A group is not decoration — it carries a
 * delay, a level, a yaw and a pivot that the prediction and every export read —
 * so a tool that dissolves one, leaves an empty one behind, copies one onto
 * itself or lets its name go stale changes the acoustic result or lies about it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './store';
import { resolveAll } from './resolve';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import type { DelayPlan } from './arrayTools';
import type { Vec3 } from '../core/types';

const st = () => useStore.getState();

const makeArray = (count: number, axis: 'x' | 'y' | 'z' = 'x', spacingM = 1.5): string => {
  const id = st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count, spacingM, axis });
  if (!id) throw new Error('the fixture could not build an array');
  return id;
};

/** A plan of the right length; only that the numbers are non-zero matters here. */
const planFor = (ids: string[]): DelayPlan => ({
  delaysS: ids.map((_, i) => (i + 1) * 0.001),
  levelsDb: null,
  maxDelayS: ids.length * 0.001,
});

const groupById = (id: string) => {
  const g = st().groups.find((x) => x.id === id);
  if (!g) throw new Error(`group ${id} is gone`);
  return g;
};

const otherGroup = (notId: string) => {
  const g = st().groups.filter((x) => x.id !== notId);
  expect(g).toHaveLength(1);
  return g[0];
};

/** Where a module actually sits once its own transform has been applied. */
const resolvedCentre = (groupId: string): Vec3 => {
  const members = resolveAll(st().sources, st().groups, st().provider).filter(
    (r) => r.source.groupId === groupId,
  );
  const n = members.length || 1;
  return {
    x: members.reduce((a, r) => a + r.position.x, 0) / n,
    y: members.reduce((a, r) => a + r.position.y, 0) / n,
    z: members.reduce((a, r) => a + r.position.z, 0) / n,
  };
};

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('steering a selection that spans more than one module', () => {
  it('leaves every existing module standing, with its offsets still applying', () => {
    const a = makeArray(4);
    const b = makeArray(4);
    st().patchGroup(a, { delayOffsetS: 0.01 });
    st().patchGroup(b, { levelOffsetDb: -3, rotationOffsetDeg: 12 });

    // "All sources" in the SUBS panel: no group picked, every cabinet in the plan
    st().selectGroup(null);
    const all = st().sources.map((x) => x.id);
    st().applyDelayPlan(all, planFor(all), { groupAs: 'ARC 90°' });

    const s = st();
    expect(s.groups.map((g) => g.id).sort()).toEqual([a, b].sort());
    expect(s.sources.filter((x) => x.groupId === a)).toHaveLength(4);
    expect(s.sources.filter((x) => x.groupId === b)).toHaveLength(4);
    // the per-array trims are what a sweep into one new group used to throw away
    expect(groupById(a).delayOffsetS).toBeCloseTo(0.01, 12);
    expect(groupById(b).levelOffsetDb).toBe(-3);
    expect(groupById(b).rotationOffsetDeg).toBe(12);
    // the plan itself still reached the cabinets
    expect(s.sources.every((x) => x.delayS > 0)).toBe(true);
    // and the panel stays on "All sources" rather than jumping to a fragment
    expect(s.selectedGroupId).toBeNull();
  });

  it('gathers only the cabinets that belong to nothing', () => {
    const a = makeArray(4);
    st().addSource(DEFAULT_SPEAKER_ID, { x: -6, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: -8, y: 0, z: 0 });

    st().selectGroup(null);
    const all = st().sources.map((x) => x.id);
    st().applyDelayPlan(all, planFor(all), { groupAs: 'END-FIRE' });

    const fresh = otherGroup(a);
    expect(fresh.name).toBe('END-FIRE');
    expect(st().sources.filter((x) => x.groupId === fresh.id)).toHaveLength(2);
    expect(st().sources.filter((x) => x.groupId === a)).toHaveLength(4);
    expect(st().selectedGroupId).toBeNull();
  });

  it('still makes one module out of a wholly loose selection, and selects it', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: -1, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    const all = st().sources.map((x) => x.id);
    st().applyDelayPlan(all, planFor(all), { groupAs: 'ARC 60°' });

    const s = st();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].name).toBe('ARC 60°');
    expect(s.selectedGroupId).toBe(s.groups[0].id);
    expect(s.sources.every((x) => x.groupId === s.groups[0].id)).toBe(true);
  });
});

describe('somewhere to hang a relative delay', () => {
  // The SUBS panel asks ensureGroup for a module when none is picked, which is
  // one keystroke away in the "Delay (rel.)" field of any project holding more
  // than one array.
  it('refuses to build one out of modules that already exist', () => {
    const a = makeArray(4);
    const b = makeArray(4);
    st().patchGroup(a, { delayOffsetS: 0.01 });
    st().patchGroup(b, { levelOffsetDb: -3 });
    st().selectGroup(null);

    const all = st().sources.map((x) => x.id);
    expect(st().ensureGroup(all, 'SUB ARRAY')).toBeNull();

    // Sweeping the selection into a fresh group used to leave a and b behind
    // with their offsets and no members to apply them to — the dissolution
    // applyDelayPlan was taught not to do, reached from the next control along.
    expect(st().groups.map((g) => g.id).sort()).toEqual([a, b].sort());
    expect(st().sources.filter((x) => x.groupId === a)).toHaveLength(4);
    expect(st().sources.filter((x) => x.groupId === b)).toHaveLength(4);
    expect(groupById(a).delayOffsetS).toBeCloseTo(0.01, 12);
    expect(groupById(b).levelOffsetDb).toBe(-3);
  });

  it('refuses to take part of a module away from the rest of it', () => {
    const a = makeArray(4);
    const half = st().sources.slice(0, 2).map((x) => x.id);

    expect(st().ensureGroup(half, 'SUB ARRAY')).toBeNull();
    expect(st().groups).toHaveLength(1);
    expect(st().sources.filter((x) => x.groupId === a)).toHaveLength(4);
  });

  it('hands back the module that already owns exactly those cabinets', () => {
    const a = makeArray(4);
    expect(st().ensureGroup(st().sources.map((x) => x.id), 'SUB ARRAY')).toBe(a);
    expect(st().groups).toHaveLength(1);
  });

  it('still makes one out of cabinets that belong to nothing', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: -1, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });

    const gid = st().ensureGroup(st().sources.map((x) => x.id), 'SUB ARRAY');
    expect(gid).toBeTruthy();
    expect(st().groups).toHaveLength(1);
    expect(st().sources.every((x) => x.groupId === gid)).toBe(true);
    // and the offset it exists for can be written to it
    st().patchGroup(gid!, { delayOffsetS: 0.004 });
    expect(groupById(gid!).delayOffsetS).toBeCloseTo(0.004, 12);
  });
});

describe('a module whose name states an angle', () => {
  const reapply = (name: string) => {
    const ids = st().sources.map((x) => x.id);
    st().applyDelayPlan(ids, planFor(ids), { groupAs: name });
  };

  it('is renamed to the angle actually applied', () => {
    const a = makeArray(4);
    st().patchGroup(a, { name: 'ARC 80°' });
    reapply('ARC 40°');
    expect(groupById(a).name).toBe('ARC 40°');
  });

  it('is renamed when the transform it named is no longer the transform', () => {
    const a = makeArray(4);
    st().patchGroup(a, { name: 'END-FIRE' });
    reapply('SUB -15°');
    expect(groupById(a).name).toBe('SUB -15°');
  });

  it('keeps a name the operator chose, and the one the array was born with', () => {
    const a = makeArray(4);
    expect(groupById(a).name).toBe('SUB ARRAY 1');
    reapply('ARC 40°');
    expect(groupById(a).name).toBe('SUB ARRAY 1');

    st().patchGroup(a, { name: 'LEFT HANG' });
    reapply('ARC 20°');
    expect(groupById(a).name).toBe('LEFT HANG');
  });
});

describe('deleting the cabinets a module is made of', () => {
  it('takes the module record with the last of them', () => {
    makeArray(3);
    st().selectAll();
    st().deleteSelected();

    expect(st().sources).toHaveLength(0);
    expect(st().groups).toHaveLength(0);
    expect(st().selectedGroupId).toBeNull();
    // and nothing empty is written to the file or handed to an exporter
    expect(st().toProject().groups).toHaveLength(0);
  });

  it('keeps the module while it still has a member', () => {
    const a = makeArray(3);
    st().selectSources([st().sources[0].id]);
    st().deleteSelected();

    expect(st().sources).toHaveLength(2);
    expect(st().groups.map((g) => g.id)).toEqual([a]);
  });

  it('gives the module back on undo, offsets and all', () => {
    const a = makeArray(3);
    st().patchGroup(a, { delayOffsetS: 0.004 });
    st().selectAll();
    st().deleteSelected();
    st().undo();

    expect(st().groups).toHaveLength(1);
    expect(st().groups[0].delayOffsetS).toBeCloseTo(0.004, 12);
    expect(st().sources.every((x) => x.groupId === a)).toBe(true);
  });
});

describe('re-grouping cabinets out of the module they were in', () => {
  it('takes the emptied module with them', () => {
    // Re-grouping empties a module exactly the way deleting its cabinets does.
    // A leaves with a 4 ms offset and no members, listed in the module picker
    // and written into the project file and every export.
    const a = makeArray(2);
    st().patchGroup(a, { delayOffsetS: 0.004 });
    st().selectAll();
    st().groupSelected('B');

    const s = st();
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].name).toBe('B');
    expect(s.groups[0].id).not.toBe(a);
    expect(s.sources.every((x) => x.groupId === s.groups[0].id)).toBe(true);
    expect(st().toProject().groups).toHaveLength(1);
  });

  it('keeps the module the cabinets did not all leave', () => {
    const a = makeArray(3);
    st().selectSources([st().sources[0].id]);
    st().groupSelected('B');

    expect(st().groups.map((g) => g.id)).toContain(a);
    expect(st().sources.filter((x) => x.groupId === a)).toHaveLength(2);
  });
});

describe('rebuilding an array that grows', () => {
  it('never labels a new cabinet with a name the array is still using', () => {
    makeArray(4);
    const ids = st().sources.map((x) => x.id);
    st().applyArrayLayout(ids, { count: 7, spacingM: 1.5, axis: 'x', centreM: 0 });

    const labels = st().sources.map((x) => x.label);
    expect(labels).toHaveLength(7);
    expect(new Set(labels).size).toBe(7);
  });
});

describe('rebuilding an array that shrinks', () => {
  it('leaves no empty module behind when the tail it drops was a whole one', () => {
    const a = makeArray(4);
    const b = makeArray(4);

    // "All sources" in the SUBS panel: with no module picked the panel hands the
    // layout tool EVERY cabinet in the project. `layoutSources` reuses members
    // in order and drops the extras, so a count of 4 deletes all four of b.
    st().selectGroup(null);
    const all = st().sources.map((x) => x.id);
    st().applyArrayLayout(all, { count: 4, spacingM: 1.5, axis: 'x', centreM: 0 });

    expect(st().sources).toHaveLength(4);
    expect(st().sources.every((x) => x.groupId === a)).toBe(true);
    // b used to survive here with no members: a module carrying a delay, a level
    // and a yaw, written into every save and every export, that the canvas could
    // not show and no selection could reach.
    expect(st().groups.map((g) => g.id)).toEqual([a]);
    expect(st().groups.map((g) => g.id)).not.toContain(b);
  });

  it('keeps the module it only made smaller', () => {
    // The prune must not reach a module that still has cabinets in it.
    const a = makeArray(4);
    const ids = st().sources.map((x) => x.id);
    st().applyArrayLayout(ids, { count: 2, spacingM: 1.5, axis: 'x', centreM: 0 });

    expect(st().sources).toHaveLength(2);
    expect(st().groups.map((g) => g.id)).toEqual([a]);
  });
});

describe('duplicating a module', () => {
  it('puts the copy beside the original, not inside it', () => {
    const a = makeArray(4);
    const originals = st().sources.map((x) => ({ ...x.position }));
    st().duplicateGroup(a);

    const copy = otherGroup(a);
    const copies = st().sources.filter((x) => x.groupId === copy.id);
    expect(copies).toHaveLength(4);
    // Coincident cabinets sum with no path difference: +6 dB everywhere, and one
    // drawn exactly on top of the other.
    for (const c of copies) {
      for (const o of originals) {
        const d = Math.hypot(c.position.x - o.x, c.position.y - o.y, c.position.z - o.z);
        expect(d).toBeGreaterThan(0.5);
      }
    }
  });

  it('gives the copy its own pivot, so a yaw turns it where it stands', () => {
    const a = makeArray(4);
    st().duplicateGroup(a);
    const copy = otherGroup(a);

    const before = resolvedCentre(copy.id);
    st().patchGroup(copy.id, { rotationOffsetDeg: 90 });
    const after = resolvedCentre(copy.id);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe('pasting a module', () => {
  it('moves its pivot by the same step as its cabinets', () => {
    const a = makeArray(4);
    st().selectGroup(a);
    st().copySelection();
    st().paste();

    const pasted = otherGroup(a);
    const source = groupById(a);
    expect(pasted.anchor.x).toBeCloseTo(source.anchor.x + 1, 9);
    expect(pasted.anchor.y).toBeCloseTo(source.anchor.y + 1, 9);

    const before = resolvedCentre(pasted.id);
    st().patchGroup(pasted.id, { rotationOffsetDeg: 45 });
    const after = resolvedCentre(pasted.id);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});
