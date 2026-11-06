/**
 * Where project files come from and go to.
 *
 * A page in a browser cannot keep a file: it uploads a copy and downloads a
 * new one, so every save was a Save As and nothing could be reopened by name.
 * The desktop apps can do better, and this is the one place that knows how:
 *
 *  - macOS: WKScriptMessageHandlerWithReply `btrFile` (desktop/BTRApp.swift),
 *    so a request is a promise answered by the native side;
 *  - Windows: WebView2 web messages (desktop/windows/BTRApp.cpp), answered by
 *    a message carrying the same request id;
 *  - browser: a file input to open, and either the File System Access API
 *    (Chromium) for a file that can be saved again in place, or a download.
 *
 * Bytes cross the bridge as base64, so a binary format can use it too.
 *
 * The native side also PUSHES requests: a file double-clicked in Finder or
 * Explorer, or passed on the command line, arrives through
 * `window.__btrHostEvent` and is handed to whoever listens (the top bar).
 */

export interface HostFile {
  /** absolute path in the desktop apps; a handle token in a browser that can save in place; else null */
  path: string | null;
  name: string;
  bytes: Uint8Array;
}

export interface SavedFile {
  path: string | null;
  name: string;
}

export interface FileHost {
  kind: 'mac' | 'windows' | 'web';
  /** files reopen by path (the recent list) */
  canReopen: boolean;
  open(): Promise<HostFile | null>;
  read(path: string): Promise<HostFile>;
  /** null when the user cancelled */
  saveAs(suggestedName: string, text: string): Promise<SavedFile | null>;
  save(path: string, text: string): Promise<void>;
}

export const PROJECT_EXTENSION = '.btrsub';

// ── base64 ────────────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface WireFile {
  path: string | null;
  name: string;
  data: string;
}
const fromWire = (f: WireFile): HostFile => ({ path: f.path, name: f.name, bytes: fromBase64(f.data) });

// ── native bridges ────────────────────────────────────────────────────────

type Request = { op: 'ready' } | { op: 'open' } | { op: 'read'; path: string } | { op: 'saveAs'; name: string; text: string } | { op: 'save'; path: string; text: string };

interface MacBridge {
  postMessage(msg: Request): Promise<unknown>;
}
interface WebView2 {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
}

const w = (typeof window === 'undefined' ? {} : window) as unknown as {
  webkit?: { messageHandlers?: { btrFile?: MacBridge } };
  chrome?: { webview?: WebView2 };
  __btrHostEvent?: (e: unknown) => void;
  showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandleLike>;
};

interface FileSystemFileHandleLike {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

function nativeHost(kind: 'mac' | 'windows', call: (r: Request) => Promise<unknown>): FileHost {
  return {
    kind,
    canReopen: true,
    async open() {
      const r = (await call({ op: 'open' })) as WireFile | null;
      return r ? fromWire(r) : null;
    },
    async read(path) {
      return fromWire((await call({ op: 'read', path })) as WireFile);
    },
    async saveAs(name, text) {
      return ((await call({ op: 'saveAs', name, text })) as SavedFile | null) ?? null;
    },
    async save(path, text) {
      await call({ op: 'save', path, text });
    },
  };
}

function windowsCall(): (r: Request) => Promise<unknown> {
  const view = w.chrome!.webview!;
  let next = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  view.addEventListener('message', (e) => {
    const d = e.data as { btrFileReply?: { id: number; ok: boolean; result?: unknown; error?: string } };
    const r = d?.btrFileReply;
    if (!r) return;
    const p = pending.get(r.id);
    if (!p) return;
    pending.delete(r.id);
    if (r.ok) p.resolve(r.result ?? null);
    else p.reject(new Error(r.error || 'the file operation failed'));
  });
  return (req) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      view.postMessage({ btrFile: { id, ...req } });
    });
}

// ── browser ───────────────────────────────────────────────────────────────

const handles = new Map<string, FileSystemFileHandleLike>();
let handleCounter = 0;

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.btrsub,.json';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const webHost: FileHost = {
  kind: 'web',
  canReopen: false,
  async open() {
    const f = await pickFile();
    return f ? { path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
  },
  async read() {
    throw new Error('a browser cannot reopen a file by its path');
  },
  async saveAs(name, text) {
    // Chromium can keep the file it saved to, so the next Save writes in place.
    if (w.showSaveFilePicker) {
      let handle: FileSystemFileHandleLike;
      try {
        handle = await w.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'BTR Sub Array project', accept: { 'application/json': [PROJECT_EXTENSION] } }],
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return null;
        throw e;
      }
      const token = `web-handle:${++handleCounter}`;
      handles.set(token, handle);
      await webHost.save(token, text);
      return { path: token, name: handle.name };
    }
    download(text, name);
    return { path: null, name };
  },
  async save(path, text) {
    const handle = handles.get(path);
    if (!handle) throw new Error('this browser no longer holds the file');
    const out = await handle.createWritable();
    await out.write(text);
    await out.close();
  },
};

// ── the host this page runs in ────────────────────────────────────────────

let host: FileHost | null = null;

export function fileHost(): FileHost {
  if (host) return host;
  const mac = w.webkit?.messageHandlers?.btrFile;
  if (mac) host = nativeHost('mac', (r) => mac.postMessage(r));
  else if (w.chrome?.webview) host = nativeHost('windows', windowsCall());
  else host = webHost;
  return host;
}

/** for tests */
export function setFileHost(h: FileHost | null) {
  host = h;
}

// ── files the operating system asks this window to open ───────────────────

const openListeners = new Set<(f: HostFile) => void>();
const queued: HostFile[] = [];

/** Receives files the OS hands over; ones that arrived before anybody listened are delivered at once. */
export function onOpenRequest(cb: (f: HostFile) => void): () => void {
  openListeners.add(cb);
  while (queued.length) cb(queued.shift()!);
  return () => openListeners.delete(cb);
}

if (typeof window !== 'undefined') {
  w.__btrHostEvent = (e: unknown) => {
    const ev = e as { event?: string; file?: WireFile };
    if (ev?.event !== 'open' || !ev.file) return;
    const f = fromWire(ev.file);
    if (openListeners.size) for (const cb of openListeners) cb(f);
    else queued.push(f);
  };
  w.chrome?.webview?.addEventListener('message', (m) => {
    const d = m.data as { btrHostEvent?: unknown };
    if (d?.btrHostEvent) w.__btrHostEvent?.(d.btrHostEvent);
  });
  // Tell the shell this page can take files now. Until then it holds a file
  // the app was started with: the navigation finishing is too early, since a
  // module script can still be loading then.
  void w.webkit?.messageHandlers?.btrFile?.postMessage({ op: 'ready' }).catch(() => undefined);
  w.chrome?.webview?.postMessage({ btrFile: { id: 0, op: 'ready' } });
}
