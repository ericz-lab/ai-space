import SwiftUI

@MainActor
final class SharedCaptureModel: ObservableObject {
    @Published var deleting: SharedCaptureDraft?
    @Published private(set) var spaces: [Connection] = []
    @Published private(set) var drafts: [SharedCaptureDraft] = []
    @Published private(set) var draft: SharedCaptureDraft?
    @Published private(set) var targets: [ScreenshotRules.Target] = []
    @Published private(set) var busy = false
    @Published private(set) var receiving = false
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var receipt: String?
    private var generation = UUID()
    private var store: SharedCaptureStore?
    private let load: (Connection) async throws -> ScreenshotRules.Availability
    private let upload: (Connection, SharedCaptureDraft, ScreenshotRules.Target) async throws -> ScreenshotRules.Answer

    init(store suppliedStore: SharedCaptureStore? = nil,
         load: ((Connection) async throws -> ScreenshotRules.Availability)? = nil,
         upload: ((Connection, SharedCaptureDraft, ScreenshotRules.Target) async throws -> ScreenshotRules.Answer)? = nil) {
        self.load = load ?? { space in
            try await Self.api(for: space).get("/api/capture", as: ScreenshotRules.Availability.self)
        }
        self.upload = upload ?? { space, item, target in
            guard let kind = ScreenshotRules.sendable(item.image) else { throw SpaceAPIError.invalidResponse }
            let data = try await Self.api(for: space).upload(ScreenshotRules.uploadPath(to: target), field: "file",
                filename: "shared.\(kind.fileExtension)", mimeType: kind.mimeType, data: item.image,
                fields: ScreenshotRules.fields(id: item.id, text: item.text, via: "share"), timeout: 60)
            return try JSONDecoder().decode(ScreenshotRules.Answer.self, from: data)
        }
        do {
            let store = try suppliedStore ?? ShareAccess.store()
            self.store = store
            spaces = try store.connections()
            drafts = try store.drafts()
        } catch { self.error = error.localizedDescription }
    }

    func beginImport() { receiving = true }

    func report(_ message: String) { receiving = false; error = message }

    /// Persist before showing the editor; dismissal never loses the only copy.
    func receive(_ data: Data) async {
        receiving = true
        defer { receiving = false }
        guard drafts.count < 12 else {
            error = String(localized: "Save or delete a pending picture before sharing another one.")
            return
        }
        guard let picture = CapturePicture.prepare(data) else {
            error = String(localized: "That picture could not be read. Pick another one.")
            return
        }
        guard let store else { return }
        do {
            let item = SharedCaptureDraft(image: picture.data, connection: spaces.first(where: \.isDefault)?.id ?? spaces.first?.id)
            try store.save(item)
            drafts = try store.drafts()
            await edit(item)
        } catch { self.error = error.localizedDescription }
    }

    func edit(_ item: SharedCaptureDraft) async {
        guard !busy else { return }
        do {
            guard let current = try store?.drafts().first(where: { $0.id == item.id }) else {
                error = String(localized: "This picture was changed in another window. Reopen it from Pending Shares.")
                drafts = (try? store?.drafts()) ?? []
                return
            }
            draft = current
            receipt = nil
            await loadTargets()
        } catch { self.error = error.localizedDescription }
    }

    func changeSpace(_ id: UUID) async {
        guard var item = draft, !busy, !item.attempted else { return }
        item.connection = id
        item.target = nil
        persist(item)
        await loadTargets()
    }

    func changeTarget(_ id: String) {
        guard var item = draft, !busy, !item.attempted else { return }
        item.target = id
        persist(item)
    }

    func changeText(_ text: String) {
        guard var item = draft, !busy, !item.attempted else { return }
        item.text = String(text.prefix(4000))
        persist(item)
    }

    private func persist(_ item: SharedCaptureDraft) {
        guard let store else { return }
        do {
            try store.update(item)
            draft = item
            drafts = try store.drafts()
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func loadTargets() async {
        let token = UUID()
        generation = token
        targets = []
        loading = false
        error = nil
        do { if let store { spaces = try store.connections() } }
        catch { self.error = error.localizedDescription; return }
        guard let item = draft, let space = spaces.first(where: { $0.id == item.connection }) else {
            error = String(localized: "Open ai-space and add a Space first. Your picture stays in Pending Shares.")
            return
        }
        loading = true
        defer { if generation == token { loading = false } }
        do {
            let answer = try await load(space)
            guard generation == token, draft?.id == item.id else { return }
            targets = answer.image ? (answer.targets ?? []) : []
            guard answer.image, !targets.isEmpty else {
                error = String(localized: "This Space has no apps that accept pictures.")
                return
            }
            if !item.attempted {
                var updated = draft ?? item
                updated.target = ScreenshotRules.preferred(targets, last: updated.target)?.id
                persist(updated)
            }
            if !targets.contains(where: { $0.id == draft?.target }) {
                error = String(localized: "The original destination is unavailable. Retry when it is available again.")
            }
        } catch {
            guard generation == token else { return }
            self.error = message(error)
        }
    }

    var canSave: Bool {
        !busy && !loading && draft != nil && targets.contains { $0.id == draft?.target }
    }

    func save() async {
        guard canSave, var item = draft, let store,
              let space = spaces.first(where: { $0.id == item.connection }),
              let target = targets.first(where: { $0.id == item.target }) else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            // Persist the exact retry destination and payload before the first network write.
            item.attempted = true
            try store.update(item)
            draft = item
            let answer = try await upload(space, item, target)
            try store.remove(item.id)
            draft = nil
            drafts = try store.drafts()
            receipt = ScreenshotRules.receipt(answer, target: target)
        } catch { self.error = message(error) }
    }

    func discard(_ item: SharedCaptureDraft) {
        guard !busy, let store else { return }
        do {
            try store.remove(item.id)
            if draft?.id == item.id { draft = nil; generation = UUID(); loading = false }
            drafts = try store.drafts()
        } catch { self.error = error.localizedDescription }
    }

    private static func api(for space: Connection) throws -> SpaceAPI {
        // Detect Keychain entitlement/read failures instead of silently treating them as logout.
        _ = try ShareAccess.cookies(for: space)
        return SpaceAPI(base: space.url) {
            // Re-read for every request: sign-out/removal must not leave a cached credential.
            guard let current = try? ShareAccess.store().connections(), current.contains(space) else { return [] }
            return (try? ShareAccess.cookies(for: space)) ?? []
        }
    }

    private func message(_ error: Error) -> String {
        if let e = error as? SpaceAPIError {
            switch e {
            case .authenticationRequired:
                return String(localized: "Open ai-space and sign in again, then retry from Pending Shares. Your picture is kept on this device.")
            case .http(let status, let detail):
                return String(localized: "Not saved (\(status)): \(detail)")
            case .invalidResponse:
                return String(localized: "The Space returned an unreadable response. Your picture is still pending.")
            }
        }
        return error.localizedDescription
    }
}
