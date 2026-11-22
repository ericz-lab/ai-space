import Foundation

/// What the Mac adds to the screens it shares with the iPhone (mobile/ios/AISpace/Core/Screens.swift,
/// ScreenStore.swift): it draws every built-in tile, so a layout copied from the panel keeps them;
/// the window opens on the home screen; and an app installed from the App Store lands there.
///
/// Names, as the code has them: the *library* is the leftmost page (`Pager.home`, "Home" in the
/// menus); the *home screen* (主屏幕) is the first screen of pinned tiles (`Screens.home`, "Main").
enum DesktopScreens {
    /// The home screen of a Space that has stored no screens yet, as the panel seeds it
    /// (src/web/screens.ts `seedScreens`): the first apps, every built-in tile, the first agents
    /// and widgets.
    static func seed(apps: [String], agents: [String], widgets: [String]) -> [PanelScreen] {
        let items = apps.prefix(Screens.seedApps).map { "app:\($0)" } + Builtin.allCases.map(\.key)
            + agents.prefix(Screens.seedAgents).map { "agent:\($0)" } + widgets.prefix(Screens.seedWidgets).map { "widget:\($0)" }
        return [PanelScreen(id: Screens.home, items: items)]
    }

    /// The panel's screens as a browser shows them: the stored ones, or the home screen it would seed.
    static func panel(_ catalogue: Catalogue) -> [PanelScreen] {
        catalogue.screens ?? seed(apps: catalogue.apps.map(\.ref), agents: catalogue.agents.map(\.ref), widgets: catalogue.widgets.map(\.id))
    }

    /// A layout just copied from the panel (`ScreenStore.copy`, which keeps the one built-in tile
    /// the phone draws) with the panel's other built-in tiles back in their places. A built-in
    /// tile this app does not know is left out, as an uninstalled app's is on the panel.
    static func keepingBuiltins(_ copied: [PanelScreen], from panel: [PanelScreen]) -> [PanelScreen] {
        copied.map { screen in
            guard let source = panel.first(where: { $0.id == screen.id }) else { return screen }
            let kept = Set(screen.items)
            var seen = Set<String>()
            let items = source.items.filter { key in
                (kept.contains(key) || Builtin(key: key) != nil) && seen.insert(key).inserted
            }
            // Whatever the copy holds that the panel's screen does not (nothing, today) stays at the end.
            return PanelScreen(id: screen.id, name: screen.name, items: items + screen.items.filter { !seen.contains($0) })
        }
    }

    /// The screen the window opens on for a Space: the home screen, which is the first screen and
    /// holds the pinned tiles. When that one is empty and a later screen is not, the first screen
    /// that holds something; never the library, and never an empty screen while another has tiles.
    static func opening(_ screens: [PanelScreen]) -> String {
        screens.first { !$0.items.isEmpty }?.id ?? Screens.home
    }
}

/// The apps of one Space this Mac has seen, so that one installed since can be told from one that
/// was there all along.
struct InstallWatch: Codable, Equatable {
    /// Entry keys (`app:<id>`) of the apps already accounted for.
    var known: Set<String> = []
    /// Apps that are new and not on the panel's home screen yet, with when they were first seen.
    var fresh: [String: Date] = [:]
}

/// An app installed from the App Store is pinned to the home screen (docs/app-catalog.md). The
/// store is the panel's page, so it pins to the *panel's* home screen; this Mac keeps screens of
/// its own, copied from the panel once, and would never show the new tile. The rule here follows
/// the panel: an app that is new to this Mac and stands on the panel's home screen is pinned to
/// this Mac's home screen too. An app that arrives another way (a link added to the library, a
/// peer's app) is on no screen of the panel and stays in the library here as well.
enum InstallRules {
    /// How long a new app may take to show up on the panel's home screen: the store pins it right
    /// after the install answers, and the catalogue can be read in between.
    static let grace: TimeInterval = 600

    /// - Parameters:
    ///   - watch: what this Mac has seen of the Space; nil the first time, when every app counts as
    ///     known (the layout copied from the panel already has what the panel pinned).
    ///   - apps: entry keys of the catalogue's apps now, in its order.
    ///   - panelHome: entry keys on the panel's home screen now.
    /// - Returns: the watch to keep, and the keys to pin to this Mac's home screen, in the
    ///   catalogue's order.
    static func adopt(_ watch: InstallWatch?, apps: [String], panelHome: [String], now: Date = Date()) -> (watch: InstallWatch, pins: [String]) {
        guard let watch else { return (InstallWatch(known: Set(apps)), []) }
        let onHome = Set(panelHome)
        var next = InstallWatch()
        var pins: [String] = []
        for key in apps where !next.known.contains(key) && next.fresh[key] == nil {
            if watch.known.contains(key) {
                next.known.insert(key)
            } else if onHome.contains(key) {
                pins.append(key)
                next.known.insert(key)
            } else {
                let first = watch.fresh[key] ?? now
                if now.timeIntervalSince(first) > grace { next.known.insert(key) } else { next.fresh[key] = first }
            }
        }
        // An app that left is forgotten, so installing it again pins it again.
        return (next, pins)
    }

    /// The screens with the keys pinned to the home screen; one already there stays where it is.
    static func pinning(_ screens: [PanelScreen], _ keys: [String]) -> [PanelScreen] {
        keys.reduce(screens) { Screens.pin($0, Screens.home, $1) }
    }
}

/// Each Space's `InstallWatch`, kept in the app's preferences on this Mac.
struct InstallWatchStore {
    var defaults: UserDefaults = .standard

    private func key(_ connection: UUID) -> String { "installWatch.\(connection.uuidString)" }

    func watch(_ connection: UUID) -> InstallWatch? {
        defaults.data(forKey: key(connection)).flatMap { try? JSONDecoder().decode(InstallWatch.self, from: $0) }
    }

    func save(_ watch: InstallWatch, _ connection: UUID) {
        if let data = try? JSONEncoder().encode(watch) { defaults.set(data, forKey: key(connection)) }
    }

    func forget(_ connection: UUID) {
        defaults.removeObject(forKey: key(connection))
    }
}

/// The home screen's first-use card (src/web/AppCatalog.tsx `catalogOffers`): how many catalog
/// apps a Space with none of them could install. A Space that has any catalog app, or an old
/// deployment of one, has chosen already; an answer that cannot be read offers nothing.
enum CatalogOffer {
    private struct Body: Decodable {
        struct App: Decodable {
            var installed: Bool?
            var state: String?
        }
        var ok: Bool?
        var apps: Lossy<App>?
    }

    static func count(_ data: Data) -> Int {
        guard let body = try? JSONDecoder().decode(Body.self, from: data), body.ok == true, let apps = body.apps?.elements else { return 0 }
        if apps.contains(where: { $0.installed == true || $0.state == "legacy" }) { return 0 }
        return apps.filter { $0.state == "available" }.count
    }
}
