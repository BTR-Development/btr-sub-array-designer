/**
 * Cabinet ORIENTATION: what happens to the published box when the cabinet is
 * rolled onto its end face.
 *
 * The engine honoured roll from the start — `localFrame` turns the radiating
 * elements and the acoustic origin with the box — but every piece of geometry
 * read the datasheet straight. A rolled cabinet therefore predicted correctly
 * and then sat on the deck at the wrong height, stacked at the wrong pitch and
 * drew a box of the wrong shape. These are the rules that closed that gap.
 */
import { describe, it, expect } from 'vitest';
import { boxSize, centreZFromBottomFace, orientedDimensions, UNKNOWN_BOX } from './schema';
import type { SpeakerModel } from './schema';
import { builtinProvider } from './provider';

/** Published 764 x 571 x 601 mm, which is WIDER than it is tall. */
const ks21 = (): SpeakerModel => {
  const m = builtinProvider.get('la-ks21');
  if (!m) throw new Error('the KS21 record is gone');
  return m;
};

const withDims = (
  over: Partial<SpeakerModel['dimensions']>,
): SpeakerModel => ({ ...ks21(), dimensions: { ...ks21().dimensions, ...over } });

describe('the box a rolled cabinet actually occupies', () => {
  it('leaves an upright cabinet exactly as published', () => {
    const m = ks21();
    expect(orientedDimensions(m, 0)).toEqual(m.dimensions);
    // 180 degrees is upside down, not on its side: the extents are the same.
    const flipped = orientedDimensions(m, 180);
    expect(flipped.widthM).toBeCloseTo(0.764, 9);
    expect(flipped.heightM).toBeCloseTo(0.571, 9);
  });

  it('swaps width and height at 90 degrees, and leaves the depth alone', () => {
    const o = orientedDimensions(ks21(), 90);
    expect(o.widthM).toBeCloseTo(0.571, 9);
    expect(o.heightM).toBeCloseTo(0.764, 9);
    // Roll is about the FRONT axis, so the depth is the one dimension it cannot
    // touch. A roll that changed the depth would move the acoustic origin.
    expect(o.depthM).toBeCloseTo(0.601, 9);
  });

  it('is the bounding box in between, not an interpolation of the labels', () => {
    const o = orientedDimensions(ks21(), 45);
    const expected = (0.764 + 0.571) * Math.cos(Math.PI / 4);
    expect(o.widthM).toBeCloseTo(expected, 9);
    expect(o.heightM).toBeCloseTo(expected, 9);
    // and it is BIGGER than either published side, which is the whole point of
    // a bounding box: a cabinet turned on the diagonal needs more deck.
    expect(o.widthM!).toBeGreaterThan(0.764);
  });

  it('loses only the output that needed the missing side', () => {
    // At 90 degrees the new HEIGHT is the old width and the new WIDTH is the old
    // height. A model with no published height can still say how tall it stands
    // on its end face, and writing the whole box off would withhold a number
    // that is known.
    const o = orientedDimensions(withDims({ heightM: null }), 90);
    expect(o.heightM).toBeCloseTo(0.764, 9);
    expect(o.widthM).toBeNull();
    // Upright, the same model knows its width and not its height.
    const up = orientedDimensions(withDims({ heightM: null }), 0);
    expect(up.widthM).toBeCloseTo(0.764, 9);
    expect(up.heightM).toBeNull();
  });
});

describe('seating a rolled cabinet on the deck', () => {
  it('uses the height it is standing in, not the one on the datasheet', () => {
    const m = ks21();
    expect(centreZFromBottomFace(m, 0, 0)).toBeCloseTo(0.2855, 6);
    // On its end face the box is 0.764 tall, so its centre is 0.382 up. Seated
    // by the published height instead it would stand 0.097 m INTO the deck.
    expect(centreZFromBottomFace(m, 0, 90)).toBeCloseTo(0.382, 6);
  });

  it('still refuses to guess when the dimension it needs is unpublished', () => {
    expect(centreZFromBottomFace(withDims({ heightM: null }), 0, 0)).toBeNull();
    // ...and at 90 degrees the height it needs is the WIDTH, which is published.
    expect(centreZFromBottomFace(withDims({ heightM: null }), 0, 90)).toBeCloseTo(0.382, 6);
    expect(centreZFromBottomFace(withDims({ widthM: null }), 0, 90)).toBeNull();
  });
});

describe('the box that gets drawn', () => {
  it('is drawn in the orientation the cabinet stands in', () => {
    const up = boxSize(ks21(), 0);
    const on = boxSize(ks21(), 90);
    expect(up.widthM).toBeCloseTo(0.764, 9);
    expect(on.widthM).toBeCloseTo(0.571, 9);
    expect(on.heightM).toBeCloseTo(0.764, 9);
    expect(up.unknown).toBe(false);
    expect(on.unknown).toBe(false);
  });

  it('keeps the nominal fallback for a cabinet nobody has measured', () => {
    const blind = withDims({ widthM: null, heightM: null, depthM: null });
    const b = boxSize(blind, 90);
    expect(b.widthM).toBe(UNKNOWN_BOX.widthM);
    expect(b.heightM).toBe(UNKNOWN_BOX.heightM);
    expect(b.unknown).toBe(true);
  });
});
