#!/bin/sh
# The Foundation-only code the phone shares with the Mac client, compiled from where it lives
# (desktop/macos/AISpace); project.yml lists the same files. Sourced by build.sh and test.sh.
SHARED_DIR=../../desktop/macos/AISpace
SHARED="$SHARED_DIR/Services/Connection.swift $SHARED_DIR/Services/ConnectionStore.swift \
$SHARED_DIR/Services/SpaceCheck.swift $SHARED_DIR/Services/SpaceAPI.swift $SHARED_DIR/Services/SpaceModels.swift \
$SHARED_DIR/Services/OmniboxRules.swift $SHARED_DIR/Services/ChatImage.swift $SHARED_DIR/Services/ChatMarkdown.swift $SHARED_DIR/Services/ChatStream.swift $SHARED_DIR/Services/DesktopRules.swift $SHARED_DIR/Web/NavigationPolicy.swift $SHARED_DIR/Web/WebCookieSession.swift \
$SHARED_DIR/Services/PetRules.swift"
# The desk pet's sheet, the panel's own (src/web/public), copied into the app by build.sh.
PET_SHEET=../../src/web/public/pet-claude.webp
