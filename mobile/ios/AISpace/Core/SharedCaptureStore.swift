import Foundation
import Darwin

/// App Group files contain addresses and pending pictures, never session credentials.
/// Each draft has its own atomic file so the app and extension cannot overwrite another draft.
struct SharedCaptureDraft: Codable, Identifiable, Equatable {
    var id = UUID()
    var image: Data
    var text = ""
    var connection: UUID?
    var target: String?
    /// Once an upload has started its destination and text are frozen for idempotent retries.
    var attempted = false
}

struct SharedCaptureStore {
    let directory: URL

    func connections() throws -> [Connection] {
        let url = directory.appendingPathComponent("spaces.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([Connection].self, from: Data(contentsOf: url))
    }

    func publish(_ connections: [Connection]) throws {
        try write(JSONEncoder().encode(connections), to: directory.appendingPathComponent("spaces.json"))
    }

    func save(_ draft: SharedCaptureDraft) throws {
        try locked(draft.id) {
            guard !FileManager.default.fileExists(atPath: path(draft.id).path) else { throw CocoaError(.fileWriteFileExists) }
            try writeDraft(draft)
        }
    }

    /// Two processes can edit the same pending item. Once either starts sending, neither may
    /// change its payload or destination; a stale editor cannot resurrect a deleted draft.
    func update(_ draft: SharedCaptureDraft) throws {
        try locked(draft.id) {
            let existing = try JSONDecoder().decode(SharedCaptureDraft.self, from: Data(contentsOf: path(draft.id)))
            guard !existing.attempted || existing == draft else { throw SharedCaptureConflict() }
            try writeDraft(draft)
        }
    }

    private func writeDraft(_ draft: SharedCaptureDraft) throws {
        guard ScreenshotRules.sendable(draft.image) != nil else { throw CocoaError(.fileWriteInapplicableStringEncoding) }
        try write(JSONEncoder().encode(draft), to: path(draft.id))
    }

    func drafts() throws -> [SharedCaptureDraft] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("draft-") && $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { try JSONDecoder().decode(SharedCaptureDraft.self, from: Data(contentsOf: $0)) }
    }

    func remove(_ id: UUID) throws {
        try locked(id) {
            if FileManager.default.fileExists(atPath: path(id).path) { try FileManager.default.removeItem(at: path(id)) }
        }
    }

    private func locked(_ id: UUID, operation: () throws -> Void) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("draft-\(id.uuidString).lock")
        let fd = Darwin.open(file.path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { flock(fd, LOCK_UN) }
        try operation()
    }

    private func path(_ id: UUID) -> URL { directory.appendingPathComponent("draft-\(id.uuidString).json") }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        var excluded = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }
}

private struct SharedCaptureConflict: LocalizedError {
    var errorDescription: String? {
        String(localized: "This picture was changed in another window. Reopen it from Pending Shares.")
    }
}
