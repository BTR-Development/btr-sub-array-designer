#!/usr/bin/env bash
# Build "BTR Sub Array Designer.app" and install it into /Applications.
#
#   ./desktop/install-macos.sh              build, self-test, install, verify
#   ./desktop/install-macos.sh --no-test    skip the bundle self-test
#   ./desktop/install-macos.sh --dmg        also produce a .dmg for handing out
#
# WHY THIS EXISTS
#
# The installed copy is a SNAPSHOT. Nothing updates it, so it drifts from the
# repository silently and nothing on screen says which commit you are looking
# at. That already happened once: the copy in dist-macos sat a month behind and
# still carried a defect that had been fixed in the code.
#
# So this script does the two steps together and then checks the result IN
# PLACE rather than trusting the copy: the self-test is run from /Applications,
# not from the build directory, because that is the binary you will actually
# launch.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP_NAME="BTR Sub Array Designer"
BIN_NAME="BTRSubArrayDesigner"
BUNDLE_ID="tech.btone.subarraydesigner"
SRC="$ROOT/dist-macos/$APP_NAME.app"
DST="/Applications/$APP_NAME.app"

# ── 1. refuse to overwrite a running app ─────────────────────────────────────
# Replacing a bundle out from under a running process leaves it in a state
# where it half-works until quit. pgrep -x matches the executable name exactly;
# note that `ps -ax -p` does NOT filter on macOS and must never be used here.
if pgrep -x "$BIN_NAME" >/dev/null 2>&1; then
  echo "==> $APP_NAME is running. Quit it first (Cmd+Q), then run this again." >&2
  exit 1
fi

# ── 2. build ─────────────────────────────────────────────────────────────────
"$HERE/build-macos.sh" "$@"
test -x "$SRC/Contents/MacOS/$BIN_NAME" || {
  echo "==> build produced no executable at $SRC" >&2
  exit 1
}

# ── 3. install ───────────────────────────────────────────────────────────────
if [ ! -w /Applications ]; then
  echo "==> /Applications is not writable by $(whoami)." >&2
  exit 1
fi

# Remove the old bundle rather than merging over it: ditto leaves files that
# the new version no longer ships, and a stale asset beside a fresh index.html
# is exactly the kind of thing that works until it doesn't. The guard makes the
# rm specific — a directory, named .app, carrying OUR bundle id — so a wrong
# APP_NAME can never delete somebody else's application.
if [ -e "$DST" ]; then
  existing="$(defaults read "$DST/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || echo '')"
  if [ -d "$DST" ] && [ "${DST##*.}" = "app" ] && [ "$existing" = "$BUNDLE_ID" ]; then
    echo "==> replacing the installed copy"
    rm -rf "$DST"
  else
    echo "==> $DST exists and is not a $BUNDLE_ID bundle. Refusing to touch it." >&2
    exit 1
  fi
fi

echo "==> install"
ditto "$SRC" "$DST"

# ── 4. verify the copy that will actually launch ─────────────────────────────
echo "==> verify"
diff -rq "$SRC" "$DST" >/dev/null || { echo "    FAILED — installed copy differs from the build" >&2; exit 1; }
echo "    identical to the build"

codesign --verify --deep --strict "$DST" 2>/dev/null \
  && echo "    ad-hoc signature valid" \
  || echo "    (signature check failed — the app still runs locally)"

# Handing the .dmg to anyone else needs a Developer ID and notarisation; say so
# once here rather than letting someone discover it on a customer's machine.
if [ -z "$(xattr -p com.apple.quarantine "$DST" 2>/dev/null)" ]; then
  echo "    no quarantine flag — first launch will not be blocked"
fi

for arg in "$@"; do [ "$arg" = "--no-test" ] && SKIP_TEST=1; done
if [ -z "${SKIP_TEST:-}" ]; then
  WASM_ASSET="$(cd "$DST/Contents/Resources/web" && ls assets/*.wasm 2>/dev/null | head -1 || true)"
  [ -n "$WASM_ASSET" ] && WASM_ASSET="/$WASM_ASSET"
  RESULT="$(BTR_WASM_ASSET="$WASM_ASSET" "$DST/Contents/MacOS/$BIN_NAME" --selftest 2>/dev/null \
    | grep '^SELFTEST ' || true)"
  [ -n "$RESULT" ] || { echo "    FAILED — the installed app produced no self-test line" >&2; exit 1; }
  echo "    $RESULT"
  case "$RESULT" in *'"worker":true'*) ;; *) echo "    FAILED — worker did not load" >&2; exit 1 ;; esac
  case "$RESULT" in *'"file":"ok"'*) ;; *) echo "    FAILED — file bridge" >&2; exit 1 ;; esac
fi

# ── 5. say what was installed, so drift is visible next time ─────────────────
commit="$(git -C "$ROOT" log --oneline -1 2>/dev/null || echo 'not a git checkout')"
echo "==> installed $DST"
echo "    from $commit"
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  echo "    WARNING: the working tree was dirty, so this build is not that commit."
fi
