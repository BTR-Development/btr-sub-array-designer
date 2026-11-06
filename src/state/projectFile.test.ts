// @vitest-environment jsdom
/**
 * Everything the project
 * file carries undoes, edits that stream in are one step, a project knows its
 * file and whether it matches it, deleting says so with Undo, an import can
 * add instead of replace, and Save writes back to the file it came from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSource, useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import { setFileHost, type FileHost, type HostFile } from '../platform/fileHost';
import { recentFiles } from '../platform/recentFiles';
import { bindFileUi, guardUnsaved, openRecent, projectFileName, proceed, saveProject } from '../ui/projectFiles';
import { translate } from '../i18n';

const st = () => useStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [], toast: null, pendingConfirm: null });
});
afterEach(() => {
  vi.useRealTimers();
  setFileHost(null);
  bindFileUi(null);
});

describe('undo takes back the prediction settings too', () => {
  it('restores the frequency, the area and the quality with the document', () => {
    st().patchSim({ frequencyHz: 125 });
    vi.advanceTimersByTime(2000);
    st().patchSim({ area: { xMin: -10, xMax: 10, vMin: 0, vMax: 30, planeOffset: 0 } });
    st().undo();
    expect(st().sim.area.xMin).toBe(-100);
    expect(st().sim.frequencyHz).toBe(125);
    st().undo();
    expect(st().sim.frequencyHz).toBe(63);
    st().redo();
    expect(st().sim.frequencyHz).toBe(125);
  });

  it('makes a held slider ONE step, and a pause or another edit a new one', () => {
    for (const f of [70, 80, 90, 100]) {
      st().patchSim({ frequencyHz: f });
      vi.advanceTimersByTime(100);
    }
    expect(st().undoStack).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    st().patchSim({ frequencyHz: 110 });
    expect(st().undoStack).toHaveLength(2);
    // another kind of edit in between breaks the run
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().patchSim({ frequencyHz: 120 });
    expect(st().undoStack).toHaveLength(4);
    st().undo();
    st().undo();
    st().undo();
    expect(st().sim.frequencyHz).toBe(100);
  });

  it('makes typing a project name one step, and undoes it', () => {
    for (const n of ['G', 'Gi', 'Gig']) st().renameProject(n);
    expect(st().undoStack).toHaveLength(1);
    st().undo();
    expect(st().project.name).toBe('Untitled');
  });
});

describe('a project knows its file', () => {
  it('is clean when new, dirty after an edit, clean again once saved', () => {
    expect(st().dirty).toBe(false);
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    expect(st().dirty).toBe(true);
    st().markSaved({ path: '/gigs/a.btrsub', name: 'a.btrsub' });
    expect(st().dirty).toBe(false);
    st().patchSim({ frequencyHz: 50 });
    expect(st().dirty).toBe(true);
  });

  it('gives the old project its old file back when an Open is undone', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().markSaved({ path: '/gigs/a.btrsub', name: 'a.btrsub' });
    // what opening another file does
    st().loadDoc({ project: { name: 'B' }, sources: [], groups: [], measurementPoints: [], customSpeakers: [] });
    st().markSaved({ path: '/gigs/b.btrsub', name: 'b.btrsub' });
    st().undo();
    // Save now must write a.btrsub, not the previous project over b.btrsub
    expect(st().file.path).toBe('/gigs/a.btrsub');
    expect(st().sources).toHaveLength(1);
  });
});

describe('deleting says so, with Undo', () => {
  it('deletes at once and offers to undo exactly that', () => {
    const a = makeSource(DEFAULT_SPEAKER_ID, 'A', { x: 0, y: 0, z: 0 });
    const b = makeSource(DEFAULT_SPEAKER_ID, 'B', { x: 1, y: 0, z: 0 });
    useStore.setState({ sources: [a, b], selectedSourceIds: [a.id, b.id] });
    st().deleteSelected();
    expect(st().sources).toHaveLength(0);
    expect(st().pendingConfirm).toBeNull();
    expect(st().toast).toMatchObject({ message: 'toast.deletedCabinets', vars: { count: 2 } });
    expect(st().toast!.undoDepth).toBe(st().undoStack.length);
  });

  it('says so when a group is deleted with its cabinets', () => {
    const a = makeSource(DEFAULT_SPEAKER_ID, 'A', { x: 0, y: 0, z: 0 });
    useStore.setState({ sources: [a], selectedSourceIds: [a.id] });
    st().groupSelected('ARRAY');
    const g = st().groups[0].id;
    st().deleteGroup(g, true);
    expect(st().sources).toHaveLength(0);
    expect(st().toast).toMatchObject({ message: 'toast.deletedCabinets', vars: { count: 1 } });
  });
});

describe('an import can add to the project', () => {
  it('keeps what is there, renews ids and is one undo step', () => {
    const mine = makeSource(DEFAULT_SPEAKER_ID, 'MINE', { x: 0, y: 0, z: 0 });
    useStore.setState({ sources: [mine], undoStack: [] });
    const theirs = { ...makeSource(DEFAULT_SPEAKER_ID, 'THEIRS', { x: 5, y: 0, z: 0 }), id: mine.id, groupId: 'g', positionKey: 'p1' };
    st().appendDoc({
      project: { name: 'Imported' },
      sources: [theirs],
      groups: [{ id: 'g', name: 'SV', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 0, anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: false }],
      measurementPoints: [],
      customSpeakers: [],
    });
    expect(st().sources.map((s) => s.label)).toEqual(['MINE', 'THEIRS']);
    const added = st().sources[1];
    expect(added.id).not.toBe(mine.id);
    expect(added.groupId).toBe(st().groups[0].id);
    expect(added.groupId).not.toBe('g');
    expect(added.positionKey).not.toBe('p1');
    expect(st().project.name).toBe('Untitled');
    st().undo();
    expect(st().sources.map((s) => s.label)).toEqual(['MINE']);
  });
});

// ── Save, Save as, Open, recent ───────────────────────────────────────────

function fakeHost(over: Partial<FileHost> = {}) {
  const disk = new Map<string, string>();
  const host: FileHost = {
    kind: 'mac',
    canReopen: true,
    open: async () => null,
    read: async (path) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error('no such file');
      return { path, name: path.split('/').pop()!, bytes: new TextEncoder().encode(text) } satisfies HostFile;
    },
    saveAs: async (name, text) => {
      disk.set(`/gigs/${name}`, text);
      return { path: `/gigs/${name}`, name };
    },
    save: async (path, text) => {
      disk.set(path, text);
    },
    ...over,
  };
  setFileHost(host);
  const errors: string[] = [];
  bindFileUi({ t: (k, v) => translate('en', k, v), setError: (e) => e && errors.push(e), setNotice: () => undefined });
  return { disk, host, errors };
}

describe('Save and Open', () => {
  beforeEach(() => localStorage.clear());

  it('asks where the first time, and records the file', async () => {
    const { disk } = fakeHost();
    st().renameProject('Gig 3/11');
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    expect(await saveProject()).toBe(true);
    expect(st().file).toEqual({ path: '/gigs/Gig 3_11.btrsub', name: 'Gig 3_11.btrsub' });
    expect(st().dirty).toBe(false);
    expect(st().toast).toMatchObject({ message: 'toast.saved' });
    expect(JSON.parse(disk.get('/gigs/Gig 3_11.btrsub')!).project.name).toBe('Gig 3/11');
  });

  it('Save writes to the same path without a dialog', async () => {
    const saveAs = vi.fn(async (name: string) => ({ path: `/gigs/${name}`, name }));
    const save = vi.fn(async (_path: string, _text: string) => undefined);
    fakeHost({ saveAs, save });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    await saveProject();
    await saveProject();
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBe('/gigs/Untitled.btrsub');
    // Save as always asks
    await saveProject(true);
    expect(saveAs).toHaveBeenCalledTimes(2);
  });

  it('remembers what was saved and reopens it by path', async () => {
    fakeHost();
    st().renameProject('Arena');
    st().addSource(DEFAULT_SPEAKER_ID, { x: 3, y: 0, z: 0 });
    await saveProject();
    expect(recentFiles().map((r) => r.name)).toEqual(['Arena.btrsub']);

    st().newProject();
    await openRecent('/gigs/Arena.btrsub', 'Arena.btrsub');
    expect(st().project.name).toBe('Arena');
    expect(st().sources[0].position.x).toBe(3);
    expect(st().file.path).toBe('/gigs/Arena.btrsub');
    expect(st().dirty).toBe(false);
  });

  it('drops a recent file that is gone, and says why', async () => {
    const { errors } = fakeHost();
    localStorage.setItem('btr.recentFiles', JSON.stringify([{ path: '/gone.btrsub', name: 'gone.btrsub', at: '' }]));
    await openRecent('/gone.btrsub', 'gone.btrsub');
    expect(recentFiles()).toEqual([]);
    expect(errors[0]).toContain('gone.btrsub');
  });

  it('names old projects in the new format on Save as', () => {
    expect(projectFileName('Gig.btr.json')).toBe('Gig.btrsub');
    expect(projectFileName('Gig.json')).toBe('Gig.btrsub');
    expect(projectFileName('')).toBe('project.btrsub');
  });
});

describe('unsaved work is not thrown away without asking', () => {
  it('asks before New when there is unsaved work, and not when there is none', () => {
    guardUnsaved({ action: 'new' });
    expect(st().pendingConfirm).toBeNull();

    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    guardUnsaved({ action: 'new' });
    expect(st().pendingConfirm).toEqual({ kind: 'discardChanges', then: { action: 'new' } });
    expect(st().sources).toHaveLength(1);

    // Don't save
    useStore.setState({ pendingConfirm: null });
    proceed({ action: 'new' });
    expect(st().sources).toHaveLength(0);
  });

  it('does not ask when the project matches its file', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().markSaved({ path: '/a.btrsub', name: 'a.btrsub' });
    guardUnsaved({ action: 'new' });
    expect(st().pendingConfirm).toBeNull();
    expect(st().sources).toHaveLength(0);
  });
});
