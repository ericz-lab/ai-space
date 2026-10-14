#!/bin/sh
# Builds the client as a Mac Catalyst app with swiftc: the same Swift sources and the same UIKit
# and SwiftUI code paths as the iPhone build, run on this Mac. The Command Line Tools are enough,
# because the macOS SDK carries the iOS frameworks for Catalyst; they carry no iOS SDK and no
# Simulator, so the iPhone build itself needs Xcode (see README.md: `xcodebuild`).
# CONFIG=debug|release (default debug: the launch switches in DebugLaunch.swift are debug only).
set -eu
cd "$(dirname "$0")/.."

[ "$(uname -s)" = Darwin ] || { echo "the iOS client builds on macOS only" >&2; exit 1; }
. scripts/sources.sh

CONFIG=${CONFIG:-debug}
APP=build/AISpace.app
case "$CONFIG" in
  debug) FLAGS="-Onone -g -DDEBUG" ;;
  release) FLAGS="-O -Xlinker -dead_strip" ;;
  *) echo "CONFIG must be debug or release" >&2; exit 2 ;;
esac

SDK=$(xcrun --sdk macosx --show-sdk-path)
IOS="$SDK/System/iOSSupport"
[ -d "$IOS/System/Library/Frameworks/UIKit.framework" ] || { echo "this macOS SDK has no Mac Catalyst support" >&2; exit 1; }

. scripts/swiftterm.sh
swiftterm_fetch
swiftterm_build

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# shellcheck disable=SC2046,SC2086
xcrun swiftc $FLAGS -parse-as-library -swift-version 5 -module-name AISpace \
  -target "$(uname -m)-apple-ios17.0-macabi" -sdk "$SDK" \
  -Fsystem "$IOS/System/Library/Frameworks" -I "$IOS/usr/lib/swift" -L "$IOS/usr/lib/swift" -L "$IOS/usr/lib" \
  -I "$SWIFTTERM_DIR" "$SWIFTTERM_DIR/SwiftTerm.o" \
  $SHARED $(find AISpace -name '*.swift' | sort) \
  -o "$APP/Contents/MacOS/AISpace"

# The Info.plist is Xcode's, with build settings in it; fill them in and add what a Mac bundle needs.
sed -e 's/$(EXECUTABLE_NAME)/AISpace/' -e 's/$(PRODUCT_BUNDLE_IDENTIFIER)/dev.ai-space.ios/' \
    -e 's/$(MARKETING_VERSION)/0.1.0/' -e 's/$(CURRENT_PROJECT_VERSION)/1/' AISpace/Info.plist > "$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
$PB -c "Delete :LSRequiresIPhoneOS" "$APP/Contents/Info.plist"
$PB -c "Add :LSMinimumSystemVersion string 14.0" "$APP/Contents/Info.plist"
$PB -c "Add :UIDeviceFamily array" -c "Add :UIDeviceFamily:0 integer 2" "$APP/Contents/Info.plist"
$PB -c "Add :CFBundleSupportedPlatforms array" -c "Add :CFBundleSupportedPlatforms:0 string MacOSX" "$APP/Contents/Info.plist"
$PB -c "Add :NSHighResolutionCapable bool true" "$APP/Contents/Info.plist"
# The Mac client owns aispace:// on a Mac; this build must not take its links.
$PB -c "Delete :CFBundleURLTypes" "$APP/Contents/Info.plist"

cp AISpace/Resources/Logo.png "$APP/Contents/Resources/"
cp -R AISpace/Resources/*.lproj "$APP/Contents/Resources/"

codesign --force --timestamp=none --sign - "$APP"
echo "built $(pwd)/$APP ($CONFIG, Mac Catalyst)"
