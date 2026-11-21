#!/usr/bin/env bash
# Install (or refresh) ai-space as a background service of this user: a systemd user unit on
# Linux, a LaunchAgent on a Mac (`space service install`, src/space/service.ts).
# Run from the checkout: bash deploy/install.sh. A release archive runs it through its own
# install.sh (release/install.sh), with BUN set to the Bun inside the release.
# Idempotent: creates the workspace, writes the unit, restarts, waits for the health check.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BUN="${BUN:-$HOME/.bun/bin/bun}"
[ -x "$BUN" ] || { echo "bun not found at $BUN (curl -fsSL https://bun.sh/install | bash)"; exit 1; }
export BUN

cd "$HERE"
# A release (RELEASE.json) ships its dependencies; a checkout installs them from the lockfile.
[ -f "$HERE/RELEASE.json" ] || "$BUN" install --frozen-lockfile

# The workspace: SPACE_HOME when set, else the one the installed unit already uses
# (a git-push deploy runs without the operator's environment), else ~/.ai-space.
# Made absolute, because the unit gets it verbatim.
SPACE_HOME="$("$BUN" src/index.ts service workspace)"
mkdir -p "$SPACE_HOME"
SPACE_HOME="$(cd "$SPACE_HOME" && pwd)"
export SPACE_HOME
# A workspace the AI Space app installed runs the app's own service: two would fight over it.
if grep -q '"managedBy": *"ai-space-local"' "$SPACE_HOME/installation.json" 2>/dev/null; then
  echo "$SPACE_HOME belongs to the AI Space app (the Local edition), which runs its own background service; nothing was changed. Use the app to run, update or remove it." >&2
  exit 1
fi
# The health check below asks the port the service listens on, which `setup` keeps in the workspace's .env.
if [ -z "${SPACE_PORT:-}" ] && [ -f "$SPACE_HOME/.env" ]; then
  SPACE_PORT="$(sed -n 's/^SPACE_PORT=//p' "$SPACE_HOME/.env" | head -n 1 | tr -d "\"' \r")"
fi

"$BUN" src/index.ts init

# The `space` command on PATH (~/.local/bin is on the unit's and the profile's PATH; docs/cli.md).
mkdir -p ~/.local/bin && ln -sfn "$HERE/bin/space" ~/.local/bin/space
# A release brings its own Bun; on a machine with none, the apps and the shell find it there too.
if [ -f "$HERE/RELEASE.json" ] && ! command -v bun >/dev/null && [ ! -x "$HOME/.bun/bin/bun" ]; then
  ln -sfn "$BUN" ~/.local/bin/bun
fi

# The unit for this checkout, workspace and Bun, written and (re)started by the service manager
# of this system. Its PATH starts with the directory of this Bun, so the apps' services (which
# inherit it) find the same one.
"$BUN" src/index.ts service install --root "$HERE" --bun "$BUN"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 2
  if curl -fsS "http://127.0.0.1:${SPACE_PORT:-8700}/healthz"; then
    echo
    echo "ai-space core: installed, answering on 127.0.0.1:${SPACE_PORT:-8700} (workspace $SPACE_HOME)"
    # The default apps' own installers, now that ai-space has written their space.env. Their
    # failure is theirs: the core is installed either way, and the step can be run again.
    if ! "$BUN" src/index.ts install-defaults; then
      echo "default apps: an installer failed (the core is fine); retry with: $BUN src/index.ts install-defaults" >&2
    fi
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) echo "the space command is $HOME/.local/bin/space; that directory is not on your PATH yet: export PATH=\"\$HOME/.local/bin:\$PATH\" (in your shell profile)" ;;
    esac
    if [ -f "$HERE/RELEASE.json" ]; then
      # A release: the panel is the next step; `space setup` stays for the optional settings.
      grep -qE '^SPACE_API_TOKEN=.+' "$SPACE_HOME/.env" || echo "next: open http://127.0.0.1:${SPACE_PORT:-8700}/ in a browser (optional settings later: space setup)"
    else
      grep -qE '^SPACE_API_TOKEN=.+' "$SPACE_HOME/.env" || echo "next: $BUN src/index.ts setup   (the basic configuration; GitHub, outside access, backups, notifications and peers are optional, later: space setup <name>)"
    fi
    exit 0
  fi
done
"$BUN" src/index.ts service status >&2 || true
echo "ai-space is not answering on 127.0.0.1:${SPACE_PORT:-8700}; its log is named above (space logs space needs it running)" >&2
exit 1
