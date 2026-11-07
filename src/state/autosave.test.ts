// @vitest-environment jsdom
/**
 * The rule that makes autosave tolerable: written constantly, offered almost
 * never. A tool that asks "restore your project?" every morning trains people
 * to dismiss the question, and then it is ignored on the one day it matters.
 *
 * The second rule, which the first one used to break: a project that is OPEN in
 * another tab is not abandoned. Every session keeps its own keys and refreshes
 * its own marker, so most of what is asserted here is about two sessions living
 * side by side.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOSAVE_AT_KEY,
  AUTOSAVE_KEY,
  PROBE_MS,
  SESSION_OPEN_KEY,
  STALE_MS,
  abandonedFromLastSession,
  atKey,
  clearAbandoned,
  installAutosave,
  openKey,
  projectKey,
  readAbandoned,
  worthSaving,
} from './autosave';
import { useStore } from './store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';
import { parseBTRProject } from '../io/btrJson';

const running: (() => void)[] = [];

/**
 * A session, as the entry point starts one, carried past its probe window.
 *
 * A session decides nothing until it has asked the other tabs whether they are
 * alive, so every case here has to step over that window before reading what
 * was found. On the real clock the caller waits with `probed()` instead.
 */
function open(): () => void {
  const stop = installAutosave();
  running.push(stop);
  if (vi.isFakeTimers()) vi.advanceTimersByTime(PROBE_MS);
  return stop;
}

/** The same wait, on a real clock: see the note on `describe('a second tab')`. */
function probed(): Promise<void> {
  return new Promise((r) => setTimeout(r, PROBE_MS + 50));
}

/** The sessions that currently claim to be open, newest keys last. */
function sessionIds(): string[] {
  return Object.keys(localStorage)
    .filter((k) => k.startsWith(`${SESSION_OPEN_KEY}.`))
    .map((k) => k.slice(SESSION_OPEN_KEY.length + 1));
}

/** The one session in play, for the single-session cases. */
function only(): string {
  const ids = sessionIds();
  expect(ids).toHaveLength(1);
  return ids[0];
}

/** Past the point where a marker that stopped moving is taken for a dead tab. */
const COLD = STALE_MS + 60_000;

beforeEach(() => {
  localStorage.clear();
  useStore.getState().newProject();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of running.splice(0)) stop();
  vi.useRealTimers();
});

describe('what gets kept', () => {
  it('does not bother with an empty project', () => {
    expect(worthSaving(0, 0)).toBe(false);
    open();
    useStore.getState().setSnap(0.5); // a change, but nothing to lose
    vi.advanceTimersByTime(5000);
    expect(localStorage.getItem(projectKey(only()))).toBeNull();
  });

  it('keeps a project that has anything in it', () => {
    expect(worthSaving(1, 0)).toBe(true);
    expect(worthSaving(0, 1)).toBe(true); // measurement points are work too

    open();
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 1, y: 2, z: 0 });
    vi.advanceTimersByTime(5000);

    const id = only();
    const saved = localStorage.getItem(projectKey(id));
    expect(saved).toBeTruthy();
    const back = parseBTRProject(saved!);
    expect(back.sources).toHaveLength(1);
    expect(back.sources[0].position).toEqual({ x: 1, y: 2, z: 0 });
    expect(localStorage.getItem(atKey(id))).toBeTruthy();
  });

  it('waits instead of writing on every change', () => {
    open();
    const s = useStore.getState();
    for (let i = 0; i < 20; i++) s.addSource(DEFAULT_SPEAKER_ID, { x: i, y: 0, z: 0 });
    // still nothing: a drag must not hammer localStorage
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem(projectKey(only()))).toBeNull();

    vi.advanceTimersByTime(2000);
    expect(parseBTRProject(localStorage.getItem(projectKey(only()))!).sources).toHaveLength(20);
  });

  it('does not stamp a time for a copy it could not write', () => {
    // A 4 MB project against a 5 MB quota is the write that fails, and the
    // timestamp used to be written anyway: the banner then offered yesterday's
    // project under a time minutes old.
    open();
    const id = only();
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);

    const firstCopy = localStorage.getItem(projectKey(id))!;
    const firstTime = localStorage.getItem(atKey(id))!;

    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === projectKey(id)) throw new Error('QuotaExceededError');
      real.call(this, key, value);
    });

    vi.advanceTimersByTime(60_000); // heartbeats, then
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 9, y: 9, z: 0 });
    vi.advanceTimersByTime(3000);

    expect(localStorage.getItem(projectKey(id))).toBe(firstCopy);
    expect(localStorage.getItem(atKey(id))).toBe(firstTime);
  });
});

describe('when it offers to restore', () => {
  it('says nothing after a session that closed on purpose', () => {
    const stop = open();
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);
    const id = only();

    window.dispatchEvent(new Event('pagehide'));
    stop();

    expect(readAbandoned()).toBeNull();
    // and the copy it left behind is cleared by the next session rather than
    // waiting for a quota error to find it
    vi.advanceTimersByTime(COLD);
    open();
    expect(abandonedFromLastSession()).toBeNull();
    expect(localStorage.getItem(projectKey(id))).toBeNull();
  });

  it('offers the project when the last session never closed', () => {
    const stop = open();
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);

    stop(); // no pagehide: the tab was killed, and its marker stops moving
    vi.advanceTimersByTime(COLD);

    open();
    const found = abandonedFromLastSession();
    expect(found).not.toBeNull();
    expect(parseBTRProject(found!.text).sources).toHaveLength(1);
  });

  it('offers it back straight after the crash, not three minutes later', () => {
    // The case the whole feature exists for: the tab dies, the user reopens it
    // at once. A session that has just been killed leaves a marker one
    // heartbeat old, so waiting for that marker to go cold meant the reopened
    // tab offered nothing for the first three minutes — the only three minutes
    // anybody is looking. Nothing answers the ping here, and that is the
    // evidence: the session is gone.
    localStorage.setItem(openKey('crashed'), new Date(Date.now() - 20_000).toISOString());
    localStorage.setItem(projectKey('crashed'), '{"sources":[]}');
    localStorage.setItem(atKey('crashed'), new Date(Date.now() - 20_000).toISOString());

    open();

    expect(abandonedFromLastSession()?.sessionId).toBe('crashed');
  });

  it('saves on the way out of a page that may come back', () => {
    // A frozen tab keeps its marker: the phone may kill it outright next, and
    // the seconds since the last debounce are then all there is.
    open();
    const s = useStore.getState();
    s.addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);
    s.addSource(DEFAULT_SPEAKER_ID, { x: 5, y: 0, z: 0 });

    const frozen = new Event('pagehide') as PageTransitionEvent;
    Object.defineProperty(frozen, 'persisted', { value: true });
    window.dispatchEvent(frozen);

    const id = only();
    expect(parseBTRProject(localStorage.getItem(projectKey(id))!).sources).toHaveLength(2);
    expect(localStorage.getItem(openKey(id))).toBeTruthy();
  });

  it('marks itself open without disturbing what it found', () => {
    // This session arms first now, so that a tab opening alongside it can see
    // it. Its own keys are its own, and it excludes itself from the search, so
    // arming cannot erase the evidence that the last session died.
    localStorage.setItem(openKey('dead'), new Date(Date.now() - COLD).toISOString());
    localStorage.setItem(projectKey('dead'), '{"sources":[]}');

    open();

    expect(abandonedFromLastSession()).not.toBeNull();
    expect(sessionIds()).toContain('dead');
    // and this session is now marked open in its own right
    expect(sessionIds().filter((id) => id !== 'dead')).toHaveLength(1);
  });

  it('stops asking once the offer has been answered, and drops that copy', () => {
    localStorage.setItem(openKey('dead'), new Date(Date.now() - COLD).toISOString());
    localStorage.setItem(projectKey('dead'), '{"sources":[]}');
    open();
    expect(abandonedFromLastSession()).not.toBeNull();

    clearAbandoned();

    expect(abandonedFromLastSession()).toBeNull();
    // answered means answered: restored or refused, it is not put to the next tab
    expect(localStorage.getItem(projectKey('dead'))).toBeNull();
    expect(localStorage.getItem(openKey('dead'))).toBeNull();
  });

  it('keeps protecting the session that just answered the offer', () => {
    localStorage.setItem(openKey('dead'), new Date(Date.now() - COLD).toISOString());
    localStorage.setItem(projectKey('dead'), '{"sources":[]}');
    const stop = open();
    const mine = sessionIds().find((id) => id !== 'dead')!;

    clearAbandoned();

    expect(localStorage.getItem(openKey(mine))).toBeTruthy();

    // and a kill after that point is still recoverable
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 7, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);
    stop();
    vi.advanceTimersByTime(COLD);
    expect(readAbandoned()).not.toBeNull();
  });

  it('offers the newest of two dead sessions, and keeps only that one', () => {
    for (const [id, at] of [['old', 90], ['new', 30]] as const) {
      localStorage.setItem(openKey(id), new Date(Date.now() - COLD).toISOString());
      localStorage.setItem(projectKey(id), `{"sources":[],"project":{"name":"${id}"}}`);
      localStorage.setItem(atKey(id), new Date(Date.now() - at * 60_000).toISOString());
    }

    open();

    expect(abandonedFromLastSession()?.sessionId).toBe('new');
    // The older one can never be reached from anywhere, and a project carrying a
    // balloon is 4 MB of the quota the live session needs for its own net.
    expect(localStorage.getItem(projectKey('old'))).toBeNull();
    expect(localStorage.getItem(projectKey('new'))).toBeTruthy();
  });
});

describe('a second tab', () => {
  /**
   * These are the cases that turn on one tab ANSWERING another, and a
   * BroadcastChannel message is delivered by the real event loop, which a fake
   * clock does not turn. So they run on the real one, and pay for it with a
   * probe window rather than a debounce: the copy is written straight into
   * storage instead of being waited for.
   */
  it('does not offer a project another tab is still working on', async () => {
    vi.useRealTimers();
    open(); // the first tab, and it stays open for the whole case
    await probed();
    const first = only();
    localStorage.setItem(projectKey(first), '{"sources":[]}');
    localStorage.setItem(atKey(first), new Date().toISOString());

    open(); // second tab, first one still running
    await probed();
    expect(abandonedFromLastSession()).toBeNull();

    // And it stays silent however cold the first tab's marker gets. A laptop
    // that slept through lunch stops the heartbeat without ending the session,
    // so the marker is not what says the tab is working — the answer is.
    localStorage.setItem(openKey(first), new Date(Date.now() - COLD).toISOString());
    open(); // third tab
    await probed();
    expect(abandonedFromLastSession()).toBeNull();
    // and nothing has taken its rescue copy away either
    expect(localStorage.getItem(projectKey(first))).toBeTruthy();
    expect(localStorage.getItem(openKey(first))).toBeTruthy();
  });

  it('does not take another tab\'s net away when it closes', () => {
    // Another tab, live: jsdom has one window, so the tab that cannot run here
    // is the one represented by its keys. Its marker is fresh.
    localStorage.setItem(openKey('other'), new Date().toISOString());
    localStorage.setItem(atKey('other'), new Date().toISOString());
    localStorage.setItem(
      projectKey('other'),
      JSON.stringify({ format: 'btr-subarray', version: 2, sources: [] }),
    );

    const stop = open();
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 4, y: 0, z: 0 });
    vi.advanceTimersByTime(3000);
    const mine = sessionIds().find((id) => id !== 'other')!;

    window.dispatchEvent(new Event('pagehide')); // this tab is closed on purpose
    stop();

    // Closing one tab used to clear the marker every other tab was relying on.
    expect(localStorage.getItem(openKey('other'))).toBeTruthy();
    expect(localStorage.getItem(projectKey('other'))).toBeTruthy();
    expect(localStorage.getItem(openKey(mine))).toBeNull();

    // And when that tab dies too, what comes back is its work, not the copy this
    // session left behind when it closed cleanly.
    vi.advanceTimersByTime(COLD);
    open();
    expect(abandonedFromLastSession()?.sessionId).toBe('other');
    expect(localStorage.getItem(projectKey(mine))).toBeNull();
  });
});

describe('a project abandoned by the previous build', () => {
  it('is still offered back, from the keys that build used', () => {
    localStorage.setItem(SESSION_OPEN_KEY, '2026-08-24T10:00:00.000Z');
    localStorage.setItem(AUTOSAVE_KEY, '{"sources":[]}');
    localStorage.setItem(AUTOSAVE_AT_KEY, '2026-08-24T10:30:00.000Z');

    open();

    const found = abandonedFromLastSession();
    expect(found?.sessionId).toBeNull();
    expect(found?.at).toBe('2026-08-24T10:30:00.000Z');

    clearAbandoned();
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_OPEN_KEY)).toBeNull();
  });

  it('is cleared out when it is not what gets offered', () => {
    localStorage.setItem(SESSION_OPEN_KEY, '2026-08-24T10:00:00.000Z');
    localStorage.setItem(AUTOSAVE_KEY, '{"sources":[]}');
    localStorage.setItem(AUTOSAVE_AT_KEY, '2026-08-24T10:30:00.000Z');
    localStorage.setItem(openKey('dead'), new Date(Date.now() - COLD).toISOString());
    localStorage.setItem(projectKey('dead'), '{"sources":[]}');
    localStorage.setItem(atKey('dead'), new Date().toISOString());

    open();

    expect(abandonedFromLastSession()?.sessionId).toBe('dead');
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
  });
});

describe('a browser that refuses to store anything', () => {
  it('degrades instead of taking the app down', () => {
    const boom = () => {
      throw new Error('QuotaExceededError');
    };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);

    expect(() => {
      open();
      useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
      vi.advanceTimersByTime(5000);
    }).not.toThrow();
  });
});
