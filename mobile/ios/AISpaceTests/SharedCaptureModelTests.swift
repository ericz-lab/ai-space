#if canImport(AISpace) && (canImport(UIKit) || canImport(AppKit))
#if canImport(AppKit)
import AppKit
#else
import UIKit
#endif
import Testing
@testable import AISpace

@MainActor @Suite struct SharedCaptureModelTests {
    @Test func failedUploadKeepsFrozenPayloadAndRetryUsesSameID() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        let space = Connection(name: "Test", url: URL(string: "https://example.com")!)
        try store.publish([space])
        let target = ScreenshotRules.Target(id: "notes/image", app: "notes", title: "Notes")
        let draft = SharedCaptureDraft(image: Data([0x89, 0x50, 0x4e, 0x47]), text: "Original", connection: space.id)
        try store.save(draft)
        var sent: [SharedCaptureDraft] = []
        let model = SharedCaptureModel(store: store, load: { _ in .init(image: true, targets: [target]) }, upload: { _, item, _ in
            sent.append(item)
            if sent.count == 1 { throw URLError(.timedOut) }
            return .init(label: "Saved note")
        })
        await model.edit(draft)
        #expect(model.canSave)
        await model.save()
        #expect(model.error != nil)
        #expect(try store.drafts().first?.attempted == true)
        model.changeText("Changed after timeout")
        model.changeTarget("other/image")
        await model.changeSpace(UUID())
        await model.save()
        #expect(sent.count == 2)
        #expect(sent[0] == sent[1])
        #expect(sent[0].id == draft.id)
        #expect(sent[0].text == "Original")
        #expect(model.receipt == "Saved note")
        #expect(try store.drafts().isEmpty)
    }

    @Test func staleTargetResponseCannotChangeNewlySelectedSpace() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        let first = Connection(name: "First", url: URL(string: "https://one.example.com")!)
        let second = Connection(name: "Second", url: URL(string: "https://two.example.com")!)
        try store.publish([first, second])
        var waiting: CheckedContinuation<ScreenshotRules.Availability, Error>?
        let model = SharedCaptureModel(store: store, load: { space in
            if space.id == first.id { return try await withCheckedThrowingContinuation { waiting = $0 } }
            return .init(image: true, targets: [.init(id: "second/image", app: "second", title: "Second")])
        })
        let draft = SharedCaptureDraft(image: Data([0x89, 0x50, 0x4e, 0x47]), connection: first.id)
        try store.save(draft)
        let pending = Task { await model.edit(draft) }
        while waiting == nil { await Task.yield() }
        await model.changeSpace(second.id)
        waiting?.resume(returning: .init(image: true, targets: [.init(id: "first/image", app: "first", title: "First")]))
        await pending.value
        #expect(model.draft?.connection == second.id)
        #expect(model.draft?.target == "second/image")
        #expect(model.targets.map(\.id) == ["second/image"])
    }

    @Test func unavailableTargetNeverUploadsAndKeepsDraft() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SharedCaptureStore(directory: root)
        let space = Connection(name: "Test", url: URL(string: "https://example.com")!)
        try store.publish([space])
        let draft = SharedCaptureDraft(image: Data([0x89, 0x50, 0x4e, 0x47]), connection: space.id)
        try store.save(draft)
        var uploads = 0
        let model = SharedCaptureModel(store: store, load: { _ in .init(image: false, targets: []) }, upload: { _, _, _ in
            uploads += 1
            return .init(label: "Unexpected")
        })
        await model.edit(draft)
        await model.save()
        #expect(!model.canSave)
        #expect(uploads == 0)
        #expect(try store.drafts() == [draft])
    }
    @Test func boundedPreviewsPreserveAnAlreadySendablePNG() throws {
        #if os(macOS)
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 3200, pixelsHigh: 1600,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0))
        let bytes = try #require(bitmap.representation(using: .png, properties: [:]))
        #else
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 3200, height: 1600), format: format).image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 3200, height: 1600))
        }
        let bytes = try #require(image.pngData())
        #endif
        let prepared = try #require(CapturePicture.prepare(bytes))
        #expect(prepared.data == bytes)
        #expect(prepared.preview.size.width <= 2048)
        let thumbnail = try #require(CapturePicture.preview(bytes, maxPixelSize: 128))
        #expect(thumbnail.size.width <= 128)
        #expect(CapturePicture.prepare(Data("not an image".utf8)) == nil)
    }

    @Test func sharedKeychainIsolatesSpacesAndClearsTheSession() throws {
        // This test needs the signed Simulator app's shared Keychain entitlement.
        let first = Connection(name: "First", url: URL(string: "https://capture.example.com")!)
        let second = Connection(name: "Second", url: first.url)
        defer { try? ShareAccess.clear(first); try? ShareAccess.clear(second) }
        let matching = try #require(HTTPCookie(properties: [.name: "session", .value: "fixture",
            .domain: "capture.example.com", .path: "/", .secure: "TRUE",
            .expires: Date().addingTimeInterval(60)]))
        let unrelated = try #require(HTTPCookie(properties: [.name: "sso", .value: "not-shared",
            .domain: "login.example.com", .path: "/"]))
        try ShareAccess.publish([matching, unrelated], for: first)
        let restored = try ShareAccess.cookies(for: first)
        #expect(restored.map(\.name) == ["session"])
        #expect(restored.first?.isSecure == true)
        #expect(restored.first?.expiresDate != nil)
        #expect(try ShareAccess.cookies(for: second).isEmpty)
        try ShareAccess.clear(first)
        #expect(try ShareAccess.cookies(for: first).isEmpty)
    }

}
#endif
