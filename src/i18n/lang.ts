/**
 * Which language the interface comes up in, and where that survives a reload.
 *
 * The language belongs to the operator, not to the document: a Polish engineer
 * who opens a file a colleague saved in Italy still wants Polish. So it is
 * never written into a project file, and it is remembered per browser instead.
 *
 * The order is: what the operator last chose, then what the browser says they
 * read, then English. Detection is a first guess and nothing more — one pick
 * from the top bar outranks it from then on, including a deliberate pick of
 * English on a Polish machine, which is why the stored value is consulted
 * first and is never overwritten by detection.
 *
 * An embedding host is not locked out by any of this: `setLang` both applies
 * and remembers, so a host that wants to drive the language calls it once on
 * boot and its choice becomes the stored one. The roadmap's reason for leaving
 * this to the host was that operator state is not the app's to keep; a first
 * guess the operator can overrule, and that the host can overrule, is.
 *
 * `<html lang>` is set from the same value. It is not decoration: it is what
 * tells a screen reader which voice to use and the browser which hyphenation
 * and spell-check dictionary to load, and the served HTML cannot know the
 * answer. Applying it lives here, next to the decision, rather than in a
 * component — the error boundary renders with no store and no hooks, and the
 * attribute still has to be right there.
 */
import type { Lang } from './index';

/** Namespaced like every other key this app owns in local storage. */
export const LANG_KEY = 'btr.lang';

const SUPPORTED: readonly Lang[] = ['en', 'pl', 'it'];

function asLang(value: string | null | undefined): Lang | null {
  // Only the primary subtag decides: pl-PL, it-CH and en-GB are all served by
  // the dictionary of their base language.
  const base = value?.toLowerCase().split('-')[0] ?? '';
  return SUPPORTED.find((l) => l === base) ?? null;
}

/**
 * The operator's last explicit choice, or null.
 *
 * Reading storage throws outright in a browser with site data blocked, and the
 * language is never worth failing a boot over.
 */
export function storedLang(): Lang | null {
  try {
    return asLang(localStorage.getItem(LANG_KEY));
  } catch {
    return null;
  }
}

/**
 * The first language the browser asks for that this app actually has.
 *
 * `languages` is in the user's own order of preference, so a machine set to
 * pl, then it, then en gets Polish rather than whichever we happen to test
 * first. The argument exists for the tests; nothing else passes it.
 */
export function detectLang(preferred?: readonly string[]): Lang | null {
  const list =
    preferred ??
    (typeof navigator === 'undefined'
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language]);
  for (const tag of list) {
    const l = asLang(tag);
    if (l) return l;
  }
  return null;
}

/** Mirror the language onto the document, for assistive tech and the browser. */
export function applyDocumentLang(lang: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
}

/**
 * The language to start in. Called once, for the store's initial state, and it
 * applies `<html lang>` on the way past so the attribute is right from the
 * first paint rather than from the first render of a component.
 */
export function initialLang(): Lang {
  const lang = storedLang() ?? detectLang() ?? 'en';
  applyDocumentLang(lang);
  return lang;
}

/** Remember an explicit choice, and mirror it onto the document. */
export function rememberLang(lang: Lang): void {
  applyDocumentLang(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // A session that cannot write its preference is still usable; it just
    // starts in the detected language next time.
  }
}
