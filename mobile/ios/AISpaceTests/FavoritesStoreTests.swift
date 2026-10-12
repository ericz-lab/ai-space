import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct FavoritesStoreTests {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("aispace-fav-\(UUID().uuidString)/favorites.json")
    let a = UUID()
    let b = UUID()

    @Test func togglesAndKeepsOrderAcrossLaunches() {
        let store = FavoritesStore(fileURL: file)
        store.toggle("app:todo", a)
        store.toggle("agent:space/assistant", a)
        store.toggle("app:notes", a)
        store.toggle("agent:space/assistant", a)
        #expect(store.keys(a) == ["app:todo", "app:notes"])
        #expect(store.isFavorite("app:todo", a))
        #expect(!store.isFavorite("app:todo", b))
        #expect(FavoritesStore(fileURL: file).keys(a) == ["app:todo", "app:notes"])
    }

    @Test func eachSpaceHasItsOwnList() {
        let store = FavoritesStore(fileURL: file)
        store.toggle("app:todo", a)
        store.toggle("app:reader", b)
        store.forget(a)
        #expect(store.keys(a).isEmpty)
        #expect(FavoritesStore(fileURL: file).keys(b) == ["app:reader"])
    }

    @Test func seedsOnceFromThePanelHomeScreen() {
        let store = FavoritesStore(fileURL: file)
        store.seed(a, pins: [])
        store.seed(a, pins: ["app:todo", "builtin:inbox", "agent:space/assistant", "app:todo", "widget:todo/today", "app:gone"])
        // Built-in tiles are the panel's own; a pin whose entry is gone is kept for when it returns.
        #expect(store.keys(a) == ["app:todo", "agent:space/assistant", "widget:todo/today", "app:gone"])
        store.seed(a, pins: ["app:docs"])
        #expect(store.keys(a).first == "app:todo")
    }

    @Test func aChoiceMadeByHandIsNotReseeded() {
        let store = FavoritesStore(fileURL: file)
        store.toggle("app:notes", a)
        store.toggle("app:notes", a)
        store.seed(a, pins: ["app:todo"])
        #expect(store.keys(a).isEmpty)
    }

    @Test func movesAnEntry() {
        let store = FavoritesStore(fileURL: file)
        for k in ["app:a", "app:b", "app:c", "app:d"] { store.toggle(k, a) }
        store.move(a, from: IndexSet(integer: 0), to: 3)
        #expect(store.keys(a) == ["app:b", "app:c", "app:a", "app:d"])
        store.move(a, from: IndexSet(integer: 3), to: 0)
        #expect(store.keys(a) == ["app:d", "app:b", "app:c", "app:a"])
    }

    @Test func anUnreadableFileStartsEmpty() throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: file)
        #expect(FavoritesStore(fileURL: file).keys(a).isEmpty)
    }
}
