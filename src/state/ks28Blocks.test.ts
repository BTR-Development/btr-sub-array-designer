/**
 * The seven KS28 cardioid blocks, measured rather than described.
 *
 * The delay comes from the cabinet's own geometry and the rejection figures come
 * from the engine, with the KS28 as an analytical omnidirectional model. If these
 * numbers ever drift, something has changed about the engine, the KS28 record or
 * the gradient construction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  KS28_BLOCKS,
  buildKs28Block,
  ks28Block,
  ks28Box,
  type BlockAxis,
  type BlockOrientation,
} from './ks28Blocks';
import { makeSource, useStore } from './store';
import { resolveAll, toEngineSources } from './resolve';
import { prepareSources, pressureAt, toDb } from '../engine/engine';
import { speedOfSoundFromTemp, type Source } from '../core/types';

const C = speedOfSoundFromTemp(20);
const st = () => useStore.getState();

const build = (id: string, axis: BlockAxis = 'horizontal', orientation: BlockOrientation = 'flat') =>
  buildKs28Block(ks28Block(id), {
    axis,
    orientation,
    speedOfSound: C,
    deckZ: 0,
    makeSource: (sid, label, pos) => makeSource(sid, label, pos),
  });

function frontToBack(sources: Source[], f: number): number {
  st().newProject();
  useStore.setState({ sources });
  const s = st();
  const srcs = toEngineSources(resolveAll(s.sources, s.groups, s.provider));
  const prepared = prepareSources(srcs, f, C);
  const out = new Float64Array(2);
  const scratch = new Float64Array(2);
  const at = (y: number) => {
    pressureAt(prepared, 0, y, 1.7, f, C, out, scratch);
    return toDb(out[0], out[1]);
  };
  return at(30) - at(-30);
}

beforeEach(() => {
  st().newProject();
  useStore.setState({ undoStack: [], redoStack: [] });
});

describe('the block as drawn', () => {
  it('is the pattern they wrote, left to right as seen from the front', () => {
    // The audience looks along -Y, so their left hand is -X: index 0 is the
    // smallest x. NO.1 is FFFB, so the turned cabinet is the rightmost.
    const b = build('no1');
    expect(b.sources).toHaveLength(4);
    const byX = [...b.sources].sort((p, q) => p.position.x - q.position.x);
    expect(byX.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FFFB');
    expect(build('no1-1').sources.sort((p, q) => p.position.x - q.position.x)
      .map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FFBF');
    expect(build('no2').sources.sort((p, q) => p.position.x - q.position.x)
      .map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FFB');
    expect(build('no2-1').sources.sort((p, q) => p.position.x - q.position.x)
      .map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FBF');
    expect(build('no3').sources.sort((p, q) => p.position.x - q.position.x)
      .map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FB');
  });

  it('reads a column from the TOP, the way the note does', () => {
    // "Column 1 (from the top) FF, column 2 (from the top) FB", and the same
    // rule for a one-row block laid out vertically.
    const col = build('no1', 'vertical');
    const topDown = [...col.sources].sort((p, q) => q.position.z - p.position.z);
    expect(topDown.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FFFB');

    const grid = build('no4');
    const left = grid.sources.filter((s) => s.position.x < 0).sort((p, q) => q.position.z - p.position.z);
    const right = grid.sources.filter((s) => s.position.x > 0).sort((p, q) => q.position.z - p.position.z);
    expect(left.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FF');
    expect(right.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('FB');
    const g2 = build('no4-2');
    const r2 = g2.sources.filter((s) => s.position.x > 0).sort((p, q) => q.position.z - p.position.z);
    expect(r2.map((s) => (s.invertPolarity ? 'B' : 'F')).join('')).toBe('BF');
  });

  it('turns the reversed cabinet round, inverts it and delays it by the gradient', () => {
    const b = build('no1');
    const back = b.sources.filter((s) => s.invertPolarity);
    expect(back).toHaveLength(1);
    expect(back[0].rotation.azimuthDeg).toBe(180);
    // one cabinet depth over c, from the cabinet's own acoustic origin
    expect(b.reverseDelayS).toBeCloseTo(0.719 / C, 9);
    // below the user's delay column, like the reverse tool
    expect(back[0].gradientDelayS).toBeCloseTo(0.719 / C, 9);
    expect(back[0].delayS).toBe(0);
    for (const f of b.sources.filter((s) => !s.invertPolarity)) {
      expect(f.rotation.azimuthDeg).toBe(0);
      expect(f.delayS).toBe(0);
      expect(f.gradientDelayS).toBeUndefined();
    }
  });

  it('stands the cabinets on the deck, touching, in whichever way up they are', () => {
    const flat = build('no1');
    expect(flat.widthM).toBeCloseTo(4 * 1.34, 9);
    expect(flat.heightM).toBeCloseTo(0.55, 9);
    for (const s of flat.sources) expect(s.position.z).toBeCloseTo(0.55 / 2, 9);
    // touching: the pitch IS the cabinet
    const xs = flat.sources.map((s) => s.position.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeCloseTo(1.34, 9);

    // on its short edge the box is 0.55 across and 1.34 tall, and the pitch
    // follows it — this is the "na krótszej krawędzi" variant
    const onEnd = build('no1', 'horizontal', 'onEnd');
    expect(onEnd.widthM).toBeCloseTo(4 * 0.55, 9);
    expect(onEnd.heightM).toBeCloseTo(1.34, 9);
    for (const s of onEnd.sources) {
      expect(s.rotation.rollDeg).toBe(90);
      expect(s.position.z).toBeCloseTo(1.34 / 2, 9);
    }

    // standing one on another, the pitch is the height and the deck is kept
    const column = build('no1', 'vertical');
    expect(column.widthM).toBeCloseTo(1.34, 9);
    expect(column.heightM).toBeCloseTo(4 * 0.55, 9);
    const zs = column.sources.map((s) => s.position.z).sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(0.55 / 2, 9);
    for (let i = 1; i < zs.length; i++) expect(zs[i] - zs[i - 1]).toBeCloseTo(0.55, 9);
  });

  it('leaves the two-row blocks alone, which are excluded from the variants', () => {
    const a = build('no4', 'horizontal');
    const b = build('no4', 'vertical');
    expect(a.widthM).toBeCloseTo(b.widthM, 9);
    expect(a.heightM).toBeCloseTo(b.heightM, 9);
    expect(a.widthM).toBeCloseTo(2 * 1.34, 9);
    expect(a.heightM).toBeCloseTo(2 * 0.55, 9);
  });
});

describe('what the blocks actually achieve', () => {
  /**
   * Measured front to back along +-30 m at ear height. The tolerance is wide
   * enough to survive a change of grid or temperature and far too tight to
   * survive the delay or the polarity going missing.
   */
  const CASES: Array<[string, number, number, number, number | null]> = [
    // id,     31.5 Hz, 63 Hz, 125 Hz, point-source ceiling
    ['no1', 2.1, 4.6, 6.2, 6.02],
    ['no1-1', 2.0, 4.4, 6.3, 6.02],
    ['no2', 4.1, 7.7, 9.9, 9.54],
    ['no2-1', 4.0, 7.5, 9.9, 9.54],
    ['no3', 30.6, 35.8, 38.4, null],
    ['no4', 2.1, 4.5, 6.3, 6.02],
    ['no4-2', 2.0, 4.5, 6.3, 6.02],
  ];

  it.each(CASES)('%s measures what the preset says it measures', (id, low, mid, high, ceiling) => {
    const b = build(id);
    if (ceiling === null) expect(b.rejectionCeilingDb).toBeNull();
    else expect(b.rejectionCeilingDb!).toBeCloseTo(ceiling, 2);
    expect(frontToBack(b.sources, 31.5)).toBeCloseTo(low, 0);
    expect(frontToBack(b.sources, 63)).toBeCloseTo(mid, 0);
    expect(frontToBack(b.sources, 125)).toBeCloseTo(high, 0);
  });

  it('keeps a point-source 3:1 block under its ceiling', () => {
    for (const f of [31.5, 63]) expect(frontToBack(build('no1').sources, f)).toBeLessThan(6.02);
  });

  it('makes the matched pair the only deep cardioid', () => {
    const at63 = Object.fromEntries(KS28_BLOCKS.map((b) => [b.id, frontToBack(build(b.id).sources, 63)]));
    const best = Object.entries(at63).sort((p, q) => q[1] - p[1])[0][0];
    expect(best).toBe('no3');
    expect(at63.no2).toBeLessThan(9.54);
  });

  it('keeps its rejection when it is turned on its end or stood up', () => {
    // The gradient is front to back; rolling the cabinet or standing the block
    // up moves cabinets sideways and vertically, not fore and aft.
    for (const variant of [
      ['horizontal', 'onEnd'],
      ['vertical', 'flat'],
    ] as Array<[BlockAxis, BlockOrientation]>) {
      const a = frontToBack(build('no2').sources, 63);
      const b = frontToBack(build('no2', variant[0], variant[1]).sources, 63);
      expect(Math.abs(a - b), variant.join('/')).toBeLessThan(0.7);
    }
  });
});

describe('the cabinet the blocks are made of', () => {
  it('is the published KS28 and nothing invented', () => {
    const flat = ks28Box('flat');
    expect(flat.widthM).toBeCloseTo(1.34, 9);
    expect(flat.heightM).toBeCloseTo(0.55, 9);
    expect(flat.depthM).toBeCloseTo(0.719, 9);
    expect(flat.gradientSpanM).toBeCloseTo(0.719, 9);
    const onEnd = ks28Box('onEnd');
    expect(onEnd.widthM).toBeCloseTo(0.55, 9);
    expect(onEnd.heightM).toBeCloseTo(1.34, 9);
    // roll is about the front axis, so the depth and the gradient do not move
    expect(onEnd.depthM).toBeCloseTo(0.719, 9);
    expect(onEnd.gradientSpanM).toBeCloseTo(0.719, 9);
  });
});
