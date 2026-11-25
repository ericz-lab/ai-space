import SwiftUI

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

/// The panel's own artwork for a built-in tile, as the app carries it: what the tile shows until
/// the Space's icon has loaded, and when it cannot be read. AppKit draws the SVG itself.
@MainActor
enum BuiltinArtwork {
    private static var images: [Builtin: NSImage] = [:]

    static func image(_ builtin: Builtin) -> NSImage? {
        if let image = images[builtin] { return image }
        guard let url = Bundle.main.url(forResource: builtin.rawValue, withExtension: "svg"), let image = NSImage(contentsOf: url) else { return nil }
        images[builtin] = image
        return image
    }
}

/// A built-in window's tile, drawn as an app's.
struct BuiltinTile: View {
    let builtin: Builtin
    /// The icon the Space serves for it (`Builtin.icon(in:)`).
    let icon: String
    let icons: IconStore
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let overArtwork = Theme.current.backdrop != nil
        Button(action: action) {
            VStack(spacing: 7) {
                EntryIcon(icon: icon, fallback: "app", artwork: BuiltinArtwork.image(builtin), icons: icons, size: 64)
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
                Button(on ? "Remove from Screen" : "Add to Screen") { model.togglePin(key, screen: Screens.home, in: connection) }
            }
        } else {
            Menu("Add to Screen") {
                ForEach(Array(screens.enumerated()), id: \.element.id) { index, s in
                    Toggle(isOn: Binding(get: { s.items.contains(key) }, set: { _ in model.togglePin(key, screen: s.id, in: connection) })) {
                        Text(verbatim: Screens.title(at: index))
                    }
                }
            }
        }
    }
}
