/**
 * What happens when the prediction worker dies.
 *
 * This used to be the app's quietest failure: `onerror` dropped the reference
 * and nothing else, so the promise the UI was waiting on never settled. The
 * "computing" indicator stayed lit, the map never changed again, and no error
 * ever reached the user. The app looked alive and had stopped working.
 *
 * Every test here is about one rule: a request handed to this client is always
 * answered, whatever the worker does.
 *
 * Alongside that: what the cache is allowed to consider the same prediction, what
 * becomes of a solve nobody is waiting for any more, and what happens to a
 * request that cannot honestly be solved at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PredictionClient, gridCacheKey, unsolvable } from './client';
import { computeGrid } from '../engine/engine';
import type { EngineSource, GridRequest } from '../engine/types';
import type { BalloonDataset } from '../speakers/schema';

const req = (frequencyHz = 63): GridRequest => ({
  sources: [{
    id: 'a', position: { x: 0, y: 0, z: 0 },
    azimuthDeg: 0, elevationDeg: 0, rollDeg: 0,
    levelDb: 0, delayS: 0, invertPolarity: false,
    refSplDb: 130, elements: null, normaliseOnAxis: false,
  }],
  frequencyHz, speedOfSound: 343.4, plane: 'top', ground: 'off',
  xMin: -2, xMax: 2, vMin: 1, vMax: 5, planeOffset: 0, nx: 4, nv: 4,
});

/** A worker that never answers, and fails on command. */
class DeadWorker {
  static live: DeadWorker[] = [];
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  posted = 0;
  /** the jobs it was actually handed, for the cancellation cases below */
  jobs: { jobId: number }[] = [];
  constructor() { DeadWorker.live.push(this); }
  postMessage(m: { jobId: number }) { this.posted++; this.jobs.push(m); }
  /** answer a job as the real worker would, so the promise behind it settles */
  answer(jobId: number) {
    this.onmessage?.({
      data: {
        jobId, nx: 4, nv: 4,
        xMin: -2, xMax: 2, vMin: 1, vMax: 5,
        spl: new Float32Array(16), maxDb: 100, refDb: 99, minDb: 90,
        bandPoints: 1, computeMs: 1,
      },
    });
  }
  terminate() { this.terminated = true; }
  fail(message = 'boom') { this.onerror?.({ message }); }
}

function withWorker(impl: unknown) {
  (globalThis as { Worker?: unknown }).Worker = impl;
}

afterEach(() => {
  DeadWorker.live = [];
  delete (globalThis as { Worker?: unknown }).Worker;
});

describe('worker death', () => {
  it('still answers the request that was in flight', async () => {
    withWorker(DeadWorker);
    const c = new PredictionClient();
    expect(c.usingWorker).toBe(true);

    const p = c.solve(req());
    await Promise.resolve();
    DeadWorker.live[0].fail('out of memory');

    // the whole point: this resolves rather than hanging forever
    const r = await p;
    expect(r.spl).toHaveLength(16);
    expect(c.workerFailure).toContain('out of memory');
  });

  it('answers a queued request too, not just the one in flight', async () => {
    withWorker(DeadWorker);
    const c = new PredictionClient();

    const a = c.solve(req(63));
    const b = c.solve(req(80)); // queued behind the first
    await Promise.resolve();
    DeadWorker.live[0].fail();

    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
  });

  it('terminates the corpse and brings up exactly one replacement', async () => {
    withWorker(DeadWorker);
    new PredictionClient();
    const first = DeadWorker.live[0];

    await Promise.resolve();
    first.fail();
    await Promise.resolve();

    expect(first.terminated).toBe(true);
    // one restart, so a transient failure does not cost the session its worker
    expect(DeadWorker.live).toHaveLength(2);
  });

  it('never hands the killer job back to the fresh worker', async () => {
    withWorker(DeadWorker);
    const c = new PredictionClient();

    const p = c.solve(req());
    await Promise.resolve();
    DeadWorker.live[0].fail();
    await p;

    // The replacement exists but was given nothing: re-running the grid that
    // just killed a worker is how an app ends up in a crash loop.
    expect(DeadWorker.live[1].posted).toBe(0);
  });

  it('gives up on workers after the second death and keeps answering', async () => {
    withWorker(DeadWorker);
    const c = new PredictionClient();

    await Promise.resolve();
    DeadWorker.live[0].fail();
    await Promise.resolve();
    DeadWorker.live[1].fail();

    expect(c.usingWorker).toBe(false);
    expect(DeadWorker.live).toHaveLength(2);

    // and it is still a working prediction client, just a slower one
    const r = await c.solve(req());
    expect(r.spl).toHaveLength(16);
  });

  it('falls back cleanly when a Worker cannot be constructed at all', async () => {
    withWorker(class { constructor() { throw new Error('blocked by CSP'); } });
    const c = new PredictionClient();

    expect(c.usingWorker).toBe(false);
    expect(c.workerFailure).toContain('CSP');
    await expect(c.solve(req())).resolves.toBeTruthy();
  });

  it('treats an undecodable message as a death, not as silence', async () => {
    withWorker(DeadWorker);
    const c = new PredictionClient();
    const p = c.solve(req());
    await Promise.resolve();
    DeadWorker.live[0].onmessageerror?.();
    await expect(p).resolves.toBeTruthy();
  });
});

describe('no worker at all', () => {
  it('solves on this thread when the platform has none', async () => {
    // Against the engine's own answer, not against "some number came back".
    // The fallback path used to be asserted only as maxDb > 0, which a grid of
    // the wrong frequency, the wrong plane or the wrong cabinet satisfies just
    // as well -- and this path is what every test in this file runs on.
    const c = new PredictionClient();
    expect(c.usingWorker).toBe(false);
    const r = await c.solve(req());
    const direct = computeGrid(req());
    expect(r.maxDb).toBe(direct.maxDb);
    expect(r.refDb).toBe(direct.refDb);
    expect([...r.spl]).toEqual([...direct.spl]);
  });

  it('serves a repeat request from cache', async () => {
    const c = new PredictionClient();
    const a = await c.solve(req());
    const b = await c.solve(req());
    expect(b).toBe(a);
    const other = await c.solve(req(80));
    expect(other).not.toBe(a);
  });
});

describe('cache key', () => {
  it('separates a band-averaged map from the single tone', async () => {
    const c = new PredictionClient();
    const tone = await c.solve(req());
    const band = await c.solve({ ...req(), bandOct: 1 / 3 });
    // without the band in the key this returned the tone map unchanged
    expect(band).not.toBe(tone);
    expect(band.bandPoints).toBeGreaterThan(1);
  });
});

/** One source carrying a balloon whose every value is `db`, on a 1 x 2 x 1 grid. */
function balloon(db: number): BalloonDataset {
  return {
    kind: 'balloon',
    frequenciesHz: [63],
    azimuthDeg: [0, 180],
    elevationDeg: [0],
    magnitudeDb: Float32Array.from([db, db]),
    phaseDeg: Float32Array.from([0, 0]),
  };
}

function withBalloon(b: BalloonDataset | undefined): GridRequest {
  const base = req();
  const src: EngineSource = { ...base.sources[0], balloon: b };
  return { ...base, sources: [src] };
}

describe('what counts as the same prediction', () => {
  it('tells two cabinets apart by their balloon', () => {
    // Two datasets 24 dB apart in every direction used to produce byte-identical
    // keys, so switching model handed back the previous model's map while the
    // Inspector already showed the new one.
    expect(gridCacheKey(withBalloon(balloon(0)))).not.toBe(gridCacheKey(withBalloon(balloon(-24))));
  });

  it('tells a balloon apart from no balloon at all', () => {
    expect(gridCacheKey(withBalloon(balloon(0)))).not.toBe(gridCacheKey(withBalloon(undefined)));
  });

  it('still recognises the same cabinet, or the cache would never hit', () => {
    const b = balloon(-6);
    expect(gridCacheKey(withBalloon(b))).toBe(gridCacheKey(withBalloon(b)));
  });
});

describe('a request that cannot be solved', () => {
  it('is refused by name rather than drawn as silence', async () => {
    // A string where a number belongs makes the amplitude NaN, and the engine
    // answers a NaN with the silence floor: a map indistinguishable from a
    // correct prediction of a rig that is not playing.
    const bad = { ...req(), sources: [{ ...req().sources[0], refSplDb: Number.NaN }] };
    expect(unsolvable(bad)).toMatch(/reference SPL/);
    await expect(new PredictionClient().solve(bad)).rejects.toThrow(/reference SPL/);
  });

  it('names a bad position, a bad element and a bad grid too', () => {
    const one = (over: Partial<EngineSource>) => ({
      ...req(),
      sources: [{ ...req().sources[0], ...over }],
    });
    expect(unsolvable(one({ position: { x: 0, y: Number.NaN, z: 0 } }))).toMatch(/position y/);
    expect(
      unsolvable(
        one({
          elements: [{ position: { x: 0, y: 0, z: 0 }, gain: Number.NaN, delayS: 0, invert: false }],
        }),
      ),
    ).toMatch(/element gain/);
    expect(unsolvable({ ...req(), xMax: Number.NaN })).toMatch(/xMax/);
    expect(unsolvable({ ...req(), nx: 0 })).toMatch(/grid is 0/);
  });

  it('passes a request that is merely unusual', () => {
    expect(unsolvable({ ...req(), nx: 1, nv: 1, xMin: 5, xMax: 5 })).toBeNull();
  });
});

describe('a solve nobody is waiting for any more', () => {
  afterEach(() => vi.useRealTimers());

  it('loses its worker to the job queued behind it', () => {
    // A running solve cannot be interrupted from outside, so the only question is
    // whether the client takes the worker away from it. DeadWorker never answers,
    // which is what an 11-second grid looks like from here.
    vi.useFakeTimers();
    withWorker(DeadWorker);
    const c = new PredictionClient();

    void c.solve(req(40));
    void c.solve(req(50)); // queued behind it
    expect(DeadWorker.live).toHaveLength(1);

    vi.advanceTimersByTime(299);
    expect(DeadWorker.live[0].terminated).toBe(false);

    vi.advanceTimersByTime(2);
    expect(DeadWorker.live[0].terminated).toBe(true);
    expect(DeadWorker.live).toHaveLength(2);
    expect(DeadWorker.live[1].posted).toBe(1);

    // Nothing failed, so nothing is reported as failed: the status line must not
    // spend the rest of the session claiming a degraded engine.
    expect(c.workerFailure).toBeNull();
    expect(c.usingWorker).toBe(true);
  });

  it('answers the job that took over', async () => {
    vi.useFakeTimers();
    withWorker(DeadWorker);
    const c = new PredictionClient();

    void c.solve(req(40));
    const second = c.solve(req(50));
    vi.advanceTimersByTime(301);

    DeadWorker.live[1].answer(DeadWorker.live[1].jobs[0].jobId);
    await expect(second).resolves.toMatchObject({ maxDb: 100 });
  });

  it('leaves a solve alone while anyone could still want it', async () => {
    // A draft solve during a drag normally finishes inside the window and its map
    // is worth having; terminating a worker per frame would cost more than the
    // solve it interrupts.
    vi.useFakeTimers();
    withWorker(DeadWorker);
    const c = new PredictionClient();

    const first = c.solve(req(40));
    void c.solve(req(50));
    vi.advanceTimersByTime(100);
    DeadWorker.live[0].answer(DeadWorker.live[0].jobs[0].jobId);
    await expect(first).resolves.toBeTruthy();

    vi.advanceTimersByTime(5000);
    expect(DeadWorker.live).toHaveLength(1);
    expect(DeadWorker.live[0].terminated).toBe(false);
    expect(DeadWorker.live[0].posted).toBe(2);
  });
});

afterEach(() => vi.restoreAllMocks());
