// @vitest-environment jsdom
/**
 * Presety użytkownika: zapis, nadpisanie po nazwie, usunięcie, i zachowanie
 * bez działającego localStorage. To jedyne presety aplikacji — wbudowane
 * zostały usunięte — więc ten moduł jest całym mechanizmem tej funkcji.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { deleteUserPreset, listUserPresets, saveUserPreset } from './userPresets';
import type { BTRProject } from '../core/types';

const proj = (name: string): BTRProject =>
  ({ format: 'btr', version: 2, project: { name }, sources: [], groups: [],
     measurementPoints: [], simulationSettings: {} as never, customSpeakers: [] }) as never;

afterEach(() => localStorage.clear());

describe('user presets', () => {
  it('saves, lists and deletes', () => {
    const a = saveUserPreset('FOH sobota', proj('a'));
    expect(a).not.toBeNull();
    saveUserPreset('Klub', proj('b'));
    expect(listUserPresets().map((p) => p.name)).toEqual(['FOH sobota', 'Klub']);

    deleteUserPreset(a!.id);
    expect(listUserPresets().map((p) => p.name)).toEqual(['Klub']);
  });

  it('the same name overwrites instead of multiplying', () => {
    const first = saveUserPreset('FOH', proj('v1'))!;
    const second = saveUserPreset('FOH', proj('v2'))!;
    expect(second.id).toBe(first.id);
    const list = listUserPresets();
    expect(list).toHaveLength(1);
    expect((list[0].project as BTRProject).project.name).toBe('v2');
  });

  it('refuses an empty name and survives rubbish in storage', () => {
    expect(saveUserPreset('   ', proj('x'))).toBeNull();
    localStorage.setItem('btr.userPresets', '{nie json');
    expect(listUserPresets()).toEqual([]);
    localStorage.setItem('btr.userPresets', JSON.stringify([{ bez: 'pol' }, null]));
    expect(listUserPresets()).toEqual([]);
  });
});
