// BTR Sub Array Designer — Windows shell.
//
// The Windows twin of desktop/BTRApp.swift, and like it this knows nothing
// about acoustics: it gives the SPA a window and a proper origin. Built from the
// Mac with mingw-w64 (desktop/build-windows.sh), so it uses no WRL/WIL — the
// COM callbacks are the small template below.
//
// The same three things break without a real origin, and are solved the same way:
//
//   * the prediction Web Worker is a MODULE worker,
//   * export uses <a download> on a blob URL.
//
// The build is served from https://btr.app/ through WebView2's virtual host
// mapping (a secure context, so module workers and wasm streaming work), and
// DownloadStarting turns an export into a Save dialog, as on the Mac.
//
// Browser data (presets, settings, crash recovery) lives in
// %LOCALAPPDATA%\BTR Sub Array Designer, never next to the exe: the installer
// puts the exe in Program Files, which a normal user cannot write, and WebView2
// would otherwise fail to start there.
//
//   BTRSubArrayDesigner.exe              normal start
//   BTRSubArrayDesigner.exe --selftest   run the bundle probe, write the result
//                                        to %TEMP%\btr-selftest.txt and exit
//   ... --selftest --selftest-save       the same, but the probe's export goes
//                                        through the real Save dialog
//
// A self-test runs in its own throw-away profile (%TEMP%\btr-selftest-profile):
// it quits hard, and in the user's profile the app's crash recovery would
// greet them next time with the probe's project.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <commdlg.h>

#include <functional>
#include <string>
#include <utility>

#include "WebView2.h"

namespace {

const wchar_t* const APP_NAME = L"BTR Sub Array Designer";
const wchar_t* const HOST = L"btr.app";
const wchar_t* const START_URL = L"https://btr.app/index.html";
const UINT WM_APP_SAVE_AS = WM_APP + 1;
const UINT WM_APP_FILE = WM_APP + 2;

// ─────────────────────────────────────────────────────────── COM callbacks ──

// One class for every WebView2 completion/event handler: they are all IUnknown
// plus a single Invoke. The IID is passed in because mingw has no __uuidof for
// these interfaces; WebView2.h defines the IIDs itself (selectany).
template <typename Iface, const IID* Iid, typename... A>
class Callback final : public Iface {
 public:
  explicit Callback(std::function<HRESULT(A...)> fn) : fn_(std::move(fn)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, *Iid)) {
      *out = static_cast<Iface*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&ref_); }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG r = InterlockedDecrement(&ref_);
    if (!r) delete this;
    return r;
  }
  HRESULT STDMETHODCALLTYPE Invoke(A... a) override { return fn_(a...); }

 private:
  std::function<HRESULT(A...)> fn_;
  LONG ref_ = 1;
};

template <typename Iface, const IID* Iid, typename... A, typename F>
Iface* make(F&& fn) {
  return new Callback<Iface, Iid, A...>(std::function<HRESULT(A...)>(std::forward<F>(fn)));
}

// ───────────────────────────────────────────────────────────────── state ──

HWND g_hwnd = nullptr;
ICoreWebView2Controller* g_controller = nullptr;
ICoreWebView2* g_webview = nullptr;
bool g_selftest = false;
bool g_selftestSave = false;
std::wstring g_selftestResult;
int g_selftestWaits = 0;
const UINT_PTR SELFTEST_TIMER = 1;
std::wstring g_exeDir;
std::wstring g_downloadNote = L"{\"error\":\"no download\"}";

// A pending export waiting for the Save dialog (see DownloadStarting).
ICoreWebView2DownloadStartingEventArgs* g_pendingArgs = nullptr;
ICoreWebView2Deferral* g_pendingDeferral = nullptr;

std::wstring exeDir() {
  wchar_t path[MAX_PATH];
  GetModuleFileNameW(nullptr, path, MAX_PATH);
  PathRemoveFileSpecW(path);
  return path;
}

std::wstring tempPath(const wchar_t* name);

std::wstring userDataDir() {
  if (g_selftest) {
    std::wstring t = tempPath(L"btr-selftest-profile");
    SHCreateDirectoryExW(nullptr, t.c_str(), nullptr);
    return t;
  }
  PWSTR local = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) {
    out = std::wstring(local) + L"\\" + APP_NAME;
    CoTaskMemFree(local);
  } else {
    out = g_exeDir + L"\\data";
  }
  SHCreateDirectoryExW(nullptr, out.c_str(), nullptr);
  return out;
}

std::wstring tempPath(const wchar_t* name) {
  wchar_t dir[MAX_PATH];
  GetTempPathW(MAX_PATH, dir);
  return std::wstring(dir) + name;
}

void writeUtf8(const std::wstring& path, const std::wstring& text) {
  int n = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n - 1 : 0, '\0');
  if (n > 1) WideCharToMultiByte(CP_UTF8, 0, text.c_str(), -1, s.data(), n, nullptr, nullptr);
  HANDLE f = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD w = 0;
  WriteFile(f, s.data(), static_cast<DWORD>(s.size()), &w, nullptr);
  CloseHandle(f);
}

/** The first .wasm the build ships, as a page-relative URL (the self-test fetches it). */
std::wstring wasmAsset() {
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW((g_exeDir + L"\\web\\assets\\*.wasm").c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return L"";
  FindClose(h);
  return std::wstring(L"/assets/") + fd.cFileName;
}

void fail(const std::wstring& message) {
  if (g_selftest) {
    writeUtf8(tempPath(L"btr-selftest.txt"), L"SELFTEST {\"error\":\"" + message + L"\"}\n");
    ExitProcess(1);
  }
  MessageBoxW(g_hwnd, message.c_str(), APP_NAME, MB_ICONERROR | MB_OK);
}

// ───────────────────────────────────────────────────────────── self-test ──

// The same probe as desktop/BTRApp.swift: it proves the module worker solved a
// grid, the wasm arrived as application/wasm and compiles, and a blob download
// reaches the native side. Keep the two in step.
const wchar_t* const PROBE = LR"JS(
(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const readGrid = () => [...document.querySelectorAll('.readout.mono')]
    .map(e => (e.textContent || '').trim())
    .find(t => /\d+×\d+/.test(t));
  let arrayTab = null;
  for (let i = 0; i < 60 && !arrayTab; i++) {
    arrayTab = document.querySelector('button.tab-array');
    if (!arrayTab) await wait(250);
  }
  if (!arrayTab) return JSON.stringify({ error: 'the interface never mounted' });
  const emptyAtStart = document.querySelectorAll('.tree-row').length;
  arrayTab.click();
  await wait(120);
  const newArray = document.querySelector('button.subs-new-array');
  if (!newArray) return JSON.stringify({ error: 'no + New array button' });
  newArray.click();
  await wait(60);
  let grid = null;
  for (let i = 0; i < 80 && !grid; i++) {
    const g = readGrid();
    if (g && !g.startsWith('-')) grid = g; else await wait(250);
  }
  if (!grid) return JSON.stringify({ error: 'no grid readout after 20 s' });
  let wasm = 'not attempted';
  if (wasmAsset) {
    try {
      const r = await fetch(wasmAsset);
      const type = r.headers.get('content-type');
      await WebAssembly.compile(await r.arrayBuffer());
      wasm = type === 'application/wasm' ? 'ok' : 'compiled but served as ' + type;
    } catch (e) {
      wasm = 'FAILED: ' + e.message;
    }
  }
  const blob = new Blob(['{"selftest":true}'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'selftest.btr.json';
  document.body.appendChild(a); a.click(); a.remove();
  await wait(1500);
  // Save as, Save in place and read back, through the web-message file bridge.
  const file = await new Promise((resolve) => {
    const view = window.chrome.webview;
    let n = 900;
    const calls = new Map();
    view.addEventListener('message', (e) => {
      const r = e.data && e.data.btrFileReply;
      if (r && calls.has(r.id)) { calls.get(r.id)(r); calls.delete(r.id); }
    });
    const call = (req) => new Promise((ok) => { const id = ++n; calls.set(id, ok); view.postMessage({ btrFile: { id, ...req } }); });
    (async () => {
      const first = await call({ op: 'saveAs', name: 'project.btrsub', text: '{"v":1,"ł":"ą"}' });
      if (!first.ok) return resolve('saveAs: ' + first.error);
      const second = await call({ op: 'save', path: first.result.path, text: '{"v":2,"ł":"ą"}' });
      if (!second.ok) return resolve('save: ' + second.error);
      const back = await call({ op: 'read', path: first.result.path });
      if (!back.ok) return resolve('read: ' + back.error);
      const text = new TextDecoder().decode(Uint8Array.from(atob(back.result.data), (c) => c.charCodeAt(0)));
      resolve(text === '{"v":2,"ł":"ą"}' ? 'ok' : 'read back ' + text);
    })();
    setTimeout(() => resolve('no reply in 5 s'), 5000);
  });
  return JSON.stringify({
    origin: location.origin,
    tabs: document.querySelectorAll('.tabs-main .tab').length,
    emptyAtStart,
    sources: document.querySelectorAll('.tree-row').length,
    grid,
    worker: /worker/.test(grid),
    wasm,
    file,
  });
})().then(
  (r) => window.chrome.webview.postMessage(r),
  (e) => window.chrome.webview.postMessage(JSON.stringify({ error: String(e) })));
)JS";

/** Write the result once the probe's download has landed (or 10 s have passed). */
void finishSelfTest() {
  if (g_downloadNote.find(L"\"bytes\"") == std::wstring::npos &&
      g_downloadNote.find(L"interrupted") == std::wstring::npos &&
      g_selftestWaits++ < (g_selftestSave ? 240 : 40)) {
    return;  // the timer comes back in 250 ms; a person has 60 s to answer the Save dialog
  }
  KillTimer(g_hwnd, SELFTEST_TIMER);
  writeUtf8(tempPath(L"btr-selftest.txt"),
            L"SELFTEST " + g_selftestResult + L"\nSELFTEST-DOWNLOAD " + g_downloadNote + L"\n");
  bool ok = g_selftestResult.find(L"\"error\"") == std::wstring::npos &&
            g_downloadNote.find(L"\"bytes\"") != std::wstring::npos;
  ExitProcess(ok ? 0 : 1);
}

void runSelfTest() {
  std::wstring script = L"const wasmAsset = '" + wasmAsset() + L"';\n" + PROBE;
  g_webview->ExecuteScript(
      script.c_str(),
      make<ICoreWebView2ExecuteScriptCompletedHandler, &IID_ICoreWebView2ExecuteScriptCompletedHandler,
           HRESULT, LPCWSTR>([](HRESULT, LPCWSTR) { return S_OK; }));
}

// ──────────────────────────────────────────────────────────────── files ──
//
// The page's file requests (src/platform/fileHost.ts) arrive as web messages
// {"btrFile":{"id":n,"op":"open|read|save|saveAs",...}} and are answered with
// {"btrFileReply":{"id":n,"ok":true,"result":...}}. A file double-clicked in
// Explorer arrives as the first command-line argument and is pushed to the
// page as {"btrHostEvent":{"event":"open","file":...}}. Bytes travel as
// base64, so any format can cross the bridge.

std::wstring g_openOnLoad;  // a file from the command line, sent once the page is up

/** The value of a string field in a flat JSON message, unescaped; empty when absent. */
std::wstring jsonString(const std::wstring& json, const wchar_t* key) {
  std::wstring needle = std::wstring(L"\"") + key + L"\":\"";
  size_t at = json.find(needle);
  if (at == std::wstring::npos) return L"";
  std::wstring out;
  for (size_t i = at + needle.size(); i < json.size(); i++) {
    wchar_t c = json[i];
    if (c == L'"') break;
    if (c != L'\\' || i + 1 >= json.size()) {
      out += c;
      continue;
    }
    wchar_t e = json[++i];
    switch (e) {
      case L'n': out += L'\n'; break;
      case L'r': out += L'\r'; break;
      case L't': out += L'\t'; break;
      case L'b': out += L'\b'; break;
      case L'f': out += L'\f'; break;
      case L'u':
        if (i + 4 < json.size()) {
          out += static_cast<wchar_t>(wcstoul(json.substr(i + 1, 4).c_str(), nullptr, 16));
          i += 4;
        }
        break;
      default: out += e;  // \" \\ \/
    }
  }
  return out;
}

long jsonNumber(const std::wstring& json, const wchar_t* key) {
  std::wstring needle = std::wstring(L"\"") + key + L"\":";
  size_t at = json.find(needle);
  return at == std::wstring::npos ? 0 : wcstol(json.c_str() + at + needle.size(), nullptr, 10);
}

std::wstring jsonQuote(const std::wstring& s) {
  std::wstring out = L"\"";
  for (wchar_t c : s) {
    if (c == L'"' || c == L'\\') {
      out += L'\\';
      out += c;
    } else if (c < 0x20) {
      wchar_t buf[8];
      swprintf(buf, 8, L"\\u%04x", static_cast<unsigned>(c));
      out += buf;
    } else {
      out += c;
    }
  }
  return out + L"\"";
}

std::wstring base64(const std::string& bytes) {
  static const char* A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::wstring out;
  out.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    unsigned n = static_cast<unsigned char>(bytes[i]) << 16;
    if (i + 1 < bytes.size()) n |= static_cast<unsigned char>(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size()) n |= static_cast<unsigned char>(bytes[i + 2]);
    out += A[(n >> 18) & 63];
    out += A[(n >> 12) & 63];
    out += i + 1 < bytes.size() ? A[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.size() ? A[n & 63] : '=';
  }
  return out;
}

std::string toUtf8(const std::wstring& w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  std::string s(n > 0 ? n : 0, '\0');
  if (n > 0) WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
  return s;
}

bool readFile(const std::wstring& path, std::string& out, std::wstring& error) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
  if (f == INVALID_HANDLE_VALUE) {
    error = L"cannot open the file (error " + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  LARGE_INTEGER size;
  GetFileSizeEx(f, &size);
  out.assign(static_cast<size_t>(size.QuadPart), '\0');
  DWORD got = 0;
  BOOL ok = out.empty() || ReadFile(f, out.data(), static_cast<DWORD>(out.size()), &got, nullptr);
  CloseHandle(f);
  if (!ok || got != out.size()) {
    error = L"cannot read the file";
    return false;
  }
  return true;
}

/** Written to a temporary file beside the target and moved over it, so a failed save leaves the old file whole. */
bool writeFileAtomic(const std::wstring& path, const std::string& bytes, std::wstring& error) {
  std::wstring tmp = path + L".saving";
  HANDLE f = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (f == INVALID_HANDLE_VALUE) {
    error = L"cannot write here (error " + std::to_wstring(GetLastError()) + L")";
    return false;
  }
  DWORD put = 0;
  BOOL ok = WriteFile(f, bytes.data(), static_cast<DWORD>(bytes.size()), &put, nullptr) && put == bytes.size();
  CloseHandle(f);
  if (!ok || !MoveFileExW(tmp.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    DeleteFileW(tmp.c_str());
    error = L"cannot write the file";
    return false;
  }
  SHAddToRecentDocs(SHARD_PATHW, path.c_str());
  return true;
}

std::wstring fileName(const std::wstring& path) { return PathFindFileNameW(path.c_str()); }

std::wstring wireFile(const std::wstring& path, std::wstring& error) {
  std::string bytes;
  if (!readFile(path, bytes, error)) return L"";
  return L"{\"path\":" + jsonQuote(path) + L",\"name\":" + jsonQuote(fileName(path)) + L",\"data\":\"" +
         base64(bytes) + L"\"}";
}

void replyFile(long id, bool ok, const std::wstring& resultOrError) {
  if (!g_webview) return;
  std::wstring msg = L"{\"btrFileReply\":{\"id\":" + std::to_wstring(id) +
                     (ok ? L",\"ok\":true,\"result\":" + (resultOrError.empty() ? L"null" : resultOrError)
                         : L",\"ok\":false,\"error\":" + jsonQuote(resultOrError)) +
                     L"}}";
  g_webview->PostWebMessageAsJson(msg.c_str());
}

void pushOpen(const std::wstring& path) {
  std::wstring error;
  std::wstring file = wireFile(path, error);
  if (file.empty()) {
    MessageBoxW(g_hwnd, (L"Could not open " + path + L": " + error).c_str(), APP_NAME, MB_ICONERROR | MB_OK);
    return;
  }
  SHAddToRecentDocs(SHARD_PATHW, path.c_str());
  g_webview->PostWebMessageAsJson((L"{\"btrHostEvent\":{\"event\":\"open\",\"file\":" + file + L"}}").c_str());
}

/** One request waiting for its dialog (dialogs run from the window procedure, as Save as does). */
std::wstring g_pendingFile;

void handleFileRequest(const std::wstring& json) {
  long id = jsonNumber(json, L"id");
  std::wstring op = jsonString(json, L"op");
  std::wstring error;
  if (op == L"ready") {
    // The page's file module has run (src/platform/fileHost.ts): only now can
    // it take the file the app was started with. NavigationCompleted is too
    // early on a slow machine, while a module script is still loading.
    if (!g_openOnLoad.empty() && !g_selftest) {
      pushOpen(g_openOnLoad);
      g_openOnLoad.clear();
    }
  } else if (op == L"read") {
    std::wstring file = wireFile(jsonString(json, L"path"), error);
    replyFile(id, !file.empty(), file.empty() ? error : file);
  } else if (op == L"save") {
    std::wstring path = jsonString(json, L"path");
    bool ok = writeFileAtomic(path, toUtf8(jsonString(json, L"text")), error);
    replyFile(id, ok, ok ? L"{\"ok\":true}" : error);
  } else if (op == L"saveAs" && g_selftest) {
    // nobody to answer a dialog: the probe's file goes to the temporary folder
    std::wstring path = tempPath((L"btr-selftest-" + jsonString(json, L"name")).c_str());
    bool ok = writeFileAtomic(path, toUtf8(jsonString(json, L"text")), error);
    replyFile(id, ok, ok ? L"{\"path\":" + jsonQuote(path) + L",\"name\":" + jsonQuote(fileName(path)) + L"}" : error);
  } else if (op == L"open" || op == L"saveAs") {
    if (!g_pendingFile.empty()) {
      replyFile(id, false, L"another file dialog is open");
      return;
    }
    g_pendingFile = json;
    PostMessageW(g_hwnd, WM_APP_FILE, 0, 0);
  } else {
    replyFile(id, false, L"unknown file request " + op);
  }
}

void runFileDialog() {
  std::wstring json;
  json.swap(g_pendingFile);
  if (json.empty()) return;
  long id = jsonNumber(json, L"id");
  std::wstring op = jsonString(json, L"op");
  wchar_t file[MAX_PATH] = L"";
  OPENFILENAMEW ofn = {};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = g_hwnd;
  ofn.lpstrFile = file;
  ofn.nMaxFile = MAX_PATH;
  std::wstring error;
  if (op == L"open") {
    ofn.lpstrFilter =
        L"Projects (*.btrsub;*.json)\0*.btrsub;*.json\0"
        L"All files\0*.*\0";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (!GetOpenFileNameW(&ofn)) return replyFile(id, true, L"null");
    std::wstring wire = wireFile(file, error);
    if (!wire.empty()) SHAddToRecentDocs(SHARD_PATHW, file);
    return replyFile(id, !wire.empty(), wire.empty() ? error : wire);
  }
  lstrcpynW(file, jsonString(json, L"name").c_str(), MAX_PATH);
  ofn.lpstrFilter = L"BTR Sub Array project (*.btrsub)\0*.btrsub\0All files\0*.*\0";
  ofn.lpstrDefExt = L"btrsub";
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
  if (!GetSaveFileNameW(&ofn)) return replyFile(id, true, L"null");
  bool ok = writeFileAtomic(file, toUtf8(jsonString(json, L"text")), error);
  replyFile(id, ok, ok ? L"{\"path\":" + jsonQuote(file) + L",\"name\":" + jsonQuote(fileName(file)) + L"}" : error);
}

// ─────────────────────────────────────────────────────────────── exports ──

/** Save dialog for one export. Runs on the UI thread, outside WebView2's event. */
void finishSaveAs() {
  ICoreWebView2DownloadStartingEventArgs* args = g_pendingArgs;
  ICoreWebView2Deferral* deferral = g_pendingDeferral;
  g_pendingArgs = nullptr;
  g_pendingDeferral = nullptr;
  if (!args || !deferral) return;

  LPWSTR suggested = nullptr;
  args->get_ResultFilePath(&suggested);
  wchar_t file[MAX_PATH] = L"";
  if (suggested) {
    lstrcpynW(file, PathFindFileNameW(suggested), MAX_PATH);
    CoTaskMemFree(suggested);
  }
  PWSTR downloads = nullptr;
  std::wstring initialDir;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Downloads, 0, nullptr, &downloads))) {
    initialDir = downloads;
    CoTaskMemFree(downloads);
  }

  OPENFILENAMEW ofn = {};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = g_hwnd;
  ofn.lpstrFile = file;
  ofn.nMaxFile = MAX_PATH;
  ofn.lpstrInitialDir = initialDir.empty() ? nullptr : initialDir.c_str();
  ofn.lpstrFilter = L"All files\0*.*\0";
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
  if (GetSaveFileNameW(&ofn)) {
    args->put_ResultFilePath(file);
  } else {
    args->put_Cancel(TRUE);
  }
  deferral->Complete();
  deferral->Release();
  args->Release();
}

/** Records where a download ended up, for the self-test report. */
void watchDownload(ICoreWebView2DownloadStartingEventArgs* args) {
  g_downloadNote = L"{\"error\":\"started, never completed\"}";
  ICoreWebView2DownloadOperation* op = nullptr;
  if (FAILED(args->get_DownloadOperation(&op)) || !op) return;
  EventRegistrationToken token;
  op->add_StateChanged(
      make<ICoreWebView2StateChangedEventHandler, &IID_ICoreWebView2StateChangedEventHandler,
           ICoreWebView2DownloadOperation*, IUnknown*>([](ICoreWebView2DownloadOperation* o, IUnknown*) {
        COREWEBVIEW2_DOWNLOAD_STATE st;
        o->get_State(&st);
        if (st == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED) {
          LPWSTR path = nullptr;
          o->get_ResultFilePath(&path);
          std::wstring target = path ? path : L"";
          if (path) CoTaskMemFree(path);
          WIN32_FILE_ATTRIBUTE_DATA fa;
          long long bytes =
              GetFileAttributesExW(target.c_str(), GetFileExInfoStandard, &fa) ? fa.nFileSizeLow : -1;
          std::wstring shown;
          for (wchar_t c : target) shown += (c == L'\\') ? L"/" : std::wstring(1, c);
          g_downloadNote = L"{\"path\":\"" + shown + L"\",\"bytes\":" + std::to_wstring(bytes) + L"}";
        } else if (st == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED) {
          g_downloadNote = L"{\"error\":\"interrupted\"}";
        }
        return S_OK;
      }),
      &token);
  op->Release();
}

HRESULT onDownloadStarting(ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs* args) {
  // No Edge download flyout: the user chose where it goes.
  args->put_Handled(TRUE);
  if (g_selftest) watchDownload(args);

  if (g_selftest && !g_selftestSave) {
    LPWSTR suggested = nullptr;
    args->get_ResultFilePath(&suggested);
    std::wstring name = suggested ? PathFindFileNameW(suggested) : L"download";
    if (suggested) CoTaskMemFree(suggested);
    args->put_ResultFilePath(tempPath((L"btr-selftest-" + name).c_str()).c_str());
    return S_OK;
  }

  // The dialog runs from the window procedure, not inside the event: a modal
  // loop nested in a WebView2 callback is asking for re-entrancy trouble.
  if (g_pendingArgs) {  // one export at a time; a second click is ignored
    args->put_Cancel(TRUE);
    return S_OK;
  }
  args->AddRef();
  g_pendingArgs = args;
  args->GetDeferral(&g_pendingDeferral);
  PostMessageW(g_hwnd, WM_APP_SAVE_AS, 0, 0);
  return S_OK;
}

// ──────────────────────────────────────────────────────────────── webview ──

void resizeWebView() {
  if (!g_controller) return;
  RECT r;
  GetClientRect(g_hwnd, &r);
  g_controller->put_Bounds(r);
}

HRESULT onController(HRESULT hr, ICoreWebView2Controller* controller) {
  if (FAILED(hr) || !controller) {
    fail(L"The web view could not be created (HRESULT " + std::to_wstring(static_cast<long>(hr)) + L").");
    return S_OK;
  }
  g_controller = controller;
  g_controller->AddRef();
  g_controller->get_CoreWebView2(&g_webview);
  resizeWebView();

  ICoreWebView2Settings* settings = nullptr;
  if (SUCCEEDED(g_webview->get_Settings(&settings)) && settings) {
    wchar_t dev[8];
    settings->put_AreDevToolsEnabled(GetEnvironmentVariableW(L"BTR_DEVTOOLS", dev, 8) > 0);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_IsZoomControlEnabled(TRUE);
    settings->Release();
  }

  ICoreWebView2_3* wv3 = nullptr;
  if (FAILED(g_webview->QueryInterface(IID_ICoreWebView2_3, reinterpret_cast<void**>(&wv3))) || !wv3) {
    fail(L"This WebView2 runtime is too old. Update Microsoft Edge WebView2 and try again.");
    return S_OK;
  }
  std::wstring web = g_exeDir + L"\\web";
  wv3->SetVirtualHostNameToFolderMapping(HOST, web.c_str(), COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
  wv3->Release();

  EventRegistrationToken token;
  ICoreWebView2_4* wv4 = nullptr;
  if (SUCCEEDED(g_webview->QueryInterface(IID_ICoreWebView2_4, reinterpret_cast<void**>(&wv4))) && wv4) {
    wv4->add_DownloadStarting(
        make<ICoreWebView2DownloadStartingEventHandler, &IID_ICoreWebView2DownloadStartingEventHandler,
             ICoreWebView2*, ICoreWebView2DownloadStartingEventArgs*>(onDownloadStarting),
        &token);
    wv4->Release();
  }

  // Links to the outside world open in the user's browser, not in a second
  // app window.
  g_webview->add_NewWindowRequested(
      make<ICoreWebView2NewWindowRequestedEventHandler, &IID_ICoreWebView2NewWindowRequestedEventHandler,
           ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* a) {
            LPWSTR uri = nullptr;
            a->get_Uri(&uri);
            if (uri) {
              if (StrCmpNIW(uri, L"http://", 7) == 0 || StrCmpNIW(uri, L"https://", 8) == 0 ||
                  StrCmpNIW(uri, L"mailto:", 7) == 0) {
                ShellExecuteW(nullptr, L"open", uri, nullptr, nullptr, SW_SHOWNORMAL);
              }
              CoTaskMemFree(uri);
            }
            a->put_Handled(TRUE);
            return S_OK;
          }),
      &token);

  g_webview->add_NavigationCompleted(
      make<ICoreWebView2NavigationCompletedEventHandler, &IID_ICoreWebView2NavigationCompletedEventHandler,
           ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs* a) {
            BOOL ok = FALSE;
            a->get_IsSuccess(&ok);
            if (!ok) {
              fail(L"The application page did not load.");
            } else if (g_selftest) {
              runSelfTest();
            }
            return S_OK;
          }),
      &token);

  g_webview->add_WebMessageReceived(
      make<ICoreWebView2WebMessageReceivedEventHandler, &IID_ICoreWebView2WebMessageReceivedEventHandler,
           ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
          [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* a) {
            // A string is the self-test's report; an object is a file request.
            LPWSTR msg = nullptr;
            if (SUCCEEDED(a->TryGetWebMessageAsString(&msg)) && msg) {
              if (g_selftest) {
                g_selftestResult = msg;
                SetTimer(g_hwnd, SELFTEST_TIMER, 250, nullptr);
              }
              CoTaskMemFree(msg);
              return S_OK;
            }
            LPWSTR json = nullptr;
            if (SUCCEEDED(a->get_WebMessageAsJson(&json)) && json) {
              std::wstring body = json;
              CoTaskMemFree(json);
              if (body.find(L"\"btrFile\"") != std::wstring::npos) handleFileRequest(body);
            }
            return S_OK;
          }),
      &token);

  // The page names the file and marks unsaved work with a leading bullet
  // (App.tsx); the title bar shows exactly that.
  g_webview->add_DocumentTitleChanged(
      make<ICoreWebView2DocumentTitleChangedEventHandler, &IID_ICoreWebView2DocumentTitleChangedEventHandler,
           ICoreWebView2*, IUnknown*>([](ICoreWebView2* view, IUnknown*) {
        LPWSTR title = nullptr;
        if (SUCCEEDED(view->get_DocumentTitle(&title)) && title) {
          if (*title) SetWindowTextW(g_hwnd, title);
          CoTaskMemFree(title);
        }
        return S_OK;
      }),
      &token);

  g_webview->Navigate(START_URL);
  return S_OK;
}

typedef HRESULT(STDAPICALLTYPE* CreateEnvFn)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
                                             ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

void startWebView() {
  HMODULE loader = LoadLibraryW((g_exeDir + L"\\WebView2Loader.dll").c_str());
  CreateEnvFn create =
      loader ? reinterpret_cast<CreateEnvFn>(GetProcAddress(loader, "CreateCoreWebView2EnvironmentWithOptions"))
             : nullptr;
  if (!create) {
    fail(L"WebView2Loader.dll is missing next to the program. Reinstall BTR Sub Array Designer.");
    return;
  }
  std::wstring data = userDataDir();
  HRESULT hr = create(
      nullptr, data.c_str(), nullptr,
      make<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
           &IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>(
          [](HRESULT r, ICoreWebView2Environment* env) {
            if (FAILED(r) || !env) {
              fail(L"Microsoft Edge WebView2 Runtime is not installed. Windows 11 ships it; on Windows 10 "
                   L"install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start again.");
              return S_OK;
            }
            return env->CreateCoreWebView2Controller(
                g_hwnd, make<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                             &IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT,
                             ICoreWebView2Controller*>(onController));
          }));
  if (FAILED(hr)) {
    fail(L"Microsoft Edge WebView2 Runtime is not installed. Windows 11 ships it; on Windows 10 "
         L"install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start again.");
  }
}

// ───────────────────────────────────────────────────────────────── window ──

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SIZE:
      resizeWebView();
      return 0;
    case WM_ACTIVATE:
      if (g_controller && LOWORD(wp) != WA_INACTIVE) {
        g_controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      }
      return 0;
    case WM_APP_SAVE_AS:
      finishSaveAs();
      return 0;
    case WM_APP_FILE:
      runFileDialog();
      return 0;
    case WM_TIMER:
      if (wp == SELFTEST_TIMER) finishSelfTest();
      return 0;
    case WM_GETMINMAXINFO: {
      auto* mm = reinterpret_cast<MINMAXINFO*>(lp);
      mm->ptMinTrackSize = {900, 600};
      return 0;
    }
    case WM_DESTROY:
      if (g_controller) g_controller->Close();
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; i < argc; i++) {
    if (lstrcmpiW(argv[i], L"--selftest") == 0) g_selftest = true;
    if (lstrcmpiW(argv[i], L"--selftest-save") == 0) g_selftest = g_selftestSave = true;
    // Explorer passes a double-clicked .btrsub as the argument (installer.nsi)
    if (argv[i][0] != L'-' && g_openOnLoad.empty()) g_openOnLoad = argv[i];
  }
  LocalFree(argv);

  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  g_exeDir = exeDir();

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = wndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(1));
  wc.hIconSm = wc.hIcon;
  wc.hbrBackground = CreateSolidBrush(RGB(17, 17, 17));
  wc.lpszClassName = L"BTRSubArrayDesigner";
  RegisterClassExW(&wc);

  // 1440 x 900 logical pixels, scaled to the monitor (the manifest makes the
  // process per-monitor DPI aware) — but never bigger than the work area: at
  // 150 % a 900 px window is 1350 px and ran under the taskbar of a 1080p-class
  // screen. Centred in what is left.
  HDC screen = GetDC(nullptr);
  int dpi = GetDeviceCaps(screen, LOGPIXELSX);
  ReleaseDC(nullptr, screen);
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  int ww = work.right - work.left, wh = work.bottom - work.top;
  int w = MulDiv(1440, dpi, 96), h = MulDiv(900, dpi, 96);
  if (w > ww * 95 / 100) w = ww * 95 / 100;
  if (h > wh * 95 / 100) h = wh * 95 / 100;
  int x = work.left + (ww - w) / 2, y = work.top + (wh - h) / 2;

  g_hwnd = CreateWindowExW(0, wc.lpszClassName, APP_NAME, WS_OVERLAPPEDWINDOW, x, y, w, h,
                           nullptr, nullptr, instance, nullptr);
  ShowWindow(g_hwnd, g_selftest ? SW_SHOWNOACTIVATE : show);
  UpdateWindow(g_hwnd);

  startWebView();

  MSG m;
  while (GetMessageW(&m, nullptr, 0, 0)) {
    TranslateMessage(&m);
    DispatchMessageW(&m);
  }
  if (g_controller) g_controller->Release();
  if (g_webview) g_webview->Release();
  CoUninitialize();
  return 0;
}
