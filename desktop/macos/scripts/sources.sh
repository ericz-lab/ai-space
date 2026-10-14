#!/bin/sh
# The Foundation-only code the Mac shares with the iPhone client, compiled from where it lives
# (mobile/ios/AISpace): the catalogue, screens, widget blocks, the Space's settings and pages,
# the terminal's routes and sessions. project.yml lists the same files. Sourced by build.sh and test.sh.
IOS_DIR=../../mobile/ios/AISpace
SHARED="$IOS_DIR/Core/Catalogue.swift $IOS_DIR/Core/CatalogueCache.swift $IOS_DIR/Core/CatalogueSearch.swift \
$IOS_DIR/Core/HubModels.swift $IOS_DIR/Core/IconSource.swift $IOS_DIR/Core/Screens.swift $IOS_DIR/Core/ScreenStore.swift \
$IOS_DIR/Core/SpaceSettings.swift $IOS_DIR/Core/TerminalModels.swift $IOS_DIR/Core/WidgetBlocks.swift \
$IOS_DIR/Live/CatalogueLoader.swift $IOS_DIR/Live/SettingsLoader.swift $IOS_DIR/Live/HubStores.swift \
$IOS_DIR/Live/TerminalSession.swift $IOS_DIR/Live/TerminalStore.swift"
# Of those, the ones the tests compile: the rest need the app's own types (TerminalTab).
SHARED_CORE="$IOS_DIR/Core/Catalogue.swift $IOS_DIR/Core/CatalogueCache.swift $IOS_DIR/Core/CatalogueSearch.swift \
$IOS_DIR/Core/HubModels.swift $IOS_DIR/Core/IconSource.swift $IOS_DIR/Core/Screens.swift $IOS_DIR/Core/ScreenStore.swift \
$IOS_DIR/Core/SpaceSettings.swift $IOS_DIR/Core/TerminalModels.swift $IOS_DIR/Core/WidgetBlocks.swift"
