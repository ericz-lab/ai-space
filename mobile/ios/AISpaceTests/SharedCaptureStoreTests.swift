import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@Suite struct SharedCaptureStoreTests {
    private let png = Data([0x89, 0x50, 0x4e, 0x47])

    @Test func reopeningPreservesPayloadDestinationAndRetryIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        let connection = Connection(name: "Seoul", url: URL(string: "https://space.example.com")!)
        try store.publish([connection])
        var draft = SharedCaptureDraft(image: png, text: "Keep this", connection: connection.id, target: "peer/notes/image")
        try store.save(draft)
        draft.attempted = true
        try store.update(draft)
        let reopened = SharedCaptureStore(directory: root)
        #expect(try reopened.connections() == [connection])
        #expect(try reopened.drafts() == [draft])
        #expect(ScreenshotRules.fields(id: draft.id, text: draft.text, via: "share")[0].1 == draft.id.uuidString.lowercased())
        try reopened.remove(draft.id)
        #expect(try store.drafts().isEmpty)
    }

    @Test func independentDraftsCannotOverwriteEachOther() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = SharedCaptureStore(directory: root)
        let second = SharedCaptureStore(directory: root)
        var a = SharedCaptureDraft(image: png)
        let b = SharedCaptureDraft(image: png, text: "Second")
        try first.save(a)
        try second.save(b)
        a.text = "Changed"
        try first.update(a)
        #expect(Set(try second.drafts().map(\.id)) == Set([a.id, b.id]))
        #expect(try second.drafts().first { $0.id == a.id }?.text == "Changed")
        try second.remove(b.id)
        #expect(try first.drafts() == [a])
    }

    @Test func rejectsUnsupportedAndOversizedImagesWithoutLosingExistingDrafts() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        let valid = SharedCaptureDraft(image: png)
        try store.save(valid)
        #expect(throws: (any Error).self) { try store.save(SharedCaptureDraft(image: Data("bad".utf8))) }
        #expect(throws: (any Error).self) { try store.save(SharedCaptureDraft(image: png + Data(count: ScreenshotRules.maxBytes))) }
        #expect(try store.drafts() == [valid])
    }

    @Test func staleEditorsCannotChangeAnAttemptOrResurrectDeletedItems() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        var draft = SharedCaptureDraft(image: png, target: "notes/image")
        try store.save(draft)
        var stale = draft
        draft.attempted = true
        try store.update(draft)
        stale.target = "spark/image"
        #expect(throws: (any Error).self) { try store.update(stale) }
        #expect(try store.drafts() == [draft])
        try store.remove(draft.id)
        #expect(throws: (any Error).self) { try store.update(stale) }
        #expect(try store.drafts().isEmpty)
    }
}
