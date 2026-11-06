#!/usr/bin/env bash
# Build "BTR Sub Array Designer.app" for macOS.
#
#   ./desktop/build-macos.sh              build, then self-test the bundle
#   ./desktop/build-macos.sh --no-test    skip the self-test
#   ./desktop/build-macos.sh --dmg        also produce a .dmg for handing out
#
# The web build is bundled into Resources/web and served to WKWebView over a
# custom scheme, which is what makes the module worker and the wasm work — see
# desktop/BTRApp.swift.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_NAME="BTR Sub Array Designer"
BIN_NAME="BTRSubArrayDesigner"
OUT="$ROOT/dist-macos"
APP="$OUT/$APP_NAME.app"

SELFTEST=1
MAKE_DMG=0
for arg in "$@"; do
  case "$arg" in
    --no-test) SELFTEST=0 ;;
    --dmg) MAKE_DMG=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "==> web build"
cd "$ROOT"
npm run build >/dev/null
test -f "$ROOT/dist/index.html" || { echo "web build produced no index.html" >&2; exit 1; }

echo "==> app bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
cp -R "$ROOT/dist" "$APP/Contents/Resources/web"

echo "==> icon"
ICONSET="$OUT/AppIcon.iconset"
rm -rf "$ICONSET"
node "$HERE/make-icon.mjs" "$ROOT/src/assets/btr-solutions.png" "$ICONSET" >/dev/null
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> compile"
# Universal so the same bundle runs on Apple silicon and Intel.
swiftc -O \
  -target arm64-apple-macos12.0 \
  -o "$OUT/$BIN_NAME-arm64" \
  "$HERE/BTRApp.swift"
swiftc -O \
  -target x86_64-apple-macos12.0 \
  -o "$OUT/$BIN_NAME-x86_64" \
  "$HERE/BTRApp.swift"
lipo -create -output "$APP/Contents/MacOS/$BIN_NAME" \
  "$OUT/$BIN_NAME-arm64" "$OUT/$BIN_NAME-x86_64"
rm -f "$OUT/$BIN_NAME-arm64" "$OUT/$BIN_NAME-x86_64"
chmod +x "$APP/Contents/MacOS/$BIN_NAME"

# Ad-hoc signature. Enough for the machine that built it; handing the app to
# someone else needs a Developer ID and notarisation — see desktop/README.md.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || \
  echo "    (ad-hoc signing failed — the app still runs locally)"

SIZE=$(du -sh "$APP" | cut -f1)
echo "==> built $APP  ($SIZE)"

if [ "$SELFTEST" -eq 1 ]; then
  echo "==> self-test"
  # Proves the three fragile pieces survived bundling: the SPA mounted, the
  # module worker is the one solving, and a real grid came back.
  # The probe fetches and compiles this, to prove the custom scheme serves wasm
  # with the right MIME type rather than merely returning bytes.
  WASM_ASSET="$(cd "$ROOT/dist" && ls assets/*.wasm 2>/dev/null | head -1 || true)"
  [ -n "$WASM_ASSET" ] && WASM_ASSET="/$WASM_ASSET"

  LOG="$(BTR_WASM_ASSET="$WASM_ASSET" "$APP/Contents/MacOS/$BIN_NAME" --selftest 2>/dev/null || true)"
  RESULT="$(printf '%s\n' "$LOG" | grep '^SELFTEST ' || true)"
  DOWNLOAD="$(printf '%s\n' "$LOG" | grep '^SELFTEST-DOWNLOAD ' || true)"
  PRINTED="$(printf '%s\n' "$LOG" | grep '^SELFTEST-PRINT ' || true)"

  if [ -z "$RESULT" ]; then
    echo "    FAILED — the app produced no self-test line" >&2
    exit 1
  fi
  echo "    $RESULT"
  echo "    ${DOWNLOAD:-SELFTEST-DOWNLOAD (none)}"
  echo "    ${PRINTED:-SELFTEST-PRINT (none)}"

  fail() { echo "    FAILED — $1" >&2; exit 1; }
  # The application opens on an EMPTY project. Asserted here because this is
  # the only check that runs the bundle a person actually launches — a unit
  # test can pin the store, not the shipped app.
  case "$RESULT" in *'"emptyAtStart":0'*) ;; *) fail "the app did not open on an empty project" ;; esac
  case "$RESULT" in *'"worker":true'*) ;; *) fail "the prediction worker did not load" ;; esac
  case "$DOWNLOAD" in *'"bytes":17'*) ;; *) fail "the export download never reached the app" ;; esac
  # The delay sheet goes to paper through the native print bridge (WKWebView
  # ignores window.print). A PDF of a few hundred bytes is a blank page.
  case "$RESULT" in *'"sheet":"printed"'*) ;; *) fail "the delay sheet did not open and print" ;; esac
  # Save as, Save in place and read back through the native file bridge.
  case "$RESULT" in *'"file":"ok"'*) ;; *) fail "the file bridge did not save, save in place and read back" ;; esac
  case "$PRINTED" in *'"ok":true'*) ;; *) fail "the print operation did not complete" ;; esac
  PDF="${TMPDIR:-/tmp/}btr-selftest-print.pdf"
  [ "$(stat -f%z "$PDF" 2>/dev/null || echo 0)" -gt 10000 ] || fail "the printed sheet is empty"
fi

if [ "$MAKE_DMG" -eq 1 ]; then
  echo "==> dmg"
  DMG="$OUT/$APP_NAME.dmg"
  rm -f "$DMG"
  STAGE="$OUT/.dmg-stage"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$STAGE"
  echo "==> built $DMG  ($(du -sh "$DMG" | cut -f1))"
fi
