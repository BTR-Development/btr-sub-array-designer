// @vitest-environment jsdom
/**
 * The interface has to speak the operator's language where it matters most.
 *
 * Everything else being localised while the disclaimers are not is worse than
 * an untranslated interface: the buttons say the program was built for you,
 * and then the one sentence telling you not to trust a number is in a language
 * you may not read. These are the strings from that gap — the data-class note
 * in the picker, the proxy note, the .GLL licence paragraph and the balloon
 * attestation — plus the two leftover literals that sat next to a key which
 * already covered them. All of it is asserted through the rendered component
 * rather than through the dictionary, so it fails again the moment a literal
 * creeps back in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SpeakerDialog } from './SpeakerDialog';
import { PlotToolbar } from './PlotToolbar';
import { PolarPlot } from './PolarPlot';
import { EN, translate, type Lang, type MessageKey } from '../i18n';
import { useStore } from '../state/store';

/** Present in the operator's language, and NOT in English. */
function only(lang: Lang, key: MessageKey) {
  expect(screen.queryByText(translate(lang, key))).not.toBeNull();
  expect(screen.queryByText(EN[key])).toBeNull();
}

beforeEach(() => {
  cleanup();
  useStore.setState({ sources: [], selectedSourceIds: [], lang: 'pl' });
});

afterEach(() => {
  useStore.setState({ lang: 'en' });
});

describe('the speaker picker in Polish', () => {
  it('says in Polish that the prediction data is not the manufacturer’s', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    only('pl', 'spk.notVendorData');
  });

  it('names the data-quality grades in Polish', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    // The grade legend under the list; the badge itself is one letter.
    expect(screen.queryByText(new RegExp(translate('pl', 'q.d')))).not.toBeNull();
  });

  it('states the proxy warning in Polish on the custom tab', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText(translate('pl', 'spk.tabCustom')));
    only('pl', 'proxy.neverInvents');
  });
});

describe('the balloon import in Italian', () => {
  beforeEach(() => useStore.setState({ lang: 'it' }));

  it('explains the .GLL licence position in Italian', () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText(translate('it', 'spk.tabImport')));
    // The paragraph is split around the mono ".GLL", so match the clause.
    expect(screen.queryByText(new RegExp(translate('it', 'bal.noGllWhy').slice(0, 40)))).not.toBeNull();
    expect(screen.queryByText(new RegExp(EN['bal.noGllWhy'].slice(0, 40)))).toBeNull();
  });

  it('asks for the licence attestation in Italian once a balloon is loaded', async () => {
    render(<SpeakerDialog onClose={() => {}} />);
    fireEvent.click(screen.getByText(translate('it', 'spk.tabImport')));

    const rows = [
      'freq_hz,az_deg,el_deg,mag_db,phase_deg',
      ...[-180, -90, 0, 90, 180].map((az) => `50,${az},0,${100 + Math.abs(az) / 10},0`),
    ].join('\n');
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File([rows], 'balloon.csv', { type: 'text/csv' })],
      configurable: true,
    });
    fireEvent.change(input);

    expect(await screen.findByText(translate('it', 'bal.licensed'))).toBeTruthy();
    expect(screen.queryByText(EN['bal.licensed'])).toBeNull();
  });
});

describe('the plot chrome', () => {
  it('translates the Fit button, not only its tooltip', () => {
    useStore.setState({ lang: 'pl' });
    render(<PlotToolbar />);
    expect(screen.queryByText('Fit')).toBeNull();
    expect(screen.queryByText(translate('pl', 'plot.fit'))).not.toBeNull();
  });

  it('says "no sources" in the polar plot in the operator’s language', () => {
    useStore.setState({ lang: 'it' });
    render(<PolarPlot sources={[]} speedOfSound={343} ground="off" />);
    only('it', 'polar.noSources');
  });
});
