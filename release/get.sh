#!/usr/bin/env bash
# Install ai-space with one command (docs/release.md#one-command-install):
#
#   curl -fsSL https://ai-space.me/install.sh | bash
#
# That address sends curl to this file as the latest GitHub Release carries it (`install.sh`). It
# picks the Server archive for this machine from the same release, checks it against the release's
# SHA256SUMS, unpacks it and runs the archive's own install.sh: the program under
# ~/.local/share/ai-space, the workspace ~/.ai-space, a systemd user unit on 127.0.0.1:8700. It asks
# nothing, needs no sudo, Bun, git or account; then the panel opens in a browser. One agent CLI
# signed in on this machine (Claude Code, Codex or DeepSeek Harness) is what ai-space needs to work,
# and it never installs one for you.
#
# Settings, all optional:
#   AI_SPACE_VERSION=0.2.0     that release instead of the latest
#   AI_SPACE_PREFIX=<dir>      where the program goes (default ~/.local/share/ai-space)
#   SPACE_HOME=<dir>           where the workspace goes (default ~/.ai-space)
#   AI_SPACE_DOWNLOAD=<url>    where the release's files are (a mirror, or file:// for tests)
#   AI_SPACE_NO_OPEN=1         do not open a browser at the end
set -euo pipefail

REPO="ericz-lab/ai-space"
TMP_DIR=""

say() { printf '%s\n' "$*"; }
fail() { printf 'ai-space install: %s\n' "$*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "neither sha256sum nor shasum is installed, so the download cannot be checked"
  fi
}

fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }

# The agent CLIs ai-space runs, where their installers usually put them.
find_cli() {
  local name="$1" d
  if command -v "$name" >/dev/null 2>&1; then return 0; fi
  for d in "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/.bun/bin" "$HOME/.npm-global/bin" /usr/local/bin; do
    [ -x "$d/$name" ] && return 0
  done
  return 1
}

main() {
  local os arch version base tmp line name want got dir port url
  os="$(uname -s)"
  case "$os" in
    Linux) ;;
    Darwin) fail "this installer is for Linux for now; the Mac comes with a later release (docs/release.md#one-command-install)" ;;
    *) fail "$os is not supported; ai-space runs on Linux with systemd" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "$(uname -m) is not supported; there are archives for x64 and arm64" ;;
  esac
  if [ "$(id -u)" = 0 ] && [ -z "${AI_SPACE_ALLOW_ROOT:-}" ]; then
    fail "run this as the user who will own ai-space, not as root (it installs for that user, no sudo needed)"
  fi
  for tool in curl tar; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"; done
  command -v systemctl >/dev/null 2>&1 || fail "systemd is needed: ai-space runs as a systemd user service"
  systemctl --user show-environment >/dev/null 2>&1 || fail "no systemd user manager answers (systemctl --user); log in as this user directly, or on WSL turn systemd on"

  version="${AI_SPACE_VERSION:-latest}"
  version="${version#v}"
  if [ -n "${AI_SPACE_DOWNLOAD:-}" ]; then base="${AI_SPACE_DOWNLOAD%/}"
  elif [ "$version" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
  else base="https://github.com/$REPO/releases/download/v$version"
  fi

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-space-install.XXXXXX")"
  trap 'rm -rf "$TMP_DIR"' EXIT
  tmp="$TMP_DIR"

  say "ai-space: looking for the $( [ "$version" = latest ] && echo "latest release" || echo "release $version" ) for linux-$arch"
  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
  if [ "$version" = latest ]; then
    line="$(grep -E "  ai-space-server-[0-9][^ ]*-linux-$arch\.tar\.gz\$" "$tmp/SHA256SUMS" | head -n1 || true)"
  else
    line="$(grep -E "  ai-space-server-${version//./\\.}-linux-$arch\.tar\.gz\$" "$tmp/SHA256SUMS" | head -n1 || true)"
  fi
  [ -n "$line" ] || fail "the release has no Server archive for linux-$arch"
  want="${line%% *}"
  name="${line##* }"

  say "ai-space: downloading $name"
  fetch "$base/$name" "$tmp/$name" || fail "could not download $base/$name"
  got="$(sha256_of "$tmp/$name")"
  [ "$got" = "$want" ] || fail "$name does not match the release's SHA256SUMS (expected $want, got $got); nothing was installed"

  tar -xzf "$tmp/$name" -C "$tmp"
  dir="$tmp/${name%.tar.gz}"
  [ -f "$dir/install.sh" ] && [ -f "$dir/RELEASE.json" ] || fail "$name is not an ai-space Server archive"
  bash "$dir/install.sh"

  port="${SPACE_PORT:-}"
  if [ -z "$port" ]; then
    local env_file="${SPACE_HOME:-$HOME/.ai-space}/.env"
    [ -f "$env_file" ] && port="$(sed -n 's/^SPACE_PORT=//p' "$env_file" | head -n1 | tr -d "\"' \r")"
  fi
  url="http://127.0.0.1:${port:-8700}/"

  say ""
  say "ai-space is running. Open the panel: $url"
  if ! find_cli claude && ! find_cli codex && ! find_cli dsh; then
    say ""
    say "No agent CLI found yet. ai-space works through one you sign in to on this machine, for example:"
    say "  Claude Code:  curl -fsSL https://claude.ai/install.sh | bash   then run: claude"
    say "  Codex:        install the Codex CLI, then run: codex login"
    say "The panel finds it once it is installed (Settings, Models)."
  fi
  if [ -n "${SSH_CONNECTION:-}" ]; then
    say ""
    say "You are on SSH: the panel listens on this machine's loopback. From your own computer:"
    say "  ssh -L ${port:-8700}:127.0.0.1:${port:-8700} ${USER:-$(id -un)}@<this machine>   then open $url"
  elif [ -z "${AI_SPACE_NO_OPEN:-}" ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; } && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

# All of it in one function, so a download cut short runs nothing.
main "$@"
