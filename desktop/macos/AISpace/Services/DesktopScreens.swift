import Foundation

/// What the Mac adds to the screens it shares with the iPhone (mobile/ios/AISpace/Core/Screens.swift,
/// ScreenStore.swift): it draws every built-in tile, so a layout copied from the panel keeps them;
/// and the window opens on the home screen.
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
