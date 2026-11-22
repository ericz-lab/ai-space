#!/usr/bin/env bash
# Install or upgrade the AI Space Server edition from an unpacked release archive (docs/release.md):
#
#   tar -xzf ai-space-<version>-<linux|macos>-<arch>.tar.gz
#   bash ai-space-<version>-<linux|macos>-<arch>/install.sh
#
# The program goes to $AI_SPACE_PREFIX (default ~/.local/share/ai-space) as releases/<version>,
# with `current` pointing at the one that runs; the workspace (SPACE_HOME, default ~/.ai-space)
# with apps, databases and .env is never touched. deploy/install.sh then (re)writes the background
# service (a systemd user unit on Linux, a LaunchAgent on a Mac) to run from `current`, restarts
# it and waits for the health check. If that fails, `current` goes back to the previous release
# and its installer runs again. The last three releases stay for a manual rollback:
# ln -sfn releases/<version> current && bash current/deploy/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/RELEASE.json" ] || { echo "run this from an unpacked ai-space release (RELEASE.json missing)" >&2; exit 1; }
case "$(uname -s)" in
  Linux | Darwin) ;;
  *) echo "the Server edition installs on Linux (a systemd user unit) and on a Mac (a LaunchAgent)" >&2; exit 1 ;;
esac
field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$2" | head -n1; }
VERSION="$(field version "$SRC/RELEASE.json")"
COMMIT="$(field commit "$SRC/RELEASE.json")"
PREFIX="${AI_SPACE_PREFIX:-$HOME/.local/share/ai-space}"
# A workspace the AI Space app installed runs the app's own service: two would fight over it.
WS="${SPACE_HOME:-$HOME/.ai-space}"
if grep -q '"managedBy": *"ai-space-local"' "$WS/installation.json" 2>/dev/null; then
  echo "$WS belongs to the AI Space app (the Local edition), which runs its own background service; nothing was changed. Use the app to run, update or remove it." >&2
  exit 1
fi
DEST="$PREFIX/releases/$VERSION"
mkdir -p "$PREFIX/releases"

# Copy the release into place unless this very build is already there.
if [ "$SRC" != "$DEST" ] && [ "$(field commit "$DEST/RELEASE.json" 2>/dev/null || true)" != "$COMMIT" ]; then
  rm -rf "$DEST.new"
  cp -a "$SRC" "$DEST.new"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
fi

PREV="$(readlink "$PREFIX/current" 2>/dev/null || true)"
# Replace the `current` link in one step. Without the flag, mv would follow the old link and move
# the new one into the release it points at: GNU spells it -T, BSD (a Mac) -h.
if mv --version >/dev/null 2>&1; then NO_FOLLOW=-T; else NO_FOLLOW=-h; fi
switch() { ln -sfn "$1" "$PREFIX/current.new" && mv -f "$NO_FOLLOW" "$PREFIX/current.new" "$PREFIX/current"; }
switch "releases/$VERSION"
echo "ai-space $VERSION ($COMMIT) in $DEST"

if BUN="$PREFIX/current/runtime/bun" bash "$PREFIX/current/deploy/install.sh"; then
  # Keep the three newest releases, and always the one that runs and the one before it.
  cd "$PREFIX/releases"
  keep="$(ls -1t | head -n3; echo "$VERSION"; if [ -n "$PREV" ]; then basename "$PREV"; fi)"
  for r in *; do
    case "$r" in *.new) continue ;; esac
    printf '%s\n' "$keep" | grep -qxF "$r" || rm -rf "$r"
  done
  exit 0
fi

echo "ai-space $VERSION did not come up" >&2
if [ -n "$PREV" ] && [ "$PREV" != "releases/$VERSION" ] && [ -d "$PREFIX/$PREV" ]; then
  echo "rolling back to $PREV" >&2
  switch "$PREV"
  BUN="$PREFIX/current/runtime/bun" bash "$PREFIX/current/deploy/install.sh" || true
  echo "rolled back to $PREV; the program changed back, the workspace data was not touched. If $VERSION migrated a database, see docs/release.md#rollback" >&2
fi
exit 1
