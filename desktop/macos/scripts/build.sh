#!/bin/sh
# Builds build/AISpace.app with swiftc, which the Command Line Tools provide; Xcode is optional.
# CONFIG=debug|release (default release). SIGN_IDENTITY defaults to ad-hoc ("-"); pass a
# "Developer ID Application: ..." identity for a distributable build, then notarize it.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the desktop app builds on macOS only" >&2; exit 1; }
. scripts/sources.sh

CONFIG=${CONFIG:-release}
APP=build/AISpace.app
case "$CONFIG" in
  debug) FLAGS="-Onone -g -DDEBUG" ;;
  release) FLAGS="-O" ;;
  *) echo "CONFIG must be debug or release" >&2; exit 2 ;;
esac

# SwiftTerm, the Terminal page's emulator, at the release the iPhone client pins
# (mobile/ios/scripts/swiftterm.sh says why from source): fetched into build/deps and compiled
# for this Mac once, and again when the release or the compiler changes.
. ../../mobile/ios/scripts/swiftterm.sh
swiftterm_fetch
SWIFTTERM_DIR=build/deps/SwiftTerm-macos-$(uname -m)
SWIFTTERM_STAMP="$SWIFTTERM_COMMIT $(xcrun swiftc --version 2>&1 | head -1)"
if [ "$(cat "$SWIFTTERM_DIR/stamp" 2>/dev/null)" != "$SWIFTTERM_STAMP" ]; then
  echo "building SwiftTerm $SWIFTTERM_VERSION (once)"
  rm -rf "$SWIFTTERM_DIR"
  mkdir -p "$SWIFTTERM_DIR"
  # shellcheck disable=SC2046
  xcrun swiftc -O -wmo -parse-as-library -swift-version 5 -module-name SwiftTerm -suppress-warnings \
    -target "$(uname -m)-apple-macos14.0" \
    -emit-module -emit-module-path "$SWIFTTERM_DIR/SwiftTerm.swiftmodule" -emit-object -o "$SWIFTTERM_DIR/SwiftTerm.o" \
    $(find "$SWIFTTERM_SRC/Sources/SwiftTerm" -name '*.swift' | sort)
  echo "$SWIFTTERM_STAMP" > "$SWIFTTERM_DIR/stamp"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# shellcheck disable=SC2086
xcrun swiftc $FLAGS -parse-as-library -swift-version 5 -module-name AISpace \
  -target "$(uname -m)-apple-macos14.0" \
  -I "$SWIFTTERM_DIR" "$SWIFTTERM_DIR/SwiftTerm.o" \
  $SHARED $(find AISpace -name '*.swift' | sort) \
  -o "$APP/Contents/MacOS/AISpace"

cp AISpace/Info.plist "$APP/Contents/Info.plist"
cp AISpace/Resources/AppIcon.icns AISpace/Resources/Logo.png "$APP/Contents/Resources/"
cp -R AISpace/Resources/*.lproj "$APP/Contents/Resources/"

# The hardened runtime refuses the microphone unless the entitlement asks for it, so voice input
# in a page would fail without a word (AISpace.entitlements).
codesign --force --options runtime --timestamp=none --entitlements AISpace/AISpace.entitlements --sign "${SIGN_IDENTITY:--}" "$APP"
echo "built $(pwd)/$APP ($CONFIG)"
