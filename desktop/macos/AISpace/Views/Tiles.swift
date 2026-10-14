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
            } else if let image = loaded.image {
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
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                EntryIcon(icon: entry.icon, fallback: entry.kind == .agent ? "person.fill" : "app", icons: icons, size: 64, isRound: entry.kind == .agent)
                    .overlay(alignment: .topTrailing) { badge.offset(x: 4, y: -4) }
                    .opacity(dimmed ? 0.5 : 1)
                Text(verbatim: entry.displayTitle())
                    .font(.callout.weight(.medium)).foregroundStyle(Theme.text)
                    // Over drawn artwork a name gets an edge in the ground colour to stay readable.
                    .shadow(color: Theme.current.backdrop == nil ? .clear : Theme.ground.opacity(0.9), radius: 2)
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
        .help(entry.displayDetail() ?? entry.displayTitle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: entry.displayTitle()))
        .accessibilityValue(Text(stateLabel))
        .accessibilityAddTraits(.isButton)
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

/// A widget of the Space as a card: its state card when the app sends blocks, its latest rows
/// otherwise, as the Space last read them from the app.
struct WidgetCard: View {
    let widget: CatalogWidget
    let icons: IconStore
    /// Opens a row's link, or the widget's own page for nil.
    let open: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open(nil) } label: {
                HStack(spacing: 10) {
                    EntryIcon(icon: widget.icon, fallback: "rectangle.3.group", icons: icons, size: 26)
                    Text(verbatim: Lang.pick(widget.title, widget.i18n, \.title)).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                    if let peer = widget.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Divider()
            rows.padding(.horizontal, 14).padding(.vertical, 11)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass()
        .opacity(widget.stale == true ? 0.6 : 1)
    }

    @ViewBuilder private var rows: some View {
        if widget.ok == false {
            Label { Text(verbatim: widget.error ?? String(localized: "not answering")) } icon: { Image(systemName: "exclamationmark.circle") }
                .font(.callout).foregroundStyle(.secondary)
        } else if widget.kind == "embed" {
            Text("Drawn by the app. Open it to see.").font(.callout).foregroundStyle(.secondary)
        } else if let blocks = widget.blocks?.elements, !blocks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                WidgetBlocksView(blocks: blocks, size: widget.size, open: { open($0) })
                if widget.stale == true {
                    Text("Last known; its machine is offline.").font(.caption).foregroundStyle(.secondary)
                } else if WidgetLayout.isOutdated(asOf: widget.asOf, staleAfterMs: widget.staleAfterMs), let date = widget.asOf.flatMap(Times.parse) {
                    Text("Updated \(Times.ago(date))").font(.caption).foregroundStyle(.secondary)
                }
            }
        } else if let items = widget.items, !items.isEmpty {
            VStack(alignment: .leading, spacing: 9) {
                ForEach(Array(items.prefix(widget.size == "1x2" || widget.size == "2x2" ? 8 : 4).enumerated()), id: \.offset) { _, item in
                    Button { open(item.url) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: item.text).font(.callout).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            if let date = item.time.flatMap(Times.parse) {
                                Text(verbatim: Times.ago(date)).font(.caption).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if widget.stale == true {
                    Text("Last known; its machine is offline.").font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("Nothing to show.").font(.callout).foregroundStyle(.secondary)
        }
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
