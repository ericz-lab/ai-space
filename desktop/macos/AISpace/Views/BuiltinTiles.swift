import SwiftUI

/// The panel's own windows as tiles (src/web/screens.ts `BUILTINS`): in the library's Apps section
/// after the apps, and pinned to a screen as `builtin:<name>` like any other tile, so a layout
/// copied from the panel keeps them. The Mac has no Shortcuts window, so it has no such tile.
enum Builtin: String, CaseIterable, Identifiable {
    case inbox, terminal, settings

    var id: String { rawValue }
    var key: String { "builtin:\(rawValue)" }

    init?(key: String) {
        guard key.hasPrefix("builtin:") else { return nil }
        self.init(rawValue: String(key.dropFirst("builtin:".count)))
    }

    var title: String {
        switch self {
        case .inbox: return String(localized: "Inbox")
        case .terminal: return String(localized: "Terminal")
        case .settings: return String(localized: "Settings")
        }
    }

    /// The icon the Space serves for it (`/api/apps` `builtins`, the defaults of src/web/api.ts).
    var icon: String { "/\(rawValue).svg" }

    var symbol: String {
        switch self {
        case .inbox: return "tray.fill"
        case .terminal: return "terminal.fill"
        case .settings: return "gearshape.fill"
        }
    }

    func matches(_ query: String) -> Bool {
        let q = query.lowercased()
        return title.lowercased().contains(q) || rawValue.contains(q)
    }
}

/// A tile of a launcher grid: an app or agent of the catalogue, or one of the panel's own windows.
enum LauncherTile: Identifiable {
    case entry(CatalogueEntry)
    case builtin(Builtin)

    var id: String {
        switch self {
        case .entry(let e): return e.key
        case .builtin(let b): return b.key
        }
    }
}

/// A built-in window's tile, drawn as an app's.
struct BuiltinTile: View {
    let builtin: Builtin
    let icons: IconStore
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let overArtwork = Theme.current.backdrop != nil
        Button(action: action) {
            VStack(spacing: 7) {
                EntryIcon(icon: builtin.icon, fallback: builtin.symbol, icons: icons, size: 64)
                Text(verbatim: builtin.title)
                    .font(.callout.weight(overArtwork ? .semibold : .medium))
                    .foregroundStyle(overArtwork && scheme == .dark ? Color.white : Theme.text)
                    .shadow(color: overArtwork && scheme == .dark ? Color(hex: 0x0F123C).opacity(0.55) : .clear, radius: 1, y: 1)
                    .multilineTextAlignment(.center).lineLimit(2)
                    .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: builtin.title))
    }
}

/// A right click on a built-in tile: open it, and put it on or take it off the screens.
struct PinMenu: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var store: ScreenStore
    let key: String
    /// The screen the tile was clicked on; nil in the library.
    let screen: String?
    let open: () -> Void

    var body: some View {
        let screens = store.screens(connection.id)
        Button("Open", action: open)
        Divider()
        if let screen {
            Button("Remove from This Screen") { model.togglePin(key, screen: screen, in: connection) }
        }
        if screens.count <= 1 {
            if screen == nil {
                let on = Screens.isPinned(screens, Screens.home, key)
                Button(on ? "Remove from Panel" : "Add to Panel") { model.togglePin(key, screen: Screens.home, in: connection) }
            }
        } else {
            Menu("Add to Panel") {
                ForEach(Array(screens.enumerated()), id: \.element.id) { index, s in
                    Toggle(isOn: Binding(get: { s.items.contains(key) }, set: { _ in model.togglePin(key, screen: s.id, in: connection) })) {
                        Text(verbatim: Screens.title(at: index))
                    }
                }
            }
        }
    }
}
