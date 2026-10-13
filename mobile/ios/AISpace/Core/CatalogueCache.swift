import Foundation

/// The last catalogue answers of each Space, one file per connection in the app's caches.
/// It holds what the panel showed (titles, links, widget rows), never a cookie or a token.
struct CatalogueCache {
    private static let io = DispatchQueue(label: "dev.ai-space.catalogue-cache", qos: .utility)
    var directory: URL

    func file(_ connection: UUID) -> URL { directory.appendingPathComponent("catalogue-\(connection.uuidString).json") }

    func load(_ connection: UUID) -> CataloguePayload? {
        Self.io.sync {
            guard let data = try? Data(contentsOf: file(connection)) else { return nil }
            return try? JSONDecoder().decode(CataloguePayload.self, from: data)
        }
    }

    func save(_ payload: CataloguePayload, _ connection: UUID) {
        Self.io.sync { write(payload, connection) }
    }

    /// Queue writes in order; load/remove drain prior writes so sign-out cannot resurrect a cache.
    func saveInBackground(_ payload: CataloguePayload, _ connection: UUID) {
        Self.io.async { write(payload, connection) }
    }

    private func write(_ payload: CataloguePayload, _ connection: UUID) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(payload) { try? data.write(to: file(connection), options: .atomic) }
    }

    func remove(_ connection: UUID) {
        Self.io.sync { try? FileManager.default.removeItem(at: file(connection)) }
    }
}
