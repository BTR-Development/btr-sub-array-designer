import { create } from 'zustand';
import {
  defaultSimulationSettings,
  speedOfSoundFromTemp,
  type BTRProject,
  type Group,
  type MeasurementPoint,
  type ProjectMeta,
  type Rotation,
  type SimulationSettings,
  type Source,
  type Vec3,
} from '../core/types';

/** Patch shape that allows partial position / rotation updates. */
export type SourcePatch = Omit<Partial<Source>, 'position' | 'rotation'> & {
  position?: Partial<Vec3>;
  rotation?: Partial<Rotation>;
};
import { centreZFromBottomFace, type SpeakerModel } from '../speakers/schema';
import { DEFAULT_CAMERA, type Camera3D } from '../render/camera3d';
import { BUILTIN_SPEAKERS, DEFAULT_SPEAKER_ID, OFFERED_SPEAKER_IDS } from '../speakers/library';
import { CompositeSpeakerDataProvider, builtinProvider } from '../speakers/provider';
import { BRANDING } from '../branding';
import type { PaletteId } from '../render/colormap';
import type { Lang, MessageKey, Vars } from '../i18n';
import { initialLang, rememberLang } from '../i18n/lang';
import { rotateSelection } from './rotateSelection';
import {
  layoutSources,
  reversedFlags,
  writeReversalPattern,
  rotatePositions,
  type DelayPlan,
  type LayoutOptions,
} from './arrayTools';
import { INITIAL_ARRAY_MODULE, moduleNameFor, type ArrayModuleState } from './arrayModule';
import { rotateXY } from './resolve';
import { crossAxes, type ArrayAxis } from '../engine/steering';
import { drawnAxes } from '../render/view';

let idCounter = 0;
export const newId = (p: string) => `${p}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

/** The part of the state that undo/redo tracks. */
export interface Doc {
  project: ProjectMeta;
  sources: Source[];
  groups: Group[];
  measurementPoints: MeasurementPoint[];
  customSpeakers: SpeakerModel[];
}

export type SnapValue = 0 | 0.05 | 0.1 | 0.25 | 0.5 | 1;

/**
 * One undo step: the document AND the prediction settings. Everything the project file carries is undoable, so a
 * frequency, an area or a quality changed by mistake comes back like a moved
 * cabinet does.
 */
export interface HistoryEntry extends Doc {
  sim: SimulationSettings;
  /**
   * The file the project belonged to at that step. Undoing past an Open must
   * give the old project its old file back: otherwise Save would write the
   * previous project over the file that was just opened.
   */
  file: ProjectFile;
}

/**
 * A question the user still has to answer before an action goes ahead.
 *
 * Deleting no longer asks: it happens at once and offers
 * Undo in a toast. What still asks is throwing away UNSAVED work, because
 * that is the one loss undo cannot bring back once the project is replaced.
 */
export type PendingConfirm = { kind: 'discardChanges'; then: DiscardThen };
/** what the user was doing when the unsaved-changes question came up */
export type DiscardThen =
  | { action: 'new' }
  | { action: 'open' }
  | { action: 'openPath'; path: string }
  /** handed over by the operating system or dropped on the window */
  | { action: 'openFile'; file: { path: string | null; name: string; bytes: Uint8Array } };

/** A short message over the plot; `undoDepth` arms its Undo button for exactly one history step. */
export interface Toast {
  id: number;
  message: MessageKey;
  vars?: Vars;
  /** the history depth right after the action; Undo is offered only while it is still the latest step */
  undoDepth: number | null;
}

/** Where the project lives on disk, as far as this window knows. */
export interface ProjectFile {
  /** absolute path in the desktop apps; null when never saved, or opened in a browser */
  path: string | null;
  /** file name to show and to suggest on Save as */
  name: string | null;
}

export interface ViewTransform {
  /** pixels per metre */
  scale: number;
  /** world coordinate at the canvas centre */
  cx: number;
  cy: number;
}

interface Clipboard {
  sources: Source[];
  groups: Group[];
}

export interface AppState extends Doc {
  sim: SimulationSettings;

  // ---- selection & UI (never part of undo history) ----
  selectedSourceIds: string[];
  selectedGroupId: string | null;
  selectedPointId: string | null;
  /** where a shift-range selection starts from */
  anchorSourceId: string | null;
  cursorPoint: Vec3 | null;
  snap: SnapValue;
  view: ViewTransform;
  showDebug: boolean;
  /** the Groups panel in the left column */
  showGroups: boolean;
  /** the guided tour is on screen; main.tsx raises it on the first run ever */
  tutorialOpen: boolean;
  setTutorialOpen: (open: boolean) => void;
  showSteering: boolean;
  showPolar: boolean;
  /** the Source GPS dock: every cabinet's coordinates and polarity in one list */
  showGps: boolean;
  /** the four frequencies drawn on the polar pattern */
  polarFrequencies: number[];
  showGrid: boolean;
  showHeatmap: boolean;
  palette: PaletteId;
  /**
   * When on, the render recomputes after every change that affects it. When off,
   * changes mark the render stale and wait for an explicit Recalculate.
   */
  autocalculate: boolean;
  /** set while autocalculate is off and the shown map no longer matches the project */
  renderStale: boolean;
  /** bumped by Recalculate to force one solve while autocalculate is off */
  recalcToken: number;
  /**
   * User-set pixel sizes for the resizable panes, keyed by pane. A key that is
   * absent means "whatever the stylesheet says" — the layout stays responsive
   * until the user takes hold of a splitter, and only then is pinned.
   */
  /**
   * Interface language. Not part of the document — it follows the operator,
   * and is remembered in this browser rather than in the project file.
   */
  lang: Lang;
  layout: Record<string, number>;
  /**
   * A destructive action waiting for the user to say yes. Held as a description
   * rather than a callback so the state stays plain data and the dialog can be
   * rendered from anywhere.
   */
  pendingConfirm: PendingConfirm | null;
  /** true while the user is dragging — the prediction drops to Draft quality */
  interacting: boolean;
  tool: 'select' | 'addPoint';

  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  clipboard: Clipboard | null;

  /** the file this project was opened from or last saved to */
  file: ProjectFile;
  /** changed since it was last opened or saved */
  dirty: boolean;
  toast: Toast | null;

  provider: CompositeSpeakerDataProvider;

  // ---- history ----
  snapshot: () => void;
  undo: () => void;
  redo: () => void;

  // ---- sources ----
  addSource: (speakerId: string, position?: Partial<Vec3>) => string;
  addSources: (sources: Source[]) => void;
  patchSources: (ids: string[], patch: SourcePatch, history?: boolean) => void;
  moveSources: (ids: string[], delta: Vec3, history?: boolean) => void;
  /**
   * Delete the selection at once, and say so in a toast with Undo: removing
   * cabinets is the one edit whose result is an absence, and an absence is
   * hard to notice in time to undo it (instead of a dialog).
   */
  deleteSelected: () => void;
  duplicateSelected: () => void;
  selectSources: (ids: string[], additive?: boolean) => void;
  /**
   * Click-to-select with the usual modifier behaviour, given the list the user is
   * looking at (tree or table order).
   *   plain  -> just this one, and it becomes the anchor
   *   toggle -> add/remove this one, and it becomes the anchor
   *   range  -> everything between the anchor and this one, anchor unchanged
   */
  selectSourceAt: (
    id: string,
    orderedIds: string[],
    mods?: { toggle?: boolean; range?: boolean },
  ) => void;
  selectAll: () => void;

  // ---- arrays & layout ----
  createArray: (opts: {
    sourceId: string;
    count: number;
    spacingM: number;
    axis: 'x' | 'y' | 'z';
    centered: boolean;
    arcDeg?: number;
  }) => void;
  /**
   * Create a NEW sub array as its own module, so a project can hold more than
   * one. Placed clear of whatever is already there and selected, which is what
   * makes the SUBS panel switch to it. Returns the new group's id.
   */
  createSubArray: (opts: {
    speakerId: string;
    count: number;
    spacingM: number;
    axis: 'x' | 'y' | 'z';
    name?: string;
  }) => string | null;
  /** Rebuild an array's geometry (Steering panel "Apply layout"). */
  applyArrayLayout: (
    ids: string[],
    opts: Omit<LayoutOptions, 'template'> & {
      speakerId?: string;
      /**
       * false pomija wpis undo — dla suwaka rozstawu, który pisze geometrię
       * przy każdym ruchu. Gest bierze jeden wpis, nie jeden na piksel; ta
       * sama zasada co w applyDelayPlan.
       */
      history?: boolean;
    },
  ) => void;
  /**
   * Write a computed delay/level taper onto members (Steering panel "Apply delay").
   *
   * `opts.groupAs` makes the transform own a module. Cabinets that belong to no
   * group are gathered into one of that name; cabinets that are already in a
   * module stay in it, offsets and all, and a module whose name asserts an angle
   * is renamed to the angle just applied. `opts.history: false` suppresses the
   * undo snapshot, for the live re-apply that runs while a steering field is
   * being dragged.
   */
  /**
   * Wzór F/B zapisany od razu, bez przebudowy — patrz writeReversalPattern.
   * Jeden klik to jeden wpis undo.
   */
  /**
   * Obrót pozycji wskazanych obudów jak jednej obudowy, do kąta bezwzględnego
   * (patrz arrayTools.rotatePositions). Jeden wpis undo.
   */
  rotatePositions: (ids: string[], yawDeg: number) => void;
  /**
   * Obrót zaznaczenia o przyrost, jak jednej bryły: po okręgu wokół środka
   * zaznaczenia (patrz rotateSelection). `from` = stan, od którego liczyć
   * (przeciąganie podaje stan sprzed przeciągnięcia); `history: false` gdy
   * wywołujący sam zrobił snapshot.
   */
  rotateSelected: (ids: string[], deltaDeg: number, opts?: { from?: Source[]; history?: boolean }) => void;
  setReversalPattern: (
    ids: string[],
    pattern: boolean[],
    opts: { axis: ArrayAxis; placeTolM: number; forwardAzimuthDeg: number; reverseDelayS: number },
  ) => void;
  applyDelayPlan: (
    ids: string[],
    plan: DelayPlan,
    opts?: {
      groupAs?: string;
      history?: boolean;
      /**
       * Zaszyty gradient kardioidy per obudowa (sekundy, w kolejności ids):
       * d/c dla odwróconej, 0 dla przedniej. Pisany ABSOLUTNIE do
       * Source.gradientDelayS, obok planu — nie do kolumny delayów. To także
       * migracja: rig zbudowany ręcznie albo starym kodem nosił d/c w delayS,
       * plan tę kolumnę nadpisuje łukiem, więc gradient przeprowadza się tu
       * do pola, którego plan nie dotyka.
       */
      gradientDelaysS?: number[];
    },
  ) => void;
  /**
   * The group that owns `ids`, creating one if they are ALL loose. Returns its
   * id, or null when the cabinets are spread over modules that already exist:
   * a common relative delay or level needs somewhere to live, but not at the
   * price of dissolving the modules it would have to be built out of.
   */
  ensureGroup: (ids: string[], name?: string) => string | null;
  /** Nudge one column of the module by a fixed step. */
  nudgeColumn: (
    ids: string[],
    column: 'levelDb' | 'x' | 'y' | 'z' | 'azimuthDeg' | 'delayS',
    delta: number,
  ) => void;
  resetModule: (
    ids: string[],
    full: boolean,
    /**
     * Gradient kardioidy, który CZĘŚCIOWY reset ma zostawić w rigu. Delay
     * odwróconej obudowy to jej konfiguracja, nie sterowanie: "Reset poziomów
     * + delayów" zdejmuje taper i poziomy, a nie rozbraja kardioidę — od tego
     * jest "Reset wszystkiego", który prostuje też heading i polaryzację.
     * Bez tych pól częściowy reset zerował d/c odwróconych skrzyń i rig
     * zostawał "odwrócony" bez gradientu: tylna strona grała, nikt nie został
     * ostrzeżony.
     */
    opts?: { reverseDelayS?: number; forwardAzimuthDeg?: number },
  ) => void;

  distributeEvenly: (ids: string[], axis: 'x' | 'y') => void;
  centerSelection: (axis: 'x' | 'y' | 'both') => void;
  reverseOrder: (ids: string[]) => void;
  mirrorSelection: (axis: 'x' | 'y', duplicate: boolean) => void;

  // ---- groups ----
  groupSelected: (name?: string) => void;
  ungroup: (groupId: string) => void;
  patchGroup: (id: string, patch: Partial<Group>, history?: boolean) => void;
  deleteGroup: (id: string, deleteMembers: boolean) => void;
  duplicateGroup: (id: string) => void;
  selectGroup: (id: string | null) => void;

  // ---- measurement points ----
  addMeasurementPoint: (position: Vec3, name?: string) => void;
  patchMeasurementPoint: (id: string, patch: Partial<MeasurementPoint>) => void;
  /** used while dragging a point — no history entry per mouse-move */
  patchMeasurementPointTransient: (id: string, position: Vec3) => void;
  deleteMeasurementPoint: (id: string) => void;
  selectPoint: (id: string | null) => void;
  setCursorPoint: (p: Vec3 | null) => void;

  // ---- speakers ----
  addCustomSpeaker: (m: SpeakerModel) => void;

  // ---- simulation & view ----
  patchSim: (patch: Partial<SimulationSettings>) => void;
  setView: (v: Partial<ViewTransform>) => void;
  /**
   * The 3D viewport's camera. Separate from `view` because the two are
   * different mappings of the same world, not two settings of one: switching
   * back to a 2D view has to find the pan and zoom where it left them.
   */
  cam3d: Camera3D;
  setCam3d: (c: Partial<Camera3D>) => void;
  /**
   * Whether the plot is the 3D viewport. NOT a third `PredictionPlane`: the
   * plane says where the SPL is COMPUTED, and the 3D view draws that same
   * plane where it actually sits, which is most of what it is for.
   */
  view3d: boolean;
  setSnap: (s: SnapValue) => void;
  toggle: (
    k:
      | 'showDebug'
      | 'showGroups'
      | 'showSteering'
      | 'showPolar'
      | 'showGps'
      | 'showGrid'
      | 'showHeatmap'
      | 'view3d',
  ) => void;
  setPolarFrequency: (index: number, hz: number) => void;
  setPalette: (p: PaletteId) => void;
  /**
   * Skala skalibrowana: refDb przypięty dwuklikiem w słupek koloru, albo null
   * dla skali automatycznej (czerwień = najgłośniejszy punkt bieżącego
   * rozwiązania). Ustawienie WIDOKU, jak paleta: nie wchodzi do undo ani do
   * pliku projektu.
   */
  calibratedRefDb: number | null;
  setCalibratedRef: (db: number | null) => void;
  /** Pin a resizable pane to a pixel size, or let the stylesheet have it back. */
  setLang: (l: Lang) => void;
  askConfirm: (c: PendingConfirm | null) => void;
  showToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  /** record that the project now lives in this file and matches it */
  markSaved: (file: ProjectFile) => void;
  /**
   * Add another document to this one — the "Add to project" side of an
   * import. One undo step; ids are renewed so nothing collides.
   */
  appendDoc: (d: Doc) => void;
  setLayoutSize: (key: string, px: number) => void;
  resetLayoutSize: (key: string) => void;
  setAutocalculate: (v: boolean) => void;
  markStale: () => void;
  recalculate: () => void;
  setInteracting: (v: boolean) => void;
  setTool: (t: 'select' | 'addPoint') => void;

  // ---- clipboard ----
  copySelection: () => void;
  paste: () => void;

  // ---- project ----
  loadDoc: (d: Doc, sim?: SimulationSettings) => void;
  newProject: () => void;
  /** Zmiana nazwy projektu z paska górnego. Bez historii: nazwa nie jest
      geometrią, a cofanie jej razem z ruchem obudowy myli bardziej niż pomaga. */
  renameProject: (name: string) => void;
  /** author and notes, edited on the delay sheet; like the name, not an undo step */
  patchProjectMeta: (patch: Partial<Pick<ProjectMeta, 'author' | 'notes'>>) => void;
  toProject: () => BTRProject;
}

function cloneDoc(d: Doc): Doc {
  return {
    project: { ...d.project },
    sources: d.sources.map((s) => ({ ...s, position: { ...s.position }, rotation: { ...s.rotation } })),
    groups: d.groups.map((g) => ({ ...g, offset: { ...g.offset }, anchor: { ...g.anchor } })),
    measurementPoints: d.measurementPoints.map((m) => ({ ...m, position: { ...m.position } })),
    customSpeakers: d.customSpeakers.map((m) => ({ ...m })),
  };
}

/**
 * The part of a selection that still exists in a document.
 *
 * `undo` and `redo` both install a document the current selection was never
 * made against, so every id the selection holds can name something the restored
 * document does not contain: a module that was deleted, a measurement point
 * that had not been created yet. `undo` repaired all three fields and `redo`
 * repaired only the source list, so redoing past a module deletion left
 * `selectedGroupId` naming a module the project no longer had — and the panels
 * that read it drove their controls from a group nobody could select away from.
 *
 * One function for both directions. The asymmetry WAS the bug: two copies of
 * this rule is how the second one came to be missing a third of it.
 *
 * `anchorSourceId` is deliberately not repaired. It is the shift-range origin
 * and `selectSourceAt` already falls back to a plain click when it cannot find
 * it in the list on screen, so a dangling anchor costs nothing and that
 * fallback is the documented behaviour rather than an accident.
 */
function selectionWithin(
  doc: Doc,
  sel: {
    selectedSourceIds: string[];
    selectedGroupId: string | null;
    selectedPointId: string | null;
  },
) {
  return {
    selectedSourceIds: sel.selectedSourceIds.filter((id) => doc.sources.some((x) => x.id === id)),
    selectedGroupId: doc.groups.some((g) => g.id === sel.selectedGroupId) ? sel.selectedGroupId : null,
    selectedPointId: doc.measurementPoints.some((m) => m.id === sel.selectedPointId)
      ? sel.selectedPointId
      : null,
  };
}

function historyEntry(s: Doc & { sim: SimulationSettings; file: ProjectFile }): HistoryEntry {
  return { ...cloneDoc(s), sim: { ...s.sim, area: { ...s.sim.area } }, file: { ...s.file } };
}

/**
 * Edits that arrive as a stream — a held slider, typing in the project name,
 * the notes on the delay sheet — become ONE undo step: a new entry only when
 * the field changes, when 1.5 s have passed, or when anything else has been
 * done in between.
 */
let coalescing: { key: string; at: number; depth: number } | null = null;
const COALESCE_MS = 1500;
function snapshotCoalesced(get: () => AppState, key: string) {
  const now = Date.now();
  const c = coalescing;
  if (c && c.key === key && now - c.at < COALESCE_MS && get().undoStack.length === c.depth) {
    c.at = now;
    useStore.setState({ dirty: true });
    return;
  }
  get().snapshot();
  coalescing = { key, at: now, depth: get().undoStack.length };
}

let toastCounter = 0;

function emptyDoc(): Doc {
  return {
    project: { name: 'Untitled', createdAt: new Date().toISOString() },
    sources: [],
    groups: [],
    measurementPoints: [],
    customSpeakers: [],
  };
}

function nextLabel(sources: Source[]): string {
  let n = sources.length + 1;
  const used = new Set(sources.map((s) => s.label));
  while (used.has(`SUB ${String(n).padStart(2, '0')}`)) n++;
  return `SUB ${String(n).padStart(2, '0')}`;
}

export function makeSource(speakerId: string, label: string, position: Vec3): Source {
  return {
    id: newId('src'),
    label,
    speakerId,
    position,
    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
    levelDb: 0,
    delayS: 0,
    invertPolarity: false,
    mute: false,
    groupId: null,
  };
}

/**
 * The group that owns exactly `ids` and nothing else, or null when they are
 * loose, mixed, or only part of a bigger group. Used before creating a module
 * so a second pass of the same tool re-uses the group it made the first time.
 */
function soleGroupOf(sources: Source[], ids: string[]): string | null {
  const idSet = new Set(ids);
  const members = sources.filter((x) => idSet.has(x.id));
  if (!members.length) return null;
  const gid = members[0].groupId;
  if (!gid || members.some((m) => m.groupId !== gid)) return null;
  return sources.some((x) => x.groupId === gid && !idSet.has(x.id)) ? null : gid;
}

/**
 * Whether `name` is one a steering apply WROTE, rather than one a person typed.
 *
 * Asked by handing the number in the name back to the generator: the naming
 * format lives in exactly one place, `moduleNameFor`, and this only asks whether
 * that function would have produced this exact string. Spelling the format out a
 * second time here is how the group-yaw bug survived — two copies of one rule
 * and nothing comparing them.
 *
 * A name it does not recognise is left alone. "SUB ARRAY 2", or "LEFT HANG"
 * typed by the operator, is a decision about the rig; only a name that ASSERTS
 * an angle has to be kept true to the delays underneath it.
 */
function namesATransform(name: string | undefined): boolean {
  if (!name) return false;
  const deg = Number(/-?\d+/.exec(name)?.[0] ?? NaN);
  const candidates: ArrayModuleState[] = Number.isNaN(deg)
    ? [{ ...INITIAL_ARRAY_MODULE, mode: 'endfire' }]
    : [
        { ...INITIAL_ARRAY_MODULE, mode: 'dispersion', dispersionDeg: deg },
        { ...INITIAL_ARRAY_MODULE, mode: 'steer', steerDeg: deg },
      ];
  return candidates.some((c) => moduleNameFor(c) === name);
}

/**
 * The modules that still have a cabinet in them.
 *
 * A module IS its members, so one that has lost the last of them is not a
 * module any more. The record used to stay behind carrying its delay, level and
 * rotation offsets, listed in the module picker and written into the project
 * file and every export: an array that exists nowhere on the canvas and that a
 * later steering pass could still be pointed at.
 *
 * There are three ways to empty a module and this is the rule for all of them.
 * Deleting its cabinets is the obvious one; re-grouping them into another
 * module is the quiet one; shrinking a layout rebuild that was handed more than
 * one module's cabinets is the quietest, because nothing on screen says the
 * tail is being deleted. Each of the three left the same orphan behind until it
 * came through here.
 */
function withoutEmptyGroups(sources: Source[], groups: Group[]): Group[] {
  return groups.filter((g) => sources.some((x) => x.groupId === g.id));
}

/** A fresh group anchored on the centroid of its members. */
function makeGroup(name: string, members: Source[]): Group {
  const n = members.length || 1;
  return {
    id: newId('grp'),
    name,
    offset: { x: 0, y: 0, z: 0 },
    rotationOffsetDeg: 0,
    anchor: {
      x: members.reduce((a, p) => a + p.position.x, 0) / n,
      y: members.reduce((a, p) => a + p.position.y, 0) / n,
      z: members.reduce((a, p) => a + p.position.z, 0) / n,
    },
    levelOffsetDb: 0,
    delayOffsetS: 0,
    mute: false,
  };
}

const MAX_HISTORY = 100;

/**
 * How far a pasted copy is stepped off the original, so that it is visible and
 * can be picked up separately. A drawing convention, not a measurement — and it
 * has to be ONE value, because it moves the members and the group's pivot
 * together.
 */
const PASTE_STEP = { x: 1, y: 1 } as const;

/**
 * Świeże klucze pozycji dla KOPII obudów, z zachowaniem podziału.
 *
 * Kopia niosąca klucz oryginału nie jest jego częścią — a widok "wszystkie
 * źródła" czyta klucze przez cały projekt, więc duplikat modułu skleiłby się
 * pozycjami ze swoim pierwowzorem.
 */
function remapPositionKeys(copies: Source[]): void {
  const fresh = new Map<string, string>();
  for (const c of copies) {
    if (!c.positionKey) continue;
    let k = fresh.get(c.positionKey);
    if (!k) {
      k = newId('pos');
      fresh.set(c.positionKey, k);
    }
    c.positionKey = k;
  }
}

export const useStore = create<AppState>((set, get) => ({
  ...emptyDoc(),
  sim: defaultSimulationSettings(),

  selectedSourceIds: [],
  selectedGroupId: null,
  selectedPointId: null,
  anchorSourceId: null,
  cursorPoint: null,
  snap: 0.25,
  view: { scale: 14, cx: 0, cy: 18 },
  // Domyślny widok programu: izometryczny 3D (DEFAULT_CAMERA). Płaszczyzna
  // predykcji startuje pozioma (plane 'top'), więc 3D pokazuje mapę na podłodze.
  view3d: true,
  cam3d: DEFAULT_CAMERA,
  showDebug: false,
  showGroups: false,
  tutorialOpen: false,
  setTutorialOpen: (tutorialOpen) => set({ tutorialOpen }),
  showSteering: false,
  showPolar: false,
  showGps: false,
  polarFrequencies: [40, 50, 63, 80],
  showGrid: true,
  showHeatmap: true,
  palette: 'spl',
  calibratedRefDb: null,
  autocalculate: true,
  renderStale: false,
  recalcToken: 0,
  interacting: false,
  tool: 'select',

  lang: initialLang(),
  layout: {},
  pendingConfirm: null,
  undoStack: [],
  redoStack: [],
  clipboard: null,
  file: { path: null, name: null },
  dirty: false,
  toast: null,

  provider: new CompositeSpeakerDataProvider(builtinProvider, []),

  snapshot: () => {
    const s = get();
    const stack = [...s.undoStack, historyEntry(s)];
    if (stack.length > MAX_HISTORY) stack.shift();
    coalescing = null;
    set({ undoStack: stack, redoStack: [], dirty: true });
  },

  undo: () => {
    const s = get();
    if (!s.undoStack.length) return;
    const prev = s.undoStack[s.undoStack.length - 1];
    const restored = historyEntry(prev);
    s.provider.setOverlay(restored.customSpeakers);
    coalescing = null;
    set({
      ...restored,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, historyEntry(s)],
      dirty: true,
      ...selectionWithin(restored, s),
    });
  },

  redo: () => {
    const s = get();
    if (!s.redoStack.length) return;
    const next = s.redoStack[s.redoStack.length - 1];
    const restored = historyEntry(next);
    s.provider.setOverlay(restored.customSpeakers);
    coalescing = null;
    set({
      ...restored,
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, historyEntry(s)],
      dirty: true,
      ...selectionWithin(restored, s),
    });
  },

  addSource: (speakerId, position) => {
    get().snapshot();
    const s = get();
    const src = makeSource(speakerId, nextLabel(s.sources), {
      x: position?.x ?? 0,
      y: position?.y ?? 0,
      z: position?.z ?? 0,
    });
    set({ sources: [...s.sources, src], selectedSourceIds: [src.id], selectedGroupId: null });
    return src.id;
  },

  addSources: (sources) => {
    get().snapshot();
    set((s) => ({ sources: [...s.sources, ...sources], selectedSourceIds: sources.map((x) => x.id) }));
  },

  patchSources: (ids, patch, history = true) => {
    if (history) get().snapshot();
    const set0 = new Set(ids);
    set((s) => ({
      sources: s.sources.map((x) =>
        set0.has(x.id)
          ? {
              ...x,
              ...patch,
              position: patch.position ? { ...x.position, ...patch.position } : x.position,
              rotation: patch.rotation ? { ...x.rotation, ...patch.rotation } : x.rotation,
            }
          : x,
      ),
    }));
  },

  moveSources: (ids, delta, history = true) => {
    if (history) get().snapshot();
    const set0 = new Set(ids);
    set((s) => ({
      sources: s.sources.map((x) =>
        set0.has(x.id)
          ? { ...x, position: { x: x.position.x + delta.x, y: x.position.y + delta.y, z: x.position.z + delta.z } }
          : x,
      ),
    }));
  },

  deleteSelected: () => {
    const s = get();
    if (!s.selectedSourceIds.length && !s.selectedPointId) return;
    const cabinets = s.selectedSourceIds.length;
    s.snapshot();
    const kill = new Set(s.selectedSourceIds);
    const kept = s.sources.filter((x) => !kill.has(x.id));
    const groups = withoutEmptyGroups(kept, s.groups);
    set({
      sources: kept,
      groups,
      measurementPoints: s.selectedPointId
        ? s.measurementPoints.filter((m) => m.id !== s.selectedPointId)
        : s.measurementPoints,
      selectedSourceIds: [],
      selectedPointId: null,
      selectedGroupId: groups.some((g) => g.id === s.selectedGroupId) ? s.selectedGroupId : null,
    });
    get().showToast(
      cabinets
        ? { message: 'toast.deletedCabinets', vars: { count: cabinets }, undoDepth: get().undoStack.length }
        : { message: 'toast.deletedPoint', undoDepth: get().undoStack.length },
    );
  },

  duplicateSelected: () => {
    const s = get();
    if (!s.selectedSourceIds.length) return;
    s.snapshot();
    const picked = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
    let label = s.sources;
    const copies: Source[] = [];
    for (const p of picked) {
      const c: Source = {
        ...p,
        id: newId('src'),
        label: nextLabel(label),
        position: { ...p.position, x: p.position.x + 1 },
        rotation: { ...p.rotation },
      };
      label = [...label, c];
      copies.push(c);
    }
    remapPositionKeys(copies);
    set({ sources: [...s.sources, ...copies], selectedSourceIds: copies.map((c) => c.id) });
  },

  selectSources: (ids, additive = false) =>
    set((s) => ({
      selectedSourceIds: additive
        ? [...new Set([...s.selectedSourceIds, ...ids])]
        : ids,
      anchorSourceId: ids.length ? ids[ids.length - 1] : null,
      selectedGroupId: null,
      selectedPointId: null,
    })),

  selectSourceAt: (id, orderedIds, mods = {}) => {
    const s = get();
    const target = orderedIds.indexOf(id);

    // Shift-range: from the anchor to here, inclusive, in the order shown.
    // Falls back to a plain click when there is no usable anchor.
    if (mods.range && s.anchorSourceId && target >= 0) {
      const from = orderedIds.indexOf(s.anchorSourceId);
      if (from >= 0) {
        const [lo, hi] = from <= target ? [from, target] : [target, from];
        set({
          selectedSourceIds: orderedIds.slice(lo, hi + 1),
          selectedGroupId: null,
          selectedPointId: null,
        });
        return;
      }
    }

    if (mods.toggle) {
      const has = s.selectedSourceIds.includes(id);
      set({
        selectedSourceIds: has
          ? s.selectedSourceIds.filter((x) => x !== id)
          : [...s.selectedSourceIds, id],
        anchorSourceId: id,
        selectedGroupId: null,
        selectedPointId: null,
      });
      return;
    }

    set({ selectedSourceIds: [id], anchorSourceId: id, selectedGroupId: null, selectedPointId: null });
  },

  selectAll: () =>
    set((s) => ({
      selectedSourceIds: s.sources.map((x) => x.id),
      anchorSourceId: s.sources[0]?.id ?? null,
    })),

  createArray: ({ sourceId, count, spacingM, axis, centered, arcDeg = 0 }) => {
    const s = get();
    const base = s.sources.find((x) => x.id === sourceId);
    if (!base || count < 1) return;
    s.snapshot();

    const created: Source[] = [];
    let labels = s.sources;
    const offset = centered ? -((count - 1) * spacingM) / 2 : 0;

    for (let i = 0; i < count; i++) {
      const d = offset + i * spacingM;
      let pos: Vec3;
      let az = base.rotation.azimuthDeg;

      if (arcDeg !== 0 && axis === 'x') {
        // Arc array: lay the cabinets on a circle whose chord length matches
        // count * spacing, fanning them by arcDeg in total.
        const totalArc = (arcDeg * Math.PI) / 180;
        const arcLen = (count - 1) * spacingM;
        const radius = count > 1 && totalArc !== 0 ? arcLen / totalArc : 0;
        const theta = count > 1 ? -totalArc / 2 + (totalArc * i) / (count - 1) : 0;
        pos = {
          x: base.position.x + radius * Math.sin(theta),
          y: base.position.y + radius * (1 - Math.cos(theta)) * -1,
          z: base.position.z,
        };
        az = base.rotation.azimuthDeg + (theta * 180) / Math.PI;
      } else {
        pos = {
          x: base.position.x + (axis === 'x' ? d : 0),
          y: base.position.y + (axis === 'y' ? d : 0),
          z: base.position.z + (axis === 'z' ? d : 0),
        };
      }

      const c: Source = {
        ...base,
        id: newId('src'),
        label: nextLabel(labels),
        position: pos,
        rotation: { ...base.rotation, azimuthDeg: az },
      };
      labels = [...labels, c];
      created.push(c);
    }

    // The seed cabinet is consumed by the array so counts stay honest.
    set({
      sources: [...s.sources.filter((x) => x.id !== sourceId), ...created],
      selectedSourceIds: created.map((c) => c.id),
    });
  },

  createSubArray: ({ speakerId, count, spacingM, axis, name }) => {
    const s = get();
    const n = Math.max(1, Math.round(count));
    if (!speakerId) return null;
    s.snapshot();

    // Put it where it can be seen and where it plainly reads as a SECOND block:
    // stepped off the existing geometry on the axis the array does NOT run along.
    // Continuing along the layout axis would just look like one longer array, and
    // would often land outside the prediction area.
    //
    // Of the two cross axes, take one the CURRENT VIEW draws. Taking the first
    // one blindly put a flown column's second array 4 m along X: invisible in
    // the side view that a flown column is designed in, and off the section the
    // map is computed on, so the user got no cabinets, no map change and no
    // error. Stepping up rather than down when that axis is height, because a
    // sub 4 m below the existing ones is underground.
    const [crossA, crossB] = crossAxes(axis);
    const drawn = drawnAxes(s.sim.plane) as readonly ArrayAxis[];
    const cross: ArrayAxis = drawn.includes(crossA) ? crossA : drawn.includes(crossB) ? crossB : crossA;
    // An empty canvas has nothing to step off, so the array brings its own
    // floor. A position is the cabinet's GEOMETRIC CENTRE, which puts a block
    // standing on the deck half a box up, not at z = 0 — dropping it at 0 sank
    // the bottom half of every cabinet through the stage. A column laid out
    // along Z is seated by its LOWEST cabinet, which is the same rule one pitch
    // at a time. An unpublished height is not halved: the block stays at z = 0
    // rather than being placed off a face nobody measured.
    const model = s.provider.get(speakerId);
    const bottomCentreZ = (model ? centreZFromBottomFace(model) : null) ?? 0;
    const centre: Vec3 = {
      x: 0,
      y: 0,
      z: axis === 'z' ? bottomCentreZ + ((n - 1) * spacingM) / 2 : bottomCentreZ,
    };
    if (s.sources.length) {
      for (const k of ['x', 'y', 'z'] as const) {
        const v = s.sources.map((x) => x.position[k]);
        centre[k] = (Math.min(...v) + Math.max(...v)) / 2;
      }
      const spread = s.sources.map((x) => x.position[cross]);
      centre[cross] = cross === 'z' ? Math.max(...spread) + 4 : Math.min(...spread) - 4;
    }

    const start = -((n - 1) * spacingM) / 2;
    let labels = s.sources;
    const created: Source[] = [];
    for (let i = 0; i < n; i++) {
      const position: Vec3 = { ...centre };
      position[axis] = centre[axis] + start + i * spacingM;
      const c = makeSource(speakerId, nextLabel(labels), position);
      // Każda obudowa nowej linii jest własną pozycją — z nadania, nie
      // z pomiaru. Zob. Source.positionKey.
      c.positionKey = newId('pos');
      labels = [...labels, c];
      created.push(c);
    }

    // Loose cabinets are an array too, just an unnamed one, so they count when
    // numbering — otherwise the SECOND array on the canvas is labelled "1".
    // Then step past any name already taken.
    const taken = new Set(s.groups.map((x) => x.name));
    let ordinal = s.groups.length + (s.sources.some((x) => !x.groupId) ? 1 : 0) + 1;
    while (taken.has(`SUB ARRAY ${ordinal}`)) ordinal++;

    const g = makeGroup(name || `SUB ARRAY ${ordinal}`, created);
    for (const c of created) c.groupId = g.id;

    set({
      sources: [...s.sources, ...created],
      groups: [...s.groups, g],
      selectedGroupId: g.id,
      selectedSourceIds: created.map((c) => c.id),
      anchorSourceId: created[0]?.id ?? null,
    });
    return g.id;
  },

  applyArrayLayout: (ids, opts) => {
    const s = get();
    const members = s.sources.filter((x) => ids.includes(x.id));
    // The template is what a NEW cabinet is cloned from, so it has to be a
    // forward one. In a reverse-stack rig the first member is the turned-round
    // box at the bottom of the first position, and cloning that handed every
    // cabinet the rig grew by its gradient delay — a delay only the reversed
    // box is supposed to carry. `reversedFlags` reads it off the canvas; with
    // no reversal anywhere the first member is still the first member.
    const forward = members.find((x) => !x.invertPolarity) ?? members[0];
    const template: Source | undefined = forward
      ? { ...forward, speakerId: opts.speakerId ?? forward.speakerId }
      : opts.speakerId
        ? makeSource(opts.speakerId, 'SUB 01', { x: 0, y: 0, z: 0 })
        : undefined;
    if (!template) return;
    if (opts.history !== false) s.snapshot();

    // The pool is EVERY cabinet in the project, this module included. A rebuild
    // that grows an array REUSES its existing members and their labels (see
    // layoutSources), so leaving them out of the pool handed the new cabinets
    // names the array was still using: two SUB 01 in one module, and a GPS list
    // in which one of them cannot be told from the other.
    let labels = s.sources;
    const rebuilt = layoutSources(
      members,
      { ...opts, template },
      () => newId('src'),
      () => {
        const l = nextLabel(labels);
        labels = [...labels, { ...template, id: newId('tmp'), label: l }];
        return l;
      },
    );
    if (opts.speakerId) for (const r of rebuilt) r.speakerId = opts.speakerId;

    // keep the module contiguous where the first member used to be
    const firstIndex = s.sources.findIndex((x) => ids.includes(x.id));
    const rest = s.sources.filter((x) => !ids.includes(x.id));
    const at = firstIndex < 0 ? rest.length : Math.min(firstIndex, rest.length);
    const laidOut = [...rest.slice(0, at), ...rebuilt, ...rest.slice(at)];
    set({
      sources: laidOut,
      // Shrinking a layout is the third way to empty a module, and the easiest
      // of the three to reach: with no module selected the SUBS panel hands
      // this EVERY cabinet in the project, `layoutSources` reuses members in
      // order and drops the extras, so a smaller count deletes the tail —
      // which is every cabinet of every module after the first. Same prune as
      // deleting and as re-grouping.
      groups: withoutEmptyGroups(laidOut, s.groups),
      selectedSourceIds: rebuilt.map((r) => r.id),
    });
  },

  rotateSelected: (ids, deltaDeg, opts) => {
    const s = get();
    if (!ids.length || !Number.isFinite(deltaDeg)) return;
    if (opts?.history !== false) s.snapshot();
    set({ sources: rotateSelection(opts?.from ?? s.sources, s.groups, ids, deltaDeg) });
  },

  rotatePositions: (ids, yawDeg) => {
    const s = get();
    if (!ids.length || !Number.isFinite(yawDeg)) return;
    s.snapshot();
    set({ sources: rotatePositions(s.sources, ids, yawDeg) });
  },

  setReversalPattern: (ids, pattern, opts) => {
    const s = get();
    const set0 = new Set(ids);
    const members = s.sources.filter((x) => set0.has(x.id));
    if (!members.length) return;
    s.snapshot();
    const written = writeReversalPattern(members, pattern, opts);
    const byId = new Map(written.map((x) => [x.id, x]));
    set({ sources: s.sources.map((x) => byId.get(x.id) ?? x) });
  },

  applyDelayPlan: (ids, plan, opts) => {
    const s = get();
    if (opts?.history !== false) s.snapshot();
    const order = new Map(s.sources.filter((x) => ids.includes(x.id)).map((x, i) => [x.id, i]));
    const grad = opts?.gradientDelaysS;
    let sources = s.sources.map((x) => {
      const i = order.get(x.id);
      if (i === undefined) return x;
      const g = grad ? grad[i] : undefined;
      return {
        ...x,
        delayS: plan.delaysS[i] ?? x.delayS,
        levelDb: plan.levelsDb ? plan.levelsDb[i] ?? x.levelDb : x.levelDb,
        // patrz opts.gradientDelaysS: zapis absolutny, undefined czyści
        ...(grad ? { gradientDelayS: g && g > 0 ? g : undefined } : {}),
      };
    });

    // A steering transform owns its cabinets. Once the arc tool has run they are
    // a module, so the common delay has somewhere to live and the next pass
    // addresses the same set instead of drifting onto whatever is selected.
    let groups = s.groups;
    let selectedGroupId = s.selectedGroupId;
    const groupAs = opts?.groupAs;
    if (groupAs && order.size) {
      const owned = soleGroupOf(sources, ids);
      if (owned) {
        // A name that states an angle has to state the CURRENT one. The name used
        // to freeze at the first angle ever applied, so a module still called
        // "ARC 80" could hold a 40 degree arc or an end-fire — a label
        // contradicting the delays it sits on. Only a name this tool wrote is
        // replaced; see namesATransform for why the operator's own name survives.
        if (namesATransform(groups.find((g) => g.id === owned)?.name)) {
          groups = groups.map((g) => (g.id === owned ? { ...g, name: groupAs } : g));
        }
        selectedGroupId = owned;
      } else {
        // The selection spans several modules, or part of one. Sweeping all of it
        // into a new group dissolved the records it came from: they kept their
        // delay, level and rotation offsets but no longer had a member to apply
        // them to, so steering "All sources" threw away every per-array trim in
        // the rig in one action, silently, and changed both the prediction and
        // the exported delay numbers. Only cabinets that belong to NOTHING get a
        // module of their own here; an existing module keeps its members and its
        // offsets, and the plan is still written to every cabinet either way.
        const loose = sources.filter((x) => order.has(x.id) && !x.groupId);
        if (loose.length) {
          const g = makeGroup(groupAs, loose);
          const looseIds = new Set(loose.map((x) => x.id));
          groups = [...groups, g];
          sources = sources.map((x) => (looseIds.has(x.id) ? { ...x, groupId: g.id } : x));
          // Point the editor at the new module only when it IS the whole
          // selection. Otherwise the panel would jump off "All sources" onto a
          // fragment of what was just steered, which is the bug that makes a
          // second pass address a different set of cabinets than the first.
          if (loose.length === order.size) selectedGroupId = g.id;
        }
      }
    }
    set({ sources, groups, selectedGroupId });
  },

  ensureGroup: (ids, name) => {
    const s = get();
    if (!ids.length) return null;
    const owned = soleGroupOf(s.sources, ids);
    if (owned) return owned;
    const idSet = new Set(ids);
    const picked = s.sources.filter((x) => idSet.has(x.id));
    // A cabinet that already belongs to a module stays in it — the rule
    // applyDelayPlan follows, for the reason spelled out there. Sweeping a
    // mixed selection into a fresh group dissolved the modules it came from:
    // they kept their delay, level and rotation offsets and lost the members
    // those offsets applied to. The Steering panel reaches here whenever a
    // relative delay is typed against "All sources", so this was one keystroke
    // away in any project with more than one array. When there is no single
    // module to hang the offset on, none is invented and the caller is told so.
    if (!picked.length || picked.some((x) => x.groupId)) return null;
    s.snapshot();
    const g = makeGroup(name || `GROUP ${s.groups.length + 1}`, picked);
    set({
      groups: [...s.groups, g],
      sources: s.sources.map((x) => (idSet.has(x.id) ? { ...x, groupId: g.id } : x)),
      selectedGroupId: g.id,
    });
    return g.id;
  },

  nudgeColumn: (ids, column, delta) => {
    const s = get();
    s.snapshot();
    const set0 = new Set(ids);
    set({
      sources: s.sources.map((x) => {
        if (!set0.has(x.id)) return x;
        switch (column) {
          case 'levelDb':
            return { ...x, levelDb: Math.max(-100, Math.min(0, x.levelDb + delta)) };
          case 'delayS':
            return { ...x, delayS: x.delayS + delta };
          case 'azimuthDeg':
            return { ...x, rotation: { ...x.rotation, azimuthDeg: x.rotation.azimuthDeg + delta } };
          default:
            return { ...x, position: { ...x.position, [column]: x.position[column] + delta } };
        }
      }),
    });
  },

  resetModule: (ids, full, opts) => {
    const s = get();
    s.snapshot();
    const set0 = new Set(ids);
    // Gradient kardioidy żyje w ZASZYTYM polu, poza kolumną delayów — więc
    // częściowy reset zeruje kolumnę użytkownika i gradientu nie dotyka,
    // a odwrócona skrzynia bez tego pola (rig ręczny albo sprzed migracji,
    // z d/c w delayS) dostaje je tu, zamiast stracić kardioidę. Pełny reset
    // prostuje rig, więc i gradient schodzi do zera.
    const members = s.sources.filter((x) => set0.has(x.id));
    const keepS = !full && opts?.reverseDelayS && opts.reverseDelayS > 0 ? opts.reverseDelayS : 0;
    const rev = keepS > 0 ? reversedFlags(members, opts?.forwardAzimuthDeg) : null;
    const revById = new Map(members.map((x, i) => [x.id, rev ? rev[i] : false]));
    set({
      sources: s.sources.map((x) =>
        set0.has(x.id)
          ? {
              ...x,
              levelDb: 0,
              delayS: 0,
              gradientDelayS: full
                ? undefined
                : revById.get(x.id)
                  ? x.gradientDelayS ?? keepS
                  : x.gradientDelayS,
              ...(full
                ? {
                    invertPolarity: false,
                    mute: false,
                    rotation: { azimuthDeg: 0, elevationDeg: 0, rollDeg: 0 },
                  }
                : {}),
            }
          : x,
      ),
    });
  },

  distributeEvenly: (ids, axis) => {
    const s = get();
    const picked = s.sources.filter((x) => ids.includes(x.id));
    if (picked.length < 3) return;
    s.snapshot();
    const sorted = [...picked].sort((a, b) => a.position[axis] - b.position[axis]);
    const lo = sorted[0].position[axis];
    const hi = sorted[sorted.length - 1].position[axis];
    const step = (hi - lo) / (sorted.length - 1);
    const target = new Map(sorted.map((x, i) => [x.id, lo + i * step]));
    set({
      sources: s.sources.map((x) =>
        target.has(x.id) ? { ...x, position: { ...x.position, [axis]: target.get(x.id)! } } : x,
      ),
    });
  },

  centerSelection: (axis) => {
    const s = get();
    const picked = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
    if (!picked.length) return;
    s.snapshot();
    const mx = picked.reduce((a, p) => a + p.position.x, 0) / picked.length;
    const my = picked.reduce((a, p) => a + p.position.y, 0) / picked.length;
    const dx = axis === 'y' ? 0 : -mx;
    const dy = axis === 'x' ? 0 : -my;
    const ids = new Set(s.selectedSourceIds);
    set({
      sources: s.sources.map((x) =>
        ids.has(x.id) ? { ...x, position: { ...x.position, x: x.position.x + dx, y: x.position.y + dy } } : x,
      ),
    });
  },

  reverseOrder: (ids) => {
    const s = get();
    const picked = s.sources.filter((x) => ids.includes(x.id));
    if (picked.length < 2) return;
    s.snapshot();
    const positions = picked.map((p) => ({ ...p.position }));
    const reversed = [...positions].reverse();
    const map = new Map(picked.map((p, i) => [p.id, reversed[i]]));
    set({
      sources: s.sources.map((x) => (map.has(x.id) ? { ...x, position: map.get(x.id)! } : x)),
    });
  },

  mirrorSelection: (axis, duplicate) => {
    const s = get();
    const picked = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
    if (!picked.length) return;
    s.snapshot();

    const flip = (src: Source): Source => {
      const pos = { ...src.position };
      let az = src.rotation.azimuthDeg;
      if (axis === 'x') {
        pos.x = -pos.x;
        az = -az; // mirroring across the YZ plane negates yaw
      } else {
        pos.y = -pos.y;
        az = 180 - az;
      }
      return { ...src, position: pos, rotation: { ...src.rotation, azimuthDeg: az } };
    };

    if (duplicate) {
      let labels = s.sources;
      const copies = picked.map((p) => {
        const c = { ...flip(p), id: newId('src'), label: nextLabel(labels) };
        labels = [...labels, c];
        return c;
      });
      remapPositionKeys(copies);
      set({ sources: [...s.sources, ...copies], selectedSourceIds: copies.map((c) => c.id) });
    } else {
      const ids = new Set(s.selectedSourceIds);
      set({ sources: s.sources.map((x) => (ids.has(x.id) ? flip(x) : x)) });
    }
  },

  groupSelected: (name) => {
    const s = get();
    const ids = new Set(s.selectedSourceIds);
    const picked = s.sources.filter((x) => ids.has(x.id));
    if (!picked.length) return;
    s.snapshot();
    const g = makeGroup(name || `GROUP ${s.groups.length + 1}`, picked);
    const sources = s.sources.map((x) => (ids.has(x.id) ? { ...x, groupId: g.id } : x));
    set({
      // Re-grouping the last cabinets out of a module empties it exactly the
      // way deleting them does, so the same prune closes both paths. The new
      // module survives it: its members were just reparented into it.
      groups: withoutEmptyGroups(sources, [...s.groups, g]),
      sources,
      selectedGroupId: g.id,
    });
  },

  /**
   * Ungrouping bakes the group's transform into the members so nothing moves
   * or changes level on screen.
   */
  ungroup: (groupId) => {
    const s = get();
    const g = s.groups.find((x) => x.id === groupId);
    if (!g) return;
    s.snapshot();
    set({
      groups: s.groups.filter((x) => x.id !== groupId),
      sources: s.sources.map((x) => {
        if (x.groupId !== groupId) return x;
        // Call the same function resolving uses rather than reimplementing it.
        // The two copies of this arithmetic were how the yaw bug survived: one
        // of them was the transpose of the other and nothing compared them.
        const turned = rotateXY(x.position, g.anchor, g.rotationOffsetDeg);
        return {
          ...x,
          groupId: null,
          position: {
            x: turned.x + g.offset.x,
            y: turned.y + g.offset.y,
            z: turned.z + g.offset.z,
          },
          rotation: { ...x.rotation, azimuthDeg: x.rotation.azimuthDeg + g.rotationOffsetDeg },
          levelDb: x.levelDb + g.levelOffsetDb,
          delayS: x.delayS + g.delayOffsetS,
          mute: x.mute || g.mute,
        };
      }),
      selectedGroupId: null,
    });
  },

  patchGroup: (id, patch, history = true) => {
    if (history) get().snapshot();
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  },

  deleteGroup: (id, deleteMembers) => {
    const s = get();
    const members = s.sources.filter((x) => x.groupId === id).length;
    s.snapshot();
    set({
      groups: s.groups.filter((g) => g.id !== id),
      sources: deleteMembers
        ? s.sources.filter((x) => x.groupId !== id)
        : s.sources.map((x) => (x.groupId === id ? { ...x, groupId: null } : x)),
      selectedGroupId: null,
    });
    if (deleteMembers && members) {
      get().showToast({ message: 'toast.deletedCabinets', vars: { count: members }, undoDepth: get().undoStack.length });
    }
  },

  duplicateGroup: (id) => {
    const s = get();
    const g = s.groups.find((x) => x.id === id);
    if (!g) return;
    const members = s.sources.filter((x) => x.groupId === id);
    s.snapshot();

    // The copy has to land somewhere it can be seen and picked up. An exactly
    // coincident duplicate is not merely confusing: two cabinets at the same
    // point sum with no path difference between them, so the map gains 6 dB
    // everywhere and predicts a rig nobody can build, while the canvas draws one
    // on top of the other and the operator has no way to tell which is which.
    //
    // Step along an axis the CURRENT VIEW draws, for the same reason
    // createSubArray does: a step along the out-of-plane axis is invisible and
    // lands off the section the map is computed on, so the user would get no
    // second array, no change to the map and no error either. Of the two drawn
    // axes take the one the module spans LESS, so the copy comes to rest beside
    // the array rather than inside it, clear of it by a metre. Positive on every
    // axis, because the one that can be height has a floor under it.
    const drawn = drawnAxes(s.sim.plane);
    const extentOn = (axis: ArrayAxis) => {
      const v = members.map((x) => x.position[axis]);
      return v.length ? Math.max(...v) - Math.min(...v) : 0;
    };
    const stepAxis: ArrayAxis = extentOn(drawn[0]) <= extentOn(drawn[1]) ? drawn[0] : drawn[1];
    const stepM = extentOn(stepAxis) + 1;
    const stepped = (p: Vec3): Vec3 => ({
      x: p.x + (stepAxis === 'x' ? stepM : 0),
      y: p.y + (stepAxis === 'y' ? stepM : 0),
      z: p.z + (stepAxis === 'z' ? stepM : 0),
    });

    const ng: Group = {
      ...g,
      id: newId('grp'),
      name: `${g.name} copy`,
      offset: { ...g.offset },
      // The pivot travels with the members it belongs to. A yaw on the copy has
      // to turn the copy about its own centre; an anchor left on the original's
      // centroid swings the whole copy across the stage instead of rotating it.
      anchor: stepped(g.anchor),
    };
    let labels = s.sources;
    const copies = members.map((x) => {
      const c: Source = {
        ...x,
        id: newId('src'),
        label: nextLabel(labels),
        groupId: ng.id,
        position: stepped(x.position),
        rotation: { ...x.rotation },
      };
      labels = [...labels, c];
      return c;
    });
    remapPositionKeys(copies);
    set({
      groups: [...s.groups, ng],
      sources: [...s.sources, ...copies],
      selectedGroupId: ng.id,
      selectedSourceIds: [],
    });
  },

  selectGroup: (id) => set({ selectedGroupId: id, selectedSourceIds: [], selectedPointId: null }),

  addMeasurementPoint: (position, name) => {
    const s = get();
    s.snapshot();
    const mp: MeasurementPoint = {
      id: newId('mp'),
      name: name || `POINT ${s.measurementPoints.length + 1}`,
      position,
    };
    set({ measurementPoints: [...s.measurementPoints, mp], selectedPointId: mp.id, selectedSourceIds: [] });
  },

  patchMeasurementPoint: (id, patch) => {
    get().snapshot();
    set((s) => ({
      measurementPoints: s.measurementPoints.map((m) =>
        m.id === id ? { ...m, ...patch, position: patch.position ? { ...m.position, ...patch.position } : m.position } : m,
      ),
    }));
  },

  patchMeasurementPointTransient: (id, position) =>
    set((s) => ({
      measurementPoints: s.measurementPoints.map((m) => (m.id === id ? { ...m, position } : m)),
    })),

  deleteMeasurementPoint: (id) => {
    get().snapshot();
    set((s) => ({
      measurementPoints: s.measurementPoints.filter((m) => m.id !== id),
      selectedPointId: s.selectedPointId === id ? null : s.selectedPointId,
    }));
  },

  selectPoint: (id) => set({ selectedPointId: id, selectedSourceIds: [], selectedGroupId: null }),
  setCursorPoint: (p) => set({ cursorPoint: p }),

  addCustomSpeaker: (m) => {
    const s = get();
    s.snapshot();
    const list = [...s.customSpeakers, m];
    s.provider.setOverlay(list);
    set({ customSpeakers: list });
  },

  patchSim: (patch) => {
    // A slider held or stepped through is one undo step, not one per value.
    snapshotCoalesced(get, `sim:${Object.keys(patch).sort().join(',')}`);
    set((s) => {
      const sim = { ...s.sim, ...patch };
      if (patch.temperatureC !== undefined) sim.speedOfSound = speedOfSoundFromTemp(patch.temperatureC);
      if (patch.area) sim.area = { ...s.sim.area, ...patch.area };
      return { sim };
    });
  },

  setView: (v) => set((s) => ({ view: { ...s.view, ...v } })),
  setCam3d: (c) => set((s) => ({ cam3d: { ...s.cam3d, ...c } })),
  setSnap: (snap) => set({ snap }),
  toggle: (k) => set((s) => ({ [k]: !s[k] } as Pick<AppState, typeof k>)),
  setPalette: (palette) => set({ palette }),
  setCalibratedRef: (db) => set({ calibratedRefDb: db }),
  setPolarFrequency: (index, hz) =>
    set((st) => ({ polarFrequencies: st.polarFrequencies.map((v, i) => (i === index ? hz : v)) })),
  setLang: (lang) => {
    // Remembered before the state changes, so the next session starts here
    // even if this render is the one that throws.
    rememberLang(lang);
    set({ lang });
  },

  askConfirm: (pendingConfirm) => set({ pendingConfirm }),
  showToast: (toast) => set({ toast: { ...toast, id: ++toastCounter } }),
  dismissToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : {})),
  markSaved: (file) => set({ file: { ...file }, dirty: false }),
  appendDoc: (d) => {
    const s = get();
    s.snapshot();
    const add = cloneDoc(d);
    const groupIds = new Map(add.groups.map((g) => [g.id, newId('g')]));
    const groups = add.groups.map((g) => ({ ...g, id: groupIds.get(g.id)! }));
    // a position key is opaque and only compared within a project: keep it unique too
    const positionKeys = new Map<string, string>();
    const sources = add.sources.map((x) => ({
      ...x,
      id: newId('s'),
      groupId: x.groupId ? (groupIds.get(x.groupId) ?? null) : null,
      positionKey: x.positionKey
        ? (positionKeys.get(x.positionKey) ??
          (positionKeys.set(x.positionKey, newId('p')), positionKeys.get(x.positionKey)!))
        : undefined,
    }));
    const points = add.measurementPoints.map((m) => ({ ...m, id: newId('m') }));
    const known = new Set(s.customSpeakers.map((m) => m.id));
    const customSpeakers = [...s.customSpeakers, ...add.customSpeakers.filter((m) => !known.has(m.id))];
    s.provider.setOverlay(customSpeakers);
    set({
      sources: [...s.sources, ...sources],
      groups: [...s.groups, ...groups],
      measurementPoints: [...s.measurementPoints, ...points],
      customSpeakers,
      selectedSourceIds: sources.map((x) => x.id),
      selectedGroupId: null,
      selectedPointId: null,
    });
  },

  setLayoutSize: (key, px) =>
    set((s) => ({ layout: { ...s.layout, [key]: Math.round(px) } })),

  resetLayoutSize: (key) =>
    set((s) => {
      const next = { ...s.layout };
      delete next[key];
      return { layout: next };
    }),

  setAutocalculate: (autocalculate) =>
    // turning it back on immediately settles whatever is pending
    set(autocalculate ? { autocalculate, renderStale: false } : { autocalculate }),
  markStale: () => {
    if (!get().autocalculate && !get().renderStale) set({ renderStale: true });
  },
  recalculate: () => set((st) => ({ recalcToken: st.recalcToken + 1, renderStale: false })),
  setInteracting: (interacting) => set({ interacting }),
  setTool: (tool) => set({ tool }),

  copySelection: () => {
    const s = get();
    const sources = s.sources.filter((x) => s.selectedSourceIds.includes(x.id));
    const groupIds = new Set(sources.map((x) => x.groupId).filter(Boolean) as string[]);
    if (s.selectedGroupId) {
      groupIds.add(s.selectedGroupId);
      for (const x of s.sources) if (x.groupId === s.selectedGroupId && !sources.includes(x)) sources.push(x);
    }
    if (!sources.length) return;
    set({ clipboard: { sources: sources.map((x) => ({ ...x })), groups: s.groups.filter((g) => groupIds.has(g.id)) } });
  },

  paste: () => {
    const s = get();
    if (!s.clipboard || !s.clipboard.sources.length) return;
    s.snapshot();
    const groupMap = new Map<string, string>();
    const newGroups = s.clipboard.groups.map((g) => {
      const id = newId('grp');
      groupMap.set(g.id, id);
      return {
        ...g,
        id,
        name: `${g.name} copy`,
        offset: { ...g.offset },
        // The pasted module is the original moved by PASTE_STEP, so its pivot
        // moves with it. Keeping the source group's anchor made a yaw on the
        // pasted array swing it about a point 1.41 m away instead of turning it
        // where it stands.
        anchor: { x: g.anchor.x + PASTE_STEP.x, y: g.anchor.y + PASTE_STEP.y, z: g.anchor.z },
      };
    });
    let labels = s.sources;
    const copies = s.clipboard.sources.map((x) => {
      const c: Source = {
        ...x,
        id: newId('src'),
        label: nextLabel(labels),
        groupId: x.groupId ? groupMap.get(x.groupId) ?? null : null,
        position: { ...x.position, x: x.position.x + PASTE_STEP.x, y: x.position.y + PASTE_STEP.y },
        rotation: { ...x.rotation },
      };
      labels = [...labels, c];
      return c;
    });
    set({
      sources: [...s.sources, ...copies],
      groups: [...s.groups, ...newGroups],
      selectedSourceIds: copies.map((c) => c.id),
    });
  },

  loadDoc: (d, sim) => {
    const s = get();
    s.snapshot();
    const doc = cloneDoc(d);
    s.provider.setOverlay(doc.customSpeakers);
    set({
      ...doc,
      sim: sim ? { ...sim } : s.sim,
      selectedSourceIds: [],
      selectedGroupId: null,
      selectedPointId: null,
    });
  },

  renameProject: (name) => {
    snapshotCoalesced(get, 'name');
    set((st) => ({ project: { ...st.project, name } }));
  },
  patchProjectMeta: (patch) => {
    snapshotCoalesced(get, `meta:${Object.keys(patch).sort().join(',')}`);
    set((st) => ({ project: { ...st.project, ...patch } }));
  },
  newProject: () => {
    const s = get();
    s.snapshot();
    s.provider.setOverlay([]);
    set({
      ...emptyDoc(),
      sim: defaultSimulationSettings(),
      selectedSourceIds: [],
      selectedGroupId: null,
      selectedPointId: null,
      // a new, empty project has nothing worth saving and no file yet
      file: { path: null, name: null },
      dirty: false,
    });
  },

  toProject: () => {
    const s = get();
    return {
      format: BRANDING.formatId,
      version: BRANDING.formatVersion,
      project: { ...s.project, modifiedAt: new Date().toISOString() },
      sources: s.sources,
      groups: s.groups,
      measurementPoints: s.measurementPoints,
      simulationSettings: s.sim,
      customSpeakers: s.customSpeakers,
    };
  },
}));

/**
 * The models to offer: the project's own custom models, the offered library
 * models (OFFERED_SPEAKER_IDS, in that order), and any other library model the
 * project already uses (`inUse`), so a list never shows a cabinet's model as
 * blank just because it is no longer offered.
 */
export function allSpeakers(customSpeakers: SpeakerModel[], inUse: Iterable<string> = []): SpeakerModel[] {
  const used = new Set(inUse);
  const offered = OFFERED_SPEAKER_IDS.map((id) => BUILTIN_SPEAKERS.find((m) => m.id === id)).filter(
    (m): m is SpeakerModel => !!m,
  );
  const kept = BUILTIN_SPEAKERS.filter((m) => used.has(m.id) && !OFFERED_SPEAKER_IDS.includes(m.id));
  return [...customSpeakers, ...offered, ...kept];
}

export { DEFAULT_SPEAKER_ID };
