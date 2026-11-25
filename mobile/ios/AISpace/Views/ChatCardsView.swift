import Combine
import SwiftUI
#if canImport(UIKit)
import UIKit
private typealias CardImage = UIImage
#else
import AppKit
private typealias CardImage = NSImage
#endif

/// What a client hands the cards of its chat: the Space's icon store (pictures load as the
/// client's icons do, with the Space's session), the app heading the agent's cards and how an
/// item's link opens (as the client opens an app page).
struct ChatCardsContext {
    let icons: IconStore?
    let app: ChatCardApp
    let open: (URL) -> Void
}

private struct ChatCardsContextKey: EnvironmentKey {
    static let defaultValue: ChatCardsContext? = nil
}

extension EnvironmentValues {
    /// Set by the page that shows a conversation; without it a reply draws no cards.
    var chatCards: ChatCardsContext? {
        get { self[ChatCardsContextKey.self] }
        set { self[ChatCardsContextKey.self] = newValue }
    }
}

/// The cards under an agent's reply (docs/chat-cards.md), shared by the Mac and the iPhone: each a
/// narrow solid frame headed by the app that did it, its items in the card's style (plan 11.3).
struct ChatCardsView: View {
    let cards: [ShownChatCard]
    /// The reply is the conversation's latest: its cards may act while their token is good.
    let actionable: Bool
    /// The conversation's card stores.
    let stores: ChatCardStores
    @Environment(\.chatCards) private var context

    var body: some View {
        if let context, !cards.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(cards) { shown in
                    ChatCardView(store: stores.store(for: shown), actionable: actionable, context: context)
                }
            }
        }
    }
}

private enum CardStrings {
    static var undo: String { String(localized: "chat.card.undo", defaultValue: "Undo") }
    static var undone: String { String(localized: "chat.card.undone", defaultValue: "Undone") }
    static var done: String { String(localized: "chat.card.done", defaultValue: "Done") }
    static var changed: String { String(localized: "chat.card.changed", defaultValue: "Changed elsewhere") }

    static func label(_ label: ChatCardRules.UndoLabel) -> String {
        switch label {
        case .one: return undo
        case .all: return String(localized: "chat.card.undoAll", defaultValue: "Undo all")
        case .rest(let n): return String(format: String(localized: "chat.card.undoRest", defaultValue: "Undo the other %lld"), n)
        }
    }

    static func undoItem(_ title: String) -> String {
        String(format: String(localized: "chat.card.undoItem", defaultValue: "Undo: %@"), title)
    }
}

/// The interface language for the agenda's weekday and month: the app's own localization.
private var cardLang: String {
    (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh") ? "zh" : "en"
}

private struct ChatCardView: View {
    @ObservedObject var store: ChatCardStore
    let actionable: Bool
    let context: ChatCardsContext

    private var card: ChatCard { store.shown.card }
    private var canUndo: Bool { ChatCardRules.canUndo(store.shown, actionable: actionable, readOnly: store.readOnly) }
    private var items: [ChatCardShownItem] { card.items.map { ChatCardRules.shown($0, store.states[$0.id]) } }
    private var many: Bool { card.items.count > 1 }
    private static let radius: CGFloat = 12

    var body: some View {
        let open = ChatCardRules.open(card, states: store.states, canUndo: canUndo)
        VStack(alignment: .leading, spacing: 0) {
            header(open: open)
            if card.kind == "value", let text = card.text {
                Theme.hairline.frame(height: 1)
                Text(verbatim: text).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.text)
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !items.isEmpty {
                Theme.hairline.frame(height: 1)
                styled
            }
            if let note = store.note {
                Text(verbatim: note).font(.system(size: 12))
                    .foregroundStyle(store.readOnly ? Color.secondary : Theme.danger)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .top) { Theme.hairline.frame(height: 1) }
            }
        }
        .background(Theme.solid, in: RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Self.radius, style: .continuous).strokeBorder(Theme.hairline))
        .frame(maxWidth: 460, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: [context.app.name, card.title].compactMap { $0 }.joined(separator: ": ")))
        // The state is read each time the card is shown, so it always says what is true now.
        .task(id: store.shown.id) { await store.refresh() }
    }

    private func header(open: [String]) -> some View {
        HStack(spacing: 8) {
            if let icon = context.app.icon, let icons = context.icons {
                EntryIcon(icon: icon, fallback: "square.grid.2x2", icons: icons, size: 20)
            }
            if let name = context.app.name {
                Text(verbatim: name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    .layoutPriority(1)
            }
            if let title = card.title {
                Text(verbatim: title).font(.system(size: 13)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if !open.isEmpty {
                Button { Task { await store.undo(open) } } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.uturn.backward").font(.system(size: 11, weight: .semibold))
                        Text(verbatim: CardStrings.label(ChatCardRules.undoLabel(total: card.items.count, open: open.count)))
                            .font(.system(size: 12, weight: .medium)).lineLimit(1)
                    }
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 10).frame(height: 26)
                    .overlay(Capsule().strokeBorder(Theme.hairline))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(store.busy)
                .fixedSize()
            }
        }
        .padding(.horizontal, 14).frame(minHeight: 44)
    }

    @ViewBuilder private var styled: some View {
        switch card.style {
        case .rows: rows
        case .compact: compact
        case .gallery: ChatCardGallery(items: items, many: many, canUndo: canUndo, store: store, context: context)
        case .agenda: agenda
        case .stat: stat
        }
    }

    // MARK: rows

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Theme.hairline.frame(height: 1) }
                line(item) {
                    leading(item)
                } text: {
                    VStack(alignment: .leading, spacing: 2) {
                        titleText(item)
                        ChatCardMeta(segments: rowSegments(item), tags: item.tags, id: item.id)
                        if let progress = item.progress { ChatCardProgress(value: progress).padding(.top, 4) }
                    }
                }
            }
        }
    }

    private func rowSegments(_ item: ChatCardShownItem) -> [ChatCardMeta.Segment] {
        var out: [ChatCardMeta.Segment] = []
        if let when = item.when { out.append(.when(when)) }
        return out + item.detailSegments.map { ChatCardMeta.Segment.text($0) }
    }

    private func agendaSegments(_ item: ChatCardShownItem) -> [ChatCardMeta.Segment] {
        var out: [ChatCardMeta.Segment] = []
        if item.status != .removed, let time = item.date?.time { out.append(.time(time)) }
        return out + item.detailSegments.map { ChatCardMeta.Segment.text($0) }
    }

    @ViewBuilder private func leading(_ item: ChatCardShownItem, image allowed: Bool = true) -> some View {
        if allowed, let image = item.image {
            // A picture stands where the circle would; done and removed show as the pill.
            ChatCardPicture(source: image, icons: context.icons)
                .frame(width: 36, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        } else if item.status == .active, let icon = item.icon {
            Image(systemName: icon.symbol).font(.system(size: 16)).foregroundStyle(.secondary).frame(width: 20, height: 20)
        } else {
            ChatCardMark(status: item.status)
        }
    }

    /// One rows or agenda row: the leading mark, the text, then the pill, the undo button or the
    /// chevron; read-only with a link, the whole row opens it.
    @ViewBuilder private func line<Lead: View, Words: View>(_ item: ChatCardShownItem, @ViewBuilder lead: () -> Lead, @ViewBuilder text: () -> Words) -> some View {
        let undoable = ChatCardRules.undoable(item.id, states: store.states, canUndo: canUndo)
        let rowUndo = ChatCardRules.rowUndo(style: card.style, many: many, undoable: undoable)
        let rowLink = ChatCardRules.rowLink(canUndo: canUndo, url: item.url)
        let content = HStack(alignment: .center, spacing: 10) {
            lead()
            text().frame(maxWidth: .infinity, alignment: .leading)
            if let pill = item.pill { ChatCardPill(pill: pill) }
            if rowUndo {
                Button { Task { await store.undo([item.id]) } } label: {
                    Image(systemName: "arrow.uturn.backward").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.busy)
                .help(Text(verbatim: CardStrings.undo))
                .accessibilityLabel(Text(verbatim: CardStrings.undoItem(item.title)))
            }
            if rowLink && item.pill == nil {
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(minHeight: 52)
        .background(item.status == .removed ? Theme.text.opacity(0.04) : Color.clear)
        if rowLink, let url = item.url.flatMap(URL.init(string:)) {
            Button { context.open(url) } label: { content.contentShape(Rectangle()) }.buttonStyle(.plain)
        } else {
            content
        }
    }

    /// The title; while the card can act and the item has a link, the title is that link.
    @ViewBuilder private func titleText(_ item: ChatCardShownItem) -> some View {
        let text = Text(verbatim: item.title).font(.system(size: 14, weight: .medium))
            .strikethrough(item.status == .removed)
            .foregroundStyle(item.status == .removed ? Color.secondary : Theme.text)
            .lineLimit(2)
        if canUndo, let url = item.url.flatMap(URL.init(string:)) {
            Button { context.open(url) } label: { text }.buttonStyle(.plain)
        } else {
            text
        }
    }

    // MARK: compact

    private var compact: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Theme.hairline.frame(height: 1) }
                let row = HStack(spacing: 10) {
                    ChatCardDot(status: item.status)
                    Text(verbatim: item.title).font(.system(size: 14)).lineLimit(1).truncationMode(.tail)
                        .strikethrough(item.status == .removed)
                        .foregroundStyle(item.status == .removed ? Color.secondary : Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let value = item.compactValue {
                        Text(verbatim: value).font(.system(size: 12)).monospacedDigit().foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .padding(.horizontal, 14).frame(height: 36)
                if let url = item.url.flatMap(URL.init(string:)) {
                    Button { context.open(url) } label: { row.contentShape(Rectangle()) }.buttonStyle(.plain)
                } else {
                    row
                }
            }
        }
    }

    // MARK: agenda

    private var agenda: some View {
        let shown = items
        return VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { i, item in
                if i > 0 { Theme.hairline.frame(height: 1) }
                line(item) {
                    HStack(spacing: 8) {
                        ChatCardDateBlock(date: ChatCardRules.showsDateBlock(shown, at: i) ? item.date : nil)
                        leading(item, image: false)
                    }
                } text: {
                    VStack(alignment: .leading, spacing: 2) {
                        titleText(item)
                        // No `when` here: the date block says it.
                        ChatCardMeta(segments: agendaSegments(item), tags: item.tags, id: item.id)
                    }
                }
            }
        }
    }

    // MARK: stat

    private var stat: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 96), spacing: 0)], spacing: 0) {
            ForEach(items) { item in
                let cell = VStack(alignment: .leading, spacing: 4) {
                    // 22 points: the web's size (plan 11.3 says 24, which its type scale does not have).
                    Text(verbatim: item.value ?? "").font(.system(size: 22, weight: .bold)).monospacedDigit()
                        .strikethrough(item.status == .removed)
                        .foregroundStyle(Theme.text).lineLimit(1).minimumScaleFactor(0.6)
                    HStack(spacing: 6) {
                        Text(verbatim: item.title).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        if let tag = item.tags.first { ChatCardTagView(tag: tag) }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                // A removed cell fades and its value is struck through; there is no pill.
                .opacity(item.status == .removed ? 0.4 : 1)
                .overlay(alignment: .leading) { Theme.hairline.frame(width: 1) }
                .overlay(alignment: .top) { Theme.hairline.frame(height: 1) }
                if let url = item.url.flatMap(URL.init(string:)) {
                    Button { context.open(url) } label: { cell.contentShape(Rectangle()) }.buttonStyle(.plain)
                } else {
                    cell
                }
            }
        }
        // The grid's own outer edges are the card's: hide the first column's and row's lines.
        .padding(.leading, -1).padding(.top, -1)
        .clipped()
    }
}

/// The gallery (plan 11.3): a grid of pictures, three columns or two when narrow, each cell's title
/// and grey line under its 4:3 picture; the whole cell opens the item.
private struct ChatCardGallery: View {
    let items: [ChatCardShownItem]
    let many: Bool
    let canUndo: Bool
    @ObservedObject var store: ChatCardStore
    let context: ChatCardsContext
    @State private var width: CGFloat = 400

    var body: some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: ChatCardRules.galleryColumns(width: width))
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(items) { cell($0) }
        }
        .padding(12)
        .background(GeometryReader { proxy in
            Color.clear.onAppear { width = proxy.size.width }.onChange(of: proxy.size.width) { _, w in width = w }
        })
    }

    @ViewBuilder private func cell(_ item: ChatCardShownItem) -> some View {
        let undoable = ChatCardRules.undoable(item.id, states: store.states, canUndo: canUndo)
        let content = VStack(alignment: .leading, spacing: 4) {
            Color.clear.aspectRatio(4 / 3, contentMode: .fit)
                .overlay { ChatCardPicture(source: item.image ?? "", icons: context.icons) }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .opacity(item.status == .removed ? 0.4 : 1)
                // Undone at the picture's top left; the undo button is at its top right.
                .overlay(alignment: .topLeading) {
                    if item.status == .removed { ChatCardPill(pill: .undone).padding(6) }
                }
            Text(verbatim: item.title).font(.system(size: 13)).strikethrough(item.status == .removed)
                .foregroundStyle(item.status == .removed ? Color.secondary : Theme.text).lineLimit(1)
            if let sub = item.gallerySubtitle {
                Text(verbatim: sub).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        ZStack(alignment: .topTrailing) {
            if let url = item.url.flatMap(URL.init(string:)) {
                Button { context.open(url) } label: { content.contentShape(Rectangle()) }.buttonStyle(.plain)
            } else {
                content
            }
            if ChatCardRules.rowUndo(style: .gallery, many: many, undoable: undoable) {
                Button { Task { await store.undo([item.id]) } } label: {
                    Image(systemName: "arrow.uturn.backward").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                        .frame(width: 28, height: 28)
                        .background(Color.black.opacity(0.45), in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(store.busy)
                .padding(6)
                .help(Text(verbatim: CardStrings.undo))
                .accessibilityLabel(Text(verbatim: CardStrings.undoItem(item.title)))
            }
        }
    }
}

/// The circle before a rows item: open while active, filled with a check when done, dashed when removed.
private struct ChatCardMark: View {
    let status: ChatCardShownItem.Status

    var body: some View {
        ZStack {
            switch status {
            case .active:
                Circle().strokeBorder(Color.secondary.opacity(0.6), lineWidth: 1.5)
            case .done:
                Circle().fill(Theme.success)
                Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(.white)
            case .removed:
                Circle().strokeBorder(Color.secondary.opacity(0.5), style: StrokeStyle(lineWidth: 1.5, dash: [2.5, 2.5]))
            }
        }
        .frame(width: 18, height: 18)
        .frame(width: 20)
        .accessibilityHidden(true)
    }
}

/// The 6-point dot of a compact row: secondary while active, the success colour when done, hollow when removed.
private struct ChatCardDot: View {
    let status: ChatCardShownItem.Status

    var body: some View {
        Group {
            switch status {
            case .active: Circle().fill(Color.secondary)
            case .done: Circle().fill(Theme.success)
            case .removed: Circle().strokeBorder(Color.secondary, lineWidth: 1)
            }
        }
        .frame(width: 6, height: 6)
        .accessibilityHidden(true)
    }
}

/// Undone, Changed elsewhere, Done.
private struct ChatCardPill: View {
    let pill: ChatCardShownItem.Pill

    var body: some View {
        let (text, color): (String, Color) = switch pill {
        case .undone: (CardStrings.undone, Color.secondary)
        case .changed: (CardStrings.changed, Theme.warning)
        case .done: (CardStrings.done, Theme.success)
        }
        Text(verbatim: text).font(.system(size: 11, weight: .medium)).lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, 8).frame(height: 20)
            .background(color.opacity(0.16), in: Capsule())
            .fixedSize()
    }
}

/// A tag: 18 points high, 7 points either side, round, 12-point text in its tone.
struct ChatCardTagView: View {
    let tag: ChatCardTag

    var body: some View {
        let color: Color = switch tag.tone {
        case .neutral: Color.secondary
        case .accent: Theme.accent
        case .positive: Theme.success
        case .warning: Theme.warning
        case .negative: Theme.danger
        }
        Text(verbatim: tag.text).font(.system(size: 12)).lineLimit(1)
            .foregroundStyle(color)
            .padding(.horizontal, 7).frame(height: 18)
            .background(color.opacity(tag.tone == .neutral ? 0.12 : 0.15), in: Capsule())
            .fixedSize()
    }
}

/// The secondary line: `when` with its calendar glyph (or the agenda's time), the detail's
/// segments, the tags and `#id`, wrapping when they do not fit.
private struct ChatCardMeta: View {
    enum Segment: Hashable {
        case when(String)
        case time(String)
        case text(String)
    }

    let segments: [Segment]
    let tags: [ChatCardTag]
    let id: String

    var body: some View {
        ChatCardFlow(spacing: 8, lineSpacing: 3) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .when(let text):
                    HStack(spacing: 3) {
                        Image(systemName: "calendar").font(.system(size: 11))
                        Text(verbatim: text)
                    }
                case .time(let text):
                    Text(verbatim: text).monospacedDigit()
                case .text(let text):
                    Text(verbatim: text)
                }
            }
            ForEach(Array(tags.enumerated()), id: \.offset) { _, tag in ChatCardTagView(tag: tag) }
            Text(verbatim: "#" + id)
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// The 3-point bar under a rows item: the hairline's colour, filled with the accent.
private struct ChatCardProgress: View {
    let value: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.hairline)
                Capsule().fill(Theme.accent).frame(width: proxy.size.width * min(1, max(0, value)))
            }
        }
        .frame(height: 3)
        .accessibilityElement()
        .accessibilityValue(Text(verbatim: "\(Int((value * 100).rounded()))%"))
    }
}

/// The agenda's 44-point date block: the day, the weekday and, for another month or year, the
/// month; empty for an item on the same day as the one before.
private struct ChatCardDateBlock: View {
    let date: ChatCardDate?

    var body: some View {
        VStack(spacing: 0) {
            if let date {
                Text(verbatim: "\(date.day)").font(.system(size: 18, weight: .bold)).monospacedDigit().foregroundStyle(Theme.text)
                Text(verbatim: date.weekday(lang: cardLang)).font(.system(size: 11)).foregroundStyle(.secondary)
                if date.needsMonth() {
                    Text(verbatim: date.monthName(lang: cardLang)).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: 44)
    }
}

/// An app's picture, loaded as the client's icons are; until it loads, or when it cannot, the
/// hairline's colour with the image glyph in the middle.
private struct ChatCardPicture: View {
    let source: String
    let icons: IconStore?
    @State private var image: CardImage?

    var body: some View {
        ZStack {
            if let image {
                #if canImport(UIKit)
                Image(uiImage: image).resizable().scaledToFill()
                #else
                Image(nsImage: image).resizable().interpolation(.high).scaledToFill()
                #endif
            } else {
                Theme.hairline
                Image(systemName: "photo").font(.system(size: 14)).foregroundStyle(.secondary)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        .clipped()
        .accessibilityHidden(true)
        .task(id: source) { image = icons?.image(source) }
        .onReceive(icons?.updates.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { changed in
            guard changed == nil || changed == source else { return }
            image = changed == nil ? nil : icons?.image(source)
        }
    }
}

/// Lays its children out in lines, wrapping to the next when one does not fit.
private struct ChatCardFlow: Layout {
    var spacing: CGFloat
    var lineSpacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = place(subviews, width: proposal.width ?? .infinity)
        let width = frames.map(\.maxX).max() ?? 0
        let height = frames.map(\.maxY).max() ?? 0
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, place(subviews, width: bounds.width)) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }

    private func place(_ subviews: Subviews, width: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            size.width = min(size.width, width)
            if x > 0, x + size.width > width {
                x = 0
                y += line + lineSpacing
                line = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            line = max(line, size.height)
        }
        // Items of one line sit on its middle.
        var out = frames
        var start = 0
        while start < out.count {
            var end = start
            while end + 1 < out.count, out[end + 1].minY == out[start].minY { end += 1 }
            let height = out[start...end].map(\.height).max() ?? 0
            for i in start...end { out[i].origin.y += (height - out[i].height) / 2 }
            start = end + 1
        }
        return out
    }
}
