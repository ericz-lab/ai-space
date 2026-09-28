#!/usr/bin/env bash
# Deploy this app into an ai-space workspace on a remote host: rsync the
# checkout, install the user-level systemd unit, restart, check /healthz.
# No sudo anywhere. Bun must be installed under ~/.bun on the host.
#
#   DEPLOY_HOST=<ssh host> ./deploy.sh
#   DEPLOY_HOST=<ssh host> SPACE_HOME=/srv/space ./deploy.sh
#   DEPLOY_HOST=<ssh host> DEPLOY_PATH=.ai-space/apps/my-app SERVICE=my-app ./deploy.sh
#
# The host-side .env is never overwritten; on the first deploy it is seeded from
# the local .env. The unit is re-installed on every run, so editing
# deploy/app.service is enough.
set -euo pipefail

APP="${SERVICE:-my-app}"
DEPLOY_HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=user@host ./deploy.sh}"
[[ "$APP" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || { echo "invalid service name: $APP" >&2; exit 1; }

# Quote arguments for the remote shell; paths are resolved on the target, never
# against the developer's HOME. The target is a Linux host with bash.
remote() {
  local command
  printf -v command '%q ' "$@"
  ssh "$DEPLOY_HOST" "$command"
}
remote_home=$(remote sh -c 'printf "%s" "$HOME"')
if [ -z "${SPACE_HOME:-}" ]; then
  SPACE_HOME=$(remote sh -c 'sed -n "s|^Environment=SPACE_HOME=||p" "$HOME/.config/systemd/user/ai-space.service" 2>/dev/null | head -n1')
fi
SPACE_HOME="${SPACE_HOME:-$remote_home/.ai-space}"
absolute_remote_path() {
  local path="$1"
  path="${path/#%h/$remote_home}"
  if [ "$path" = '~' ]; then path="$remote_home"; fi
  if [[ "$path" == '~/'* ]]; then path="$remote_home/${path:2}"; fi
  [[ "$path" = /* ]] || path="$remote_home/$path"
  printf '%s' "$path"
}
SPACE_HOME=$(absolute_remote_path "$SPACE_HOME")
DEPLOY_PATH=$(absolute_remote_path "${DEPLOY_PATH:-$SPACE_HOME/apps/$APP}")
case "$SPACE_HOME$DEPLOY_PATH" in *$'\n'*|*$'\r'*) echo "deployment paths must be single-line" >&2; exit 1;; esac
remote mkdir -p -- "$SPACE_HOME" "$DEPLOY_PATH"
SPACE_HOME=$(remote sh -c 'cd "$1" && pwd' sh "$SPACE_HOME")
DEPLOY_PATH=$(remote sh -c 'cd "$1" && pwd' sh "$DEPLOY_PATH")

echo "==> Syncing to ${DEPLOY_HOST}:${DEPLOY_PATH}"
sync_args=(-az --delete --exclude node_modules --exclude .env --exclude data --exclude .DS_Store)
if rsync --help | grep -q -- '--protect-args'; then
  sync_args+=(--protect-args)
  sync_path="$DEPLOY_PATH"
else
  # Older rsync (including the macOS system copy) passes paths through a shell.
  sync_path=$(printf '%q' "$DEPLOY_PATH")
fi
rsync "${sync_args[@]}" ./ "$DEPLOY_HOST:$sync_path/"

echo "==> Ensuring host .env exists"
if remote test -f "$DEPLOY_PATH/.env"; then
  echo "    host .env present, keeping it"
else
  [ -f .env ] || { echo "ERROR: no local .env to seed the host with (copy .env.example)"; exit 1; }
  scp .env "$DEPLOY_HOST:$DEPLOY_PATH/.env"
fi

echo "==> Installing dependencies"
remote sh -c 'cd "$1" && "$HOME/.bun/bin/bun" install --production' sh "$DEPLOY_PATH"

echo "==> Installing user systemd unit ${APP}.service"
# Escape for systemd quoted paths first, then for sed replacement strings.
unit_path() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g; s/[\\&|]/\\&/g'; }
sed -e "s|@DIR@|$(unit_path "$DEPLOY_PATH")|g" -e "s|@SPACE_HOME@|$(unit_path "$SPACE_HOME")|g" deploy/app.service |
  ssh "$DEPLOY_HOST" "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/${APP}.service"
ssh "$DEPLOY_HOST" "loginctl enable-linger \$(whoami) 2>/dev/null || true; systemctl --user daemon-reload && systemctl --user enable '${APP}'"

echo "==> Restarting ${APP}"
ssh "$DEPLOY_HOST" "systemctl --user restart '${APP}'"
sleep 3

echo "==> Health check"
port=$(remote sh -c 'grep -E "^PORT=" "$1/.env" | tail -1 | cut -d= -f2' sh "$DEPLOY_PATH" || true)
port="${port:-8710}"
code=$(ssh "$DEPLOY_HOST" "curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${port}/healthz'" || true)
if [ "$code" = "200" ]; then
  echo "    OK: /healthz returned 200 on port ${port}"
else
  echo "    FAILED: /healthz returned '${code}'"
  ssh "$DEPLOY_HOST" "journalctl --user -u '${APP}' -n 20 --no-pager"
  exit 1
fi

echo "==> Done. Register or re-read the manifest on the host:"
echo "    new app:      POST /api/apps/sync"
echo "    existing app: POST /api/apps/${APP}/sync"
