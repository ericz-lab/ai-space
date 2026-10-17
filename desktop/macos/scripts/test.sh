#!/bin/sh
# Builds and runs AISpaceTests (swift-testing) with swiftc, from the Command Line Tools or Xcode.
# The tests cover the app's Foundation-only policy code and the iPhone client's Core files the
# Mac shares (scripts/sources.sh); they compile with it into one module.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the desktop tests run on macOS only" >&2; exit 1; }
. scripts/sources.sh

DEV=$(xcode-select -p)
first() { for d in "$@"; do [ -e "$d" ] && { echo "$d"; return; }; done; }
FW=$(first "$DEV/Library/Developer/Frameworks" "$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks")
LIB=$(first "$DEV/Library/Developer/usr/lib" "$DEV/Platforms/MacOSX.platform/Developer/usr/lib")
PLUGINS=$(first "$DEV/usr/lib/swift/host/plugins/testing" "$DEV/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing")
[ -n "$FW" ] && [ -e "$FW/Testing.framework" ] || { echo "swift-testing not found under $DEV" >&2; exit 1; }

OUT=build/tests
mkdir -p "$OUT"
# shellcheck disable=SC2046
xcrun swiftc -parse-as-library -swift-version 5 -module-name AISpaceTests \
  -target "$(uname -m)-apple-macos14.0" \
  -F "$FW" -Xlinker -rpath -Xlinker "$FW" ${LIB:+-Xlinker -rpath -Xlinker "$LIB"} \
  ${PLUGINS:+-plugin-path "$PLUGINS"} \
  $(find AISpace/Services -name '*.swift' | sort) AISpace/Web/NavigationPolicy.swift $SHARED_CORE \
  $(find AISpaceTests -name '*.swift' | sort) ../../mobile/ios/AISpaceTests/SharedCaptureStoreTests.swift scripts/TestMain.swift \
  -o "$OUT/AISpaceTests"
exec "$OUT/AISpaceTests" "$@"
