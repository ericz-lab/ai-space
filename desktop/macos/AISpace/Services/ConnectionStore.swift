import Foundation

/// The saved connections, kept as one JSON file under the app's Application Support directory,
/// separate from any Space workspace. Exactly one connection is the default while any exist.
@MainActor
final class ConnectionStore: ObservableObject {
    @Published private(set) var connections: [Connection] = []
    @Published private(set) var loadError: String?

    private let fileURL: URL

    init(fileURL: URL = ConnectionStore.defaultFileURL) {
        self.fileURL = fileURL
        load()
    }

    nonisolated static var defaultFileURL: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("ai-space", isDirectory: true).appendingPathComponent("connections.json")
    }

    var defaultConnection: Connection? { connections.first(where: \.isDefault) ?? connections.first }

    func connection(_ id: UUID) -> Connection? { connections.first { $0.id == id } }

    @discardableResult
    func add(name: String, url: URL, makeDefault: Bool = false) -> Connection {
        let c = Connection(name: Self.displayName(name, url), url: url, isDefault: makeDefault || connections.isEmpty)
        if c.isDefault { clearDefault() }
        connections.append(c)
        save()
        return c
    }

    func update(_ id: UUID, name: String, url: URL) {
        guard let i = connections.firstIndex(where: { $0.id == id }) else { return }
        connections[i].name = Self.displayName(name, url)
        connections[i].url = url
        save()
    }

    func setDefault(_ id: UUID) {
        guard connections.contains(where: { $0.id == id }) else { return }
        for i in connections.indices { connections[i].isDefault = connections[i].id == id }
        save()
    }

    func remove(_ id: UUID) {
        connections.removeAll { $0.id == id }
        if !connections.isEmpty && !connections.contains(where: \.isDefault) { connections[0].isDefault = true }
        save()
    }

    private func clearDefault() {
        for i in connections.indices { connections[i].isDefault = false }
    }

    private static func displayName(_ name: String, _ url: URL) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? (url.host ?? url.absoluteString) : trimmed
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        do {
            connections = try JSONDecoder().decode([Connection].self, from: data)
        } catch {
            // Keep the unreadable file for the operator instead of overwriting it on the next save.
            let aside = fileURL.deletingPathExtension().appendingPathExtension("unreadable.json")
            try? FileManager.default.removeItem(at: aside)
            try? FileManager.default.moveItem(at: fileURL, to: aside)
            loadError = aside.path
        }
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(connections).write(to: fileURL, options: .atomic)
        } catch {
            NSLog("ai-space: could not save connections: \(error.localizedDescription)")
        }
    }
}
