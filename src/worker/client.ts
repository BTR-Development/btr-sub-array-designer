/**
 * Main-thread side of the prediction worker.
 *
 * - one job at a time; newer requests supersede queued ones (drag-friendly), and
 *   a running job that a newer one has been waiting behind for CANCEL_AFTER_MS
 *   loses its worker to it
 * - results are cached by a key derived from everything the ACOUSTICS depend on
 *   (geometry, frequency, plane, grid, speed of sound, ground). Changing only
 *   the palette or the dynamic range never re-enters this module.
 * - falls back to a synchronous solve if Workers are unavailable.
 */

import { computeGrid } from '../engine/engine';
import type { GridRequest, GridResult } from '../engine/types';
import type { BalloonDataset } from '../speakers/schema';
import type { WorkerRequest, WorkerResponse } from './sim.worker';

/**
 * Identity of a balloon dataset, for the cache key.
 *
 * A balloon is megabytes of magnitude and phase, so serialising it into a key
 * costs more than the solve the cache saves. It does not have to be serialised:
 * a dataset is built once by the importer and never written to afterwards, so
 * the OBJECT is the identity. Two cabinets are two objects, the same cabinet is
 * the same object on every solve, and re-importing the same data simply misses
 * the cache once.
 *
 * An object identity is also exact, which a sampled checksum is not, and the
 * price of a collision here is the wrong cabinet's map with nothing on screen
 * to say so — two balloons 24 dB apart in every direction used to produce
 * byte-identical keys because the dataset was left out of this string
 * altogether. The grid shape rides along so a key still reads in a debugger.
 */
const balloonIds = new WeakMap<BalloonDataset, number>();
let nextBalloonId = 1;
function balloonKey(b: BalloonDataset | undefined): string {
  if (!b) return 'x';
  let id = balloonIds.get(b);
  if (id === undefined) {
    id = nextBalloonId++;
    balloonIds.set(b, id);
  }
  return `${id}:${b.frequenciesHz.length}/${b.azimuthDeg.length}/${b.elevationDeg.length}`;
}

export function gridCacheKey(req: GridRequest): string {
  const s = req.sources
    .map(
      (x) =>
        `${x.position.x.toFixed(4)},${x.position.y.toFixed(4)},${x.position.z.toFixed(4)},` +
        `${x.azimuthDeg.toFixed(3)},${x.elevationDeg.toFixed(3)},${x.rollDeg.toFixed(3)},` +
        `${x.levelDb.toFixed(3)},${x.delayS.toFixed(9)},${x.invertPolarity ? 1 : 0},` +
        `${x.refSplDb},${x.normaliseOnAxis ? 1 : 0},` +
        // The acoustic origin turns with the cabinet, so it is geometry: leave
        // it out and rotating a box returns the previous map from cache.
        `${x.originOffset ? `${x.originOffset.x}/${x.originOffset.y}/${x.originOffset.z}` : 'c'},` +
        `${x.elements ? x.elements.map((e) => `${e.position.x}/${e.position.y}/${e.position.z}/${e.gain}/${e.delayS}/${e.invert ? 1 : 0}`).join('|') : 'o'},` +
        // The balloon IS the cabinet's acoustics. Leaving it out made switching
        // model return the previous model's map, with the Inspector already
        // showing the new one.
        `${balloonKey(x.balloon)}`,
    )
    .join(';');
  return [
    s,
    req.frequencyHz.toFixed(4),
    // Without this a change of averaging returns the previous map from cache.
    (req.bandOct ?? 0).toFixed(4),
    req.bandPoints ?? '',
    req.speedOfSound.toFixed(4),
    req.plane,
    req.ground,
    req.xMin, req.xMax, req.vMin, req.vMax, req.planeOffset,
    req.nx, req.nv,
  ].join('~');
}

const MAX_CACHE = 24;

/**
 * Why this request cannot be solved, or null when it can.
 *
 * The engine answers a NaN with silence. `bandDb` folds any non-positive or
 * non-finite power into `SILENCE_DB`, so ONE bad number anywhere in a source —
 * historically a `maxSpl: "loud"` in a project file, which becomes a source's
 * drive level and therefore its complex amplitude — draws a map at the bottom of
 * the colour scale that is indistinguishable from a correct prediction of a rig
 * that is not playing. A map is the output of this program; a map that is quietly
 * wrong is the worst thing it can produce.
 *
 * The number cannot be repaired here. Substituting a level, a position or a
 * distance would be inventing the very figures the speaker-data policy forbids
 * inventing, so the solve is refused by name instead and the caller shows no map
 * at all. Project files are validated at the door (`parseCustomSpeakers`), so
 * anything reaching this point is a defect in our own code, and being told which
 * field it is in is worth more than a picture of silence.
 *
 * The balloon grids are deliberately not scanned: they are hundreds of thousands
 * of samples, checked once by the importer that builds them, and walking them on
 * every solve would cost more than the solve.
 */
export function unsolvable(req: GridRequest): string | null {
  const bad = (v: number, what: string) => (isFinite(v) ? null : `${what} is ${v}`);
  const checks: (string | null)[] = [
    bad(req.frequencyHz, 'frequency'),
    bad(req.speedOfSound, 'speed of sound'),
    bad(req.xMin, 'grid xMin'), bad(req.xMax, 'grid xMax'),
    bad(req.vMin, 'grid vMin'), bad(req.vMax, 'grid vMax'),
    bad(req.planeOffset, 'plane offset'),
    req.nx >= 1 && req.nv >= 1 ? null : `grid is ${req.nx} x ${req.nv}`,
    req.bandOct === undefined ? null : bad(req.bandOct, 'band width'),
  ];
  for (const x of req.sources) {
    checks.push(
      bad(x.position.x, `${x.id} position x`),
      bad(x.position.y, `${x.id} position y`),
      bad(x.position.z, `${x.id} position z`),
      bad(x.azimuthDeg, `${x.id} azimuth`),
      bad(x.elevationDeg, `${x.id} elevation`),
      bad(x.rollDeg, `${x.id} roll`),
      bad(x.levelDb, `${x.id} level`),
      bad(x.delayS, `${x.id} delay`),
      bad(x.refSplDb, `${x.id} reference SPL`),
    );
    const o = x.originOffset;
    if (o) {
      checks.push(
        bad(o.x, `${x.id} acoustic origin x`),
        bad(o.y, `${x.id} acoustic origin y`),
        bad(o.z, `${x.id} acoustic origin z`),
      );
    }
    for (const e of x.elements ?? []) {
      checks.push(
        bad(e.position.x, `${x.id} element x`),
        bad(e.position.y, `${x.id} element y`),
        bad(e.position.z, `${x.id} element z`),
        bad(e.gain, `${x.id} element gain`),
        bad(e.delayS, `${x.id} element delay`),
      );
    }
  }
  const faults = checks.filter((c) => c !== null);
  return faults.length ? `Cannot predict: ${faults.join(', ')}.` : null;
}

/**
 * How long a solve nobody is waiting for any more is allowed to keep running.
 *
 * A running solve cannot be interrupted from outside. `computeGrid` is one tight
 * loop and a `postMessage` is only read once it returns, so the only way to stop
 * one is to terminate the worker and start another. That costs a module
 * instantiation, which is why it is not done on every superseded job: during a
 * drag a draft solve usually finishes well inside this window, and its map is
 * worth having on screen.
 *
 * Past the window the job is dead weight. A mistyped prediction area or a
 * 32-cabinet third-octave solve can run for seconds with every later edit queued
 * behind it, and the user is left dragging against a map that does not move.
 */
const CANCEL_AFTER_MS = 300;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class PredictionClient {
  private worker: Worker | null = null;
  private jobId = 0;
  private pending: { req: GridRequest; key: string; resolve: (r: GridResult) => void } | null = null;
  private inFlight: {
    jobId: number;
    key: string;
    req: GridRequest;
    resolve: (r: GridResult) => void;
    startedAt: number;
  } | null = null;
  /** armed while a queued job is waiting behind a running one; see CANCEL_AFTER_MS */
  private cancelTimer: ReturnType<typeof setTimeout> | null = null;
  private cache = new Map<string, GridResult>();
  /**
   * Set when the worker has died. Read by the UI so a degraded solve says so
   * instead of quietly getting slower.
   */
  private failure: string | null = null;
  /**
   * One restart, and only for FUTURE jobs. If a particular grid is what killed
   * the worker, handing it straight back to a fresh worker kills that one too,
   * and the app spins. The job that failed is finished on this thread instead.
   */
  private restartsLeft = 1;

  constructor() {
    this.spawn();
  }

  private spawn() {
    try {
      const w = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      w.onerror = (e) => this.onWorkerLost(e.message || 'worker error');
      // A result that cannot be structured-cloned arrives here, not at onerror.
      w.onmessageerror = () => this.onWorkerLost('worker message could not be decoded');
      this.worker = w;
    } catch (e) {
      this.worker = null;
      this.failure = e instanceof Error ? e.message : 'worker could not be started';
    }
  }

  /**
   * The worker died. Everything waiting on it must still be answered.
   *
   * Before this existed, `onerror` dropped the reference and nothing else: the
   * in-flight promise never settled, so the caller's `.then` never ran, the
   * "computing" indicator stayed on for the rest of the session and the map
   * never updated again. No error reached the user; the app simply stopped
   * being a prediction tool. Answering the orphans on this thread blocks for
   * one solve, which is always better than never answering them.
   */
  private onWorkerLost(reason: string) {
    this.failure = reason;
    this.disarmCancel();
    try {
      this.worker?.terminate();
    } catch {
      // terminate() on an already-dead worker is not worth reporting
    }
    this.worker = null;

    const orphans = [this.inFlight, this.pending].filter((j) => j !== null);
    this.inFlight = null;
    this.pending = null;

    for (const job of orphans) {
      try {
        const r = computeGrid(job.req);
        this.put(job.key, r);
        job.resolve(r);
      } catch {
        // A solve that throws on this thread would have thrown in the worker
        // too. Leaving the promise unsettled is what caused the original hang,
        // so answer it with the last good map rather than with silence.
        const last = this.cache.values().next().value;
        if (last) job.resolve(last);
      }
    }

    if (this.restartsLeft > 0) {
      this.restartsLeft--;
      this.spawn();
      this.drain();
    }
  }

  get usingWorker() {
    return this.worker !== null;
  }

  /** Why the worker is not being used, or null when all is well. */
  get workerFailure() {
    return this.failure;
  }

  private onMessage(d: WorkerResponse) {
    const cur = this.inFlight;
    this.inFlight = null;
    this.disarmCancel();
    if (cur && cur.jobId === d.jobId) {
      const result: GridResult = {
        nx: d.nx, nv: d.nv,
        xMin: d.xMin, xMax: d.xMax, vMin: d.vMin, vMax: d.vMax,
        spl: d.spl, maxDb: d.maxDb, refDb: d.refDb, minDb: d.minDb,
        bandPoints: d.bandPoints, computeMs: d.computeMs,
      };
      this.put(cur.key, result);
      cur.resolve(result);
    }
    this.drain();
  }

  private put(key: string, r: GridResult) {
    this.cache.set(key, r);
    while (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private drain() {
    if (this.inFlight || !this.pending || !this.worker) return;
    const job = this.pending;
    this.pending = null;
    const id = ++this.jobId;
    this.inFlight = { jobId: id, key: job.key, req: job.req, resolve: job.resolve, startedAt: nowMs() };
    const msg: WorkerRequest = { jobId: id, request: job.req };
    this.worker.postMessage(msg);
  }

  private disarmCancel() {
    if (this.cancelTimer !== null) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
  }

  /** Start the clock on a running job that a newer one is already waiting behind. */
  private armCancel() {
    if (this.cancelTimer !== null || !this.inFlight || !this.pending) return;
    const { jobId, startedAt } = this.inFlight;
    this.cancelTimer = setTimeout(
      () => {
        this.cancelTimer = null;
        // Only if that same job is still running and something is still queued:
        // either may have moved on while the timer was pending.
        if (this.inFlight?.jobId === jobId && this.pending) this.cancelInFlight();
      },
      Math.max(0, CANCEL_AFTER_MS - (nowMs() - startedAt)),
    );
  }

  /**
   * Throw away the running solve and give the worker to the queued one.
   *
   * Nothing settles the abandoned job's promise. That is deliberate and it is
   * what already happens to a queued job that a newer request replaces: the one
   * caller is `usePrediction`, which discards any answer older than its latest
   * request, and handing it either a stale map or a fabricated one would be
   * worse than silence.
   *
   * `failure` is not set and no restart is spent, because nothing failed — this
   * is not the dead-worker path, and reporting a degraded engine after a
   * cancellation would be a lie the status line repeats for the rest of the
   * session.
   */
  private cancelInFlight() {
    if (!this.inFlight) return;
    this.inFlight = null;
    try {
      this.worker?.terminate();
    } catch {
      // terminate() on a worker that has already gone is not worth reporting
    }
    this.worker = null;
    this.spawn();
    if (this.worker) {
      this.drain();
      return;
    }
    // The replacement worker could not be started. Finish the queued job here
    // rather than leave the caller waiting on a promise nothing will settle.
    const job = this.pending;
    this.pending = null;
    if (!job) return;
    try {
      const r = computeGrid(job.req);
      this.put(job.key, r);
      job.resolve(r);
    } catch {
      // as in onWorkerLost: an unsettled promise is what froze the indicator
      const last = this.cache.values().next().value;
      if (last) job.resolve(last);
    }
  }

  /**
   * Request a grid. Resolves with a cached result immediately when nothing that
   * affects the acoustics has changed.
   */
  solve(req: GridRequest): Promise<GridResult> {
    // Refused rather than thrown: this is called from a React effect, and taking
    // the whole interface down over one bad field would lose the project too.
    const refuse = unsolvable(req);
    if (refuse) return Promise.reject(new Error(refuse));

    const key = gridCacheKey(req);
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);

    if (!this.worker) {
      const r = computeGrid(req);
      this.put(key, r);
      return Promise.resolve(r);
    }

    return new Promise<GridResult>((resolve) => {
      // A newer request replaces any queued one — during a drag we only ever
      // care about the latest position.
      this.pending = { req, key, resolve };
      this.drain();
      // Still queued means a solve is running. Give it CANCEL_AFTER_MS to finish
      // before its worker is taken away from it.
      this.armCancel();
    });
  }

  clearCache() {
    this.cache.clear();
  }

  dispose() {
    this.disarmCancel();
    this.worker?.terminate();
    this.worker = null;
  }
}
