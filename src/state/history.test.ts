/**
 * Undo, which the whole suite had one assertion about.
 *
 * Undo is not a feature of this program so much as the condition under which
 * every other feature is usable: an operator tries a steering angle, a taper or
 * a layout precisely because Cmd+Z is there. Three rules hold it up and none of
 * them was pinned.
 *
 *  - `history: false` — a drag is ONE entry. The caller takes a snapshot when
 *    the pointer goes down and then writes hundreds of times without one, so a
 *    write that snapshots on its own turns a single move into a mouse-wheel of
 *    undos, and a write that never snapshots loses the move entirely.
 *  - `MAX_HISTORY` — the stack is bounded, and it has to shed its OLDEST entry.
 *    Shedding the newest instead caps undo at the first hundred edits of the
 *    session and is invisible until an operator has made a hundred and one.
 *  - the snapshot boundary — an entry is the state BEFORE the action, and it is
 *    a copy of it. Sharing the live objects means the entry drifts along with
 *    the project and undo restores the state it was supposed to leave.
 *
 * What is deliberately NOT restored matters just as much: the selection, the
 * view, the language and the simulation settings are not the document, and an
 * undo that rewound the frequency slider or the camera would be unusable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';

const st = () => useStore.getState();

/** The x of the first cabinet — the value every edit below moves. */
const x = () => st().sources[0].position.x;

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('what one undo undoes', () => {
  it('goes back to before the action, not to the middle of it', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    expect(st().sources).toHaveLength(1);
    const id = st().sources[0].id;

    st().undo();
    expect(st().sources).toHaveLength(0);

    st().redo();
    expect(st().sources).toHaveLength(1);
    expect(st().sources[0].id).toBe(id);
  });

  it('is a whole drag, however many writes the drag made', () => {
    // The canvas takes one snapshot on pointer-down and then writes on every
    // pointer-move with history off. Fifty mouse-moves are one entry.
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const id = st().sources[0].id;

    st().snapshot();
    for (let i = 1; i <= 50; i++) {
      st().patchSources([id], { position: { x: i * 0.1, y: 0, z: 0 } }, false);
    }
    expect(st().undoStack).toHaveLength(1);
    expect(x()).toBeCloseTo(5, 9);

    st().undo();
    expect(x()).toBe(0);
    expect(st().undoStack).toHaveLength(0);
  });

  it('records an edit that does not say otherwise', () => {
    // The flag defaults to true, so every ordinary write from a field or a
    // menu is undoable without the caller having to remember.
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const id = st().sources[0].id;

    st().patchSources([id], { levelDb: -3 });
    st().moveSources([id], { x: 1, y: 0, z: 0 });
    expect(st().undoStack).toHaveLength(2);

    st().undo();
    expect(x()).toBe(0);
    st().undo();
    expect(st().sources[0].levelDb).toBe(0);
  });

  it('throws away the redo branch as soon as a new edit lands on it', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    const id = st().sources[0].id;
    st().moveSources([id], { x: 5, y: 0, z: 0 });
    st().undo();
    expect(st().redoStack).toHaveLength(1);

    st().moveSources([id], { x: -5, y: 0, z: 0 });
    expect(st().redoStack).toHaveLength(0);
    // and redo is now a no-op rather than a jump onto the abandoned branch
    st().redo();
    expect(x()).toBe(-5);
  });

  it('does nothing at all at the ends of the stack', () => {
    expect(() => st().undo()).not.toThrow();
    expect(() => st().redo()).not.toThrow();
    expect(st().sources).toHaveLength(0);
  });
});

describe('the bound on the stack', () => {
  /** `n` separate edits, each nudging the cabinet one metre along X. */
  function edits(n: number): void {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const id = st().sources[0].id;
    for (let i = 0; i < n; i++) st().moveSources([id], { x: 1, y: 0, z: 0 });
  }

  it('holds a hundred entries and not one more', () => {
    edits(100);
    expect(st().undoStack).toHaveLength(100);
    edits(101);
    expect(st().undoStack).toHaveLength(100);
  });

  it('forgets the oldest edit, so the hundred most recent survive', () => {
    // 150 edits, so the cabinet is at x = 150 and the fifty oldest entries are
    // gone. Undoing all hundred that remain must land on x = 50 — the state
    // the fifty-first edit started from. Dropping the NEWEST entry instead
    // (pop where the code shifts) would freeze the stack at the first hundred
    // states and walk back to x = 0.
    edits(150);
    expect(x()).toBe(150);

    for (let i = 0; i < 100; i++) st().undo();
    expect(x()).toBe(50);
    expect(st().undoStack).toHaveLength(0);

    // and the horizon is a wall, not a wrap
    st().undo();
    expect(x()).toBe(50);
  });

  it('walks back one edit at a time on the way there', () => {
    edits(150);
    for (let i = 149; i >= 50; i--) {
      st().undo();
      expect(x(), `after undoing edit ${i + 1}`).toBe(i);
    }
  });
});

describe('an entry is a copy, not a view', () => {
  it('shares no object with the project it was taken from', () => {
    // cloneDoc exists for this. An entry holding the live source objects tracks
    // every later edit, and undo then "restores" the state it was meant to
    // leave — which looks like undo doing nothing at all.
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 2, z: 3 });
    useStore.setState({ undoStack: [], redoStack: [] });
    st().snapshot();

    const entry = st().undoStack[0];
    expect(entry.sources).not.toBe(st().sources);
    expect(entry.sources[0]).not.toBe(st().sources[0]);
    expect(entry.sources[0].position).not.toBe(st().sources[0].position);
    expect(entry.sources[0].rotation).not.toBe(st().sources[0].rotation);
    expect(entry.project).not.toBe(st().project);
    // and it is the same VALUES, so the copy is a copy and not a blank
    expect(entry.sources[0].position).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('keeps two successive edits distinct rather than collapsing them', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const id = st().sources[0].id;

    st().moveSources([id], { x: 3, y: 0, z: 0 });
    st().moveSources([id], { x: 4, y: 0, z: 0 });
    expect(x()).toBe(7);
    st().undo();
    expect(x()).toBe(3);
    st().undo();
    expect(x()).toBe(0);
  });
});

describe('what undo does not touch', () => {
  it('leaves the interface where the operator put it', () => {
    // The camera, the selection tool and the language are not the document.
    // Rewinding them with it makes undo unusable: an operator who nudges a
    // cabinet and presses Cmd+Z would also lose their zoom. (The frequency
    // used to be on this list; the prediction settings are
    // part of the project and undo like it — see the next block.)
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    const id = st().sources[0].id;
    st().moveSources([id], { x: 2, y: 0, z: 0 });

    st().setView({ scale: 40, cx: 11, cy: 22 });
    useStore.setState({ lang: 'pl', showDebug: true });

    st().undo();
    expect(x()).toBe(0);
    expect(st().view).toEqual({ scale: 40, cx: 11, cy: 22 });
    expect(st().lang).toBe('pl');
    expect(st().showDebug).toBe(true);

    useStore.setState({ lang: 'en', showDebug: false });
  });

  it('never leaves a selection pointing at something that is gone', () => {
    // The Inspector reads the selection to decide what to draw. A selected id
    // with no cabinet behind it is a panel describing a box that is not there.
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    const second = st().sources[1].id;
    expect(st().selectedSourceIds).toEqual([second]);

    st().undo();
    expect(st().sources).toHaveLength(1);
    expect(st().selectedSourceIds).toEqual([]);
  });

  it('drops a module and a measurement point from the selection the same way', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    st().selectSources(st().sources.map((s) => s.id));
    st().groupSelected('ARRAY');
    expect(st().selectedGroupId).not.toBeNull();

    st().undo();
    expect(st().groups).toHaveLength(0);
    expect(st().selectedGroupId).toBeNull();

    st().addMeasurementPoint({ x: 0, y: 10, z: 1.7 });
    const mp = st().selectedPointId;
    expect(mp).not.toBeNull();
    st().undo();
    expect(st().measurementPoints).toHaveLength(0);
    expect(st().selectedPointId).toBeNull();
  });
});

describe('what redo must not leave behind either', () => {
  // Redo installs a document the current selection was never made against in
  // exactly the way undo does, and it repaired only the source list — the rule
  // existed in two copies and the second was missing two thirds of it. The
  // sequences below are the ones an operator actually performs: make an edit,
  // step back to look at what was there, click the thing that reappeared, then
  // step forward again.
  it('clears a module the redone document no longer has', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    st().selectSources(st().sources.map((s) => s.id));
    st().groupSelected('ARRAY');
    const g = st().selectedGroupId;
    expect(g).not.toBeNull();

    st().ungroup(g!);
    st().undo();
    expect(st().groups).toHaveLength(1);
    st().selectGroup(g!);

    st().redo();
    expect(st().groups).toHaveLength(0);
    // A module id with no module behind it is what the SUBS panel drives its
    // steering, taper and relative delay from, so this is not cosmetic.
    expect(st().selectedGroupId).toBeNull();
  });

  it('clears a measurement point the redone document no longer has', () => {
    st().addMeasurementPoint({ x: 0, y: 10, z: 1.7 });
    const p = st().selectedPointId;
    expect(p).not.toBeNull();

    st().deleteSelected();
    st().undo();
    expect(st().measurementPoints).toHaveLength(1);
    st().selectPoint(p!);

    st().redo();
    expect(st().measurementPoints).toHaveLength(0);
    expect(st().selectedPointId).toBeNull();
  });

  it('keeps a selection the redone document still contains', () => {
    // The repair is a filter and not a reset. An edit that changed no id must
    // leave the operator pointed at what they were pointed at.
    st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    st().selectSources(st().sources.map((s) => s.id));
    st().groupSelected('ARRAY');
    const g = st().selectedGroupId!;

    st().patchGroup(g, { levelOffsetDb: -3 });
    st().undo();
    st().redo();

    expect(st().groups[0].levelOffsetDb).toBe(-3);
    expect(st().selectedGroupId).toBe(g);
  });
});

describe('the live re-apply a steering field does while it is dragged', () => {
  it('is one entry for the whole drag, and one undo takes the array back', () => {
    // `applyDelayPlan({ history: false })` is the steering panel's equivalent of
    // a canvas drag: the slider writes a whole new delay plan on every frame.
    st().addSource(DEFAULT_SPEAKER_ID, { x: -1, y: 0, z: 0 });
    st().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const ids = st().sources.map((s) => s.id);

    st().snapshot();
    for (let deg = 1; deg <= 20; deg++) {
      st().applyDelayPlan(ids, { delaysS: [0, deg * 1e-4], levelsDb: null, maxDelayS: deg * 1e-4 }, { history: false });
    }
    expect(st().undoStack).toHaveLength(1);
    expect(st().sources[1].delayS).toBeCloseTo(20e-4, 12);

    st().undo();
    expect(st().sources[1].delayS).toBe(0);
  });

  it('records one entry when the caller says nothing', () => {
    st().addSource(DEFAULT_SPEAKER_ID, { x: -1, y: 0, z: 0 });
    useStore.setState({ undoStack: [], redoStack: [] });
    const ids = st().sources.map((s) => s.id);
    st().applyDelayPlan(ids, { delaysS: [5e-4], levelsDb: null, maxDelayS: 5e-4 });
    expect(st().undoStack).toHaveLength(1);
    st().undo();
    expect(st().sources[0].delayS).toBe(0);
  });
});
