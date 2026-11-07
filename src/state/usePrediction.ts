import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  pinkBand,
  QUALITY_TARGET_CELLS,
  type GroundModel,
  type PredictionArea,
  type Quality,
  type SimulationSettings,
} from '../core/types';
import type { EngineSource, GridRequest, GridResult } from '../engine/types';
import { PredictionClient, gridCacheKey } from '../worker/client';
import { useStore } from './store';
import { resolveAll, toEngineSources } from './resolve';

/**
 * Coarsest grid worth drawing on an axis. Below this the map is a handful of
 * blocks and tells the user nothing.
 */
const MIN_CELLS_PER_AXIS = 8;

/**
 * Grid dimensions for a quality level, preserving the area's aspect ratio.
 *
 * `QUALITY_TARGET_CELLS` is a BUDGET, not a suggestion: it is what keeps a solve
 * inside a second or two, and the aspect ratio may divide it between the axes but
 * must never multiply it. It used to. The per-axis floor was applied before the
 * aspect scaling, so as soon as one axis pinned at the floor the other grew with
 * the aspect ratio unopposed: an area 1 mm deep asked for 400000 x 8 = 3.2
 * million cells, and — because the floor bites the same way at every quality —
 * DRAFT asked for exactly the same 3.2 million, which is the quality a drag uses.
 * Clamping each axis against the budget the other one has already spent keeps
 * `nx * nv <= target` for every shape, without changing a single sane area: a
 * 50 x 50 m field is still 510 x 510 at high and 118 x 118 at draft.
 *
 * The extents are read as a rectangle rather than as an ordered pair, because the
 * area fields commit on every keystroke: typing "50" into Y min while Y max is
 * still 45 passes through an inverted range, which is a moment in an edit and not
 * a request to predict a negative depth.
 */
export function gridSize(area: PredictionArea, quality: Quality): { nx: number; nv: number } {
  const w = Math.max(1e-3, Math.abs(area.xMax - area.xMin));
  const h = Math.max(1e-3, Math.abs(area.vMax - area.vMin));
  const target = QUALITY_TARGET_CELLS[quality];
  const aspect = w / h;
  const cap = Math.floor(target / MIN_CELLS_PER_AXIS);
  const nv = clamp(Math.round(Math.sqrt(target / aspect)), MIN_CELLS_PER_AXIS, cap);
  // Rounded, not floored, so a square area still comes out at exactly the grid
  // it always did: the budget is a cost ceiling, and being 100 cells over it on a
  // 260000-cell solve is not what this is defending against.
  const nx = clamp(Math.round(nv * aspect), MIN_CELLS_PER_AXIS, Math.round(target / nv));
  return { nx, nv };
}

function clamp(v: number, lo: number, hi: number): number {
  // NaN (a degenerate aspect ratio) sorts to the floor rather than through it
  return v > hi ? hi : v > lo ? v : lo;
}

/**
 * Take the "render out of date" badge down.
 *
 * `markStale` is a store action because raising the flag is a statement about the
 * project. Lowering it is a statement about the PREDICTION — the map on screen is
 * the one the project would produce — and this hook is the only code that holds
 * both sides of that comparison, so the flag is cleared from here rather than
 * through an action nothing else could use correctly.
 */
function clearStale() {
  if (useStore.getState().renderStale) useStore.setState({ renderStale: false });
}

let sharedClient: PredictionClient | null = null;
export function predictionClient(): PredictionClient {
  if (!sharedClient) sharedClient = new PredictionClient();
  return sharedClient;
}

export interface PredictionState {
  result: GridResult | null;
  computing: boolean;
  usingWorker: boolean;
  sourceCount: number;
  /** grid dimensions actually solved */
  nx: number;
  nv: number;
  /**
   * The engine sources the shown map was solved from, plus the air/ground it used.
   * Anything else that draws from the same solve (the polar pattern) reads these,
   * so it freezes and updates in step with the map instead of running ahead of it
   * while autocalculate is off.
   */
  solved: { sources: EngineSource[]; speedOfSound: number; ground: GroundModel } | null;
  /**
   * Why there is no map, in the engine's own words, or null when nothing was
   * refused.
   *
   * A refused solve used to reach the user as an empty canvas and a line in the
   * developer console. The canvas is the output of this program, so "no map"
   * has to be said out loud: the interface renders a localised sentence and
   * this string underneath it, because the string names the field — the
   * source's id and then `reference SPL is NaN` — and the field name is what
   * makes the project fixable instead of merely broken.
   */
  refusal: string | null;
}

/**
 * Autocalculate solves at most once in this time, measured from the start of
 * one solve to the start of the next. A change inside the interval waits for
 * its end, and only the newest state is solved then, so a stream of edits never
 * postpones the map indefinitely and never queues up solves nobody will see.
 */
export const AUTO_SOLVE_INTERVAL_MS = 2000;

/** A solve that has given no answer for this long is treated as lost and asked for again. */
const SOLVE_LOST_AFTER_MS = 15000;

/** The engine's request for this project at a quality. */
function gridRequest(
  sources: EngineSource[],
  sim: SimulationSettings,
  quality: Quality,
): GridRequest {
  const { nx, nv } = gridSize(sim.area, quality);
  // Szum różowy to dla silnika zwykłe uśrednienie pasmowe: środek
  // geometryczny pasma i jego szerokość w oktawach. Punkty idą równo w
  // log f, a tam równe kroki niosą w szumie różowym równą moc — patrz
  // pinkBand. Mapowanie tutaj, nie w silniku: klucze cache i tak nazywają
  // frequencyHz + bandOct, więc tryb różowy dostaje je za darmo.
  const pink = sim.signal === 'pink' ? pinkBand(sim) : null;
  return {
    sources,
    frequencyHz: pink ? pink.centreHz : sim.frequencyHz,
    speedOfSound: sim.speedOfSound,
    plane: sim.plane,
    ground: sim.ground,
    xMin: sim.area.xMin,
    xMax: sim.area.xMax,
    vMin: sim.area.vMin,
    vMax: sim.area.vMax,
    planeOffset: sim.area.planeOffset,
    nx,
    nv,
    bandOct: pink ? pink.bandOct : sim.bandOct,
  };
}

/**
 * Runs the prediction whenever anything acoustically relevant changes, at most
 * once per AUTO_SOLVE_INTERVAL_MS while autocalculate is on. Recalculate is not
 * limited. Quality drops to Draft while the user is dragging, and the
 * full-quality solve follows the release.
 *
 * While autocalculate is on, a check on the same interval compares the project
 * as it stands with the map on screen and solves again if they differ and
 * nothing is on its way. That covers a change the effect below never saw, such
 * as a model replaced in the provider, and a solve whose answer never came.
 */
export function usePrediction(): PredictionState {
  const sources = useStore((s) => s.sources);
  const groups = useStore((s) => s.groups);
  const provider = useStore((s) => s.provider);
  const sim = useStore((s) => s.sim);
  const interacting = useStore((s) => s.interacting);
  const autocalculate = useStore((s) => s.autocalculate);
  const recalcToken = useStore((s) => s.recalcToken);
  const markStale = useStore((s) => s.markStale);

  const [result, setResult] = useState<GridResult | null>(null);
  const [solved, setSolved] = useState<PredictionState['solved']>(null);
  const [computing, setComputing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const seq = useRef(0);
  /**
   * The project behind the map on screen, as a cache key taken at the SETTLED
   * quality, so "has anything really changed" is a question about the project
   * rather than about whether the mouse happens to be down.
   */
  const solvedKey = useRef<string | null>(null);
  const solvedToken = useRef(recalcToken);
  /** the exact grid on screen, draft or full; solvedKey cannot tell those apart */
  const shownKey = useRef<string | null>(null);
  /** the grid being solved now, and when it was asked for */
  const pendingKey = useRef<string | null>(null);
  const pendingSince = useRef(0);
  /** the grid the engine refused: asking again would only get the same answer */
  const refusedKey = useRef<string | null>(null);
  const lastSolveAt = useRef(Number.NEGATIVE_INFINITY);
  /** a solve waiting for the interval to end */
  const waiting = useRef<ReturnType<typeof setTimeout> | null>(null);

  const engineSources = useMemo(
    () => toEngineSources(resolveAll(sources, groups, provider)),
    [sources, groups, provider],
  );

  const startSolve = useCallback((req: GridRequest, settledKey: string) => {
    const gridKey = gridCacheKey(req);
    const my = ++seq.current;
    const now = Date.now();
    lastSolveAt.current = now;
    pendingKey.current = gridKey;
    pendingSince.current = now;
    setComputing(true);
    predictionClient()
      .solve(req)
      .then((r) => {
        if (seq.current !== my) return; // a newer request superseded this one
        solvedKey.current = settledKey;
        shownKey.current = gridKey;
        pendingKey.current = null;
        refusedKey.current = null;
        setResult(r);
        // publish the exact inputs behind this solve, so other views of the same
        // solve stay in step with it
        setSolved({ sources: req.sources, speedOfSound: req.speedOfSound, ground: req.ground });
        // a newer state may already be waiting for the interval to end
        setComputing(waiting.current !== null);
        setRefusal(null);
      })
      .catch((e: unknown) => {
        if (seq.current !== my) return;
        setComputing(waiting.current !== null);
        // No map, rather than the previous map left standing under a project it
        // no longer describes. A refused solve names the field it choked on
        // (see `unsolvable`), and the empty-canvas state is the honest answer
        // until that field is fixed.
        setResult(null);
        setSolved(null);
        solvedKey.current = null;
        shownKey.current = null;
        pendingKey.current = null;
        refusedKey.current = gridKey;
        // Carried out of the hook rather than only into the console: a canvas
        // that goes blank with nothing said is the same failure as a map that
        // is quietly wrong, only cheaper to mistake for "no cabinets yet".
        setRefusal(e instanceof Error ? e.message : String(e));
        console.error(e);
      });
  }, []);

  useEffect(() => {
    const quality: Quality = interacting ? 'draft' : sim.quality;
    const req = gridRequest(engineSources, sim, quality);

    if (!engineSources.length) {
      seq.current++; // an answer still on its way is for cabinets that are gone
      setResult(null);
      setSolved(null);
      setComputing(false);
      setRefusal(null);
      solvedKey.current = null;
      shownKey.current = null;
      pendingKey.current = null;
      refusedKey.current = null;
      return;
    }

    // With autocalculate off the map is frozen: a change only marks it stale, and
    // Recalculate (which bumps recalcToken) releases exactly one solve.
    //
    // The comparison runs at the SETTLED quality, never at the draft grid a drag
    // borrows. Draft is a property of the mouse, not of the project: pressing the
    // button on a cabinet changes nothing but `interacting`, and comparing the
    // draft key against the solved one read that as an edit, so a plain click
    // raised "render out of date" and nothing could ever lower it again.
    const settledKey = gridCacheKey(gridRequest(engineSources, sim, sim.quality));
    const forced = recalcToken !== solvedToken.current;
    if (!autocalculate && !forced) {
      // Equal keys mean the map on screen IS this project — an undo back to an
      // already-solved state, or a click that changed nothing. Saying it is out
      // of date would be false, and the badge is the user's only cue that
      // Recalculate is owed.
      if (settledKey === solvedKey.current) clearStale();
      else markStale();
      if (pendingKey.current === null) setComputing(false);
      return;
    }
    solvedToken.current = recalcToken;

    if (!forced) {
      const gridKey = gridCacheKey(req);
      // Already on screen: the full map of this project, which a press that moved
      // nothing must not swap for a draft, or the same grid again.
      if (settledKey === shownKey.current || gridKey === shownKey.current) {
        seq.current++; // an older state still being solved must not replace it
        pendingKey.current = null;
        setComputing(false);
        return;
      }
      // Already being solved, which is also how StrictMode's second run lands here.
      if (gridKey === pendingKey.current) return;
    }

    const wait = forced ? 0 : lastSolveAt.current + AUTO_SOLVE_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      startSolve(req, settledKey);
      return;
    }
    setComputing(true);
    const timer = setTimeout(() => {
      waiting.current = null;
      startSolve(req, settledKey);
    }, wait);
    waiting.current = timer;
    return () => {
      clearTimeout(timer);
      waiting.current = null;
    };
  }, [engineSources, sim, interacting, autocalculate, recalcToken, markStale, startSolve]);

  // The check described above. It reads the store afresh, not the values this
  // render holds, because what it looks for is the change this render missed.
  useEffect(() => {
    if (!autocalculate) return;
    const check = setInterval(() => {
      if (waiting.current !== null) return;
      const st = useStore.getState();
      const current = toEngineSources(resolveAll(st.sources, st.groups, st.provider));
      if (!current.length) return;
      const req = gridRequest(current, st.sim, st.interacting ? 'draft' : st.sim.quality);
      const gridKey = gridCacheKey(req);
      const settledKey = gridCacheKey(gridRequest(current, st.sim, st.sim.quality));
      if (settledKey === shownKey.current || gridKey === shownKey.current) return;
      if (gridKey === refusedKey.current) return;
      if (gridKey === pendingKey.current && Date.now() - pendingSince.current < SOLVE_LOST_AFTER_MS) return;
      startSolve(req, settledKey);
    }, AUTO_SOLVE_INTERVAL_MS);
    return () => clearInterval(check);
  }, [autocalculate, startSolve]);

  const { nx, nv } = gridSize(sim.area, interacting ? 'draft' : sim.quality);
  return {
    result,
    computing,
    usingWorker: predictionClient().usingWorker,
    sourceCount: engineSources.length,
    nx,
    nv,
    solved,
    refusal,
  };
}
