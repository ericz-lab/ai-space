#!/bin/sh
# Builds and runs AISpaceTests (swift-testing) with swiftc for this Mac, from the Command Line
# Tools or Xcode. The tests cover the Foundation-only code in AISpace/Core and the files shared
# with the Mac client; none of it needs an iOS SDK or a simulator.
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the iOS client's tests run on macOS only" >&2; exit 1; }
. scripts/sources.sh

DEV=$(xcode-select -p)
first() { for d in "$@"; do [ -e "$d" ] && { echo "$d"; return; }; done; }
FW=$(first "$DEV/Library/Developer/Frameworks" "$DEV/Platforms/MacOSX.platform/Developer/Library/Frameworks")
LIB=$(first "$DEV/Library/Developer/usr/lib" "$DEV/Platforms/MacOSX.platform/Developer/usr/lib")
PLUGINS=$(first "$DEV/usr/lib/swift/host/plugins/testing" "$DEV/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing")
[ -n "$FW" ] && [ -e "$FW/Testing.framework" ] || { echo "swift-testing not found under $DEV" >&2; exit 1; }

OUT=build/tests
mkdir -p "$OUT"
# shellcheck disable=SC2046,SC2086
xcrun --sdk macosx swiftc -parse-as-library -swift-version 5 -module-name AISpaceTests \
  -target "$(uname -m)-apple-macos14.0" \
  -F "$FW" -Xlinker -rpath -Xlinker "$FW" ${LIB:+-Xlinker -rpath -Xlinker "$LIB"} \
  ${PLUGINS:+-plugin-path "$PLUGINS"} \
  $SHARED $(find AISpace/Core -name '*.swift' | sort) \
  $(find AISpaceTests -name '*.swift' | sort) scripts/TestMain.swift \
  -o "$OUT/AISpaceTests"
exec "$OUT/AISpaceTests" "$@"
