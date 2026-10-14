import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The Mac lays out its screens as the iPhone does (mobile/ios/AISpace/Core/ScreenStore.swift,
/// compiled into the Mac app): copied from the panel once, then its own.
@MainActor
struct ScreenLayoutTests {
    let file = FileManager.default.temporaryDirectory
        .appendingPathComponent("ai-space-tests-\(UUID().uuidString)", isDirectory: true)
        .appendingPathComponent("screens.json")
    let space = UUID()

    @Test func panelIsCopiedOnceThenEditsStayOnThisMac() {
        let store = ScreenStore(fileURL: file)
        store.seed(space, from: [PanelScreen(id: Screens.home, name: "", items: ["app:notes", "builtin:inbox"])])
        #expect(store.screens(space).first?.items == ["app:notes"])

        store.edit(space) { Screens.pin($0, Screens.home, "agent:space/assistant") }
        // A later catalogue does not overwrite what was changed here.
        store.seed(space, from: [PanelScreen(id: Screens.home, name: "", items: ["app:todo"])])
        let reread = ScreenStore(fileURL: file)
        #expect(reread.screens(space).first?.items == ["app:notes", "agent:space/assistant"])
    }

    @Test func emptyPanelDoesNotCountAsALayout() {
        let store = ScreenStore(fileURL: file)
        store.seed(space, from: [PanelScreen(id: Screens.home, name: "", items: [])])
        store.seed(space, from: [PanelScreen(id: Screens.home, name: "", items: ["app:notes"])])
        #expect(store.screens(space).first?.items == ["app:notes"])
    }
}
