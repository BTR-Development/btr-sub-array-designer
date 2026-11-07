/**
 * The last projects opened or saved, by path (eight, in the
 * File menu and on the start screen).
 *
 * Kept by the page rather than by each shell, so macOS and Windows show the
 * same list in the same place; the shells still tell the system (the Dock's
 * and the taskbar's own recent lists). Only hosts that can reopen a file by
 * its path keep one: a browser has nothing to reopen.
 */
const KEY = 'btr.recentFiles';
export const MAX_RECENT = 8;

export interface RecentFile {
  path: string;
  name: string;
  /** ISO time of the last open or save */
  at: string;
}

export function recentFiles(): RecentFile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((r): r is RecentFile => typeof r?.path === 'string' && typeof r?.name === 'string')
      : [];
  } catch {
    return [];
  }
}

function write(list: RecentFile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // a full or blocked storage loses the list, not the project
  }
}

export function rememberRecent(path: string, name: string, now = new Date()) {
  write([{ path, name, at: now.toISOString() }, ...recentFiles().filter((r) => r.path !== path)]);
}

export function forgetRecent(path: string) {
  write(recentFiles().filter((r) => r.path !== path));
}
