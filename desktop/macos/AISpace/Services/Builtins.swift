import Foundation

/// The panel's own tiles (src/web/screens.ts `BUILTINS`), in the order the library and a seeded
/// home screen show them: in the library's Apps section after the apps, and pinned to a screen as
/// `builtin:<name>` like any other tile, so a layout copied from the panel keeps them.
enum Builtin: String, CaseIterable, Identifiable {
    case store, inbox, shortcuts, terminal, settings

    var id: String { rawValue }
    var key: String { "builtin:\(rawValue)" }

    init?(key: String) {
        guard key.hasPrefix("builtin:") else { return nil }
        self.init(rawValue: String(key.dropFirst("builtin:".count)))
    }

    var title: String {
        switch self {
        case .store: return String(localized: "App Store")
        case .inbox: return String(localized: "Inbox")
        case .shortcuts: return String(localized: "Shortcuts")
        case .terminal: return String(localized: "Terminal")
        case .settings: return String(localized: "Settings")
        }
    }

    /// The panel's own artwork for the tile (src/web/public/<name>.svg), which every Space serves
    /// at this path and the app carries a copy of (scripts/build.sh, project.yml).
    var defaultIcon: String { "/\(rawValue).svg" }

    /// The icon the Space shows for the tile now: `builtins` of `/api/apps`, which is the active
    /// icon pack's file when the pack covers the tile (docs/panel.md#icon-packs), else the panel's
    /// own artwork. A Space older than `builtins`, or than this tile, has the default.
    func icon(in served: [String: String]) -> String {
        guard let icon = served[rawValue], !icon.isEmpty else { return defaultIcon }
        return icon
    }

    /// The page of the web panel that is this tile's window (docs/panel.md#built-in-pages), for
    /// the two the app does not draw itself; nil for the ones it draws.
    var page: String? {
        switch self {
        case .store, .shortcuts: return "/?page=\(rawValue)"
        case .inbox, .terminal, .settings: return nil
        }
    }

    /// The tab id of a tile's web page among the open apps; no app's id has a colon.
    static func isTab(_ id: String) -> Bool { Builtin(key: id) != nil }

    func matches(_ query: String) -> Bool {
        let q = query.lowercased()
        return title.lowercased().contains(q) || rawValue.contains(q)
    }
}
