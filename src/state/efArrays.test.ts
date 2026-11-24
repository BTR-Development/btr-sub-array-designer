/**
 * End-fire blocks, as rebuilt on 8.11.2026: the rows are read from where the
 * cabinets stand along the aim, the delays follow from the rows and are kept
 * right on every change, and the user's Delay column is never touched (except
 * by the explicit "convert to free cabinets").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSource, useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import type { Source } from '../core/types';
import { efLayout, nextEfName, rowsAlong, spacingForHz, worldDeltaToLocal } from './efArrays';
import { resolveAll } from './resolve';
import { parseBTRProject } from '../io/btrJson';

const st = () => useStore.getState();
const c = () => st().sim.speedOfSound;
const byId = (id: string) => st().sources.find((x) => x.id === id)!;
const totalDelay = (id: string) =>
  resolveAll(st().sources, st().groups, st().provider).find((r) => r.source.id === id)!.delayS;

/** One row of `n` cabinets across X at depth `y`, facing +Y. */
function row(n: number, y: number, label = 'S'): Source[] {
  return Array.from({ length: n }, (_, i) =>
    makeSource(DEFAULT_SPEAKER_ID, `${label}${y}_${i}`, { x: i * 1.5, y, z: 0.3 }),
  );
}

function put(sources: Source[]) {
  useStore.setState({ sources, selectedSourceIds: sources.map((x) => x.id), undoStack: [] });
}

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [], toast: null });
});

describe('making a block from one row', () => {
  it('builds the rows behind the front row, one undo step, all selected', () => {
    put(row(2, 0));
    const id = st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 3, spacingM: 1, targetHz: 86 });
    expect(id).toBeTruthy();
    expect(st().sources).toHaveLength(6);
    expect(st().sources.map((x) => x.position.y).sort((a, b) => a - b)).toEqual([-2, -2, -1, -1, 0, 0]);
    expect(st().sources.every((x) => x.ef?.arrayId === id)).toBe(true);
    expect(st().selectedSourceIds).toHaveLength(6);
    expect(st().efArrays[0]).toMatchObject({ name: 'EF 1', aimDeg: 0, targetHz: 86 });
    expect(new Set(st().sources.map((x) => x.label)).size).toBe(6);
    expect(st().undoStack).toHaveLength(1);
    st().undo();
    expect(st().sources).toHaveLength(2);
    expect(st().efArrays).toHaveLength(0);
  });

  it('builds behind along the aim, whatever the aim', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 90, rows: 3, spacingM: 1.2, targetHz: null });
    const xs = st().sources.map((x) => x.position.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-2.4, 9);
    expect(xs[1]).toBeCloseTo(-1.2, 9);
    expect(st().sources.every((x) => Math.abs(x.position.y) < 1e-9)).toBe(true);
  });

  it('builds in the world even for a member of a turned group', () => {
    const s = makeSource(DEFAULT_SPEAKER_ID, 'G', { x: 0, y: 0, z: 0.3 });
    s.groupId = 'g';
    useStore.setState({
      groups: [
        { id: 'g', name: 'G', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 30, anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: false },
      ],
    });
    put([s]);
    st().createEndFire({ ids: [s.id], aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const world = resolveAll(st().sources, st().groups, st().provider).map((r) => r.position);
    const behind = world.find((p) => p.y < -0.5)!;
    expect(behind.x).toBeCloseTo(0, 9);
    expect(behind.y).toBeCloseTo(-1, 9);
  });

  it('uses cabinets that already stand in rows as they stand', () => {
    put([...row(2, 0), ...row(2, -1.1)]);
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 5, spacingM: 1, targetHz: null });
    expect(st().sources).toHaveLength(4);
    expect(st().sources.every((x) => x.ef)).toBe(true);
  });

  it('refuses a cabinet that already belongs to a block, and says so', () => {
    put(row(2, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const n = st().sources.length;
    expect(st().createEndFire({ ids: [st().sources[0].id], aimDeg: 0, rows: 3, spacingM: 1, targetHz: null })).toBeNull();
    expect(st().sources).toHaveLength(n);
    expect(st().toast?.message).toBe('ef.alreadyAssigned');
  });

  it('frees a dissolved block’s number for the next one', () => {
    expect(nextEfName([{ name: 'EF 1' }, { name: 'EF 3' }])).toBe('EF 2');
  });
});

describe('the delays', () => {
  it('rear row 0, each row in front later by its distance over c, outside the Delay column', () => {
    put([...row(2, 0), ...row(2, -1), ...row(2, -2)]);
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 3, spacingM: 1, targetHz: null });
    const [f0, f1, m0, , r0] = st().sources;
    expect(byId(r0.id).efDelayS).toBeCloseTo(0, 12);
    expect(byId(m0.id).efDelayS).toBeCloseTo(1 / c(), 12);
    expect(byId(f0.id).efDelayS).toBeCloseTo(2 / c(), 12);
    expect(byId(f1.id).efDelayS).toBe(byId(f0.id).efDelayS);
    expect(st().sources.every((x) => x.delayS === 0)).toBe(true);
    // the engine, the tables and the exporters read it through the resolver
    expect(totalDelay(f0.id)).toBeCloseTo(2 / c(), 12);
  });

  it('follow a moved row and a change of temperature, without history', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const front = st().sources[0].id;
    const depth = st().undoStack.length;
    st().moveSources([front], { x: 0, y: 0.5, z: 0 }, false);
    expect(byId(front).efDelayS).toBeCloseTo(1.5 / c(), 12);
    st().patchSim({ temperatureC: 35 });
    expect(byId(front).efDelayS).toBeCloseTo(1.5 / c(), 12);
    expect(st().undoStack.length).toBeGreaterThanOrEqual(depth);
  });

  it('add up with the Delay column and a group offset', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const front = st().sources[0].id;
    st().patchSources([front], { delayS: 0.002 });
    expect(totalDelay(front)).toBeCloseTo(0.002 + 1 / c(), 12);
  });

  it('go when a cabinet leaves the block or the block is dissolved', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 3, spacingM: 1, targetHz: null });
    const front = st().sources[0].id;
    st().removeFromEf([front]);
    expect(byId(front).ef).toBeUndefined();
    expect(byId(front).efDelayS).toBeUndefined();
    st().deleteEfArray(st().efArrays[0].id);
    expect(st().sources.every((x) => x.ef === undefined && x.efDelayS === undefined)).toBe(true);
    st().undo();
    expect(st().sources.filter((x) => x.efDelayS !== undefined)).toHaveLength(2);
  });

  it('can be kept as plain numbers: convert to free cabinets', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const front = st().sources[0].id;
    st().patchSources([front], { delayS: 0.001 });
    st().bakeEfArray(st().efArrays[0].id);
    expect(st().efArrays).toHaveLength(0);
    expect(byId(front).delayS).toBeCloseTo(0.001 + 1 / c(), 12);
    expect(byId(front).efDelayS).toBeUndefined();
    expect(totalDelay(front)).toBeCloseTo(0.001 + 1 / c(), 12);
  });

  it('a cabinet added later takes its row from where it stands', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    const extra = makeSource(DEFAULT_SPEAKER_ID, 'X', { x: 3, y: -1.1, z: 0.3 });
    useStore.setState({ sources: [...st().sources, extra] });
    st().addToEf([extra.id], st().efArrays[0].id);
    const l = efLayout(resolveAll(st().sources, st().groups, st().provider), st().efArrays[0], c());
    expect(l.rows).toHaveLength(2);
    expect(l.rows[1].ids).toContain(extra.id);
  });

  it('a duplicate and a pasted copy arrive outside the block', () => {
    put(row(1, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 2, spacingM: 1, targetHz: null });
    st().selectSources([st().sources[0].id]);
    st().duplicateSelected();
    const dup = st().sources[st().sources.length - 1];
    expect(dup.ef).toBeUndefined();
    expect(dup.efDelayS).toBeUndefined();
    st().selectSources([st().sources[0].id]);
    st().copySelection();
    st().paste();
    expect(st().sources[st().sources.length - 1].ef).toBeUndefined();
  });
});

describe('reading a block', () => {
  it('finds rows along the aim, front first, within the row tolerance', () => {
    const pts = [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 2, y: 0.1 } },
      { id: 'c', position: { x: 0, y: -1 } },
    ];
    expect(rowsAlong(pts, 0).map((r) => r.ids)).toEqual([['b', 'a'], ['c']]);
    // seen along X the same points are three rows
    expect(rowsAlong(pts, 90)).toHaveLength(2);
  });

  it('says what the spacing is tuned for, and warns about the things worth warning about', () => {
    const subs = [...row(1, 0), ...row(1, -1), ...row(1, -2.6)];
    subs[2].rotation.azimuthDeg = 180;
    useStore.setState({ sources: subs.map((x) => ({ ...x, ef: { arrayId: 'e' } })) });
    const l = efLayout(
      resolveAll(st().sources, st().groups, st().provider),
      { id: 'e', name: 'EF 1', aimDeg: 0, targetHz: null },
      343,
    );
    expect(l.gapsM.map((g) => +g.toFixed(6))).toEqual([1, 1.6]);
    expect(l.tunedHz).toBeCloseTo(343 / (4 * 1.3), 9);
    expect(l.uneven).toBe(true);
    expect(l.offAimIds).toEqual([subs[2].id]);
  });

  it('respaces the rows behind the front row to λ/4', () => {
    put([...row(1, 0), ...row(1, -0.8), ...row(1, -1.9)]);
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 3, spacingM: 1, targetHz: null });
    const d = spacingForHz(80, c());
    st().respaceEf(st().efArrays[0].id, d);
    const ys = st().sources.map((x) => x.position.y);
    expect(ys[0]).toBe(0);
    expect(ys[1]).toBeCloseTo(-d, 9);
    expect(ys[2]).toBeCloseTo(-2 * d, 9);
    expect(st().efArrays[0].targetHz).toBeCloseTo(80, 9);
  });

  it('turns a movement in the world into a turned group’s own frame', () => {
    const g = { id: 'g', name: 'G', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 90, anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: false };
    const l = worldDeltaToLocal({ x: 0, y: -1, z: 0 }, g);
    // the group turns its own +X onto the world's −Y
    expect(l.x).toBeCloseTo(1, 9);
    expect(l.y).toBeCloseTo(0, 9);
  });
});

describe('the file', () => {
  it('survives a save and open round trip', () => {
    put(row(2, 0));
    st().createEndFire({ ids: st().selectedSourceIds, aimDeg: 0, rows: 3, spacingM: 1, targetHz: 86 });
    st().patchEfArray(st().efArrays[0].id, { aimDeg: 5 });
    const p = parseBTRProject(JSON.stringify(st().toProject()));
    expect(p.efArrays).toEqual(st().efArrays);
    expect(p.sources.filter((x) => x.ef?.arrayId === st().efArrays[0].id)).toHaveLength(6);
  });

  it('drops a membership whose block the file does not have', () => {
    const p = parseBTRProject(
      JSON.stringify({
        format: 'btr-sub-array',
        version: 2,
        project: { name: 'X' },
        efArrays: [{ id: 'ef1', name: 'EF 1', aimDeg: 0, targetHz: null }],
        sources: [
          { id: 'a', label: 'A', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, ef: { arrayId: 'ef1' } },
          { id: 'b', label: 'B', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, ef: { arrayId: 'missing' } },
        ],
        simulationSettings: {},
      }),
    );
    expect(p.sources.find((x) => x.id === 'a')!.ef).toEqual({ arrayId: 'ef1' });
    expect(p.sources.find((x) => x.id === 'b')!.ef).toBeUndefined();
  });

  it('takes the old hand-applied delays out of the Delay column, and only those', () => {
    const C = 343.2;
    const p = parseBTRProject(
      JSON.stringify({
        format: 'btr-sub-array',
        version: 2,
        project: { name: 'X' },
        efArrays: [{ id: 'ef1', name: 'EF 1', rows: 2 }],
        sources: [
          { id: 'f', label: 'F', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: 0, z: 0 }, delayS: 1 / C, ef: { arrayId: 'ef1', row: 1 } },
          { id: 'r', label: 'R', speakerId: DEFAULT_SPEAKER_ID, position: { x: 0, y: -1, z: 0 }, delayS: 0, ef: { arrayId: 'ef1', row: 2 } },
          { id: 'g', label: 'G', speakerId: DEFAULT_SPEAKER_ID, position: { x: 2, y: 0, z: 0 }, delayS: 0.005, ef: { arrayId: 'ef1', row: 1 } },
        ],
        simulationSettings: { speedOfSound: C },
      }),
    );
    expect(p.efArrays?.[0]).toEqual({ id: 'ef1', name: 'EF 1', aimDeg: 0, targetHz: null });
    expect(p.sources.find((x) => x.id === 'f')!.delayS).toBe(0);
    // typed in by hand since: not what the old button wrote, so it stays
    expect(p.sources.find((x) => x.id === 'g')!.delayS).toBe(0.005);
  });
});
