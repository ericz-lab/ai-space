#!/bin/sh
# The Mac downloads (docs/release.md), in a .dmg with an Applications link, under dist/ at the
# repository root:
#
#   ai-space-client-<version>-macos-<arch>.dmg            build/AISpace.app from build.sh
#   ai-space-local-<version>-macos-<arch>.dmg             EDITION=local APP=<AI Space.app> from
#                                                         release/local.ts (already signed inside)
#   ...-unsigned.dmg                                      no Developer ID given: for testing only,
#                                                         Gatekeeper blocks it for everyone else
#
# SIGN_IDENTITY   "Developer ID Application: <name> (<team>)", in a keychain codesign can reach
# APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   notarization (an app-specific password); without
#                 them a signed build is not notarized, and the script fails rather than ship it
# BUILD_NUMBER    CFBundleVersion (the CI run number)
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "the Mac client packages on macOS only" >&2; exit 1; }

ROOT=$(cd ../.. && pwd)
VERSION=$(plutil -extract CFBundleShortVersionString raw AISpace/Info.plist)
ARCH=$(uname -m)
[ "$ARCH" = x86_64 ] && ARCH=x64
SIGNED=no
[ -n "${SIGN_IDENTITY:-}" ] && [ "$SIGN_IDENTITY" != "-" ] && SIGNED=yes
if [ "$SIGNED" = yes ] && { [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ] || [ -z "${APPLE_APP_PASSWORD:-}" ]; }; then
  echo "SIGN_IDENTITY is set but APPLE_ID, APPLE_TEAM_ID or APPLE_APP_PASSWORD is not: a signed build must be notarized" >&2
  exit 1
fi

EDITION=${EDITION:-client}
case "$EDITION" in
  client) CONFIG=release ./scripts/build.sh; APP=build/AISpace.app ;;
  local)
    [ -n "${APP:-}" ] || { echo "EDITION=local needs APP=<path to AI Space.app> from release/local.ts" >&2; exit 2; }
    case "$APP" in /*) ;; *) APP="$ROOT/$APP" ;; esac
    [ -f "$APP/Contents/Resources/space/RELEASE.json" ] || { echo "$APP carries no Local release" >&2; exit 1; }
    codesign --verify --strict --deep "$APP"
    ;;
  *) echo "EDITION must be client or local" >&2; exit 2 ;;
esac

NAME="ai-space-$EDITION-$VERSION-macos-$ARCH"
[ "$SIGNED" = yes ] || NAME="$NAME-unsigned"
mkdir -p "$ROOT/dist"
DMG="$ROOT/dist/$NAME.dmg"
STAGE=build/dmg
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/AI Space.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "AI Space $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"

if [ "$SIGNED" = yes ]; then
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --timeout 30m
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose "$DMG"
fi
echo "$DMG"
