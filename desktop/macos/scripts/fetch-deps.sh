#!/bin/sh
# Fetches SwiftTerm's sources into build/deps, which the Xcode project compiles as a library
# (`bun run desktop:xcode` runs this first). build.sh fetches them itself.
set -eu
cd "$(dirname "$0")/.."
. ../../mobile/ios/scripts/swiftterm.sh
swiftterm_fetch
