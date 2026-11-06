# macOS app

```bash
npm run build:macos            # build + self-test, into dist-macos/
npm run build:macos -- --dmg   # also produce a .dmg
npm run install:macos          # build, then install into /Applications
```

Output lands in `dist-macos/`. The app is **~2 MB** and the disk image under 1 MB,
because the shell is a native WKWebView host rather than a bundled browser.

## Installing

`npm run install:macos` is the one to use, because the installed copy is a
snapshot that nothing updates. It drifts from the repository in silence, and
that has already happened: a copy sat a month behind and was still carrying a
defect long after the code had been fixed.

It takes the same flags as the build, and it refuses rather than guessing:

- **The app must be quit.** Replacing a bundle under a running process leaves it
  half-working until the next launch.
- **The old bundle is removed, not merged over.** `ditto` on its own leaves files
  the new version no longer ships, and a stale asset beside a fresh `index.html`
  is the kind of fault that works until it doesn't. The removal is guarded on the
  bundle id, so a wrong name can never delete another application.
- **The self-test runs from `/Applications`**, not from `dist-macos/` — that is
  the binary you will actually launch, and copying is a step that can fail.
- **It prints the commit it installed**, and says so when the working tree was
  dirty and the build therefore is not that commit.

Handing the `.dmg` to anyone else still needs a Developer ID and notarisation;
see below.

## What the shell actually does

`BTRApp.swift` is a plain AppKit app with one window and one web view. It exists
because three things the app needs are all broken under `file://`:

| | why it breaks | what the shell does |
|---|---|---|
| Prediction worker | it is a **module** worker, and module scripts need a real origin | serves the build over a `btr://app/` custom scheme, which is a proper non-opaque origin |
| Export | `<a download>` on a blob is silently dropped by WKWebView | `WKDownloadDelegate` takes the download and shows a save panel |

Nothing in the shell knows about acoustics, and the web build is bundled
unmodified — `dist/` is copied into `Contents/Resources/web` as-is. The browser
version and the app run identical code.

## Self-test

The build refuses to pass unless the bundle actually works. `--selftest` launches
the app, waits for a real solve, and asserts on all three of the above:

```
SELFTEST {"origin":"btr://app","tabs":8,"sources":21,"grid":"245×245 20 ms · worker","worker":true}
SELFTEST-DOWNLOAD {"name":"…-selftest.btr.json","bytes":17}
```

`"worker":true` means the module worker — not the main-thread fallback — produced
the grid. The download line means a blob export reached
the native side and was written to disk. Either of the two missing fails the build.

Skip it with `--no-test` when iterating on the shell itself.

## Signing, and what it means for handing the app to someone

The build applies an **ad-hoc signature** (`codesign --sign -`). That is enough
for the machine that built it, and **not** enough for anyone else:

- copied to another Mac, the app carries a quarantine flag and Gatekeeper will
  refuse it — "cannot be opened because the developer cannot be verified";
- the recipient can get past it with **right-click → Open** once, or
  `xattr -dr com.apple.quarantine "BTR Sub Array Designer.app"`;
- telling people to do that is fine for a handful of colleagues and wrong for a
  product you sell.

Proper distribution needs an Apple **Developer ID** certificate (paid developer
programme) and notarisation:

```bash
codesign --force --deep --options runtime --timestamp \
  --sign "Developer ID Application: <NAME> (<TEAMID>)" \
  "dist-macos/BTR Sub Array Designer.app"

xcrun notarytool submit "dist-macos/BTR Sub Array Designer.dmg" \
  --apple-id <APPLE_ID> --team-id <TEAMID> --password <APP_SPECIFIC_PASSWORD> --wait

xcrun stapler staple "dist-macos/BTR Sub Array Designer.dmg"
```

`--options runtime` (hardened runtime) is required for notarisation and is
deliberately *not* in the build script, because it changes nothing locally and
would only fail confusingly without a real certificate.

## Architectures

Built universal — `arm64` and `x86_64` are compiled separately and joined with
`lipo`, so one bundle runs on Apple silicon and Intel. Minimum macOS 12.

## Icon

`make-icon.mjs` composes the app icon from `src/assets/btr-solutions.png`. The
artwork is white on transparent and would be invisible in the Dock, so it is
placed on the app's own panel colour with the rounded-rect mask and a teal rim.
No image library — same hand-rolled PNG path as the rest of the tooling here.

## Known gaps

- **Projects are `.btrsub`** (an extension of its own) and
  open by double-click on both systems; older `.json` / `.btr.json` projects
  open through *File → Open* or *Open With*. Save writes back in place through
  the native file bridge (`btrFile`, see `src/platform/fileHost.ts`).
- **No auto-update.** A new version means handing over a new build.
- **Window state** other than size and position is not restored; the app starts
  on an empty project every time, exactly like the browser build.

# Windows app

```sh
./desktop/build-windows.sh
```

Builds on the Mac with mingw-w64 and NSIS (`brew install mingw-w64 makensis`) and
writes to `dist-windows/`:

- `BTR-Sub-Array-Designer-<version>-Setup.exe` — per-user installer, no
  administrator rights: `%LOCALAPPDATA%\Programs\BTR Sub Array Designer`, Start
  menu and desktop shortcuts, an Apps & features entry. `/S` installs silently.
- `BTR-Sub-Array-Designer-<version>-portable.zip` — unzip and run.

The shell is `windows/BTRApp.cpp`, a Win32 window around Microsoft Edge WebView2,
which Windows 11 ships with (on Windows 10 the program says where to get it). It
does the same three jobs as the macOS shell:

- it serves the build from `https://btr.app/` (WebView2 virtual host mapping), so
  the module worker works;
- it turns an export into a Save dialog that opens in Downloads;
- it keeps browser data in `%LOCALAPPDATA%\BTR Sub Array Designer` and never next
  to the exe, which sits in a folder a normal user cannot write. The uninstaller
  asks before it deletes presets.

The WebView2 SDK is fetched from NuGet on the first build, pinned to one version
and checked by hash. `makensis` needs a UTF-8 locale (under `C` it dies with
`std::bad_alloc`), and the script sets one.

## Windows self-test

Nothing on the Mac can run the result. On Windows:

```bat
BTRSubArrayDesigner.exe --selftest
```

This runs the same probe as the macOS self-test in a throw-away profile and writes
`%TEMP%\btr-selftest.txt`. `--selftest-save` sends the probe's export through the
real Save dialog and waits up to 60 s for someone to press Save.

Checked in a VirtualBox VM (Windows 11 Pro, ARM64, the x64 build
under emulation):
- install, shortcuts, the Apps entry and a clean uninstall;
- the self-test: origin `https://btr.app`, a grid solved by the module worker;
- a download through the Save dialog into Downloads;
- the window fits the work area at 150 %.

The build has not been run on a native x64 PC.
