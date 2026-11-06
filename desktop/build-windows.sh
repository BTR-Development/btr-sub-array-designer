#!/usr/bin/env bash
# Build BTR Sub Array Designer for Windows (x64) from the Mac.
#
#   ./desktop/build-windows.sh
#
# Needs mingw-w64 and NSIS (brew install mingw-w64 makensis). Produces, in
# dist-windows/:
#   BTR-Sub-Array-Designer-<version>-Setup.exe   per-user installer, no admin
#   BTR-Sub-Array-Designer-<version>-portable.zip  unzip and run
#
# The shell is desktop/windows/BTRApp.cpp (WebView2). The WebView2 SDK is fetched
# from NuGet on first use, pinned to one version and checked by hash, and kept
# out of git (desktop/windows/deps/). Nothing here can RUN the result — there is
# no Windows on this Mac; test it on Windows with `BTRSubArrayDesigner.exe
# --selftest`, which writes %TEMP%\btr-selftest.txt.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WIN="$HERE/windows"
OUT="$ROOT/dist-windows"
STAGE="$OUT/BTR Sub Array Designer"
BIN="BTRSubArrayDesigner.exe"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$HERE/Info.plist")"
REV="$(git -C "$ROOT" rev-parse --short HEAD)$([ -z "$(git -C "$ROOT" status --porcelain -- src desktop)" ] || echo '+dirty')"
CXX=x86_64-w64-mingw32-g++
WINDRES=x86_64-w64-mingw32-windres

WV2_VERSION="1.0.2592.51"
WV2_SHA256="805c79e05184fab18c9fe7b8ba820c598399b97adc1fbf5b0ea490efad91d5b8"
WV2="$WIN/deps/webview2"

command -v "$CXX" >/dev/null || { echo "missing $CXX (brew install mingw-w64)" >&2; exit 1; }
command -v makensis >/dev/null || { echo "missing makensis (brew install makensis)" >&2; exit 1; }

echo "==> WebView2 SDK $WV2_VERSION"
if [ ! -f "$WV2/build/native/include/WebView2.h" ]; then
  mkdir -p "$WIN/deps"
  curl -fsSL -o "$WIN/deps/webview2.nupkg" \
    "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$WV2_VERSION"
  echo "$WV2_SHA256  $WIN/deps/webview2.nupkg" | shasum -a 256 -c - >/dev/null \
    || { echo "WebView2 SDK hash mismatch" >&2; exit 1; }
  rm -rf "$WV2" && mkdir -p "$WV2" && unzip -q "$WIN/deps/webview2.nupkg" -d "$WV2"
fi

echo "==> web build"
cd "$ROOT"
npm run build >/dev/null
test -f "$ROOT/dist/index.html" || { echo "web build produced no index.html" >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$STAGE"

echo "==> icon"
ICONSET="$OUT/AppIcon.iconset"
node "$HERE/make-icon.mjs" "$ROOT/src/assets/btr-solutions.png" "$ICONSET" >/dev/null
node "$WIN/make-ico.mjs" "$ICONSET" "$OUT/AppIcon.ico" >/dev/null
rm -rf "$ICONSET"

echo "==> resources"
cp "$WIN/app.manifest" "$OUT/app.manifest"
cp "$WIN/app.rc" "$OUT/app.rc"
COMMAS="${VERSION//./,},0"
(cd "$OUT" && "$WINDRES" -O coff \
  -DVERSION_DOTS="\\\"$VERSION\\\"" -DVERSION_COMMAS="$COMMAS" -DGIT_REV="\\\"$REV\\\"" \
  app.rc -o app.res.o)

echo "==> compile"
"$CXX" -std=c++17 -O2 -municode -mwindows -DNDEBUG \
  -I "$WV2/build/native/include" \
  "$WIN/BTRApp.cpp" "$OUT/app.res.o" \
  -static -static-libgcc -static-libstdc++ \
  -lole32 -loleaut32 -luuid -lshlwapi -lshell32 -lcomdlg32 -luser32 -lgdi32 \
  -s -o "$STAGE/$BIN"
cp "$WV2/runtimes/win-x64/native/WebView2Loader.dll" "$STAGE/"
cp -R "$ROOT/dist" "$STAGE/web"

# The exe must not depend on any mingw runtime DLL: it ships alone.
DEPS="$(x86_64-w64-mingw32-objdump -p "$STAGE/$BIN" | awk '/DLL Name/ {print $3}' | sort -u | tr '\n' ' ')"
for d in $DEPS; do
  case "$(echo "$d" | tr '[:upper:]' '[:lower:]')" in
    kernel32.dll|user32.dll|gdi32.dll|ole32.dll|oleaut32.dll|shell32.dll|shlwapi.dll|comdlg32.dll|advapi32.dll|msvcrt.dll|api-ms-win-*) ;;
    *) echo "unexpected runtime dependency: $d" >&2; exit 1 ;;
  esac
done
echo "    imports: $DEPS"

echo "==> installer"
SETUP="$OUT/BTR-Sub-Array-Designer-$VERSION-Setup.exe"
# makensis 3.13 dies with std::bad_alloc under the C locale (an empty
# environment, as in a non-interactive shell); any UTF-8 locale works.
LC_ALL=en_US.UTF-8 makensis -V2 -DVERSION="$VERSION" -DOUTFILE="$SETUP" -DSTAGE="$STAGE" -DICON="$OUT/AppIcon.ico" \
  "$WIN/installer.nsi"

echo "==> portable zip"
ZIP="$OUT/BTR-Sub-Array-Designer-$VERSION-portable.zip"
(cd "$OUT" && zip -qr "$ZIP" "$(basename "$STAGE")")

rm -f "$OUT/app.rc" "$OUT/app.manifest" "$OUT/app.res.o"
echo "==> built $VERSION ($REV)"
ls -lh "$SETUP" "$ZIP" | awk '{print "    " $5 "  " $9}'
