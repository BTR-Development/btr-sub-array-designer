/**
 * The dictionaries as a contract rather than as a best effort.
 *
 * A missing key is not a visible failure — `translate` falls back to English —
 * so a half-translated interface looks deliberate and nobody notices. That is
 * exactly how the data-class warnings and the licence attestation stayed in
 * English while the buttons around them were localised. These tests make the
 * gap loud instead.
 *
 * A placeholder mismatch IS visible, and badly: the renderer leaves an unknown
 * `{name}` standing in the output, so a translated sentence shows a raw brace
 * to the user.
 */
import { describe, expect, it } from 'vitest';
import { DICTS, EN, LANGUAGES, translate, type Lang, type MessageKey } from './index';

const KEYS = Object.keys(EN) as MessageKey[];
const OTHER: Lang[] = ['pl', 'it'];

const placeholders = (s: string) => new Set(s.match(/\{(\w+)\}/g) ?? []);

describe('the dictionaries cover the same ground', () => {
  it.each(OTHER)('%s translates every English key', (lang) => {
    const missing = KEYS.filter((k) => !DICTS[lang][k]);
    expect(missing).toEqual([]);
  });

  it.each(OTHER)('%s has no key English does not have', (lang) => {
    const orphans = Object.keys(DICTS[lang]).filter((k) => !(k in EN));
    expect(orphans).toEqual([]);
  });

  it.each(OTHER)('%s carries the same placeholders as English', (lang) => {
    // The Polish tour inflects these control names, which a placeholder cannot do.
    // tutorial.test.tsx checks that its own placeholders are all filled.
    const inflected = ['tour.welcome.body', 'tour.edit.body', 'tour.output.body'];
    const wrong = KEYS.filter((k) => {
      if (lang === 'pl' && inflected.includes(k)) return false;
      const raw = DICTS[lang][k];
      if (!raw) return false; // a missing key is the test above, not this one
      const en = placeholders(EN[k]);
      const other = placeholders(raw);
      return en.size !== other.size || [...en].some((p) => !other.has(p));
    });
    expect(wrong).toEqual([]);
  });

  it('offers exactly the languages it has dictionaries for', () => {
    expect(LANGUAGES.map((l) => l.id).sort()).toEqual(Object.keys(DICTS).sort());
  });
});

describe('the honesty contract is not left in English', () => {
  /**
   * The strings a user has to be able to read to know how much of a number to
   * believe, or what they are attesting to. A fallback to English here is the
   * whole finding, so these are checked for a real translation and not merely
   * for a present key.
   */
  const CONTRACT: MessageKey[] = [
    'q.a',
    'q.b',
    'q.c',
    'q.d',
    'spk.notVendorData',
    'spk.dimsUnknown',
    'proxy.title',
    'proxy.approx',
    'proxy.none',
    'proxy.neverInvents',
    'proxy.rebuiltGradient',
    'proxy.borrowedBalloon',
    'proxy.idealOmni',
    'proxy.analytical',
    'facts.dimsUnknown',
    'facts.maxSplUnknown',
    'bal.noGllWhy',
    'bal.licensed',
    'bal.localOnly',
    'bal.gradeB',
    'bal.dimHint',
    'bal.provenanceHint',
    'plot.refused',
    'plot.refusedWhy',
    'subs.footprintUnknown',
    'subs.stackNoHeight',
    'subs.reverseNoDepth',
    'subs.reverseCardioid',
    'subs.cannotRebuild',
    'insp.negativeDelay',
  ];

  it.each(OTHER)('%s says them in its own words', (lang) => {
    const untranslated = CONTRACT.filter((k) => translate(lang, k) === EN[k]);
    expect(untranslated).toEqual([]);
  });
});

describe('translate', () => {
  it('fills placeholders from the chosen language', () => {
    expect(translate('pl', 'arr.overlap', { w: '0.60' })).toContain('0.60');
  });

  it('leaves an unknown placeholder alone rather than printing undefined', () => {
    expect(translate('en', 'arr.overlap', {})).toContain('{w}');
  });
});
