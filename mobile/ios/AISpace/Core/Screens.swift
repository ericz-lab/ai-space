import Foundation

/// A screen as the panel defines it (docs/panel.md#screens, src/space/panel/layout.ts): entry
/// keys pinned to it, in order. The phone copies the Space's screens once and then keeps its own
/// (ScreenStore).
struct PanelScreen: Codable, Hashable, Identifiable {
    var id: String
    var name: String
    var items: [String]

    init(id: String, name: String = "", items: [String] = []) {
        self.id = id
        self.name = name
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        items = (try? c.decode([String].self, forKey: .items)) ?? []
    }
}

/// The operations of src/web/screens.ts, as pure functions over the whole list. A key whose entry
/// is gone keeps its place through every one of them.
enum Screens {
    static let home = "home"
    /// As many as the panel allows (MAX_SCREENS in layout.ts).
    static let limit = 20
    /// The panel's own tiles, in the order a seeded home screen has them.
    static let builtins = ["inbox", "terminal", "settings"]
    /// The one built-in tile the phone draws: Settings, which opens over the pages as on the panel.
    /// The other built-ins are the panel's own windows; the phone has their pages under Settings.
    static let settingsKey = "builtin:settings"
    /// How many entries of each kind a first home screen takes (SEED in screens.ts).
    static let seedApps = 8, seedAgents = 4, seedWidgets = 4

    /// The home screen of a Space that has stored no screens yet, as the panel seeds it.
    static func seed(apps: [String], agents: [String], widgets: [String]) -> [PanelScreen] {
        let items = apps.prefix(seedApps).map { "app:\($0)" } + builtins.map { "builtin:\($0)" }
            + agents.prefix(seedAgents).map { "agent:\($0)" } + widgets.prefix(seedWidgets).map { "widget:\($0)" }
        return [PanelScreen(id: home, items: items)]
    }

    private static func map(_ screens: [PanelScreen], _ id: String, _ change: (inout PanelScreen) -> Void) -> [PanelScreen] {
        screens.map { s in
            guard s.id == id else { return s }
            var copy = s
            change(&copy)
            return copy
        }
    }

    /// Adds the entry at the end of the screen; an entry already there stays where it is.
    static func pin(_ screens: [PanelScreen], _ id: String, _ key: String) -> [PanelScreen] {
        map(screens, id) { if !$0.items.contains(key) { $0.items.append(key) } }
    }

    static func unpin(_ screens: [PanelScreen], _ id: String, _ key: String) -> [PanelScreen] {
        map(screens, id) { $0.items.removeAll { $0 == key } }
    }

    static func isPinned(_ screens: [PanelScreen], _ id: String, _ key: String) -> Bool {
        screens.first { $0.id == id }?.items.contains(key) ?? false
    }

    /// Puts the entries of a group (the tiles, or the widgets, which a screen draws apart) in a
    /// new order; entries outside the group keep their places, and a key of the group that the
    /// new order leaves out stays where it was.
    static func reorder(_ screens: [PanelScreen], _ id: String, group: [String], to order: [String]) -> [PanelScreen] {
        guard Set(group) == Set(order), group.count == order.count else { return screens }
        let inGroup = Set(group)
        return map(screens, id) { s in
            var next = order.makeIterator()
            s.items = s.items.map { inGroup.contains($0) ? (next.next() ?? $0) : $0 }
        }
    }

    /// A new empty screen at the end, with an id no other screen has; nil at the limit.
    static func add(_ screens: [PanelScreen]) -> (screens: [PanelScreen], id: String)? {
        guard screens.count < limit else { return nil }
        var n = screens.count
        while screens.contains(where: { $0.id == "s\(n)" }) { n += 1 }
        return (screens + [PanelScreen(id: "s\(n)")], "s\(n)")
    }

    /// The home screen cannot be deleted; deleting a screen leaves its entries in the library.
    static func remove(_ screens: [PanelScreen], _ id: String) -> [PanelScreen] {
        id == home ? screens : screens.filter { $0.id != id }
    }

    /// Screens carry no names: they are Main, Screen 2, Screen 3… by position. (Home is the tab
    /// with the library.)
    static func title(at index: Int) -> String {
        index == 0 ? String(localized: "Main") : String(localized: "Screen \(index + 1)")
    }
}
