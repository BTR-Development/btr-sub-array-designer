// @vitest-environment jsdom
/**
 * The prediction lifecycle: how big a solve the grid is allowed to ask for, and
 * what the "render out of date" badge is actually a statement about.
 *
 * Both were untested, and both defects lived in the seam rather than in a
 * function: `gridSize` was correct about aspect ratio and wrong about cost, and
 * the staleness flag was correct about every value it compared and wrong about
 * which quality to compare at.
 *
 * jsdom has no Worker, so `PredictionClient` really solves on this thread. The
 * grids here are the default area, which is small enough for that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AUTO_SOLVE_INTERVAL_MS, gridSize, predictionClient, usePrediction } from './usePrediction';
import { useStore } from './store';
import { QUALITY_TARGET_CELLS, type PredictionArea, type Quality } from '../core/types';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';

const QUALITIES: Quality[] = ['draft', 'normal', 'high'];

function area(over: Partial<PredictionArea> = {}): PredictionArea {
  return { xMin: -25, xMax: 25, vMin: 0, vMax: 50, planeOffset: 1.5, ...over };
}

describe('how big a solve the grid asks for', () => {
  it('leaves a sane area exactly as it was', () => {
    // The budget divided between two equal axes, which is what it always did:
    // this fix must not change the resolution of an ordinary prediction.
    expect(gridSize(area(), 'high')).toEqual({ nx: 510, nv: 510 });
    expect(gridSize(area(), 'draft')).toEqual({ nx: 118, nv: 118 });
  });

  it('keeps the cell budget whatever shape the area is', () => {
    const shapes: Record<string, PredictionArea> = {
      // typing "50" into "Y min" while Y max is still 45
      inverted: area({ vMin: 50, vMax: 45 }),
      // one axis collapsed, mid-edit
      collapsed: area({ xMin: 10, xMax: 10 }),
      // a stray zero on the end of a number
      enormous: area({ xMin: -1e6, xMax: 1e6 }),
      thin: area({ vMin: 0, vMax: 0.001 }),
      tall: area({ xMin: 0, xMax: 0.001 }),
    };
    for (const [name, a] of Object.entries(shapes)) {
      for (const q of QUALITIES) {
        const { nx, nv } = gridSize(a, q);
        // 400000 x 8 = 3.2 million cells is what this used to return for the
        // inverted case, at EVERY quality including the draft a drag uses.
        // The budget, plus the slack that rounding an axis to whole cells can
        // add to it. The inverted case used to return 400000 x 8: not 1% over
        // the budget, twelve times it.
        expect(nx * nv, `${name} at ${q}`).toBeLessThanOrEqual(QUALITY_TARGET_CELLS[q] * 1.01);
        expect(Math.min(nx, nv), `${name} at ${q}`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('reads an inverted range as the rectangle it will become', () => {
    expect(gridSize(area({ vMin: 50, vMax: 45 }), 'high')).toEqual(
      gridSize(area({ vMin: 45, vMax: 50 }), 'high'),
    );
  });
});

describe('the render-out-of-date badge, with autocalculate off', () => {
  const st = () => useStore.getState();

  /** Let the solve's promise settle and the effect it triggers run. */
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    act(() => {
      st().newProject();
      // `newProject` is about the document; autocalculate and the badge are
      // interface state that survives it, and every case here starts from a map
      // that has actually been solved.
      st().setAutocalculate(true);
      st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0.4 });
    });
  });

  it('stays down when a click only picks a cabinet up', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    expect(view.result.current.result).not.toBeNull();

    act(() => st().setAutocalculate(false));
    expect(st().renderStale).toBe(false);

    // Pointer down on a cabinet: the project does not change, only `interacting`,
    // which drops the quality to draft. Comparing the draft grid against the
    // solved one read that as an edit, and nothing ever lowered the flag again.
    act(() => st().setInteracting(true));
    await settle();
    expect(st().renderStale).toBe(false);

    act(() => st().setInteracting(false));
    await settle();
    expect(st().renderStale).toBe(false);
    // the map is still the one that was solved
    expect(view.result.current.result).not.toBeNull();
    view.unmount();
  });

  it('goes up for a real edit', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    act(() => st().setAutocalculate(false));

    act(() => st().moveSources([st().sources[0].id], { x: 2, y: 0, z: 0 }));
    await settle();
    expect(st().renderStale).toBe(true);
    view.unmount();
  });

  it('comes back down when an undo returns to the map on screen', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    act(() => st().setAutocalculate(false));

    act(() => st().moveSources([st().sources[0].id], { x: 2, y: 0, z: 0 }));
    await settle();
    expect(st().renderStale).toBe(true);

    // Back to the state the visible map was solved from. "Out of date" is a
    // claim about the map, and the claim is no longer true.
    act(() => st().undo());
    await settle();
    expect(st().renderStale).toBe(false);
    view.unmount();
  });

  it('stays up when an undo lands somewhere else again', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    act(() => st().setAutocalculate(false));

    const id = () => st().sources[0].id;
    act(() => st().moveSources([id()], { x: 2, y: 0, z: 0 }));
    act(() => st().moveSources([id()], { x: 2, y: 0, z: 0 }));
    await settle();
    // one Recalculate, so the map now shows the twice-moved cabinet
    act(() => st().recalculate());
    await settle();
    expect(st().renderStale).toBe(false);

    act(() => st().undo());
    await settle();
    expect(st().renderStale).toBe(true);
    view.unmount();
  });
});

describe('the gate that decides whether a solve runs at all', () => {
  /**
   * The badge tests above check what the flag SAYS. These check what the hook
   * DOES, which is the half a user pays for: autocalculate exists because a
   * 32-cabinet third-octave solve takes seconds, and a gate that leaks one
   * solve per keystroke gives that time back to nobody.
   *
   * Counting calls into `PredictionClient` rather than watching the result,
   * because the client caches: a leaked solve that happens to hit the cache is
   * still a defect in the gate, and it is the one that would survive a rewrite.
   */
  const st = () => useStore.getState();

  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  let solves: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    act(() => {
      st().newProject();
      st().setAutocalculate(true);
      st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0.4 });
    });
    solves = vi.spyOn(predictionClient(), 'solve');
  });

  afterEach(() => {
    solves.mockRestore();
  });

  it('runs nothing at all once autocalculate is off', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    act(() => st().setAutocalculate(false));
    const frozen = view.result.current.result;
    const frozenSources = view.result.current.solved?.sources;
    solves.mockClear();

    for (let i = 0; i < 5; i++) {
      act(() => st().moveSources([st().sources[0].id], { x: 1, y: 0, z: 0 }));
      await settle();
    }
    expect(solves).not.toHaveBeenCalled();

    // and the map on screen is still the one that was solved, object for
    // object: anything else drawn from this solve (the polar pattern) reads
    // `solved`, so it has to freeze with the map rather than run ahead of it.
    expect(view.result.current.result).toBe(frozen);
    expect(view.result.current.solved?.sources).toBe(frozenSources);
    expect(frozenSources?.[0].position.x).toBe(0);
    expect(st().sources[0].position.x).toBe(5);
    view.unmount();
  });

  it('lets Recalculate through exactly once', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    act(() => st().setAutocalculate(false));

    act(() => st().moveSources([st().sources[0].id], { x: 4, y: 0, z: 0 }));
    await settle();
    solves.mockClear();

    act(() => st().recalculate());
    await settle();
    expect(solves).toHaveBeenCalledTimes(1);
    // the released solve is of the CURRENT project, not of the one the token
    // was bumped from
    expect(view.result.current.solved?.sources[0].position.x).toBe(4);
    expect(st().renderStale).toBe(false);

    // The token must not stay hot. A second edit is frozen again, and the
    // effect re-running for any other reason does not sneak a solve through.
    solves.mockClear();
    act(() => st().moveSources([st().sources[0].id], { x: 1, y: 0, z: 0 }));
    await settle();
    act(() => st().setInteracting(true));
    await settle();
    act(() => st().setInteracting(false));
    await settle();
    expect(solves).not.toHaveBeenCalled();
    expect(st().renderStale).toBe(true);
    view.unmount();
  });

  it('draws nothing, and asks for nothing, when there is no cabinet left', async () => {
    const view = renderHook(() => usePrediction());
    await settle();
    solves.mockClear();

    act(() => {
      st().selectSources(st().sources.map((s) => s.id));
      st().deleteSelected();
    });
    await settle();
    expect(solves).not.toHaveBeenCalled();
    expect(view.result.current.result).toBeNull();
    expect(view.result.current.solved).toBeNull();
    expect(view.result.current.sourceCount).toBe(0);
    view.unmount();
  });
});

describe('pink noise', () => {
  const st = () => useStore.getState();
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    act(() => st().newProject());
  });

  it('solves the chosen band, not the slider frequency', async () => {
    act(() => {
      st().createSubArray({ speakerId: DEFAULT_SPEAKER_ID, count: 2, spacingM: 4, axis: 'x' });
      st().patchSim({ signal: 'pink', pinkLoHz: 25, pinkHiHz: 100, frequencyHz: 63 });
    });
    const view = renderHook(() => usePrediction());
    await settle();
    const r = view.result.current.result!;
    expect(r).not.toBeNull();
    // Dwie oktawy 25..100 Hz: rozwiązań jest wiele, nie jedno — pojedynczy
    // ton miałby bandPoints 1. To jest obserwowalna różnica między "mapa
    // szumu" a "mapa tonu z innym podpisem".
    expect(r.bandPoints).toBeGreaterThan(1);

    // the same project as a single tone combs: at a null cell the pink map
    // reads HIGHER, because the null sits at one frequency and the noise
    // carries the rest of the band
    act(() => st().patchSim({ signal: 'tone', bandOct: 0 }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, AUTO_SOLVE_INTERVAL_MS + 50));
    });
    const tone = view.result.current.result!;
    expect(tone.bandPoints).toBe(1);
    view.unmount();
  });
});

describe('autocalculate: at most one solve per interval, and nothing left behind', () => {
  const st = () => useStore.getState();
  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const move = (dx: number) => act(() => st().moveSources([st().sources[0].id], { x: dx, y: 0, z: 0 }));

  let solves: ReturnType<typeof vi.spyOn>;
  let view: ReturnType<typeof renderHook<ReturnType<typeof usePrediction>, unknown>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    act(() => {
      st().newProject();
      st().setAutocalculate(true);
      st().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0.4 });
    });
    solves = vi.spyOn(predictionClient(), 'solve');
    view = renderHook(() => usePrediction());
    await settle();
    expect(solves).toHaveBeenCalledTimes(1);
    solves.mockClear();
  });

  afterEach(() => {
    view.unmount();
    solves.mockRestore();
    vi.useRealTimers();
  });

  it('solves a change at once when the last solve is older than the interval', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    move(3);
    await settle();
    expect(solves).toHaveBeenCalledTimes(1);
    expect(view.result.current.solved?.sources[0].position.x).toBe(3);
  });

  it('holds a change back until the interval ends, and solves only the newest state', async () => {
    move(1);
    await advance(500);
    move(1);
    await advance(500);
    move(1);
    await advance(AUTO_SOLVE_INTERVAL_MS - 1000 - 1);
    expect(solves).not.toHaveBeenCalled();
    expect(view.result.current.computing).toBe(true);

    await advance(1);
    expect(solves).toHaveBeenCalledTimes(1);
    expect(view.result.current.solved?.sources[0].position.x).toBe(3);
    expect(view.result.current.computing).toBe(false);
  });

  it('never exceeds one solve per interval under a stream of edits, and does not starve', async () => {
    for (let i = 0; i < 20; i++) {
      move(0.1);
      await advance(500); // 10 s of edits, one every half second
    }
    expect(solves.mock.calls.length).toBeLessThanOrEqual(5);
    expect(solves.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('does not put a draft over the map for a press that moved nothing', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    const before = view.result.current.result;
    act(() => st().setInteracting(true));
    await advance(AUTO_SOLVE_INTERVAL_MS);
    act(() => st().setInteracting(false));
    await advance(AUTO_SOLVE_INTERVAL_MS);
    expect(solves).not.toHaveBeenCalled();
    expect(view.result.current.result).toBe(before);
  });

  it('follows a drag with the full grid once it is released', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    act(() => st().setInteracting(true));
    move(2);
    await settle();
    const draft = view.result.current.result!;
    act(() => st().setInteracting(false));
    await advance(AUTO_SOLVE_INTERVAL_MS);
    const full = view.result.current.result!;
    expect(full.nx * full.nv).toBeGreaterThan(draft.nx * draft.nv);
  });

  it('lets Recalculate through at once, whatever the interval says', async () => {
    move(1);
    act(() => st().recalculate());
    await settle();
    expect(solves).toHaveBeenCalledTimes(1);
    expect(view.result.current.solved?.sources[0].position.x).toBe(1);
  });

  it('notices a change the render never saw, and solves it', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    // mutated in place, so the store's selectors see the same object and the
    // hook does not re-render: the check is the only thing that can catch this
    const sim = st().sim as { frequencyHz: number };
    sim.frequencyHz = 40;
    await advance(AUTO_SOLVE_INTERVAL_MS);
    expect(solves).toHaveBeenCalledTimes(1);
    expect((solves.mock.calls[0][0] as { frequencyHz: number }).frequencyHz).toBe(40);
    sim.frequencyHz = 63;
  });

  it('asks again for a solve whose answer never came', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    solves.mockImplementationOnce(() => new Promise(() => undefined));
    move(1);
    await settle();
    expect(solves).toHaveBeenCalledTimes(1);
    expect(view.result.current.computing).toBe(true);

    await advance(10000); // not yet: it may simply be a long solve
    expect(solves).toHaveBeenCalledTimes(1);

    await advance(6000);
    expect(solves).toHaveBeenCalledTimes(2);
    expect(view.result.current.computing).toBe(false);
    expect(view.result.current.solved?.sources[0].position.x).toBe(1);
  });

  it('does not keep asking for what the engine refused', async () => {
    await advance(AUTO_SOLVE_INTERVAL_MS);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    solves.mockImplementationOnce(() => Promise.reject(new Error('refused')));
    move(1);
    await settle();
    expect(view.result.current.refusal).toBe('refused');
    await advance(AUTO_SOLVE_INTERVAL_MS * 5);
    expect(solves).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('checks nothing while autocalculate is off', async () => {
    act(() => st().setAutocalculate(false));
    await advance(AUTO_SOLVE_INTERVAL_MS);
    const sim = st().sim as { frequencyHz: number };
    sim.frequencyHz = 40;
    await advance(AUTO_SOLVE_INTERVAL_MS * 3);
    expect(solves).not.toHaveBeenCalled();
    sim.frequencyHz = 63;
  });
});
