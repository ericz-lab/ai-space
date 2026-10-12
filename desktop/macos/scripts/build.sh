#!/bin/sh
# Builds build/AISpace.app with swiftc, which the Command Line Tools provide; Xcode is optional.
# CONFIG=debug|release (default release). SIGN_IDENTITY defaults to ad-hoc ("-"); pass a
# "Developer ID Application: ..." identity for a distributable build, then notarize it.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the desktop app builds on macOS only" >&2; exit 1; }

CONFIG=${CONFIG:-release}
APP=build/AISpace.app
case "$CONFIG" in
  debug) FLAGS="-Onone -g -DDEBUG" ;;
  release) FLAGS="-O" ;;
  *) echo "CONFIG must be debug or release" >&2; exit 2 ;;
esac

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# shellcheck disable=SC2086
xcrun swiftc $FLAGS -parse-as-library -swift-version 5 -module-name AISpace \
  -target "$(uname -m)-apple-macos14.0" \
  $(find AISpace -name '*.swift' | sort) \
  -o "$APP/Contents/MacOS/AISpace"

cp AISpace/Info.plist "$APP/Contents/Info.plist"
cp AISpace/Resources/AppIcon.icns "$APP/Contents/Resources/"
cp -R AISpace/Resources/*.lproj "$APP/Contents/Resources/"

codesign --force --options runtime --timestamp=none --sign "${SIGN_IDENTITY:--}" "$APP"
echo "built $(pwd)/$APP ($CONFIG)"
