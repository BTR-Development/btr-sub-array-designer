// @vitest-environment jsdom
/**
 * Where a cabinet lands when you press "+ Add".
 *
 * A position in BTR is the cabinet's geometric CENTRE, so placing a box at
 * z = 0 puts half of it under the deck. Side view is the first thing an engineer
 * opens after placing a system, so this is a visible wrong answer rather than a
 * rounding detail — and the vertical stack control has always placed the bottom
 * FACE, which made the two controls disagree about the same floor.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpeakerDialog } from './SpeakerDialog';
import { optionalNumber } from './fieldValue';
import { allSpeakers, useStore } from '../state/store';
import { builtinProvider } from '../speakers/provider';
import { buildCustomSpeaker, findProxy, type CustomSpeakerSpec } from '../speakers/proxy';
import { EN, PROXY_ACOUSTICS_KEY } from '../i18n';

const KS28 = builtinProvider.get('la-ks28')!;

beforeEach(() => {
  cleanup();
  useStore.setState({ sources: [], selectedSourceIds: [] });
  useStore.getState().patchSim({ plane: 'top' });
});

describe('+ Add on the plan view', () => {
  it('stands the cabinet on the deck instead of burying half of it', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText('KS28'));

    const [s] = useStore.getState().sources;
    expect(s.speakerId).toBe('la-ks28');
    expect(KS28.dimensions.heightM).toBe(0.55);
    expect(s.position.z).toBeCloseTo(0.55 / 2, 9);
  });

  it('leaves a cabinet of unpublished height at zero rather than inventing half of one', () => {
    const unknown = {
      ...KS28,
      id: 'mystery-sub',
      model: 'MYSTERY SUB',
      dimensions: { widthM: null, heightM: null, depthM: null },
    };
    useStore.getState().addCustomSpeaker(unknown);

    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText('MYSTERY SUB'));

    const s = useStore.getState().sources.at(-1)!;
    expect(s.speakerId).toBe('mystery-sub');
    expect(s.position.z).toBe(0);
  });
});

describe('a custom cabinet whose figures are still being typed', () => {
  /**
   * Max SPL is not a caption. `resolve` makes it the source's `refSplDb`, which
   * is a DRIVE LEVEL, so whatever lands in this field ends up in the complex
   * amplitude the engine sums. A field that cannot be parsed has confirmed
   * nothing, and unconfirmed is null — never NaN, which is a number and
   * therefore survives every check between here and the solve.
   */
  it('reads a figure it cannot parse as unknown rather than as NaN', () => {
    // The unit rather than the dialog, because the gap this closes is one the
    // browser hides: a number input reports "" for "-" or "1e", so the DOM
    // cannot deliver the string that used to become NaN. The rule still has to
    // be in our code, and this is the rule.
    for (const half of ['-', '+', '.', '1e', 'NaN', 'loud', ' ']) {
      expect(optionalNumber(half), half).toBe('');
    }
    expect(optionalNumber('')).toBe('');
    // and a figure that IS confirmed still gets through, sign and all
    expect(optionalNumber('-3.5')).toBe(-3.5);
    expect(optionalNumber('136')).toBe(136);
  });

  /**
   * What the proxy note promises has to be what the cabinet actually gets.
   *
   * The note used to end "the acoustics are borrowed from the closest verified
   * model" for every proxy. That stopped being true when `predictionFor` began
   * rebuilding the two-element gradient from the user's own depth — precisely
   * so that a borrowed rear element could not land behind the user's own back
   * baffle — and it was never true for an omni proxy, which lends nothing at
   * all. The sentence is now chosen by the kind of dataset the proxy holds.
   */
  it('says what this proxy lends, rather than one sentence for all of them', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    // The default spec is omnidirectional, and an omni proxy carries no
    // directivity to lend.
    expect(screen.getByText(EN['proxy.idealOmni'])).toBeTruthy();
    expect(screen.queryByText(EN['proxy.rebuiltGradient'])).toBeNull();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'cardioid' } });

    expect(screen.getByText(EN['proxy.rebuiltGradient'])).toBeTruthy();
    expect(screen.queryByText(EN['proxy.idealOmni'])).toBeNull();
  });

  it('keeps the table of sentences in step with the dataset each proxy produces', () => {
    // PROXY_ACOUSTICS_KEY is keyed on the PROXY's dataset; the cabinet gets
    // whatever `predictionFor` makes of it. Nothing but this comparison stops
    // the two drifting apart, because they live in different files on purpose:
    // the rule is the library's, the wording is the dictionary's.
    const library = allSpeakers([]);
    const spec: CustomSpeakerSpec = {
      name: 'probe',
      widthM: 0.6,
      heightM: 0.6,
      depthM: 0.5,
      type: 'omnidirectional',
      maxSpl: null,
      frequencyRange: null,
    };
    for (const type of ['omnidirectional', 'cardioid'] as const) {
      const match = findProxy({ ...spec, type }, library);
      expect(match, type).not.toBeNull();
      const built = buildCustomSpeaker({ ...spec, type }, library);
      expect(PROXY_ACOUSTICS_KEY[match!.model.predictionData.kind], type).toBe(
        PROXY_ACOUSTICS_KEY[built.predictionData.kind],
      );
    }
  });

  it('places a cabinet whose max SPL was left half typed with no drive level', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    fireEvent.change(screen.getByLabelText('Max SPL'), { target: { value: '-' } });
    fireEvent.click(screen.getByText('Create & place'));

    const model = useStore.getState().customSpeakers.at(-1)!;
    expect(model.maxSpl).toBeNull();
    expect(useStore.getState().sources.at(-1)!.speakerId).toBe(model.id);
  });
});
