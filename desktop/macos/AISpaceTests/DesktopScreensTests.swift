import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The built-in tiles on this Mac: their icons, their pages, and what a copied layout keeps of them.
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
        #expect(StorePage.path(pickAll: true) == "/?page=store&pick=all")
        #expect(StorePage.path(pickAll: false) == "/?page=store")
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
}
