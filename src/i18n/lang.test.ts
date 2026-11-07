// @vitest-environment jsdom
/**
 * The language has to survive a reload.
 *
 * It used to be hardcoded to English with no reader and no writer, so an
 * operator who picked Polish got Polish until the next refresh and English
 * after it — with nothing on screen to explain why. `<html lang>` was wrong
 * the whole time too, which is what a screen reader goes by.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDocumentLang, detectLang, initialLang, LANG_KEY, rememberLang, storedLang } from './lang';
import { useStore } from '../state/store';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.lang = 'en';
});

afterEach(() => {
  localStorage.clear();
});

describe('detection', () => {
  it('takes the first browser preference this app actually speaks', () => {
    expect(detectLang(['sv-SE', 'it-CH', 'pl'])).toBe('it');
  });

  it('matches on the primary subtag, not the whole tag', () => {
    expect(detectLang(['pl-PL'])).toBe('pl');
  });

  it('says nothing rather than guessing when it speaks none of them', () => {
    expect(detectLang(['sv-SE', 'de'])).toBeNull();
  });
});

describe('what the operator picked', () => {
  it('is remembered across a reload', () => {
    rememberLang('pl');
    expect(storedLang()).toBe('pl');
    expect(initialLang()).toBe('pl');
  });

  it('outranks the browser, including a deliberate pick of English', () => {
    rememberLang('en');
    expect(detectLang(['pl-PL'])).toBe('pl');
    expect(initialLang()).toBe('en');
  });

  it('falls back to English when nothing is stored and nothing matches', () => {
    expect(initialLang()).toBe('en');
  });

  it('ignores a stored value that is not a language we have', () => {
    localStorage.setItem(LANG_KEY, 'klingon');
    expect(storedLang()).toBeNull();
  });
});

describe('the document element', () => {
  it('follows the language, for screen readers and hyphenation', () => {
    applyDocumentLang('it');
    expect(document.documentElement.lang).toBe('it');
  });

  it('is set by the boot-time choice, not only by a later pick', () => {
    rememberLang('pl');
    document.documentElement.lang = 'en';
    initialLang();
    expect(document.documentElement.lang).toBe('pl');
  });
});

describe('the store', () => {
  it('writes the choice through, so the next session starts there', () => {
    useStore.getState().setLang('it');
    expect(useStore.getState().lang).toBe('it');
    expect(localStorage.getItem(LANG_KEY)).toBe('it');
    expect(document.documentElement.lang).toBe('it');
    useStore.getState().setLang('en');
  });
});
