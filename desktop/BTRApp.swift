// BTR Sub Array Designer — macOS shell.
//
// The app is a self-contained SPA. The only job here is to give it a window and
// a proper origin, because three things it needs are all broken under file://:
//
//   * the prediction Web Worker is a MODULE worker,
//   * export uses <a download> on a blob URL, which WKWebView drops on the floor
//     unless a download delegate takes it.
//
// A WKURLSchemeHandler serving the bundled build over btr://app/ solves the first
// two by giving the page a real, non-opaque origin; WKDownloadDelegate solves the
// third. Nothing here knows anything about acoustics.

import AppKit
import WebKit
import UniformTypeIdentifiers

let SCHEME = "btr"
let ORIGIN = "btr://app/"

// ─────────────────────────────────────────────────────────────── static files ──

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root
    }

    private static let mimeTypes: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "wasm": "application/wasm",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "svg": "image/svg+xml",
        "ico": "image/x-icon",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "map": "application/json; charset=utf-8",
    ]

    /// Resolve a request path to a file inside the bundled build, refusing to
    /// escape it. A path that names no file falls back to index.html so the SPA
    /// keeps working if it ever grows client-side routes.
    private func resolve(_ url: URL) -> URL? {
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        let candidate = root.appendingPathComponent(path).standardizedFileURL
        guard candidate.path.hasPrefix(root.standardizedFileURL.path) else { return nil }

        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
        if candidate.pathExtension.isEmpty { return root.appendingPathComponent("index.html") }
        return nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let file = resolve(url),
              let data = try? Data(contentsOf: file)
        else {
            let url = task.request.url ?? URL(string: ORIGIN)!
            let response = HTTPURLResponse(
                url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Length": "0"])!
            task.didReceive(response)
            task.didFinish()
            return
        }

        let mime = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                // The build is immutable inside the bundle; the worker and the
                // wasm are fetched by the page as same-origin subresources.
                "Cache-Control": "no-cache",
            ])!

        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// ────────────────────────────────────────────────────────────────── downloads ──

/// Saves whatever the page downloads. The app exports project files this way, so
/// this is load-bearing, not a nicety.
final class DownloadHandler: NSObject, WKDownloadDelegate {
    /// In self-test the destination is chosen for us, so the export path can be
    /// exercised end to end without a human dismissing a save panel.
    let headless: Bool

    init(headless: Bool) {
        self.headless = headless
    }

    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        if headless {
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("btr-selftest-\(UUID().uuidString)-\(suggestedFilename)")
            try? FileManager.default.removeItem(at: dest)
            completionHandler(dest)
            return
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first

        panel.begin { result in
            guard result == .OK, let url = panel.url else {
                completionHandler(nil)
                return
            }
            // WKDownload insists on writing a file that does not exist yet.
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard headless else { return }
        let url = download.progress.fileURL
        let bytes = (try? Data(contentsOf: url ?? URL(fileURLWithPath: "/nonexistent")).count) ?? -1
        print("SELFTEST-DOWNLOAD {\"name\":\"\(url?.lastPathComponent ?? "?")\",\"bytes\":\(bytes)}")
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if headless { print("SELFTEST-DOWNLOAD {\"error\":\"\(error.localizedDescription)\"}") }
        NSLog("[BTR] download failed: \(error.localizedDescription)")
    }
}

// ──────────────────────────────────────────────────────────────────── printing ──

/// WKWebView ignores `window.print()`, so the page asks for printing over this
/// handler instead (src/ui/DelaySheet.tsx). A separate object rather than the
/// app delegate itself, because the content controller holds its handlers
/// strongly and the delegate owns the web view: that would be a cycle.
final class PrintBridge: NSObject, WKScriptMessageHandler {
    weak var app: AppDelegate?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        app?.printPage()
    }
}

// ─────────────────────────────────────────────────────────────────── files ──

/// The page's file requests (src/platform/fileHost.ts): open, read, save as
/// and save in place, answered as promises. Like PrintBridge, a separate
/// object so the content controller does not retain the app delegate.
final class FileBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var app: AppDelegate?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let app, let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "malformed file request")
            return
        }
        app.fileRequest(op: op, body: body, reply: replyHandler)
    }
}

/// What the Open panel offers: projects, old and new.
private let OPEN_EXTENSIONS = ["btrsub", "json"]

/// A file in the shape the page reads it: base64, so any format can cross the bridge.
private func wireFile(_ url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    return ["path": url.path, "name": url.lastPathComponent, "data": data.base64EncodedString()]
}

// ──────────────────────────────────────────────────────────────────── the app ──

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let selfTest = CommandLine.arguments.contains("--selftest")
    private lazy var downloads = DownloadHandler(headless: selfTest)
    private let printBridge = PrintBridge()
    private let fileBridge = FileBridge()
    private var titleObservation: NSKeyValueObservation?
    /// files handed over by Finder before the page could take them
    private var pendingOpens: [URL] = []
    /// set by the page itself ("ready"), see fileRequest
    private var pageReady = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let web = Bundle.main.resourceURL?.appendingPathComponent("web") else {
            fatalError("bundled web build is missing")
        }

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(root: web), forURLScheme: SCHEME)
        printBridge.app = self
        config.userContentController.add(printBridge, name: "btrPrint")
        fileBridge.app = self
        config.userContentController.addScriptMessageHandler(fileBridge, contentWorld: .page, name: "btrFile")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1500, height: 950),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "BTR Sub Array Designer"
        // Deliberately NOT fullSizeContentView: the page draws its own dense top
        // bar, which would end up underneath the traffic lights.
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("BTRMainWindow")

        buildMenu()

        // The page names the file and marks unsaved work with a leading bullet
        // (App.tsx); the window shows the name and puts the bullet where macOS
        // puts it, in the close button.
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            guard let self, let title = view.title, !title.isEmpty else { return }
            let edited = title.hasPrefix("• ")
            self.window.title = edited ? String(title.dropFirst(2)) : title
            self.window.isDocumentEdited = edited
        }

        window.makeKeyAndOrderFront(nil)
        if !selfTest { NSApp.activate(ignoringOtherApps: true) }

        webView.load(URLRequest(url: URL(string: ORIGIN + "index.html")!))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // ---- downloads -----------------------------------------------------------

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // An external http(s) link (a datasheet, a manufacturer page) belongs in
        // the user's browser and a mailto: link in their mail program, not in
        // this window.
        if let url = navigationAction.request.url,
           url.scheme == "http" || url.scheme == "https" || url.scheme == "mailto",
           navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = downloads
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = downloads
    }

    // ---- load result ---------------------------------------------------------

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard selfTest else { return }
        runSelfTest()
    }

    // ---- files ---------------------------------------------------------------

    /// Finder: a double-clicked .btrsub, a file dropped on the Dock icon, or
    /// one opened with "Open With". The page decides what to do with it, the
    /// unsaved-changes question included.
    func application(_ application: NSApplication, open urls: [URL]) {
        pendingOpens.append(contentsOf: urls)
        flushOpens()
    }

    private func flushOpens() {
        guard pageReady else { return }
        while !pendingOpens.isEmpty {
            let url = pendingOpens.removeFirst()
            guard let file = try? wireFile(url),
                  let json = try? JSONSerialization.data(withJSONObject: ["event": "open", "file": file]),
                  let text = String(data: json, encoding: .utf8) else { continue }
            NSDocumentController.shared.noteNewRecentDocumentURL(url)
            webView.evaluateJavaScript("window.__btrHostEvent(\(text))") { _, error in
                if let error { NSLog("[BTR] handing the file to the page failed: \(error.localizedDescription)") }
            }
        }
    }

    func fileRequest(op: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let write = { (url: URL, text: String) -> String? in
            do {
                try text.write(to: url, atomically: true, encoding: .utf8)
                NSDocumentController.shared.noteNewRecentDocumentURL(url)
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        switch op {
        case "ready":
            // The page's file module has run and can take files. Not the
            // navigation's didFinish: a module script may still be on its way
            // then, and a file double-clicked to START the app arrived at a
            // page with nobody there to receive it.
            pageReady = true
            flushOpens()
            reply(NSNull(), nil)
        case "open":
            let panel = NSOpenPanel()
            panel.allowedContentTypes = OPEN_EXTENSIONS.compactMap { UTType(filenameExtension: $0) }
            panel.allowsMultipleSelection = false
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { return reply(NSNull(), nil) }
                do {
                    NSDocumentController.shared.noteNewRecentDocumentURL(url)
                    reply(try wireFile(url), nil)
                } catch {
                    reply(nil, error.localizedDescription)
                }
            }
        case "read":
            guard let path = body["path"] as? String else { return reply(nil, "no path") }
            do { reply(try wireFile(URL(fileURLWithPath: path)), nil) } catch { reply(nil, error.localizedDescription) }
        case "save":
            guard let path = body["path"] as? String, let text = body["text"] as? String else {
                return reply(nil, "no path or no content")
            }
            if let error = write(URL(fileURLWithPath: path), text) { reply(nil, error) } else { reply(["ok": true], nil) }
        case "saveAs":
            guard let text = body["text"] as? String else { return reply(nil, "no content") }
            let name = (body["name"] as? String) ?? "project.btrsub"
            if selfTest {
                // nobody to answer a panel: the probe's file goes to the temporary folder
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("btr-selftest-" + name)
                if let error = write(url, text) { return reply(nil, error) }
                return reply(["path": url.path, "name": url.lastPathComponent], nil)
            }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            if let project = UTType(filenameExtension: "btrsub") { panel.allowedContentTypes = [project] }
            panel.isExtensionHidden = false
            panel.beginSheetModal(for: window) { response in
                guard response == .OK, let url = panel.url else { return reply(NSNull(), nil) }
                if let error = write(url, text) { reply(nil, error) } else {
                    reply(["path": url.path, "name": url.lastPathComponent], nil)
                }
            }
        default:
            reply(nil, "unknown file request \(op)")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[BTR] navigation failed: \(error.localizedDescription)")
        if selfTest { exit(2) }
    }

    /// Headless check that the three fragile pieces actually came up: the React
    /// tree mounted, the module worker is the one solving, and a real grid came
    /// back. Printed as one line so the build script can assert on it.
    private func runSelfTest() {
        // callAsyncJavaScript takes an async function BODY, so this is plain
        // statements with a return — not an IIFE.
        // callAsyncJavaScript takes an async function BODY, so this is plain
        // statements with a return — not an IIFE.
        //
        // The three things that break under file:// are each exercised for real:
        // the module worker has to be the one that solved the grid, the wasm has
        // to arrive as application/wasm AND compile, and a blob download has to
        // reach the native side.
        let probe = """
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const readGrid = () => [...document.querySelectorAll('.readout.mono')]
          .map(e => (e.textContent || '').trim())
          .find(t => /\\d+×\\d+/.test(t));

        // The application starts EMPTY, on purpose, so nothing is being solved
        // when it opens and there is no grid to read. The probe therefore has
        // to put a cabinet in before it can prove the worker solved anything.
        // It used to load the first shipped preset; shipped presets are gone
        // (the Presets menu holds only what the user saved). The + Add button
        // is no use either — it opens the cabinet DIALOG, it does not add —
        // so the probe opens the Array panel and presses + New array, which
        // creates a line of cabinets in one click.
        //
        // Found by this self-test failing the day the empty start landed, which
        // is the test working: it asserts a real grid came back, and with no
        // sources there is no grid. Do NOT soften the grid assertion to make
        // this pass; that would stop the bundle check proving the module worker
        // and the wasm survived bundling, which is the whole reason it exists.
        //
        // Clicked by CLASS, never by label: the interface ships in several
        // languages and the buttons read differently in each. `.tab-array` and
        // `.subs-new-array` exist for exactly this probe.
        // Wait for the tree to mount first. The old probe got this for free:
        // it spent its twenty seconds looking for a grid, and by the time the
        // grid existed so did everything else. Clicking is the FIRST thing now,
        // so it has to wait for something to click.
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

        // the same call the exporters use
        const blob = new Blob(['{"selftest":true}'], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'selftest.btr.json';
        document.body.appendChild(a); a.click(); a.remove();
        await wait(1200);

        // Save as, Save in place and read back, through the file bridge: under
        // --selftest Save as writes to the temporary folder without a panel.
        let file = await (async () => {
          const bridge = window.webkit?.messageHandlers?.btrFile;
          if (!bridge) return 'no file bridge';
          try {
            const first = await bridge.postMessage({ op: 'saveAs', name: 'project.btrsub', text: '{"v":1}' });
            await bridge.postMessage({ op: 'save', path: first.path, text: '{"v":2}' });
            const back = await bridge.postMessage({ op: 'read', path: first.path });
            return atob(back.data) === '{"v":2}' && back.name === first.name ? 'ok' : 'read back ' + atob(back.data);
          } catch (e) {
            return 'FAILED: ' + (e && e.message || e);
          }
        })();

        // The delay sheet goes to paper through the native print bridge; under
        // --selftest the job is saved to a PDF and reported as SELFTEST-PRINT.
        let sheet = 'not attempted';
        document.querySelector('button.tb-file')?.click();
        await wait(150);
        document.querySelector('button.menu-delay-sheet')?.click();
        await wait(300);
        const printButton = document.querySelector('button.sheet-print');
        if (!printButton) sheet = 'no sheet dialog';
        else if (!document.querySelector('.print-sheet-root .sheet table')) sheet = 'no table in the print root';
        else { printButton.click(); sheet = 'printed'; await wait(4000); }

        return JSON.stringify({
          origin: location.origin,
          tabs: document.querySelectorAll('.tabs-main .tab').length,
          // Before the cabinet, and after it: the first pins the empty start
          // in the SHIPPED bundle, which no unit test can reach.
          emptyAtStart,
          sources: document.querySelectorAll('.tree-row').length,
          grid,
          worker: /worker/.test(grid),
          wasm,
          sheet,
          file,
        });
        """

        let wasmAsset = ProcessInfo.processInfo.environment["BTR_WASM_ASSET"] ?? ""
        webView.callAsyncJavaScript(probe,
                                    arguments: ["wasmAsset": wasmAsset],
                                    in: nil,
                                    in: .page) { result in
            switch result {
            case .success(let value):
                print("SELFTEST \(value as? String ?? "?")")
                exit((value as? String)?.contains("\"error\"") == true ? 1 : 0)
            case .failure(let error):
                print("SELFTEST failed: \(error.localizedDescription)")
                exit(1)
            }
        }
    }

    // ---- printing ------------------------------------------------------------

    /// The system print panel over the page as the print stylesheet lays it
    /// out; its PDF menu is the "save as PDF" route. Margins come from the
    /// page's own @page rule, so the panel's are zeroed.
    ///
    /// Under --selftest there is nobody to press Print: the job is written
    /// straight to a PDF in the temporary folder and reported, so the build can
    /// check that the sheet really comes out on paper and not as a blank page.
    func printPage() {
        let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo()
        info.topMargin = 0
        info.bottomMargin = 0
        info.leftMargin = 0
        info.rightMargin = 0
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        var target: URL?
        if selfTest {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("btr-selftest-print.pdf")
            try? FileManager.default.removeItem(at: url)
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
            target = url
        }
        let op = webView.printOperation(with: info)
        op.showsPrintPanel = !selfTest
        op.showsProgressPanel = !selfTest
        // Without a frame the operation lays the page out at zero size and
        // prints nothing.
        op.view?.frame = webView.bounds
        printTarget = target
        op.runModal(for: window, delegate: self, didRun: #selector(printDidRun(_:success:contextInfo:)),
                    contextInfo: nil)
    }

    private var printTarget: URL?

    @objc private func printDidRun(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        guard selfTest, let url = printTarget else { return }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        print("SELFTEST-PRINT {\"ok\":\(success),\"bytes\":\(bytes)}")
        fflush(stdout)
    }

    // ---- menu ----------------------------------------------------------------

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About BTR Sub Array Designer",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Without a real Edit menu the standard shortcuts never reach the text
        // fields, so typing a delay and pressing Cmd+A does nothing.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(.separator())
        view.addItem(withTitle: "Enter Full Screen",
                     action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc private func reload() { webView.reload() }
    @objc private func zoomReset() { webView.pageZoom = 1.0 }
    @objc private func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2.5) }
    @objc private func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.5) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
