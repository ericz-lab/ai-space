#!/bin/sh
# AI Space for Linux (installed as bin/ai-space): runs the app with GJS (GTK 4, libadwaita,
# WebKitGTK 6.0).
here=$(dirname "$(readlink -f "$0")")
export AISPACE_LAUNCHER="${AISPACE_LAUNCHER:-$(readlink -f "$0")}"
# install.sh copies the system's gjs here so an AppArmor profile can name this app alone.
gjs="$here/ai-space-gjs"
[ -x "$gjs" ] || gjs=$(command -v gjs || true)
if [ -z "$gjs" ]; then
  echo "ai-space: gjs is missing; install gjs, libadwaita, WebKitGTK 6.0 and libsecret (see docs/linux-desktop.md)" >&2
  exit 1
fi
# WebKit sandboxes its web processes with bubblewrap, which needs user namespaces. Where the
# system restricts them (Ubuntu 23.10 and later) and no AppArmor profile allows this app
# (install.sh --apparmor), the pages run without that sandbox rather than not at all.
if [ -z "${WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS:-}" ]; then
  restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
  nosandbox=""
  if [ "$restricted" = 1 ]; then
    [ "$gjs" = "$here/ai-space-gjs" ] && grep -qsF "$gjs" /etc/apparmor.d/ai-space || nosandbox=1
  elif command -v unshare >/dev/null 2>&1 && ! unshare --user --map-root-user true 2>/dev/null; then
    nosandbox=1
  fi
  if [ -n "$nosandbox" ]; then
    export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 AISPACE_WEB_SANDBOX=off
  fi
fi
exec "$gjs" -m "$here/../main.js" "$@"
