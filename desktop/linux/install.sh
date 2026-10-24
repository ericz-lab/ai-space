#!/bin/sh
# Installs AI Space for Linux for this user, from the directory this script is in:
#   ~/.local/share/ai-space/app        the app (replaced on every install)
#   ~/.local/bin/ai-space              the launcher
#   ~/.local/share/applications        the desktop entry (and the aispace:// handler)
#   ~/.local/share/icons, metainfo     the icon and AppStream metadata
# `install.sh --uninstall` removes those. Neither touches a Space's workspace or the Local
# edition's background service: remove that first in Settings › This Computer.
# `install.sh --apparmor` (with sudo) adds an AppArmor profile that lets this app, and only it,
# use the user namespaces WebKit's sandbox needs where the system restricts them (Ubuntu 23.10+).
set -eu

APP_ID=dev.ai_space.Desktop
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DEST="$DATA/ai-space/app"
BIN="$HOME/.local/bin"
here=$(cd "$(dirname "$0")" && pwd)

uninstall() {
  rm -rf "$DEST"
  [ -f /etc/apparmor.d/ai-space ] && echo "The AppArmor profile stays; remove it with: sudo rm /etc/apparmor.d/ai-space && sudo apparmor_parser -R ai-space" || true
  rm -f "$BIN/ai-space" "$DATA/applications/$APP_ID.desktop" "$DATA/icons/hicolor/scalable/apps/$APP_ID.svg" "$DATA/metainfo/$APP_ID.metainfo.xml"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" || true
  echo "AI Space removed. Your Spaces, settings and the app's web data stay in ~/.config/ai-space and $DATA/ai-space/desktop."
}

# The profile names the app's own copy of gjs, as Ubuntu's profile for Epiphany names it.
apparmor() {
  [ -x "$DEST/bin/ai-space-gjs" ] || { echo "install.sh: install the app first" >&2; exit 1; }
  profile=$(mktemp)
  cat >"$profile" <<PROFILE
# AI Space for Linux ($DEST): allows everything, as an unconfined process, plus the user
# namespaces WebKit's bubblewrap sandbox needs. Written by install.sh --apparmor.
abi <abi/4.0>,
include <tunables/global>

profile ai-space "$DEST/bin/ai-space-gjs" flags=(unconfined) {
  userns,

  include if exists <local/ai-space>
}
PROFILE
  sudo install -m 0644 "$profile" /etc/apparmor.d/ai-space
  rm -f "$profile"
  sudo apparmor_parser -r /etc/apparmor.d/ai-space
  echo "AppArmor profile installed: WebKit's sandbox is on the next time AI Space starts."
}

case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
  --apparmor) apparmor; exit 0 ;;
esac

[ -f "$here/main.js" ] || { echo "install.sh: run it from a built app directory (bun desktop/linux/build.ts)" >&2; exit 1; }

missing=""
command -v gjs >/dev/null 2>&1 || missing="$missing gjs"
for lib in Adw-1 WebKit-6.0 Soup-3.0 Secret-1; do
  found=""
  for d in /usr/lib/*/girepository-1.0 /usr/lib64/girepository-1.0 /usr/lib/girepository-1.0; do
    [ -f "$d/$lib.typelib" ] && found=1 && break
  done
  [ -n "$found" ] || missing="$missing $lib"
done
if [ -n "$missing" ]; then
  echo "AI Space needs:$missing" >&2
  echo "  Debian/Ubuntu: sudo apt install gjs gir1.2-adw-1 gir1.2-webkit-6.0 gir1.2-soup-3.0 gir1.2-secret-1" >&2
  echo "  Fedora:        sudo dnf install gjs libadwaita webkitgtk6.0 libsoup3 libsecret" >&2
  echo "  Arch:          sudo pacman -S gjs libadwaita webkitgtk-6.0 libsoup3 libsecret" >&2
  exit 1
fi

if [ "$here" != "$DEST" ]; then
  rm -rf "$DEST.new"
  mkdir -p "$(dirname "$DEST")"
  cp -a "$here" "$DEST.new"
  rm -rf "$DEST"
  mv "$DEST.new" "$DEST"
fi

# A copy of the system's gjs, so an AppArmor profile can name this app alone (see --apparmor).
cp "$(readlink -f "$(command -v gjs)")" "$DEST/bin/ai-space-gjs"

mkdir -p "$BIN" "$DATA/applications" "$DATA/icons/hicolor/scalable/apps" "$DATA/metainfo"
ln -sfn "$DEST/bin/ai-space" "$BIN/ai-space"
sed "s|@EXEC@|$BIN/ai-space|g" "$DEST/share/$APP_ID.desktop" >"$DATA/applications/$APP_ID.desktop"
cp "$DEST/data/icons/hicolor/scalable/apps/$APP_ID.svg" "$DATA/icons/hicolor/scalable/apps/"
cp "$DEST/share/$APP_ID.metainfo.xml" "$DATA/metainfo/"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true
command -v xdg-mime >/dev/null 2>&1 && xdg-mime default "$APP_ID.desktop" x-scheme-handler/aispace || true

edition=$(sed -n 's/.*"edition": *"\([a-z]*\)".*/\1/p' "$DEST/VERSION.json" 2>/dev/null || true)
echo "AI Space ($edition edition) installed. Open it from the app grid, or run: ai-space"
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && ! grep -qsF "$DEST/bin/ai-space-gjs" /etc/apparmor.d/ai-space; then
  echo "This system restricts user namespaces, so web pages run without WebKit's sandbox."
  echo "To turn the sandbox on: $DEST/install.sh --apparmor   (asks for your password)"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: $BIN is not on your PATH." ;; esac
