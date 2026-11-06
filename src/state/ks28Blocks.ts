/**
 * The KS28 cardioid blocks, as data and one builder.
 *
 * Seven arrangements of KS28 in which some cabinets are turned to face
 * backwards, written down as patterns of F and B (F facing the audience, B
 * facing the stage), read LEFT TO RIGHT AS SEEN FROM THE FRONT, and top to
 * bottom when a block has more than one row.
 *
 *   NO.1    F F F B        NO.2    F F B        NO.3   F B
 *   NO.1.1  F F B F        NO.2.1  F B F
 *   NO.4    columns of two, left F/F and right F/B
 *   NO.4.2  columns of two, left F/F and right B/F
 *
 * The delays are computed from the pressure gradient: a cabinet turned round
 * radiates from the other side of its own box, so its source sits one cabinet
 * DEPTH behind the forward ones, and the rear null appears when it is inverted
 * and delayed by that depth over the speed of sound. For a KS28 that is
 * 0.719 m, which at 20 °C is 2.095 ms.
 *
 * Rear cancellation is the DIFFERENCE between the two groups over their sum, so
 * with point-source cabinets the ratio sets a ceiling no delay can lift:
 *
 *   NO.3    1 forward : 1 reversed   matched, and the only true cardioid here
 *   NO.2    2 : 1                    9.5 dB
 *   NO.1    3 : 1                    6.0 dB
 *   NO.4    3 : 1                    6.0 dB
 *
 * The KS28 here is an analytical omnidirectional model. Every block is measured
 * with it in ks28Blocks.test.ts, and the editor prints the ceiling beside the
 * control that builds them.
 */

import type { Source, Vec3 } from '../core/types';
import { BUILTIN_SPEAKERS } from '../speakers/library';
import { acousticOrigin, rollExtents } from '../speakers/schema';
import { distanceToDelay, gradientRejectionDb } from '../engine/steering';

export const KS28_ID = 'la-ks28';

/** Which way a cabinet in a block faces: at the audience, or at the stage. */
export type Facing = 'F' | 'B';

/**
 * How the cabinet itself is turned about its own front axis.
 *
 * `flat` is the way a KS28 is normally stacked, 1.34 m across and 0.55 m tall.
 * `onEnd` stands it on its short edge, 0.55 across and 1.34 tall. It is a roll, so it is the same control the
 * Inspector and the SUBS panel already offer.
 */
export type BlockOrientation = 'flat' | 'onEnd';

/** Which way a single-row pattern is laid out. */
export type BlockAxis = 'horizontal' | 'vertical';

export interface Ks28Block {
  id: string;
  /** the name the block goes by */
  label: string;
  /**
   * Rows top to bottom; each row left to right AS SEEN FROM THE FRONT.
   *
   * The audience looks along -Y, so their left hand is -X: pattern index 0 is
   * the smallest x. A one-row block can also be laid out vertically, and then
   * index 0 is the TOP of a column.
   */
  rows: Facing[][];
  /** true for the two blocks left out of the layout variants */
  fixedGrid?: boolean;
}

export const KS28_BLOCKS: Ks28Block[] = [
  { id: 'no1', label: 'NO.1', rows: [['F', 'F', 'F', 'B']] },
  { id: 'no1-1', label: 'NO.1.1', rows: [['F', 'F', 'B', 'F']] },
  { id: 'no2', label: 'NO.2', rows: [['F', 'F', 'B']] },
  { id: 'no2-1', label: 'NO.2.1', rows: [['F', 'B', 'F']] },
  { id: 'no3', label: 'NO.3', rows: [['F', 'B']] },
  // "2 columns, lying in two stacks, touching. Column 1 (from the top) FF,
  // column 2 (from the top) FB." Read as rows, top first, with column 1 on the
  // left as seen from the front — the files carry no handedness for it, and
  // left-to-right is how every other block in the set is written.
  { id: 'no4', label: 'NO.4', rows: [['F', 'F'], ['F', 'B']], fixedGrid: true },
  { id: 'no4-2', label: 'NO.4.2', rows: [['F', 'B'], ['F', 'F']], fixedGrid: true },
];

export function ks28Block(id: string): Ks28Block {
  const b = KS28_BLOCKS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown KS28 block "${id}"`);
  return b;
}

/** The KS28's published box, and the extents it occupies in a given roll. */
export function ks28Box(orientation: BlockOrientation) {
  const m = BUILTIN_SPEAKERS.find((x) => x.id === KS28_ID);
  if (!m) throw new Error('the KS28 record is gone from the library');
  const d = m.dimensions;
  if (d.widthM == null || d.heightM == null || d.depthM == null) {
    throw new Error('the KS28 record has stopped publishing a dimension');
  }
  const rollDeg = orientation === 'onEnd' ? 90 : 0;
  const e = rollExtents(d.widthM, d.heightM, rollDeg);
  return {
    rollDeg,
    /** across, in the orientation it stands in */
    widthM: e.widthM!,
    /** tall, in the orientation it stands in */
    heightM: e.heightM!,
    depthM: d.depthM,
    /**
     * Distance between a forward cabinet's radiating point and a turned-round
     * one's. Taken from `acousticOrigin` rather than assumed to be the depth,
     * so a model that declares its own origin is believed.
     */
    gradientSpanM: 2 * Math.abs(acousticOrigin(m).y),
  };
}

export interface BuildBlockOptions {
  orientation?: BlockOrientation;
  /** ignored for the two-row blocks, which already have a shape */
  axis?: BlockAxis;
  /** world position of the block's CENTRE on the two layout axes */
  centre?: Vec3;
  /**
   * Height of the bottom face of the lowest cabinet. The block is seated on it,
   * which is what makes a ground stack sit ON the ground rather than half in it.
   */
  deckZ?: number;
  speedOfSound?: number;
  /** the heading the F cabinets face; B is this plus half a turn */
  forwardAzimuthDeg?: number;
  label?: (index: number) => string;
  makeSource: (speakerId: string, label: string, position: Vec3) => Source;
}

export interface BuiltBlock {
  sources: Source[];
  /** how many face each way, and the ceiling that ratio puts on rear rejection */
  forward: number;
  reversed: number;
  rejectionCeilingDb: number | null;
  /** the gradient delay written onto every reversed cabinet, seconds */
  reverseDelayS: number;
  /** outer extents of the whole block */
  widthM: number;
  heightM: number;
  depthM: number;
}

/**
 * Turn a block into cabinets.
 *
 * Cabinets TOUCH: the pitch is the cabinet's own extent in the orientation it
 * is standing in, on both axes, by design
 * ("so that the cabinets touch with their outer walls") and what every one of
 * the source files does.
 */
export function buildKs28Block(block: Ks28Block, opts: BuildBlockOptions): BuiltBlock {
  const orientation = opts.orientation ?? 'flat';
  const box = ks28Box(orientation);
  const c = opts.speedOfSound ?? 343;
  const fwdAz = opts.forwardAzimuthDeg ?? 0;
  const centre = opts.centre ?? { x: 0, y: 0, z: 0 };
  const label = opts.label ?? ((i) => `SUB ${String(i + 1).padStart(2, '0')}`);

  // A one-row block laid out vertically is the same pattern standing up: index
  // 0 is the TOP of a column.
  const vertical = !block.fixedGrid && opts.axis === 'vertical';
  const grid = vertical ? block.rows[0].map((f) => [f]) : block.rows;

  const nRows = grid.length;
  const nCols = Math.max(...grid.map((r) => r.length));
  const widthM = nCols * box.widthM;
  const heightM = nRows * box.heightM;

  // Rows are written top first, so row 0 is the HIGHEST.
  const topZ = (opts.deckZ ?? 0) + heightM;
  const leftX = centre.x - widthM / 2;

  const reverseDelayS = distanceToDelay(box.gradientSpanM, c);
  const sources: Source[] = [];
  let forward = 0;
  let reversed = 0;
  let n = 0;

  for (let r = 0; r < nRows; r++) {
    for (let col = 0; col < grid[r].length; col++) {
      const back = grid[r][col] === 'B';
      if (back) reversed++;
      else forward++;
      const s = opts.makeSource(KS28_ID, label(n), {
        x: leftX + (col + 0.5) * box.widthM,
        y: centre.y,
        z: topZ - (r + 0.5) * box.heightM,
      });
      s.rotation = {
        azimuthDeg: back ? fwdAz + 180 : fwdAz,
        elevationDeg: 0,
        rollDeg: box.rollDeg,
      };
      // Inverted AND delayed, which is the whole construction: turning the box
      // round only moves where it radiates from. See the file header.
      s.invertPolarity = back;
      // Below the user's delay column, like the reverse tool: the gradient is
      // part of the cabinet, and it is what tells the model this box plays
      // the rear of a cardioid (see Source.gradientDelayS).
      s.delayS = 0;
      if (back) s.gradientDelayS = reverseDelayS;
      sources.push(s);
      n++;
    }
  }

  return {
    sources,
    forward,
    reversed,
    rejectionCeilingDb: reversed > 0 ? gradientRejectionDb(forward, reversed) : 0,
    reverseDelayS,
    widthM,
    heightM,
    depthM: box.depthM,
  };
}
