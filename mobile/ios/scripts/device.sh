#!/usr/bin/env bash
# Build AISpace for a connected iPhone, renew its development profile, and install it over the
# copy already on the phone (same bundle id and team, so the app's data is kept).
#
#   bun run ios:device                           # first paired iPhone, first team signed in to Xcode
#   AISPACE_TEAM=XXXXXXXXXX AISPACE_DEVICE=<udid> AISPACE_NO_LAUNCH=1 bun run ios:device
#
# A free (Personal Team) profile lasts 7 days; running this again before then re-signs the app
# without removing it, so it can run daily from launchd (README.md). The phone must be paired and
# reachable by cable or Wi-Fi.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
team="${AISPACE_TEAM:-$(defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null \
  | sed -n 's/.*teamID = \([A-Z0-9]*\);.*/\1/p' | head -n 1)}"
[[ -n "$team" ]] || { echo "no team: sign in to Xcode (Settings > Accounts) or set AISPACE_TEAM" >&2; exit 1; }
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

device="${AISPACE_DEVICE:-}"
if [[ -z "$device" ]]; then
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null
  device="$(/usr/bin/python3 -I -c '
import json, sys
for d in json.load(open(sys.argv[1]))["result"]["devices"]:
    hp = d.get("hardwareProperties", {})
    cp = d.get("connectionProperties", {})
    if hp.get("platform") == "iOS" and hp.get("reality") == "physical" \
       and cp.get("pairingState") == "paired" and cp.get("tunnelState") != "unavailable":
        print(hp["udid"]); break
' "$json")"
  rm -f "$json"
fi
[[ -n "$device" ]] || { echo "no paired iPhone reachable: connect it by cable or on the same Wi-Fi" >&2; exit 1; }

# Xcode keeps a cached profile until it has expired; drop ours two days early so the next build
# fetches a fresh one before the app on the phone stops opening.
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
soon=$(( $(date +%s) + 2 * 86400 ))
for p in "$profiles"/*.mobileprovision; do
  [[ -e "$p" ]] || continue
  plist="$(security cms -D -i "$p" 2>/dev/null)" || continue
  appid="$(plutil -extract Entitlements.application-identifier raw -o - - <<<"$plist" 2>/dev/null || true)"
  [[ "$appid" == "$team.dev.ai-space.ios" || "$appid" == "$team.dev.ai-space.ios.share" ]] || continue
  exp="$(plutil -extract ExpirationDate raw -o - - <<<"$plist")"
  (( $(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$exp" +%s) < soon )) && rm -f "$p" && echo "renewing $appid (expires $exp)"
done

"$here/scripts/swiftterm.sh"

derived="$here/build/device"
xcodebuild -project "$here/AISpace.xcodeproj" -scheme AISpace -configuration Debug \
  -destination "id=$device" -derivedDataPath "$derived" \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$team" CODE_SIGN_STYLE=Automatic \
  build -quiet

app="$derived/Build/Products/Debug-iphoneos/AISpace.app"
xcrun devicectl device install app --device "$device" "$app"
[[ -n "${AISPACE_NO_LAUNCH:-}" ]] || xcrun devicectl device process launch --device "$device" dev.ai-space.ios || true

profile="$app/embedded.mobileprovision"
expires="$(security cms -D -i "$profile" 2>/dev/null | plutil -extract ExpirationDate raw -o - - 2>/dev/null || true)"
echo "installed on $device; profile expires ${expires:-unknown}"
