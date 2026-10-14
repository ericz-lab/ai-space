#!/bin/sh
# SwiftTerm, the terminal emulator behind the Terminal page: its sources at the pinned release, in
# build/deps/SwiftTerm, for both builds. project.yml compiles them as a static library target, so
# `bun run ios:xcode` runs this first; build.sh sources it and compiles them with swiftc.
#
# It is compiled from source and not taken as a Swift package because the package brings two things
# a build must then have: a build-tool plugin to trust, and a Metal shader, which needs the Metal
# toolchain (a separate Xcode download, absent from the Command Line Tools). The app needs neither:
# the plugin only writes the file written below, and SwiftTerm draws with Core Graphics unless it
# is asked for Metal, which the app never does.
SWIFTTERM_VERSION=1.20.0
SWIFTTERM_COMMIT=5d14406844143538cd8f8851d2d8a67c1fe443e5
SWIFTTERM_URL=https://github.com/migueldeicaza/SwiftTerm.git
SWIFTTERM_SRC=build/deps/SwiftTerm

swiftterm_fetch() {
  [ "$(git -C "$SWIFTTERM_SRC" rev-parse HEAD 2>/dev/null)" = "$SWIFTTERM_COMMIT" ] && [ -f "$SWIFTTERM_SRC/Sources/SwiftTerm/SwiftTermBuildInfo.swift" ] && return 0
  echo "fetching SwiftTerm $SWIFTTERM_VERSION"
  rm -rf "$SWIFTTERM_SRC"
  mkdir -p build/deps
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "v$SWIFTTERM_VERSION" "$SWIFTTERM_URL" "$SWIFTTERM_SRC"
  # A tag can be moved; the commit cannot.
  [ "$(git -C "$SWIFTTERM_SRC" rev-parse HEAD)" = "$SWIFTTERM_COMMIT" ] || {
    echo "SwiftTerm v$SWIFTTERM_VERSION is not at $SWIFTTERM_COMMIT; check the release and update scripts/swiftterm.sh" >&2
    rm -rf "$SWIFTTERM_SRC"
    return 1
  }
  cat > "$SWIFTTERM_SRC/Sources/SwiftTerm/SwiftTermBuildInfo.swift" <<INFO
// Written by scripts/swiftterm.sh in place of the package's build-info plugin.
public enum SwiftTermBuildInfo {
    public static let branch: String? = nil
    public static let tag: String? = "v$SWIFTTERM_VERSION"
    public static let commit: String? = "$SWIFTTERM_COMMIT"
    public static let hasUncommittedChanges: Bool? = false
    public static let version: String = "v$SWIFTTERM_VERSION"
}
INFO
}

# For build.sh, which has set SDK and IOS: the module and object for Mac Catalyst in SWIFTTERM_DIR,
# compiled once and again when the release or the compiler changes.
swiftterm_build() {
  SWIFTTERM_DIR=build/deps/SwiftTerm-macabi-$(uname -m)
  SWIFTTERM_STAMP="$SWIFTTERM_COMMIT $(xcrun swiftc --version 2>&1 | head -1)"
  [ "$(cat "$SWIFTTERM_DIR/stamp" 2>/dev/null)" = "$SWIFTTERM_STAMP" ] && return 0
  echo "building SwiftTerm $SWIFTTERM_VERSION (once)"
  rm -rf "$SWIFTTERM_DIR"
  mkdir -p "$SWIFTTERM_DIR"
  # shellcheck disable=SC2046
  xcrun swiftc -O -wmo -parse-as-library -swift-version 5 -module-name SwiftTerm -suppress-warnings \
    -target "$(uname -m)-apple-ios17.0-macabi" -sdk "$SDK" \
    -Fsystem "$IOS/System/Library/Frameworks" -I "$IOS/usr/lib/swift" \
    -emit-module -emit-module-path "$SWIFTTERM_DIR/SwiftTerm.swiftmodule" -emit-object -o "$SWIFTTERM_DIR/SwiftTerm.o" \
    $(find "$SWIFTTERM_SRC/Sources/SwiftTerm" -name '*.swift' | sort) || return 1
  echo "$SWIFTTERM_STAMP" > "$SWIFTTERM_DIR/stamp"
}

# Run on its own, it fetches: what the Xcode project needs before it is generated or built.
case "$0" in
  *swiftterm.sh)
    set -eu
    cd "$(dirname "$0")/.."
    swiftterm_fetch
    ;;
esac
