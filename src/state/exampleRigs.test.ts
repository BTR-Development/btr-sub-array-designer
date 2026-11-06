/**
 * Where the shipped presets stand.
 *
 * A source position is the cabinet's geometric CENTRE, so a cabinet on the deck
 * is at z = height/2. Every preset but the flown column used to be built at
 * z = 0, which is half a box under the deck: 0.275 m for the KS28 the demo
 * project ships, 0.300 m for the reference cabinet the teaching presets use.
 * Nothing in plan view shows it — the side view does, and the demo project is
 * the first thing a new user opens.
 */
import { describe, it, expect } from 'vitest';
import { builtinProvider } from '../speakers/provider';
import { DEMO_RIG_ID, EXAMPLE_RIGS } from './exampleRigs';

describe('preset floor convention', () => {
  it('leaves no cabinet buried in the deck', () => {
    for (const preset of EXAMPLE_RIGS) {
      for (const s of preset.build().doc.sources) {
        const h = builtinProvider.get(s.speakerId)?.dimensions.heightM;
        expect(h, `${preset.id}: ${s.speakerId} publishes no height`).toBeTypeOf('number');
        const bottomFaceZ = s.position.z - h! / 2;
        // a tolerance, not a slack: z is built from arithmetic on the height
        expect(bottomFaceZ, `${preset.id} / ${s.label}`).toBeGreaterThan(-1e-9);
      }
    }
  });

  it('stands the demo project on the deck, not above it', () => {
    const demo = EXAMPLE_RIGS.find((p) => p.id === DEMO_RIG_ID)!.build();
    const h = builtinProvider.get(demo.doc.sources[0].speakerId)!.dimensions.heightM!;
    expect(h).toBeCloseTo(0.55, 9); // KS28
    for (const s of demo.doc.sources) expect(s.position.z).toBeCloseTo(h / 2, 9);
  });
});
