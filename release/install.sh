#!/usr/bin/env bash
# Install or upgrade the AI Space Server edition from an unpacked release archive (docs/release.md):
#
#   tar -xzf ai-space-server-<version>-linux-<arch>.tar.gz
#   bash ai-space-server-<version>-linux-<arch>/install.sh
#
# The program goes to $AI_SPACE_PREFIX (default ~/.local/share/ai-space) as releases/<version>,
# with `current` pointing at the one that runs; the workspace (SPACE_HOME, default ~/.ai-space)
# with apps, databases and .env is never touched. deploy/install.sh then (re)writes the user unit
# to run from `current`, restarts it and waits for the health check. If that fails, `current`
# goes back to the previous release and its installer runs again. The last three releases stay
# for a manual rollback: ln -sfn releases/<version> current && bash current/deploy/install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SRC/RELEASE.json" ] || { echo "run this from an unpacked ai-space release (RELEASE.json missing)" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "the Server edition installs as a systemd user unit; Linux only for now" >&2; exit 1; }
field() { sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$2" | head -n1; }
VERSION="$(field version "$SRC/RELEASE.json")"
COMMIT="$(field commit "$SRC/RELEASE.json")"
PREFIX="${AI_SPACE_PREFIX:-$HOME/.local/share/ai-space}"
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
switch() { ln -sfn "$1" "$PREFIX/current.new" && mv -T "$PREFIX/current.new" "$PREFIX/current"; }
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
