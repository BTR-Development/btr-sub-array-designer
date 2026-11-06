/**
 * Opening and saving a project, the way a document program does it: Save writes back to the file the
 * project came from, Save as asks where, Open and the recent list reopen by path, and
 * nothing that is unsaved is thrown away without asking.
 *
 * Kept out of the components because four places start these actions — the
 * File menu, the keyboard, the unsaved-changes dialog and the operating
 * system handing over a file — and they must all behave the same. The top bar
 * binds the parts that need its UI (its error and notice strips) once it is mounted.
 */
import { useStore, type DiscardThen } from '../state/store';
import { EXPORTERS, importerFor } from '../io/registry';
import { legacyYawNotice } from '../io/btrJson';
import { describeUnreadableSpeakerFile } from '../io/speakerData/balloonImport';
import { requestFit } from '../render/view';
import { worthSaving } from '../state/autosave';
import { fileHost, PROJECT_EXTENSION, type HostFile } from '../platform/fileHost';
import { forgetRecent, rememberRecent } from '../platform/recentFiles';
import type { MessageKey, Vars } from '../i18n';

export interface FileUi {
  t: (key: MessageKey, vars?: Vars) => string;
  setError: (msg: string | null) => void;
  setNotice: (msg: string | null) => void;
}

let ui: FileUi | null = null;

export function bindFileUi(next: FileUi | null) {
  ui = next;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The name a project is saved under, in the project format. */
export function projectFileName(name: string): string {
  const base = (name || 'project').replace(/[^\w\-. ]+/g, '_').replace(/(\.btr)?\.(json|btrsub)$/i, '');
  return `${base}${PROJECT_EXTENSION}`;
}

/** Open what the user picked, dropped or double-clicked: a project file. */
export async function openHostFile(f: HostFile): Promise<void> {
  if (!ui) return;
  ui.setError(null);
  const file = new File([f.bytes as BlobPart], f.name);
  const importer = importerFor(file);
  if (!importer) {
    // A dropped .GLL deserves the real reason and the way forward, not a shrug.
    ui.setError(describeUnreadableSpeakerFile(f.name) ?? `No importer accepts "${f.name}".`);
    return;
  }
  try {
    const p = await importer.import(file);
    ui.setNotice(legacyYawNotice(p));
    const s = useStore.getState();
    s.loadDoc(
      {
        project: p.project,
        sources: p.sources,
        groups: p.groups,
        measurementPoints: p.measurementPoints,
        customSpeakers: p.customSpeakers,
      },
      p.simulationSettings,
    );
    s.markSaved({ path: f.path, name: f.name });
    if (f.path && fileHost().canReopen) rememberRecent(f.path, f.name);
    requestFit();
  } catch (e) {
    ui.setError(message(e));
  }
}

export async function openDialog(): Promise<void> {
  try {
    const f = await fileHost().open();
    if (f) await openHostFile(f);
  } catch (e) {
    ui?.setError(message(e));
  }
}

export async function openRecent(path: string, name: string): Promise<void> {
  try {
    await openHostFile(await fileHost().read(path));
  } catch (e) {
    // moved or deleted since: say so once, and stop offering it
    forgetRecent(path);
    ui?.setError(ui.t('tb.recentGone', { name, error: message(e) }));
  }
}

/**
 * Save in place when the project has a file this host can write again;
 * otherwise, and always with `asNew`, ask where. True when it was saved.
 */
export async function saveProject(asNew = false): Promise<boolean> {
  const s = useStore.getState();
  const host = fileHost();
  const text = await (await EXPORTERS[0].export(s.toProject())).text();
  if (!asNew && s.file.path) {
    const name = s.file.name ?? projectFileName(s.project.name);
    try {
      await host.save(s.file.path, text);
    } catch (e) {
      ui?.setError(ui.t('tb.saveFailed', { name, error: message(e) }));
      return false;
    }
    useStore.getState().markSaved({ path: s.file.path, name });
    if (host.canReopen) rememberRecent(s.file.path, name);
    s.showToast({ message: 'toast.saved', vars: { name }, undoDepth: null });
    return true;
  }
  const suggested = projectFileName(s.file.name ?? s.project.name);
  let saved;
  try {
    saved = await host.saveAs(suggested, text);
  } catch (e) {
    ui?.setError(ui.t('tb.saveFailed', { name: suggested, error: message(e) }));
    return false;
  }
  if (!saved) return false;
  useStore.getState().markSaved(saved);
  if (saved.path && host.canReopen) rememberRecent(saved.path, saved.name);
  s.showToast({ message: 'toast.saved', vars: { name: saved.name }, undoDepth: null });
  return true;
}

/** Carry out what the user asked for once unsaved work is dealt with. */
export function proceed(then: DiscardThen) {
  if (then.action === 'new') {
    useStore.getState().newProject();
    requestFit();
  } else if (then.action === 'open') void openDialog();
  else if (then.action === 'openFile') void openHostFile(then.file);
  else void openRecent(then.path, then.path.split(/[\\/]/).pop() ?? then.path);
}

/**
 * Replace the project only after asking, when there is work that is not in a
 * file: Save / Don't save / Cancel (ConfirmDialog). An empty project, or one
 * that matches its file, goes ahead at once.
 */
export function guardUnsaved(then: DiscardThen) {
  const s = useStore.getState();
  if (s.dirty && worthSaving(s.sources.length, s.measurementPoints.length)) {
    s.askConfirm({ kind: 'discardChanges', then });
    return;
  }
  proceed(then);
}
