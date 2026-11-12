#!/bin/sh
# Runs AISpaceTests in the iOS Simulator with Xcode: the whole suite, including the tests behind
# `#if canImport(UIKit)` (web sessions, the cookie store, the icon cache, the share editor and its
# shared Keychain) that scripts/test.sh cannot build on the Mac. Needs Xcode and an iPhone
# simulator; IOS_SIMULATOR picks one by name or UDID, otherwise the first available iPhone is used.
# Arguments go to xcodebuild, e.g. `-only-testing:AISpaceTests/WebCookieSessionTests`.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the iOS client's tests run on macOS only" >&2; exit 1; }
xcodebuild -version >/dev/null 2>&1 || { echo "xcodebuild not found: the Simulator tests need Xcode" >&2; exit 1; }

# The project compiles SwiftTerm from the sources this fetches (`bun run ios:xcode` does the same).
. scripts/swiftterm.sh
swiftterm_fetch

SIM=${IOS_SIMULATOR:-$(xcrun simctl list devices available | sed -n 's/^ *\(iPhone[^(]*\) (\([0-9A-F-]\{36\}\)).*/\2/p' | head -n 1)}
[ -n "$SIM" ] || { echo "no available iPhone simulator; create one in Xcode or set IOS_SIMULATOR" >&2; exit 1; }
case "$SIM" in
  *-*-*-*-*) DEST="platform=iOS Simulator,id=$SIM" ;;
  *) DEST="platform=iOS Simulator,name=$SIM" ;;
esac

exec xcodebuild test -project AISpace.xcodeproj -scheme AISpace -destination "$DEST" \
  -derivedDataPath build/sim -quiet "$@"
