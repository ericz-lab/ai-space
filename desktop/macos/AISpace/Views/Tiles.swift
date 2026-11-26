import Combine
import SwiftUI

/// The image of one icon as the icon store has it, followed as it loads (view state lives in an
/// object: the Command Line Tools cannot expand `@State`).
@MainActor
final class IconImage: ObservableObject {
    @Published private(set) var image: NSImage?
    private var icon: String?
    private var icons: IconStore?
    private var watcher: AnyCancellable?

    func show(_ icon: String?, from icons: IconStore) {
        guard icon != self.icon || icons !== self.icons else { return }
        self.icon = icon
        self.icons = icons
        image = icons.image(icon)
        watcher = icons.updates.filter { $0 == nil || $0 == icon }.sink { [weak self] changed in
            guard let self else { return }
            self.image = changed == nil ? nil : icons.image(icon)
        }
    }
}

/// An icon or avatar from the Space: an emoji, a loaded image, or a symbol while it loads.
/// An app's icon is a rounded square; an agent's avatar is a circle, as a person's is.
struct EntryIcon: View {
    let icon: String?
    let fallback: String
    /// A drawing the app carries for this icon, shown in place of the symbol while the Space's
    /// icon loads or cannot be read (the built-in tiles' own artwork).
    var artwork: NSImage?
    let icons: IconStore
    var size: CGFloat = 60
    var isRound = false
    @StateObject private var loaded = IconImage()

    var body: some View {
        let shape = isRound ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
        Group {
            if let emoji = Icon.emoji(icon) {
                Text(verbatim: emoji).font(.system(size: size * 0.52))
                    .frame(width: size, height: size)
                    .background(.regularMaterial, in: shape)
            } else if let image = loaded.image ?? artwork {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFill().frame(width: size, height: size)
                    .clipShape(shape)
            } else {
                Image(systemName: fallback).font(.system(size: size * 0.4)).foregroundStyle(.secondary)
                    .frame(width: size, height: size)
                    .background(.regularMaterial, in: shape)
            }
        }
        .overlay(shape.stroke(Theme.hairline))
        .accessibilityHidden(true)
        .onAppear { loaded.show(icon, from: icons) }
        .onChange(of: icon) { _, icon in loaded.show(icon, from: icons) }
    }
}

/// An app, agent or widget of the library or a screen: its icon over its name, and only what is
/// wrong marked on it (not answering, paused, its machine offline).
struct EntryTile: View {
    let entry: CatalogueEntry
    let icons: IconStore
    /// The library's tiles show their details under the pointer; a screen's show none.
    var details = false
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                EntryIcon(icon: entry.icon, fallback: entry.kind == .agent ? "person.fill" : "app", icons: icons, size: 64, isRound: entry.kind == .agent)
                    .overlay(alignment: .topTrailing) { badge.offset(x: 4, y: -4) }
                    .opacity(dimmed ? 0.5 : 1)
                Text(verbatim: entry.displayTitle())
                    .font(.callout.weight(overArtwork ? .semibold : .medium))
                    // Over drawn artwork a name is set like a phone's home screen: white with a soft
                    // dark shadow over the dark versions, the text colour alone over the pale ones.
                    .foregroundStyle(overArtwork && scheme == .dark ? Color.white : Theme.text)
                    .shadow(color: overArtwork && scheme == .dark ? Color(hex: 0x0F123C).opacity(0.55) : .clear, radius: 1, y: 1)
                    .shadow(color: overArtwork && scheme == .dark ? Color(hex: 0x0F123C).opacity(0.35) : .clear, radius: 2.5)
                    .multilineTextAlignment(.center).lineLimit(2)
                    .frame(maxWidth: .infinity)
                if let note {
                    Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(details ? detailText : "")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: entry.displayTitle()))
        .accessibilityValue(Text(stateLabel))
        .accessibilityAddTraits(.isButton)
    }

    private var overArtwork: Bool { Theme.current.backdrop != nil }

    /// What the pointer shows over a library tile: the name, its state and peer, its description.
    private var detailText: String {
        let state = [stateLabel, entry.reach == .up || entry.reach == .unknown || entry.reach == .link ? nil : entry.peer]
            .compactMap { $0 }.filter { !$0.isEmpty }
        return ([entry.displayTitle(), state.isEmpty ? nil : state.joined(separator: " · "), entry.displayDetail()].compactMap { $0 })
            .joined(separator: "\n")
    }

    private var dimmed: Bool { entry.reach == .peerOffline || entry.reach == .paused }

    /// The line under the title: the peer the entry lives on, or why it will not answer.
    private var note: String? {
        switch entry.reach {
        case .down: return String(localized: "not answering")
        case .paused: return String(localized: "paused")
        case .peerOffline: return entry.peer.map { String(localized: "\($0) offline") } ?? String(localized: "offline")
        default: return entry.peer
        }
    }

    private var stateLabel: String {
        switch entry.reach {
        case .up: return String(localized: "running")
        case .unknown, .link: return entry.peer ?? ""
        default: return note ?? ""
        }
    }

    @ViewBuilder private var badge: some View {
        switch entry.reach {
        case .down: Circle().fill(Theme.danger).frame(width: 12, height: 12).overlay(Circle().strokeBorder(Theme.solid, lineWidth: 2))
        case .peerOffline: symbol("wifi.slash")
        case .paused: symbol("pause.fill")
        case .up, .unknown, .link: EmptyView()
        }
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
            .frame(width: 18, height: 18).background(Color.gray, in: Circle())
            .overlay(Circle().strokeBorder(Theme.solid, lineWidth: 2))
    }
}

/// How the API's instants read in the app (docs/time.md).
enum Times {
    /// "2h ago"; an instant within the last minute, or one a skewed clock puts ahead, is "now".
    static func ago(_ date: Date, now: Date = Date()) -> String {
        if date > now.addingTimeInterval(-60) { return String(localized: "now") }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
    }

    static func parse(_ text: String) -> Date? { ISO8601.parse(text) }
}
