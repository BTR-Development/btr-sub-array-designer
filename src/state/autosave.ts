/**
 * Keeps the open project recoverable when the session ends badly.
 *
 * The error boundary already rescues the project when a RENDER throws. That is
 * only one of the ways an afternoon disappears: a tab the browser kills under
 * memory pressure, a laptop that runs out of battery, a closed window, a
 * crashed GPU process. None of those run any of our code on the way out, so
 * nothing can be saved at the moment it happens. The copy has to already exist.
 *
 * WHAT MAKES THIS SAFE TO OFFER BACK
 *
 * A tool that greets you with "restore your project?" every single morning
 * teaches you to dismiss the question without reading it, and then it is not
 * there on the one day it matters. So the copy is written constantly and
 * offered almost never: a marker is set while the session is open and cleared
 * on the way out, and the offer is made only when the marker survived, which
 * means the last session did not end on purpose.
 *
 * Nothing is ever restored automatically. Reopening a project the user did not
 * ask for, possibly over one they have already started, is its own data loss.
 *
 * ONE SET OF KEYS PER TAB, AND A WAY TO ASK WHO IS STILL THERE
 *
 * All of this used to live in three keys shared by every tab of the browser,
 * which turned the protection into a hazard as soon as a second tab existed:
 * the new tab read the first tab's LIVE project as abandoned and offered it
 * back, and whichever tab closed first cleared the marker the other one was
 * relying on. Every session now owns its own three keys.
 *
 * Namespacing alone is not enough, because an open marker on its own cannot say
 * whether the session behind it is working or dead — a dead one runs no code to
 * say so. These are TWO questions, and answering both from the marker's age is
 * what broke crash recovery on its own primary case: "is another tab live right
 * now" needs a wide cold window to survive a throttled or sleeping machine, and
 * "did this session die" needs none at all, because the marker of a session
 * that has just crashed is one heartbeat old at most. Held together, the
 * feature offered nothing for the first three minutes after the crash it exists
 * for.
 *
 * So a tab opening ASKS, over a BroadcastChannel, and every live tab answers in
 * milliseconds. A session that does not answer is gone, however warm its marker
 * is. The marker's age is the fallback for a browser with no channel, and it
 * still serves as a tiebreak between two dead sessions.
 */
import { useStore } from './store';

/**
 * The keys as they were before they were namespaced. They are still read, once,
 * so that a project abandoned by the previous build is still offered back; each
 * per-session key is this name plus the session id.
 */
export const AUTOSAVE_KEY = 'btr.autosave.project';
export const AUTOSAVE_AT_KEY = 'btr.autosave.at';
export const SESSION_OPEN_KEY = 'btr.session.open';

export const projectKey = (session: string) => `${AUTOSAVE_KEY}.${session}`;
export const atKey = (session: string) => `${AUTOSAVE_AT_KEY}.${session}`;
export const openKey = (session: string) => `${SESSION_OPEN_KEY}.${session}`;

/** Long enough that dragging a cabinet does not write on every frame. */
const DEBOUNCE_MS = 2000;

/** How often a living session says it is still there. */
const HEARTBEAT_MS = 20_000;

/**
 * How cold an open marker has to be before the session behind it is presumed
 * dead, WHEN THE MARKER IS ALL WE HAVE.
 *
 * It cannot be tight. A background tab has its timers throttled to roughly once
 * a minute, and a machine that sleeps stops them altogether, so a window of
 * seconds would read a living tab as abandoned and offer its live project to
 * another tab — the failure this module was rewritten to stop. Erring the other
 * way costs a delay and nothing else: the marker is not going anywhere, and the
 * offer is made by whichever tab opens next.
 *
 * That delay is exactly why this is no longer the first question asked: see
 * `presumedDead`. It applies to a browser with no BroadcastChannel, and it
 * orders two dead sessions against each other.
 *
 * Exported so the tests can step past it rather than hard-code a number that
 * would quietly stop testing anything if this one grew.
 */
export const STALE_MS = 3 * 60_000;

/** The channel every tab of this origin answers on. */
const CHANNEL_NAME = 'btr.session';

/**
 * How long a tab waits for the live ones to answer its ping.
 *
 * A round trip between two tabs of one browser is well under a millisecond;
 * this is slack for a main thread that happens to be busy when the ping lands.
 * It is also the delay before the recovery banner can appear, so it is short
 * enough to read as part of the load.
 *
 * Exported for the tests, which have to step past it deliberately.
 */
export const PROBE_MS = 150;

interface Ping {
  btr: 'who' | 'here';
  id: string;
}

function openChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    // Same posture as storage: a session that cannot ask falls back on the
    // marker's age rather than taking the application down.
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Private browsing, a full quota, or a blocked origin. Autosave is a safety
    // net, and a safety net that throws is worse than one that is absent.
    return false;
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // as above
  }
}

/** A project worth keeping: anything the user would be upset to lose. */
export function worthSaving(sourceCount: number, pointCount: number): boolean {
  return sourceCount > 0 || pointCount > 0;
}

export interface Recoverable {
  text: string;
  at: string;
  /** which session left it behind; null for the pre-namespacing keys */
  sessionId: string | null;
}

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Every key in this origin, or an empty list when storage cannot be read. */
function allKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push(k);
    }
  } catch {
    // a browser that refuses to enumerate storage has nothing to offer back
  }
  return out;
}

function idsWithPrefix(prefix: string, keys: string[]): string[] {
  return keys.filter((k) => k.startsWith(`${prefix}.`)).map((k) => k.slice(prefix.length + 1));
}

/** When a session last said it was alive. 0 for a marker we cannot read as a time. */
function markerTime(session: string): number {
  const t = Date.parse(safeGet(openKey(session)) ?? '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Which sessions answered the ping, or null when there was nothing to ask with.
 *
 * An empty set is not the same as null: it means every other tab was asked and
 * none of them is there.
 */
export type LiveSessions = Set<string> | null;

/**
 * Is the session behind this marker gone?
 *
 * Answering the ping is the only positive evidence of life there is, and it
 * arrives in milliseconds. The marker's age is a poor substitute in both
 * directions: a session that has just crashed leaves a marker one heartbeat
 * old, and a tab left open through lunch on a sleeping laptop leaves one hours
 * cold. It is used only when the channel could not be opened at all.
 *
 * The residual case is a tab the browser has FROZEN, which neither runs its
 * heartbeat nor answers: it is read as dead, and its project may be offered to
 * the tab that is open now. Nothing is ever restored automatically and the
 * offer states the time it is offering, so the cost of being wrong here is a
 * banner someone dismisses.
 */
function presumedDead(id: string, live: LiveSessions, now: number): boolean {
  if (live) return !live.has(id);
  return now - markerTime(id) > STALE_MS;
}

interface ReadOptions {
  /** the session doing the reading, whose own copy is never a candidate */
  excludeSessionId?: string;
  /** injectable clock, so a cold marker can be tested without waiting */
  now?: number;
  /** who answered the ping; omitted means fall back to the markers' age */
  live?: LiveSessions;
}

/**
 * A project left behind by a session that ended abnormally, or null.
 *
 * Returns nothing for a session that answered the ping, however much unsaved
 * work it is holding: that project is open in another tab, and offering a
 * living project to a second tab is how a copy becomes a fork.
 *
 * Returns nothing after a clean exit either. The marker is removed on the way
 * out, and the copy left behind it is cleared by the next `installAutosave`.
 */
export function readAbandoned(opts: ReadOptions = {}): Recoverable | null {
  const now = opts.now ?? Date.now();
  const live = opts.live ?? null;
  const keys = allKeys();
  const found: Recoverable[] = [];

  for (const id of idsWithPrefix(SESSION_OPEN_KEY, keys)) {
    if (id === opts.excludeSessionId) continue;
    if (!presumedDead(id, live, now)) continue; // answered, or still warm
    const text = safeGet(projectKey(id));
    if (!text) continue;
    found.push({ text, at: safeGet(atKey(id)) ?? '', sessionId: id });
  }

  // The pre-namespacing keys, read once. They carry no heartbeat, so a marker
  // that is present is taken at face value: the build that wrote it is gone.
  if (safeGet(SESSION_OPEN_KEY) !== null) {
    const text = safeGet(AUTOSAVE_KEY);
    if (text) found.push({ text, at: safeGet(AUTOSAVE_AT_KEY) ?? '', sessionId: null });
  }

  if (!found.length) return null;
  const when = (r: Recoverable) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) ? t : (r.sessionId ? markerTime(r.sessionId) : 0);
  };
  return found.reduce((best, r) => (when(r) > when(best) ? r : best));
}

function forget(session: string | null) {
  if (session === null) {
    safeRemove(AUTOSAVE_KEY);
    safeRemove(AUTOSAVE_AT_KEY);
    safeRemove(SESSION_OPEN_KEY);
    return;
  }
  safeRemove(projectKey(session));
  safeRemove(atKey(session));
  safeRemove(openKey(session));
}

/**
 * Drop what no session can be offered from any more.
 *
 * Two things accumulate otherwise, and a balloon-carrying project is 4 MB
 * against a typical 5 MB quota, so accumulating is not free — it is the live
 * session's own net that stops being writable.
 *
 *   - a copy with no marker: a session that exited cleanly. Its copy was kept
 *     deliberately while the keys were global, because it was the same copy the
 *     next session would have written; per session it is simply unreachable.
 *   - every abandoned copy except the one being offered. Only the newest is ever
 *     put to the user, so the rest cannot be reached from anywhere.
 *
 * `keep` is the session whose copy is about to be offered, and `mine` is the one
 * writing from now on.
 *
 * OFFERING AND DELETING ARE NOT THE SAME BET. Getting an offer wrong costs a
 * banner someone dismisses; getting a deletion wrong costs an afternoon. So a
 * marked session's copy is dropped only on the positive evidence of a ping that
 * went out and was not answered — never on a cold marker alone, whatever
 * `readAbandoned` decided to offer from one. A browser with no BroadcastChannel
 * therefore prunes nothing here but the markerless copies below. Its dead
 * copies still drain, one per launch: the newest is offered, and answering the
 * banner drops it, which makes the next one the newest.
 */
function prune(mine: string, keep: string | null | undefined, live: LiveSessions) {
  const keys = allKeys();
  const markers = new Set(idsWithPrefix(SESSION_OPEN_KEY, keys));

  for (const id of idsWithPrefix(AUTOSAVE_KEY, keys)) {
    if (id === mine || markers.has(id)) continue;
    safeRemove(projectKey(id));
    safeRemove(atKey(id));
  }
  for (const id of markers) {
    if (id === mine || id === keep) continue;
    // A tab that answered is a tab that is working. Touching its copy would be
    // this module's original defect with the roles swapped.
    if (live && !live.has(id)) forget(id);
  }
  // The pre-namespacing trio, including a copy left behind by a clean exit under
  // the old build: unreachable unless it is the copy being offered right now.
  if (keep !== null) forget(null);
}

/**
 * The offer has been answered, so stop making it.
 *
 * The answered copy is dropped, which is the only thing that ever removes one:
 * it has now been either restored or refused, and leaving it behind would put
 * the same question to the next tab that opens.
 *
 * The CURRENT session's marker is not touched. It used to be re-armed here,
 * because clearing the single global marker would otherwise have disarmed the
 * protection for the rest of the sitting — a tab killed an hour after the banner
 * was answered had nothing to offer back. With a marker per session there is
 * nothing to repair: the one being dropped belongs to a session that is over.
 */
export function clearAbandoned() {
  const w = window as unknown as { __btrAbandoned?: Recoverable | null };
  const offered = w.__btrAbandoned ?? null;
  w.__btrAbandoned = null;
  if (offered) forget(offered.sessionId);
}

/**
 * Waiting to be told what the previous session left behind.
 *
 * The answer used to be known by the time `installAutosave` returned. It is now
 * a ping's round trip away, so the recovery banner subscribes instead of
 * reading once and concluding there was nothing.
 */
const waitingForProbe = new Set<(found: Recoverable | null) => void>();
let probeSettled = false;

/**
 * Call back with what the last session left behind, once that is known.
 *
 * Fires immediately when the probe has already answered — including when no
 * session ever installed, which is simply "nothing".
 */
export function onAbandonedSettled(cb: (found: Recoverable | null) => void): () => void {
  if (probeSettled) {
    cb(abandonedFromLastSession());
    return () => {};
  }
  waitingForProbe.add(cb);
  return () => {
    waitingForProbe.delete(cb);
  };
}

/**
 * Start autosaving. Call once, from the entry point.
 *
 * Arms this session's marker and starts answering other tabs' pings FIRST, so
 * that a tab opening a millisecond from now cannot read this one as dead. What
 * the previous session left behind is decided `PROBE_MS` later, once the live
 * tabs have had their chance to answer.
 */
// ── when the draft copy was last written, for the status bar ──────────────
// Not in the store: writing it there would wake the store subscription below,
// which would schedule another write, for ever.
let lastDraft: Date | null = null;
const draftListeners = new Set<() => void>();
function announceDraft(at: Date) {
  lastDraft = at;
  for (const cb of draftListeners) cb();
}
export function lastDraftAt(): Date | null {
  return lastDraft;
}
export function onDraftSaved(cb: () => void): () => void {
  draftListeners.add(cb);
  return () => draftListeners.delete(cb);
}

export function installAutosave(): () => void {
  if (typeof window === 'undefined') return () => {};

  const session = newSessionId();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const arm = () => safeSet(openKey(session), new Date().toISOString());
  const startBeating = () => {
    arm();
    if (beat === null) beat = setInterval(arm, HEARTBEAT_MS);
  };
  const stopBeating = () => {
    if (beat !== null) clearInterval(beat);
    beat = null;
  };

  const write = () => {
    timer = null;
    try {
      const st = useStore.getState();
      if (!worthSaving(st.sources.length, st.measurementPoints.length)) return;
      // The payload first, and the clock ONLY if the payload landed. Stamping it
      // either way offered yesterday's project under today's time: the 4 MB write
      // is exactly the one a full quota refuses, and the banner read as though
      // the copy behind it were minutes old.
      if (!safeSet(projectKey(session), JSON.stringify(st.toProject()))) return;
      const at = new Date();
      safeSet(atKey(session), at.toISOString());
      announceDraft(at);
    } catch {
      // a project that cannot be serialised is a bug worth finding elsewhere,
      // not a reason to take the application down from a background timer
    }
  };

  startBeating();

  /**
   * Ask who else is there, and answer whoever asks us.
   *
   * The handler that answers is in place before the question goes out, so this
   * session is already answerable to a tab that opens during its own probe
   * window; two tabs started together see each other rather than each other's
   * corpses.
   */
  const channel = openChannel();
  const live = new Set<string>();
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  const settle = (answered: LiveSessions) => {
    const when = Date.now();
    const abandoned = readAbandoned({ excludeSessionId: session, now: when, live: answered });
    prune(session, abandoned?.sessionId, answered);
    // Expose what the previous session left behind, for the recovery banner.
    (window as unknown as { __btrAbandoned?: Recoverable | null }).__btrAbandoned = abandoned;
    probeSettled = true;
    for (const cb of [...waitingForProbe]) cb(abandoned);
    waitingForProbe.clear();
  };

  probeSettled = false;
  if (channel) {
    channel.onmessage = (e: MessageEvent<Ping>) => {
      const msg = e.data;
      if (!msg || typeof msg.id !== 'string') return;
      // Any message at all is proof of life, including the ping of a tab that
      // opened during this one's probe window.
      live.add(msg.id);
      if (msg.btr === 'who') channel.postMessage({ btr: 'here', id: session } satisfies Ping);
    };
    channel.postMessage({ btr: 'who', id: session } satisfies Ping);
    probeTimer = setTimeout(() => {
      probeTimer = null;
      settle(live);
    }, PROBE_MS);
  } else {
    // Nothing to ask with: decide now, from the markers alone.
    settle(null);
  }

  const unsubscribe = useStore.subscribe(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(write, DEBOUNCE_MS);
  });

  /**
   * `pagehide` rather than `beforeunload`, because it also fires when a phone
   * moves the tab out of memory — and those two cases need OPPOSITE handling,
   * which `event.persisted` is what distinguishes.
   *
   * A real unload is the user saying nothing needs recovering, so the marker
   * goes. The copy itself is left for the next `installAutosave` to prune: an
   * unload handler is the least reliable place in the program to do work, and
   * the prune catches it whether this ran to completion or not.
   *
   * A frozen page may come back. Its marker stays exactly where it is, so that a
   * tab the phone then kills outright is still recoverable, and the debounced
   * write is flushed because those seconds are now the last ones there are.
   */
  const onLeave = (e: PageTransitionEvent) => {
    stopBeating();
    if (timer) {
      clearTimeout(timer);
      write();
    }
    if (!e.persisted) safeRemove(openKey(session));
  };
  window.addEventListener('pagehide', onLeave);

  // Restored from the back/forward cache: still the same project, and the
  // marker has to start moving again or another tab will read this one as dead.
  const onShow = () => startBeating();
  window.addEventListener('pageshow', onShow);

  return () => {
    unsubscribe();
    window.removeEventListener('pagehide', onLeave);
    window.removeEventListener('pageshow', onShow);
    stopBeating();
    if (timer) clearTimeout(timer);
    if (probeTimer) clearTimeout(probeTimer);
    // Stop answering: a closed session that still replied would keep its own
    // copy from ever being offered back.
    channel?.close();
  };
}

/** What `installAutosave` found from the previous session, if anything. */
export function abandonedFromLastSession(): Recoverable | null {
  return (window as unknown as { __btrAbandoned?: Recoverable | null }).__btrAbandoned ?? null;
}
