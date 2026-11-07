/**
 * Presety UŻYTKOWNIKA — jedyne presety, jakie aplikacja ma.
 *
 * Menu „Presety"
 * trzyma wyłącznie to, co użytkownik sam zapisał. Preset to cały projekt
 * (toProject), zapisany pod nazwą w localStorage — ten sam format, który idzie
 * do pliku .btr.json, więc wczytanie przechodzi przez ten sam parser i stare
 * presety przeżywają zmiany modelu dokładnie tak, jak stare pliki.
 *
 * localStorage bywa niedostępny (prywatne okno, czyszczenie danych), więc
 * każda operacja jest opakowana i zwraca uczciwą pustkę zamiast wyjątku —
 * menu pokazuje wtedy „brak presetów", a zapis po prostu melduje porażkę.
 */
import type { BTRProject } from '../core/types';

export interface UserPreset {
  id: string;
  name: string;
  /** ISO — kiedy zapisany; menu pokazuje to małym drukiem */
  savedAt: string;
  project: BTRProject;
}

const KEY = 'btr.userPresets';

function read(): UserPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (p): p is UserPreset =>
        !!p && typeof p.id === 'string' && typeof p.name === 'string' && !!p.project,
    );
  } catch {
    return [];
  }
}

function write(list: UserPreset[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function listUserPresets(): UserPreset[] {
  return read();
}

/**
 * Zapisuje projekt pod nazwą. Ta sama nazwa NADPISUJE istniejący preset —
 * zapis „FOH sobota" po poprawce ma znaczyć „ten sam preset, nowsza wersja",
 * a nie mnożyć wpisy, których nie da się potem odróżnić.
 */
export function saveUserPreset(name: string, project: BTRProject): UserPreset | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const list = read();
  const existing = list.find((p) => p.name === trimmed);
  const preset: UserPreset = {
    id: existing?.id ?? `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    savedAt: new Date().toISOString(),
    project,
  };
  const next = existing ? list.map((p) => (p.id === preset.id ? preset : p)) : [...list, preset];
  return write(next) ? preset : null;
}

export function deleteUserPreset(id: string): void {
  write(read().filter((p) => p.id !== id));
}
