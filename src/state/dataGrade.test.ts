import { describe, expect, it } from 'vitest';
import { makeSource } from './store';
import { mapDataGrade } from './dataGrade';
import { builtinProvider } from '../speakers/provider';
import type { Group } from '../core/types';

const at = (x: number) => ({ x, y: 0, z: 0.3 });

describe('mapDataGrade', () => {
  it('is null for an empty or fully muted project', () => {
    expect(mapDataGrade([], [], builtinProvider)).toBeNull();
    const s = { ...makeSource('la-ks28', 'A', at(0)), mute: true };
    expect(mapDataGrade([s], [], builtinProvider)).toBeNull();
  });

  it('is the model’s own grade for a rig of one model', () => {
    const rig = [0, 1, 2].map((x) => makeSource('la-ks28', `S${x}`, at(x)));
    expect(mapDataGrade(rig, [], builtinProvider)).toEqual({ grade: 'C', models: 1 });
  });

  it('is the WEAKEST grade among the sounding cabinets', () => {
    const rig = [makeSource('la-ks28', 'B', at(0)), makeSource('la-ks21', 'C', at(1))];
    expect(mapDataGrade(rig, [], builtinProvider)).toEqual({ grade: 'C', models: 2 });
  });

  it('leaves out what is muted, by itself or by its group', () => {
    const g: Group = {
      id: 'g', name: 'G', offset: { x: 0, y: 0, z: 0 }, rotationOffsetDeg: 0,
      anchor: { x: 0, y: 0, z: 0 }, levelOffsetDb: 0, delayOffsetS: 0, mute: true,
    };
    const ks28 = makeSource('la-ks28', 'B', at(0));
    const inMutedGroup = { ...makeSource('la-ks21', 'C', at(1)), groupId: 'g' };
    const muted = { ...makeSource('la-sb18', 'C', at(2)), mute: true };
    expect(mapDataGrade([ks28, inMutedGroup, muted], [g], builtinProvider)).toEqual({ grade: 'C', models: 1 });
  });
});
