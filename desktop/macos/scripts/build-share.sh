#!/bin/sh
# Build the signed Mac app with its image Share extension; requires Xcode and a development team.
set -eu
cd "$(dirname "$0")/../../.."
: "${DEVELOPMENT_TEAM:?Set DEVELOPMENT_TEAM to the Apple team used for both app and extension}"
bun run desktop:xcode
xcodebuild -project desktop/macos/AISpace.xcodeproj -scheme AISpace -configuration Release \
  -destination 'generic/platform=macOS' -derivedDataPath desktop/macos/build/share \
  "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM" -allowProvisioningUpdates build
