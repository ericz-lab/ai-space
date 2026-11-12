import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct InboxStoreTests {
    private let inboxJSON = #"{"ok":true,"items":[{"thread":"a","app":"todo","text":"one","unread":true},{"thread":"b","app":"todo","text":"two","unread":true}]}"#

    @Test func aSecondQuickActionIsSentAfterTheFirstInsteadOfDropped() async {
        var posted: [[String]] = []
        var reads = 0
        let store = InboxStore(
            api: SpaceAPI(base: URL(string: "https://space.example")!, cookies: { [] }),
            fetch: { _ in
                reads += 1
                return Data(inboxJSON.utf8)
            },
            post: { path, body in
                // The first change is slow, so the second tap arrives while it is saving.
                if posted.isEmpty { try await Task.sleep(nanoseconds: 50_000_000) }
                posted.append([path] + ((body["threads"] as? [String]) ?? []))
            })
        await store.refresh()
        reads = 0
        async let first: Void = store.mark("a", read: true)
        async let second: Void = store.mark("b", done: true)
        _ = await (first, second)
        #expect(posted.count == 2)
        #expect(Set(posted) == [["/api/inbox/mark", "a"], ["/api/inbox/mark", "b"]])
        // One read once both are in, not one per change racing the second.
        #expect(reads == 1)
        #expect(!store.isSaving && store.saveError == nil)
    }
}
