#!/usr/bin/env bash
# Install (or refresh) ai-space as a user-level systemd service on this machine.
# Run from the checkout: bash deploy/install.sh. A release archive runs it through its own
# install.sh (release/install.sh), with BUN set to the Bun inside the release.
# Idempotent: creates the workspace, installs the unit, enables linger, restarts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || { echo "bun not found at $BUN (curl -fsSL https://bun.sh/install | bash)"; exit 1; }

UNIT=~/.config/systemd/user/ai-space.service

# The workspace: SPACE_HOME when set, else the one the installed unit already uses
# (a git-push deploy runs without the operator's environment), else ~/.ai-space.
# Made absolute, because the unit gets it verbatim.
if [ -z "${SPACE_HOME:-}" ] && [ -f "$UNIT" ]; then
  SPACE_HOME="$(sed -n 's|^Environment=SPACE_HOME=||p' "$UNIT" | head -n1)"
  SPACE_HOME="${SPACE_HOME/#%h/$HOME}"
fi
SPACE_HOME="${SPACE_HOME:-$HOME/.ai-space}"
SPACE_HOME="${SPACE_HOME/#\~/$HOME}"
mkdir -p "$SPACE_HOME"
SPACE_HOME="$(cd "$SPACE_HOME" && pwd)"
export SPACE_HOME

cd "$HERE"
# A release (RELEASE.json) ships its dependencies; a checkout installs them from the lockfile.
[ -f "$HERE/RELEASE.json" ] || "$BUN" install --frozen-lockfile
"$BUN" src/index.ts init

# The `space` command on PATH (~/.local/bin is on the unit's and the profile's PATH; docs/cli.md).
mkdir -p ~/.local/bin && ln -sfn "$HERE/bin/space" ~/.local/bin/space
# A release brings its own Bun; on a machine with none, the apps and the shell find it there too.
if [ -f "$HERE/RELEASE.json" ] && ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  ln -sfn "$BUN" ~/.local/bin/bun
fi

mkdir -p ~/.config/systemd/user
# The unit's PATH starts with the directory of this Bun, so the apps' services (which inherit
# it) find the same one; for the usual ~/.bun/bin it is already there.
BUN_DIR="$(dirname "$BUN")"
PATH_FIX=""
[ "$BUN_DIR" = "$HOME/.bun/bin" ] || PATH_FIX="s|^Environment=PATH=|Environment=PATH=$BUN_DIR:|;"
sed "s|%h/.ai-space/core|$HERE|; s|^Environment=SPACE_HOME=.*|Environment=SPACE_HOME=$SPACE_HOME|; s|%h/.bun/bin/bun|$BUN|; $PATH_FIX" deploy/ai-space.service > "$UNIT"
loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now ai-space
systemctl --user restart ai-space
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS "http://127.0.0.1:${SPACE_PORT:-8700}/healthz"; then
    echo
    # The default apps' own installers, now that ai-space has written their space.env.
    "$BUN" src/index.ts install-defaults
    grep -qE '^SPACE_API_TOKEN=.+' "$SPACE_HOME/.env" || echo "next: $BUN src/index.ts setup   (fills $SPACE_HOME/.env interactively; see docs/install.md)"
    exit 0
  fi
done
systemctl --user --no-pager --lines=10 status ai-space || true
echo "ai-space is not answering on 127.0.0.1:${SPACE_PORT:-8700}; see: journalctl --user -u ai-space -n 50" >&2
exit 1
