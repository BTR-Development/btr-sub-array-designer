import { describe, expect, it } from 'vitest';
import { allSpeakers } from './store';
import { builtinProvider } from '../speakers/provider';

describe('the models the program offers', () => {
  it('are the six subs, in order', () => {
    expect(allSpeakers([]).map((m) => m.model)).toEqual(['KS28', 'KS21', 'SB18', 'J-SUB', 'SL-SUB', 'KSL-SUB']);
  });

  it('still include a hidden model a project already uses, after the offered ones', () => {
    expect(allSpeakers([], ['db-b22-sub', 'la-ks28']).map((m) => m.id)).toEqual([
      'la-ks28', 'la-ks21', 'la-sb18', 'db-j-sub', 'db-sl-sub', 'db-ksl-sub', 'db-b22-sub',
    ]);
  });

  it('hide, not delete: an old project’s model still resolves for prediction', () => {
    for (const id of ['db-b22-sub', 'db-v-sub', 'btr-ref-omni-18', 'nexo-rs18']) expect(builtinProvider.get(id)).toBeTruthy();
  });
});
