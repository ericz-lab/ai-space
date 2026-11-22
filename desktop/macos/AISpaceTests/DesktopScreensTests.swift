import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The home screen on this Mac: where the window opens, which built-in tiles a copied layout keeps,
/// and what an App Store install adds to it.
@MainActor
struct DesktopScreensTests {
    let file = FileManager.default.temporaryDirectory
        .appendingPathComponent("ai-space-tests-\(UUID().uuidString)", isDirectory: true)
        .appendingPathComponent("screens.json")
    let space = UUID()

    // MARK: The built-in tiles

    @Test func builtinsAreThePanelsFiveInItsOrder() {
        #expect(Builtin.allCases.map(\.key) == ["builtin:store", "builtin:inbox", "builtin:shortcuts", "builtin:terminal", "builtin:settings"])
        #expect(Builtin(key: "builtin:store") == .store)
        #expect(Builtin(key: "builtin:later") == nil)
        #expect(Builtin(key: "app:store") == nil)
    }

    @Test func aTileShowsTheIconTheSpaceServes() {
        // No answer yet, or a Space older than `builtins`: the panel's own artwork.
        #expect(Builtin.store.icon(in: [:]) == "/store.svg")
        #expect(Builtin.settings.icon(in: ["settings": ""]) == "/settings.svg")
        // An icon pack covers some tiles and leaves the others on the default.
        let served = ["store": "/store.svg", "inbox": "/api/panel/icons/per-app/app/space~inbox?v=1"]
        #expect(Builtin.inbox.icon(in: served) == "/api/panel/icons/per-app/app/space~inbox?v=1")
        #expect(Builtin.store.icon(in: served) == "/store.svg")
        #expect(Builtin.terminal.icon(in: served) == "/terminal.svg")
    }

    @Test func storeAndShortcutsAreThePanelsPages() {
        #expect(Builtin.store.page == "/?page=store")
        #expect(Builtin.shortcuts.page == "/?page=shortcuts")
        #expect(Builtin.inbox.page == nil && Builtin.terminal.page == nil && Builtin.settings.page == nil)
        #expect(Builtin.isTab("builtin:store") && !Builtin.isTab("store") && !Builtin.isTab("david/notes"))
    }

    @Test func aNewSpaceSeedsEveryBuiltinTile() {
        let seeded = DesktopScreens.seed(apps: ["notes"], agents: ["space/assistant"], widgets: [])
        #expect(seeded == [PanelScreen(id: Screens.home, items: [
            "app:notes", "builtin:store", "builtin:inbox", "builtin:shortcuts", "builtin:terminal", "builtin:settings", "agent:space/assistant",
        ])])
    }

    @Test func aCopiedLayoutKeepsThePanelsBuiltinTilesInPlace() {
        let panel = [
            PanelScreen(id: Screens.home, items: ["builtin:store", "app:notes", "builtin:inbox", "builtin:later", "builtin:settings", "agent:space/assistant"]),
            PanelScreen(id: "s1", items: ["builtin:terminal", "widget:notes/recent"]),
        ]
        let store = ScreenStore(fileURL: file)
        store.seed(space, from: panel)
        // The phone's copy keeps Settings alone of the built-in tiles.
        #expect(store.screens(space).first?.items == ["app:notes", "builtin:settings", "agent:space/assistant"])
        store.edit(space) { DesktopScreens.keepingBuiltins($0, from: panel) }
        #expect(store.screens(space).map(\.items) == [
            ["builtin:store", "app:notes", "builtin:inbox", "builtin:settings", "agent:space/assistant"],
            ["builtin:terminal", "widget:notes/recent"],
        ])
    }

    // MARK: Where the window opens

    @Test func aFirstInstallOpensOnTheHomeScreen() {
        // Nothing copied yet: the home screen, never the library.
        #expect(DesktopScreens.opening([PanelScreen(id: Screens.home)]) == Screens.home)
        #expect(DesktopScreens.opening([]) == Screens.home)
        // The seeded layout of a new Space: its home screen holds the tiles.
        let seeded = DesktopScreens.seed(apps: [], agents: ["space/assistant"], widgets: [])
        #expect(DesktopScreens.opening(seeded) == Screens.home)
        // The library's page id (`Pager.home`) is no screen's.
        #expect(DesktopScreens.opening(seeded) != "#home")
    }

    @Test func itOpensOnTheFirstScreenThatHoldsTiles() {
        let screens = [PanelScreen(id: Screens.home), PanelScreen(id: "s1"), PanelScreen(id: "s2", items: ["app:notes"]), PanelScreen(id: "s3", items: ["app:todo"])]
        #expect(DesktopScreens.opening(screens) == "s2")
        // The home screen wins whenever it holds anything.
        #expect(DesktopScreens.opening([PanelScreen(id: Screens.home, items: ["builtin:settings"]), PanelScreen(id: "s1", items: ["app:notes"])]) == Screens.home)
        // Every screen empty: the home screen, not a later empty one.
        #expect(DesktopScreens.opening([PanelScreen(id: Screens.home), PanelScreen(id: "s1")]) == Screens.home)
    }

    // MARK: Installs

    @Test func theFirstLookPinsNothing() {
        let (watch, pins) = InstallRules.adopt(nil, apps: ["app:notes", "app:todo"], panelHome: ["app:notes", "app:todo"])
        #expect(pins.isEmpty)
        #expect(watch == InstallWatch(known: ["app:notes", "app:todo"]))
    }

    @Test func appsInstalledFromTheStoreArePinnedToTheHomeScreen() {
        // A new Space: no apps, and the layout copied from the seeded panel.
        let panel = DesktopScreens.seed(apps: [], agents: ["space/assistant"], widgets: [])
        let store = ScreenStore(fileURL: file)
        store.seed(space, from: panel)
        store.edit(space) { DesktopScreens.keepingBuiltins($0, from: panel) }
        let first = InstallRules.adopt(nil, apps: [], panelHome: panel[0].items)
        #expect(first.pins.isEmpty)

        // The first-use choice installs two apps; the store pins each to the panel's home screen.
        let after = panel[0].items + ["app:ai-todo", "app:ai-notes"]
        let second = InstallRules.adopt(first.watch, apps: ["app:ai-notes", "app:ai-todo"], panelHome: after)
        #expect(second.pins == ["app:ai-notes", "app:ai-todo"])
        store.edit(space) { InstallRules.pinning($0, second.pins) }
        #expect(store.screens(space).first?.items == panel[0].items + ["app:ai-notes", "app:ai-todo"])

        // The next look pins nothing again, and a tile taken off this Mac's screen stays off.
        store.edit(space) { Screens.unpin($0, Screens.home, "app:ai-todo") }
        let third = InstallRules.adopt(second.watch, apps: ["app:ai-notes", "app:ai-todo"], panelHome: after)
        #expect(third.pins.isEmpty)
        store.edit(space) { InstallRules.pinning($0, third.pins) }
        #expect(store.isPinned("app:ai-todo", space) == false)
        // What the Mac pinned survives a relaunch.
        #expect(ScreenStore(fileURL: file).isPinned("app:ai-notes", space))
    }

    @Test func anAppThatIsNotOnThePanelsHomeScreenStaysInTheLibrary() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let start = InstallWatch(known: ["app:notes"])
        // Added from a link, or a peer's app: on no screen of the panel.
        let seen = InstallRules.adopt(start, apps: ["app:notes", "app:link"], panelHome: ["app:notes"], now: now)
        #expect(seen.pins.isEmpty)
        #expect(seen.watch.fresh == ["app:link": now])
        // The store's pin can land after the catalogue was read: it still counts a little later.
        let pinned = InstallRules.adopt(seen.watch, apps: ["app:notes", "app:link"], panelHome: ["app:notes", "app:link"], now: now.addingTimeInterval(20))
        #expect(pinned.pins == ["app:link"])
        // Past the grace it is an app like any other: pinning it on the panel later is not an install.
        let late = InstallRules.adopt(seen.watch, apps: ["app:notes", "app:link"], panelHome: ["app:notes"], now: now.addingTimeInterval(InstallRules.grace + 1))
        #expect(late.pins.isEmpty && late.watch == InstallWatch(known: ["app:notes", "app:link"]))
        let later = InstallRules.adopt(late.watch, apps: ["app:notes", "app:link"], panelHome: ["app:notes", "app:link"], now: now.addingTimeInterval(InstallRules.grace + 60))
        #expect(later.pins.isEmpty)
    }

    @Test func anAppInstalledAgainIsPinnedAgain() {
        let had = InstallWatch(known: ["app:notes", "app:todo"])
        let gone = InstallRules.adopt(had, apps: ["app:notes"], panelHome: ["app:notes"])
        #expect(gone.watch == InstallWatch(known: ["app:notes"]))
        let back = InstallRules.adopt(gone.watch, apps: ["app:notes", "app:todo"], panelHome: ["app:notes", "app:todo"])
        #expect(back.pins == ["app:todo"])
    }

    @Test func theWatchIsKeptPerSpace() {
        let name = "ai-space-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let store = InstallWatchStore(defaults: defaults)
        #expect(store.watch(space) == nil)
        let watch = InstallWatch(known: ["app:notes"], fresh: ["app:link": Date(timeIntervalSince1970: 5)])
        store.save(watch, space)
        #expect(store.watch(space) == watch)
        #expect(store.watch(UUID()) == nil)
        store.forget(space)
        #expect(store.watch(space) == nil)
    }

    // MARK: The first-use card

    @Test func aSpaceWithNoCatalogAppIsOfferedTheCatalog() {
        func count(_ json: String) -> Int { CatalogOffer.count(Data(json.utf8)) }
        #expect(count(#"{"ok":true,"apps":[{"name":"a","state":"available"},{"name":"b","state":"available"},{"name":"c","state":"unavailable"}]}"#) == 2)
        // Any catalog app installed, or an old deployment of one: the choice was made.
        #expect(count(#"{"ok":true,"apps":[{"name":"a","state":"available"},{"name":"b","state":"installed","installed":true}]}"#) == 0)
        #expect(count(#"{"ok":true,"apps":[{"name":"a","state":"available"},{"name":"b","state":"legacy"}]}"#) == 0)
        // A refusal, or something that is not the catalog, offers nothing.
        #expect(count(#"{"ok":false,"error":"sign-in required"}"#) == 0)
        #expect(count("<html>") == 0)
    }
}
