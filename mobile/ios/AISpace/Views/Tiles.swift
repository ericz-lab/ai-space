import SwiftUI

/// An icon or avatar from the Space: an emoji, a loaded image, or a symbol while it loads.
/// An app's icon is a rounded square; an agent's avatar is a circle, as a person's is.
struct EntryIcon: View {
    let icon: String?
    let fallback: String
    let icons: IconStore
    var size: CGFloat = 60
    var isRound = false
    @State private var image: UIImage?

    var body: some View {
        let shape = isRound ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
        Group {
            if let emoji = Icon.emoji(icon) {
                Text(verbatim: emoji).font(.system(size: size * 0.52))
                    .frame(width: size, height: size)
                    .background(.regularMaterial, in: shape)
            } else if let image {
                Image(uiImage: image).resizable().scaledToFill().frame(width: size, height: size)
                    .clipShape(shape)
            } else {
                Image(systemName: fallback).font(.system(size: size * 0.4)).foregroundStyle(.secondary)
                    .frame(width: size, height: size)
                    .background(.regularMaterial, in: shape)
            }
        }
        .overlay(shape.stroke(Theme.hairline))
        .accessibilityHidden(true)
        .task(id: icon) { image = icons.image(icon) }
        .onReceive(icons.updates.filter { $0 == nil || $0 == icon }) { changed in
            image = changed == nil ? nil : icons.image(icon)
        }
    }
}

struct EntryTile: View {
    let entry: CatalogueEntry
    let icons: IconStore
    let peer: PeerStatus?
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var artwork: Bool { Theme.current.backdrop != nil }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                EntryIcon(icon: entry.icon, fallback: entry.kind == .agent ? "person.fill" : "app", icons: icons, isRound: entry.kind == .agent)
                    .overlay(alignment: .topTrailing) { badge.offset(x: 4, y: -4) }
                    .opacity(dimmed ? 0.5 : 1)
                Text(verbatim: entry.displayTitle())
                    .font(.caption.weight(artwork ? .semibold : .medium))
                    // Over drawn artwork a name is set like a phone's home screen: white with a soft
                    // dark shadow on the dark versions, the text color without a shadow on the pale light ones.
                    .foregroundStyle(artwork && scheme == .dark ? Color.white : Theme.text)
                    .shadow(color: artwork && scheme == .dark ? Color(hex: 0x0F123C).opacity(0.55) : .clear, radius: 1, y: 1)
                    .multilineTextAlignment(.center).lineLimit(2)
                    .frame(maxWidth: .infinity)
                if let note {
                    Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

    /// Only what is wrong is marked: a tile without a badge is one that answers.
    @ViewBuilder private var badge: some View {
        switch entry.reach {
        case .down: dot(Theme.danger)
        case .peerOffline: symbol("wifi.slash")
        case .paused: symbol("pause.fill")
        case .up, .unknown, .link: EmptyView()
        }
    }

    private func dot(_ color: Color) -> some View {
        Circle().fill(color).frame(width: 12, height: 12).overlay(Circle().strokeBorder(Theme.solid, lineWidth: 2))
    }

    private func symbol(_ name: String) -> some View {
        Image(systemName: name).font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
            .frame(width: 18, height: 18).background(Color.gray, in: Circle())
            .overlay(Circle().strokeBorder(Theme.solid, lineWidth: 2))
    }
}

/// A widget of the Space as a card: its state card when the app sends blocks, its latest rows
/// otherwise, as the Space last read them from the app. A widget drawn by the app itself (an embedded page) opens in the app's page instead.
struct WidgetCard: View {
    let widget: CatalogWidget
    let icons: IconStore
    /// Opens a row's link, or the widget's own page for nil.
    let open: (String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { open(nil) } label: {
                HStack(spacing: 10) {
                    EntryIcon(icon: widget.icon, fallback: "rectangle.3.group", icons: icons, size: 28)
                    Text(verbatim: Lang.pick(widget.title, widget.i18n, \.title)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                    if let peer = widget.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // The head and the rows are apart by space alone, without a rule between them.
            rows.padding(.horizontal, 14).padding(.top, 2).padding(.bottom, 12)
        }
        .glass(bordered: false)
        .opacity(widget.stale == true ? 0.6 : 1)
    }

    @ViewBuilder private var rows: some View {
        if widget.ok == false {
            Label { Text(verbatim: widget.error ?? String(localized: "not answering")) } icon: { Image(systemName: "exclamationmark.circle") }
                .font(.footnote).foregroundStyle(.secondary)
        } else if widget.kind == "embed" {
            Text("Drawn by the app. Open it to see.").font(.footnote).foregroundStyle(.secondary)
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
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(items.prefix(4).enumerated()), id: \.offset) { _, item in
                    Button { open(item.url) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: item.text).font(.subheadline).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 8)
                            if let date = item.time.flatMap(Times.parse) {
                                Text(verbatim: Times.ago(date))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1).layoutPriority(1)
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
            Text("Nothing to show.").font(.footnote).foregroundStyle(.secondary)
        }
    }
}
