import Foundation

/// The favourites of each saved Space: entry keys (`app:<id>`, `agent:<id>`, `widget:<id>`) in
/// the operator's order, kept in one JSON file on this phone. A key whose entry is gone (an
/// uninstalled app, a peer that left) is kept, so it comes back with the entry, as the panel's
/// screens do. The first catalogue of a Space seeds the list from the panel's home screen once.
@MainActor
final class FavoritesStore: ObservableObject {
    struct Record: Codable, Equatable {
        var keys: [String] = []
        var seeded = false
    }

    @Published private(set) var records: [String: Record] = [:]
    private let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL), let saved = try? JSONDecoder().decode([String: Record].self, from: data) {
            records = saved
        }
    }

    func keys(_ connection: UUID) -> [String] { records[connection.uuidString]?.keys ?? [] }

    func isFavorite(_ key: String, _ connection: UUID) -> Bool { keys(connection).contains(key) }

    func toggle(_ key: String, _ connection: UUID) {
        change(connection) { r in
            if let i = r.keys.firstIndex(of: key) { r.keys.remove(at: i) } else { r.keys.append(key) }
            // A choice made by hand is never overwritten by a later seed.
            r.seeded = true
        }
    }

    func move(_ connection: UUID, from source: IndexSet, to destination: Int) {
        change(connection) { r in
            let moving = source.filter { $0 < r.keys.count }.map { r.keys[$0] }
            let offset = source.filter { $0 < destination }.count
            for i in source.sorted(by: >) where i < r.keys.count { r.keys.remove(at: i) }
            r.keys.insert(contentsOf: moving, at: max(0, min(r.keys.count, destination - offset)))
        }
    }

    /// Takes the panel's home screen as the first favourites. Only pins of a kind the phone
    /// shows are taken (`builtin:` tiles are the panel's own), and only once per Space.
    func seed(_ connection: UUID, pins: [String]) {
        guard records[connection.uuidString]?.seeded != true else { return }
        let kinds = EntryKind.allCases.map { $0.rawValue + ":" }
        var seen = Set<String>()
        let keys = pins.filter { pin in kinds.contains { pin.hasPrefix($0) } && seen.insert(pin).inserted }
        // An empty home screen is not a choice yet: wait for a catalogue that has pins.
        guard !keys.isEmpty else { return }
        change(connection) { r in
            r.keys = keys
            r.seeded = true
        }
    }

    func forget(_ connection: UUID) {
        guard records.removeValue(forKey: connection.uuidString) != nil else { return }
        save()
    }

    private func change(_ connection: UUID, _ body: (inout Record) -> Void) {
        var record = records[connection.uuidString] ?? Record()
        body(&record)
        records[connection.uuidString] = record
        save()
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(records).write(to: fileURL, options: .atomic)
        } catch {
            NSLog("ai-space: could not save favourites: \(error.localizedDescription)")
        }
    }
}
