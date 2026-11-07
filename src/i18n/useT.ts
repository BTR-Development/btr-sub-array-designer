import { useStore } from '../state/store';
import { translate, type MessageKey, type Vars } from './index';

/**
 * `const t = useT()` then `t('src.title')`.
 *
 * A hook rather than a bare function so a language change re-renders the tree —
 * the store subscription is the whole mechanism.
 */
export function useT(): (key: MessageKey, vars?: Vars) => string {
  const lang = useStore((s) => s.lang);
  return (key, vars) => translate(lang, key, vars);
}
