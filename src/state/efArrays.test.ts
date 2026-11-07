/**
 * End-fired arrays: the container, the hand-filled rows and their two rules —
 * nothing is overwritten (an occupied row refuses, an assigned cabinet
 * refuses) and nothing is copied (a duplicate arrives released). The delays
 * come from where the rows stand, not from the row numbers.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSource, useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import { EF_MAX_ARRAYS, EF_MAX_ROWS, type Source } from '../core/types';
import { efRowMeansY, efRowsOutOfOrder, nextEfName } from './efArrays';
import { resolveAll } from './resolve';
import { parseBTRProject } from '../io/btrJson';

const st = () => useStore.getState();

/** One cabinet per metre of Y, nearest the audience (largest Y) first. */
function rowOfSubs(ys: number[]): Source[] {
  return ys.map((y, i) => makeSource(DEFAULT_SPEAKER_ID, `SUB ${i + 1}`, { x: 0, y, z: 0.3 }));
}

function seedEf(rows = 3): string {
  const id = st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
  st().createArray({ sourceId: id, count: 2, spacingM: 2, axis: 'x', centered: true, efRows: rows });
  return st().efArrays[0].id;
}

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [], toast: null });
});

describe('the container', () => {
  it('rides array creation as one undo step, and undoes with it', () => {
    seedEf(4);
    expect(st().efArrays).toHaveLength(1);
    expect(st().efArrays[0]).toMatchObject({ name: 'EF 1', rows: 4 });
    const depth = st().undoStack.length;
    st().undo();
    expect(st().efArrays).toHaveLength(0);
    expect(st().undoStack.length).toBe(depth - 1);
  });

  it('refuses the eleventh array and says so', () => {
    for (let i = 0; i < EF_MAX_ARRAYS + 1; i++) seedEf(2);
    expect(st().efArrays).toHaveLength(EF_MAX_ARRAYS);
    expect(st().toast?.message).toBe('arr.efLimit');
  });

  it('clamps the rows to the limit', () => {
    seedEf(99);
    expect(st().efArrays[0].rows).toBe(EF_MAX_ROWS);
  });

  it('frees a deleted array’s number for the next one', () => {
    expect(nextEfName([{ id: 'a', name: 'EF 1', rows: 2 }, { id: 'b', name: 'EF 3', rows: 2 }])).toBe(
      'EF 2',
    );
  });
});

describe('assigning rows', () => {
  it('assigns the selection to a free row, with Undo offered', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0, -2]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    const assigned = st().sources.find((x) => x.id === subs[0].id)!;
    expect(assigned.ef).toEqual({ arrayId: efId, row: 1 });
    expect(st().toast?.message).toBe('toast.efAssigned');
    expect(st().toast?.undoDepth).toBe(st().undoStack.length);
  });

  it('never overwrites an occupied row', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0, -2]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().assignToEf([subs[1].id], efId, 1);
    expect(st().sources.find((x) => x.id === subs[1].id)!.ef).toBeUndefined();
    expect(st().toast?.message).toBe('ef.noOverwrite');
  });

  it('never moves an assigned cabinet to another row or array in silence', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0, -2]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().assignToEf([subs[0].id], efId, 2);
    expect(st().sources.find((x) => x.id === subs[0].id)!.ef!.row).toBe(1);
    expect(st().toast?.message).toBe('ef.alreadyAssigned');
  });

  it('released cabinets can be assigned again', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().releaseFromEf([subs[0].id]);
    expect(st().sources.find((x) => x.id === subs[0].id)!.ef).toBeUndefined();
    st().assignToEf([subs[0].id], efId, 2);
    expect(st().sources.find((x) => x.id === subs[0].id)!.ef!.row).toBe(2);
  });

  it('deleting the array releases its cabinets', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().deleteEfArray(efId);
    expect(st().efArrays).toHaveLength(0);
    expect(st().sources.find((x) => x.id === subs[0].id)!.ef).toBeUndefined();
  });

  it('a duplicate and a pasted copy arrive released', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().selectSources([subs[0].id]);
    st().duplicateSelected();
    const dup = st().sources[st().sources.length - 1];
    expect(dup.id).not.toBe(subs[0].id);
    expect(dup.ef).toBeUndefined();
    st().selectSources([subs[0].id]);
    st().copySelection();
    st().paste();
    const pasted = st().sources[st().sources.length - 1];
    expect(pasted.ef).toBeUndefined();
  });
});

describe('the delays', () => {
  it('farthest row first, each nearer row later by distance over c', () => {
    const efId = seedEf(3);
    // audience is +Y: row 1 at y 0 is nearest, row 3 at y -4 farthest
    const subs = rowOfSubs([0, 0, -2, -2, -4, -4]);
    subs[1].position.x = 2;
    subs[3].position.x = 2;
    subs[5].position.x = 2;
    useStore.setState({ sources: [...st().sources.filter((x) => !x.label.startsWith('SUB')), ...subs] });
    st().assignToEf([subs[0].id, subs[1].id], efId, 1);
    st().assignToEf([subs[2].id, subs[3].id], efId, 2);
    st().assignToEf([subs[4].id, subs[5].id], efId, 3);
    st().applyEfDelays(efId);
    const c = st().sim.speedOfSound;
    const by = (id: string) => st().sources.find((x) => x.id === id)!.delayS;
    expect(by(subs[4].id)).toBeCloseTo(0, 12);
    expect(by(subs[2].id)).toBeCloseTo(2 / c, 12);
    expect(by(subs[0].id)).toBeCloseTo(4 / c, 12);
    // every cabinet of a row carries the row's delay
    expect(by(subs[1].id)).toBe(by(subs[0].id));
    expect(st().toast?.message).toBe('toast.efDelays');
  });

  it('does nothing below two occupied rows', () => {
    const efId = seedEf(3);
    const subs = rowOfSubs([0]);
    useStore.setState({ sources: [...st().sources, ...subs], undoStack: [] });
    st().assignToEf([subs[0].id], efId, 1);
    const depth = st().undoStack.length;
    st().applyEfDelays(efId);
    expect(st().undoStack.length).toBe(depth);
  });

  it('flags row numbers that disagree with the geometry', () => {
    const efId = seedEf(2);
    // row 1 must be nearest the audience; here it is the farther one
    const subs = rowOfSubs([-4, 0]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 1);
    st().assignToEf([subs[1].id], efId, 2);
    const means = efRowMeansY(resolveAll(st().sources, st().groups, st().provider), efId);
    expect(efRowsOutOfOrder(means)).toBe(true);
  });
});

describe('the file', () => {
  it('survives a save and open round trip', () => {
    const efId = seedEf(5);
    const subs = rowOfSubs([0, -2]);
    useStore.setState({ sources: [...st().sources, ...subs] });
    st().assignToEf([subs[0].id], efId, 2);
    const p = parseBTRProject(JSON.stringify(st().toProject()));
    expect(p.efArrays).toEqual(st().efArrays);
    expect(p.sources.find((x) => x.id === subs[0].id)!.ef).toEqual({ arrayId: efId, row: 2 });
  });

  it('drops an assignment whose array or row the file does not have', () => {
    const text = JSON.stringify({
      format: 'btr-sub-array',
      version: 2,
      project: { name: 'X' },
      efArrays: [{ id: 'ef1', name: 'EF 1', rows: 2 }],
      sources: [
        { id: 'a', label: 'A', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, ef: { arrayId: 'ef1', row: 7 } },
        { id: 'b', label: 'B', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, ef: { arrayId: 'missing', row: 1 } },
        { id: 'c', label: 'C', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, ef: { arrayId: 'ef1', row: 2 } },
      ],
      simulationSettings: {},
    });
    const p = parseBTRProject(text);
    expect(p.sources.find((x) => x.id === 'a')!.ef).toBeUndefined();
    expect(p.sources.find((x) => x.id === 'b')!.ef).toBeUndefined();
    expect(p.sources.find((x) => x.id === 'c')!.ef).toEqual({ arrayId: 'ef1', row: 2 });
  });
});
