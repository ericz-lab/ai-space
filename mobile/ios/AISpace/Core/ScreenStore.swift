import Foundation

/// The screens of each saved Space as this phone lays them out, kept in one JSON file here. A
/// phone, a browser and a Mac are different places to work from, so each has its own layout: the
/// first catalogue of a Space copies the panel's screens once, and from then on what is pinned,
/// moved or added here stays here and nothing is written to the Space.
@MainActor
final class ScreenStore: ObservableObject {
    struct Record: Codable, Equatable {
        var screens = [PanelScreen(id: Screens.home)]
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

    /// Home first; a Space that has not been copied yet has an empty home screen.
    func screens(_ connection: UUID) -> [PanelScreen] { records[connection.uuidString]?.screens ?? Record().screens }

    func isPinned(_ key: String, screen: String = Screens.home, _ connection: UUID) -> Bool {
        Screens.isPinned(screens(connection), screen, key)
    }

    /// Takes the panel's screens as the phone's first layout, once per Space.
    func seed(_ connection: UUID, from panel: [PanelScreen]) {
        guard records[connection.uuidString]?.seeded != true else { return }
        let copy = Self.copy(panel)
        // A panel with nothing pinned is not a layout yet: wait for a catalogue that has one.
        guard copy.contains(where: { !$0.items.isEmpty }) else { return }
        write(connection, Record(screens: copy, seeded: true))
    }

    /// Replaces the phone's layout with the panel's as it is now, when the operator asks for it.
    func reset(_ connection: UUID, from panel: [PanelScreen]) {
        write(connection, Record(screens: Self.copy(panel), seeded: true))
    }

    /// Points every agent pinned once per machine at its group, so a screen shows the agent once
    /// (AgentGroups.canonical); keeps whether the layout was copied or made by hand.
    func merge(_ connection: UUID, groups: [AgentGroup]) {
        guard let record = records[connection.uuidString], !groups.isEmpty else { return }
        let screens = record.screens.map { s in PanelScreen(id: s.id, name: s.name, items: AgentGroups.canonical(s.items, groups)) }
        write(connection, Record(screens: screens, seeded: record.seeded))
    }

    func edit(_ connection: UUID, _ change: ([PanelScreen]) -> [PanelScreen]) {
        // A layout made by hand is never overwritten by a later copy.
        write(connection, Record(screens: Self.normalized(change(screens(connection))), seeded: true))
    }

    func forget(_ connection: UUID) {
        guard records.removeValue(forKey: connection.uuidString) != nil else { return }
        save()
    }

    /// The panel's screens as the phone keeps them: only entries of a kind the phone shows
    /// (of the `builtin:` tiles, the panel's own windows, only Settings), each once per screen.
    /// A key whose entry is gone is kept, so it comes back with the entry.
    static func copy(_ panel: [PanelScreen]) -> [PanelScreen] {
        let kinds = EntryKind.allCases.map { $0.rawValue + ":" }
        return normalized(panel.map { s in
            var seen = Set<String>()
            return PanelScreen(id: s.id, name: s.name, items: s.items.filter { key in
                (key == Screens.settingsKey || kinds.contains { key.hasPrefix($0) }) && seen.insert(key).inserted
            })
        })
    }

    /// Home exists and comes first, ids are unique, and there are no more screens than the limit.
    private static func normalized(_ screens: [PanelScreen]) -> [PanelScreen] {
        var seen = Set<String>()
        var out = screens.filter { seen.insert($0.id).inserted }
        if let i = out.firstIndex(where: { $0.id == Screens.home }) {
            out.insert(out.remove(at: i), at: 0)
        } else {
            out.insert(PanelScreen(id: Screens.home), at: 0)
        }
        return Array(out.prefix(Screens.limit))
    }

    private func write(_ connection: UUID, _ record: Record) {
        guard records[connection.uuidString] != record else { return }
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
            NSLog("ai-space: could not save the screens: \(error.localizedDescription)")
        }
    }
}
