import AppKit
import SwiftUI

/// What a card lets its blocks do (src/web/WidgetBlocks.tsx `BlockCtx`). `live`: the controls respond
/// (not while the screen is arranged, not in the library). `acts`: the write-back controls are drawn
/// (a widget of this Space); `actLive`: they respond.
struct BlockContext {
    var live = false
    var acts = false
    var actLive = false
    /// The action being sent, if any: the others wait.
    var busy: String?
    /// Checks ticked while their action is on the way.
    var ticked: Set<String> = []
    var onAction: (WidgetAction) -> Void = { _ in }

    static let inert = BlockContext()

    func check(_ b: WidgetBlock) -> WidgetAction? { acts && b.action?.kind == .check ? b.action : nil }
    func button(_ b: WidgetBlock) -> WidgetAction? { acts && b.action?.kind == .button ? b.action : nil }
    /// Whether the block draws a control of its own (its link then covers the block without wrapping the controls).
    func hasControl(_ b: WidgetBlock) -> Bool { b.copy != nil || (acts && b.action != nil) }
    func isDone(_ b: WidgetBlock) -> Bool { check(b).map { ticked.contains($0.id) } ?? false }
}

/// The values that changed since the last payload, by block: they flash once (`n` restarts it).
struct BlockFlash: Equatable {
    var n: Int
    var marks: [BlockChange?]

    func mark(_ i: Int) -> (change: BlockChange, n: Int)? {
        guard i < marks.count, let c = marks[i] else { return nil }
        return (c, n)
    }
}

/// Whether the parts that grow in (bars, gauge, tanks, the hero's number, a chart) have grown: false
/// for the moment a card's blocks first appear, or a view or a page changes, then true.
private struct WidgetEntranceKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var widgetEntered: Bool {
        get { self[WidgetEntranceKey.self] }
        set { self[WidgetEntranceKey.self] = newValue }
    }
}

/// Plays the entrance once, when the view it wraps appears; still under Reduce Motion.
private struct Entrance: ViewModifier {
    let enabled: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.widgetEntered) private var parent
    @State private var entered = false

    func body(content: Content) -> some View {
        content
            // Not enabled, it passes the entrance around it on.
            .environment(\.widgetEntered, parent && (entered || !enabled || reduceMotion))
            .onAppear {
                guard enabled, !reduceMotion, !entered else { return }
                withAnimation(.easeOut(duration: 0.6)) { entered = true }
            }
    }
}

/// A changed value: tinted up or down, or a soft highlight behind changed text, for about a second.
private struct FlashValue: ViewModifier {
    let flash: (change: BlockChange, n: Int)?
    let base: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    func body(content: Content) -> some View {
        let tint: Color? = on ? (flash?.change == .up ? Theme.tonePositive : flash?.change == .down ? Theme.toneNegative : nil) : nil
        content
            .foregroundStyle(tint ?? base)
            .background(RoundedRectangle(cornerRadius: 4).fill(Theme.text.opacity(on && flash?.change == .text ? 0.12 : 0)).padding(-2))
            .task(id: flash?.n ?? 0) {
                guard let flash, flash.n > 0, !reduceMotion else { return }
                on = true
                try? await Task.sleep(for: .milliseconds(420))
                withAnimation(.easeOut(duration: 0.78)) { on = false }
            }
    }
}

private extension View {
    func flashing(_ flash: (change: BlockChange, n: Int)?, base: Color) -> some View { modifier(FlashValue(flash: flash, base: base)) }
}

/// A widget's blocks as a state card, as the panel draws them (src/web/WidgetBlocks.tsx): the
/// first block is the hero, the rest compact rows. Against a Space older than the widget
/// interactions (`paged` false) it is drawn as before: the hero over as many rows as the size holds.
/// Otherwise the layout follows the size class (wide: the rows beside the hero, or under it in two
/// columns), the rows that do not fit are paged with dots, and in a card of a fixed height (`fit`)
/// the rows per page come from the room left under the hero.
struct WidgetBlocksView: View {
    let blocks: [WidgetBlock]
    /// The size class the layout follows: the card's drawn box in the widget area, else its size.
    let size: String?
    var paged = false
    var fit = false
    var ctx = BlockContext.inert
    var flash: BlockFlash?
    /// Opens a block's link.
    let open: (String) -> Void

    var body: some View {
        if let hero = blocks.first {
            if paged {
                stateCard(hero, Array(blocks.dropFirst()))
                    .modifier(Entrance(enabled: true))
            } else {
                legacy(hero)
            }
        }
    }

    private func legacy(_ hero: WidgetBlock) -> some View {
        let rows = Array(blocks.dropFirst().prefix(WidgetLayout.rows(size: size)))
        return VStack(alignment: .leading, spacing: 16) {
            linked(hero) { BlockHero(block: hero) }
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, block in
                        linked(block) { BlockRow(block: block) }
                    }
                }
            }
        }
    }

    @ViewBuilder private func stateCard(_ hero: WidgetBlock, _ rest: [WidgetBlock]) -> some View {
        let s = WidgetLayout.span(size)
        let heroView = BlockLink(block: hero, ctx: ctx, open: open) { BlockHero(block: hero, ctx: ctx, flash: flash?.mark(0), big: s.rows == 2) }
        let rows = RowsRegion(rows: rest, columns: s.columns == 2 && s.rows == 2 ? 2 : 1, perBySize: WidgetLayout.rows(size: size), fit: fit, ctx: ctx, flash: flash, open: open)
        if s.columns == 2 && s.rows == 1 && !rest.isEmpty {
            HStack(alignment: .top, spacing: 18) {
                heroView.frame(maxWidth: .infinity, alignment: .topLeading)
                rows.frame(maxWidth: .infinity, maxHeight: fit ? .infinity : nil, alignment: .topLeading)
            }
        } else {
            VStack(alignment: .leading, spacing: 12) {
                heroView
                if !rest.isEmpty { rows.frame(maxHeight: fit ? .infinity : nil, alignment: .topLeading) }
            }
        }
    }

    @ViewBuilder private func linked<Content: View>(_ block: WidgetBlock, @ViewBuilder _ content: () -> Content) -> some View {
        if let url = block.url, !url.isEmpty {
            Button { open(url) } label: { content().contentShape(Rectangle()) }.buttonStyle(.plain)
        } else {
            content()
        }
    }
}

/// A block's link: the whole block is a button when it has no control of its own; with a control
/// (copy, a check, a button) a click anywhere else on the block follows the link and the controls
/// keep their clicks, so copying never opens the link.
private struct BlockLink<Content: View>: View {
    let block: WidgetBlock
    let ctx: BlockContext
    let open: (String) -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        if let url = block.url, !url.isEmpty {
            if ctx.hasControl(block) {
                content()
                    .contentShape(Rectangle())
                    .onTapGesture { open(url) }
                    .accessibilityAction(named: Text("Open")) { open(url) }
            } else {
                Button { open(url) } label: { content().contentShape(Rectangle()) }.buttonStyle(.plain)
            }
        } else {
            content()
        }
    }
}

/// The rows after the hero, paged when they do not all fit: every page is laid out in the same place
/// (the others hidden), so a card sized by its content keeps the height of its tallest page; in a
/// card of a fixed height the rows per page are the most that fit in the room it has.
private struct RowsRegion: View {
    let rows: [WidgetBlock]
    let columns: Int
    let perBySize: Int
    let fit: Bool
    let ctx: BlockContext
    let flash: BlockFlash?
    let open: (String) -> Void
    @StateObject private var state = RowsState()

    static let gap: CGFloat = 4
    static let columnGap: CGFloat = 18
    /// The dots' row and the space above it.
    static let pagerH: CGFloat = 26

    var body: some View {
        if fit {
            // The room the card leaves the rows, measured from a filler that takes all of it; the
            // rows are laid over it and never push the card taller than its box.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onGeometryChange(for: CGSize.self) { $0.size } action: { state.size = $0 }
                .overlay(alignment: .topLeading) { content }
                .background(alignment: .topLeading) { measure }
                .clipped()
                .onChange(of: rows.count) { state.heights = [:] }
        } else {
            content
                .onGeometryChange(for: CGSize.self) { $0.size } action: { state.size = $0 }
        }
    }

    private var content: some View {
        let per = perPage
        let pages = WidgetInteract.pages(Array(rows.indices), per: per)
        let cur = min(state.page, pages.count - 1)
        return VStack(alignment: .leading, spacing: 2) {
            if fit || pages.count == 1 {
                grid(pages[cur]).id(cur).modifier(Entrance(enabled: pages.count > 1))
            } else {
                ZStack(alignment: .topLeading) {
                    ForEach(Array(pages.enumerated()), id: \.offset) { pi, page in
                        grid(page)
                            .opacity(pi == cur ? 1 : 0)
                            .allowsHitTesting(pi == cur)
                            .accessibilityHidden(pi != cur)
                    }
                }
                .id(cur).modifier(Entrance(enabled: true))
            }
            if pages.count > 1 {
                if fit { Spacer(minLength: 0) }
                WidgetPager(count: pages.count, page: cur, live: ctx.live) { state.page = $0 }
                    .frame(maxWidth: .infinity)
            }
        }
        .frame(maxHeight: fit ? .infinity : nil, alignment: .topLeading)
    }

    /// The rows measured once each at the width they are drawn at, for the rows per page.
    private var measure: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, block in
                BlockRow(block: block, ctx: ctx)
                    .frame(width: max(columnWidth, 1), alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { state.heights[i] = $0 }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .hidden()
        .accessibilityHidden(true)
    }

    private var columnWidth: CGFloat {
        columns == 2 ? (state.size.width - Self.columnGap) / 2 : state.size.width
    }

    private var perPage: Int {
        guard fit, state.size.height > 0 else { return fit ? max(rows.count, 1) : perBySize }
        let heights = rows.indices.map { Double(state.heights[$0] ?? 0) }
        guard heights.allSatisfy({ $0 > 0 }) else { return max(rows.count, 1) }
        return WidgetLayout.rowsThatFit(Double(state.size.height), heights, gap: Double(Self.gap), cols: columns, pagerH: Double(Self.pagerH))
    }

    private func grid(_ page: [Int]) -> some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ForEach(Array(stride(from: 0, to: page.count, by: columns)), id: \.self) { k in
                HStack(alignment: .top, spacing: Self.columnGap) {
                    ForEach(page[k..<min(k + columns, page.count)], id: \.self) { i in
                        row(i).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if columns == 2 && k + 1 >= page.count { Color.clear.frame(maxWidth: .infinity, maxHeight: 0) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func row(_ i: Int) -> some View {
        let b = rows[i]
        return BlockLink(block: b, ctx: ctx, open: open) { BlockRow(block: b, ctx: ctx, flash: flash?.mark(i + 1)) }
    }
}

@MainActor
private final class RowsState: ObservableObject {
    @Published var page = 0
    @Published var size = CGSize.zero
    @Published var heights: [Int: CGFloat] = [:]
}

/// Round dots under the rows, one per page, the current one marked; Left and Right move between them.
struct WidgetPager: View {
    let count: Int
    let page: Int
    let live: Bool
    let show: (Int) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<count, id: \.self) { i in
                Button { show(i) } label: {
                    Circle()
                        .fill(i == page ? Theme.text : Theme.text.opacity(0.22))
                        .frame(width: 6, height: 6)
                        .scaleEffect(i == page ? 1.15 : 1)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!live)
                .accessibilityLabel(Text("Page \(i + 1) of \(count)"))
                .accessibilityAddTraits(i == page ? .isSelected : [])
            }
        }
        .focusable(live)
        .onKeyPress(keys: [.leftArrow, .rightArrow]) { press in
            guard live else { return .ignored }
            show(WidgetInteract.step(page, pages: count, forward: press.key == .rightArrow))
            return .handled
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Pages"))
    }
}

extension BlockTone {
    var color: Color {
        switch self {
        case .positive: return Theme.tonePositive
        case .negative: return Theme.toneNegative
        case .warning: return Theme.toneWarning
        case .neutral: return .secondary
        }
    }
}

private func missing() -> String { String(localized: "No data") }

/// The value and date a trend shows while the pointer rests on one of its points.
struct PointReadout: Equatable {
    var value: String?
    var date: String

    init(_ point: WidgetBlock.Point, block: WidgetBlock) {
        value = point.v.map { BlockFormat.string($0, block.number, signed: block.signed == true) }
        date = Self.date(point.t)
    }

    /// A point's date, with the time when the series is finer than a day (WidgetBlocks.tsx `pointDate`).
    static func date(_ t: String, lang: String = Lang.current) -> String {
        let locale = Locale(identifier: lang == "zh" ? "zh-Hans" : lang)
        if WidgetInteract.isTimed(t), let d = ISO8601.parse(t) {
            return d.formatted(Date.FormatStyle(locale: locale).month(.abbreviated).day().hour().minute())
        }
        let day = ISO8601.parse(t) ?? Self.day.date(from: String(t.prefix(10)))
        guard let day else { return t }
        var style = Date.FormatStyle(date: .numeric, time: .omitted, locale: locale)
        style.timeZone = TimeZone(identifier: "UTC") ?? .current
        return day.formatted(style)
    }

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}

/// A number that counts up from zero while the hero's entrance plays; later values show at once.
private struct CountingValue: View, Animatable {
    var value: Double
    let target: Double
    let block: WidgetBlock

    var animatableData: Double {
        get { value }
        set { value = newValue }
    }

    var body: some View {
        let shown = value == target ? target : (target.rounded() == target ? value.rounded() : value)
        Text(verbatim: BlockFormat.string(shown, block.number))
    }
}

/// The first block, drawn large: its label, its value, and what its type adds.
struct BlockHero: View {
    let block: WidgetBlock
    var ctx = BlockContext.inert
    var flash: (change: BlockChange, n: Int)?
    /// A tall card: its chart drawn taller.
    var big = false
    @Environment(\.widgetEntered) private var entered
    @State private var point: WidgetBlock.Point?
    @State private var hovering = false

    var body: some View {
        let read = point.map { PointReadout($0, block: block) }
        let value = read.map(\.value) ?? block.shown()
        let tone = block.effectiveTone
        let check = ctx.check(block)
        let done = ctx.isDone(block)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if let check, block.type != .status { WidgetCheck(action: check, ctx: ctx) }
                Text(verbatim: block.label.text()).font(.caption).foregroundStyle(Theme.text.opacity(0.6)).lineLimit(1)
                    .strikethrough(done)
                Spacer(minLength: 0)
                BlockControls(block: block, ctx: ctx, hovering: hovering)
            }
            if block.type == .status {
                HStack(spacing: 8) {
                    if let check {
                        WidgetCheck(action: check, ctx: ctx)
                    } else {
                        Circle().fill(tone?.color ?? Theme.text.opacity(0.6)).frame(width: 10, height: 10)
                    }
                    Text(verbatim: value ?? "").font(.system(size: 17, weight: .semibold)).lineSpacing(2).lineLimit(2)
                        .strikethrough(done)
                        .flashing(flash, base: done ? Theme.text.opacity(0.6) : Theme.text)
                }
                if let date = block.time.flatMap(Times.parse) {
                    Text(verbatim: Times.ago(date)).font(.caption).monospacedDigit().foregroundStyle(Theme.text.opacity(0.42))
                }
            } else if block.type == .tanks {
                TanksView(block: block)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    let color = value == nil ? Theme.text.opacity(0.6) : (block.type == .gauge && tone != nil && tone != .neutral ? tone!.color : Theme.text)
                    Group {
                        if read == nil, block.type == .metric, block.display == nil, let target = block.value {
                            CountingValue(value: entered ? target : 0, target: target, block: block)
                        } else {
                            Text(verbatim: value ?? missing())
                        }
                    }
                    .font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.6)
                    .flashing(flash, base: color)
                    if block.type == .metric, let delta = block.delta { BlockDelta(delta: delta, showsLabel: true) }
                }
            }
            switch block.type {
            case .trend: Spark(block: block, onPoint: { point = $0 }).frame(height: big ? 80 : 48)
            case .progress: ProgressBar(block: block)
            case .gauge: GaugeScale(block: block)
            default: EmptyView()
            }
            if let date = read?.date {
                Text(verbatim: date).font(.caption).monospacedDigit().foregroundStyle(Theme.text.opacity(0.6)).lineLimit(1)
            } else if let caption = block.caption?.text(), !caption.isEmpty {
                Text(verbatim: caption).font(.caption).foregroundStyle(Theme.text.opacity(0.42)).lineLimit(2)
            }
        }
        .opacity(done ? 0.75 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
        .accessibilityElement(children: ctx.hasControl(block) ? .contain : .combine)
    }
}

/// A block after the first, on one line: label left, value right, its drawing below.
struct BlockRow: View {
    let block: WidgetBlock
    var ctx = BlockContext.inert
    var flash: (change: BlockChange, n: Int)?
    @State private var point: WidgetBlock.Point?
    @State private var hovering = false

    var body: some View {
        let read = point.map { PointReadout($0, block: block) }
        let value = read.map(\.value) ?? block.shown()
        let tone = block.effectiveTone
        let toned = (block.type == .gauge || block.type == .metric) && tone != nil && tone != .neutral
        let check = ctx.check(block)
        let done = ctx.isDone(block)
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let check {
                    WidgetCheck(action: check, ctx: ctx).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                } else if block.type == .status {
                    Circle().fill(tone?.color ?? Theme.text.opacity(0.6)).frame(width: 7, height: 7).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                }
                Text(verbatim: block.label.text()).font(.subheadline).foregroundStyle(Theme.text.opacity(done ? 0.5 : 0.78)).lineLimit(1)
                    .strikethrough(done)
                    .help(Text(verbatim: [block.label.text(), block.caption?.text() ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")))
                    // A long value leaves the label at least about three characters (the panel's `min-width: 3em`).
                    .frame(minWidth: 40, alignment: .leading)
                Spacer(minLength: 8)
                if block.type != .tanks {
                    Text(verbatim: value ?? missing())
                        .font(.subheadline.weight(.medium)).monospacedDigit()
                        .lineLimit(1).layoutPriority(1)
                        .strikethrough(done)
                        .flashing(flash, base: value == nil || done ? Theme.text.opacity(0.6) : (toned ? tone!.color : Theme.text))
                }
                if block.type == .metric, let delta = block.delta { BlockDelta(delta: delta, showsLabel: false) }
                if block.type == .status, let date = block.time.flatMap(Times.parse) {
                    Text(verbatim: Times.ago(date)).font(.caption).monospacedDigit().foregroundStyle(Theme.text.opacity(0.42)).lineLimit(1)
                }
                if let date = read?.date {
                    Text(verbatim: date).font(.caption).monospacedDigit().foregroundStyle(Theme.text.opacity(0.6)).lineLimit(1)
                }
                BlockControls(block: block, ctx: ctx, hovering: hovering)
            }
            switch block.type {
            case .trend: Spark(block: block, onPoint: { point = $0 }).frame(height: 22)
            case .progress: ProgressBar(block: block)
            case .tanks: TanksView(block: block, small: true)
            case .gauge: GaugeScale(block: block)
            default: EmptyView()
            }
        }
        .padding(.vertical, 2)
        .opacity(done ? 0.75 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onHover { hovering = $0 }
        .accessibilityElement(children: ctx.hasControl(block) ? .contain : .combine)
    }
}

/// The trailing controls of a block: copy, then a block button.
private struct BlockControls: View {
    let block: WidgetBlock
    let ctx: BlockContext
    let hovering: Bool

    var body: some View {
        if block.copy != nil || ctx.button(block) != nil {
            HStack(spacing: 4) {
                if let text = block.copy { CopyButton(text: text, live: ctx.live, shown: hovering) }
                if let a = ctx.button(block) { WidgetActionPill(action: a, ctx: ctx) }
            }
            .fixedSize()
        }
    }
}

/// Copies the block's text and says so in place for 1.5 s. Shown while the pointer is over its
/// block or it has the focus; VoiceOver always finds it.
private struct CopyButton: View {
    let text: String
    let live: Bool
    let shown: Bool
    @State private var done = false
    @FocusState private var focused: Bool

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            done = true
        } label: {
            HStack(spacing: 4) {
                Image(systemName: done ? "checkmark" : "doc.on.doc").font(.system(size: 11, weight: .semibold))
                if done { Text("Copied").font(.caption2.weight(.semibold)) }
            }
            .foregroundStyle(done ? AnyShapeStyle(Theme.tonePositive) : AnyShapeStyle(Theme.text.opacity(0.6)))
            .padding(.horizontal, 5).frame(minWidth: 22, minHeight: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused($focused)
        .disabled(!live)
        .opacity(done || shown || focused ? 1 : 0)
        .help(Text(done ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy")))
        .accessibilityLabel(Text(done ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy")))
        .task(id: done) {
            guard done else { return }
            try? await Task.sleep(for: .milliseconds(1500))
            done = false
        }
    }
}

/// A round checkbox in place of the status dot; ticked at once, rolled back by the card when the action fails.
struct WidgetCheck: View {
    let action: WidgetAction
    let ctx: BlockContext

    var body: some View {
        let on = ctx.ticked.contains(action.id)
        let label = action.label.text()
        Button {
            if !on { ctx.onAction(action) }
        } label: {
            ZStack {
                Circle().strokeBorder(on ? Theme.text : Theme.text.opacity(0.4), lineWidth: 1.5)
                    .background(Circle().fill(on ? Theme.text : Color.clear))
                if on { Image(systemName: "checkmark").font(.system(size: 8, weight: .heavy)).foregroundStyle(Theme.solid) }
            }
            .frame(width: 15, height: 15)
            .padding(3)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!ctx.actLive || (ctx.busy != nil && !on))
        .opacity(!ctx.actLive && !on ? 0.55 : 1)
        .help(Text(verbatim: label))
        .accessibilityLabel(Text(verbatim: label))
        .accessibilityValue(Text(on ? LocalizedStringKey("checked") : LocalizedStringKey("unchecked")))
        .accessibilityAddTraits(.isToggle)
    }
}

/// A small pill: a block's button at the end of its row, or a card's button in its footer.
struct WidgetActionPill: View {
    let action: WidgetAction
    let ctx: BlockContext
    var primary = false

    var body: some View {
        let busy = ctx.busy == action.id
        Button { ctx.onAction(action) } label: {
            HStack(spacing: 5) {
                if busy { ProgressView().controlSize(.mini) }
                Text(verbatim: action.label.text()).lineLimit(1)
            }
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10).frame(minHeight: 22)
            .foregroundStyle(primary ? Color.white : Theme.text)
            .background(primary ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.text.opacity(0.08)), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!ctx.actLive || ctx.busy != nil)
        .opacity(!ctx.actLive || (ctx.busy != nil && !busy) ? 0.5 : 1)
    }
}

/// A change is colored only when the app says whether it is good or bad: up is not always good.
struct BlockDelta: View {
    let delta: WidgetBlock.Delta
    let showsLabel: Bool

    var body: some View {
        let arrow = delta.value > 0 ? "▲ " : (delta.value < 0 ? "▼ " : "")
        let label = showsLabel ? (delta.label?.text() ?? "") : ""
        Text(verbatim: arrow + BlockFormat.string(abs(delta.value), delta.number) + (label.isEmpty ? "" : " \(label)"))
            .font(.caption.weight(.medium)).monospacedDigit()
            .foregroundStyle(delta.tone?.color ?? Theme.text.opacity(0.6))
            .lineLimit(1)
    }
}

/// A trend's points as a line or bars. A line breaks at a missing point rather than bridging it,
/// each unbroken run with a faint area down to the floor; a signed or bar trend is drawn from zero,
/// the latest bar at full strength and the history behind it quieter, so today reads at a glance.
/// Each part is one shape: a view per bar made a card with a chart many times heavier to lay out
/// and to scroll than one without. The pointer over it picks the nearest point (`onPoint`): its bar
/// at full strength, or a dot on a thin rule over a line.
struct Spark: View {
    let block: WidgetBlock
    var onPoint: ((WidgetBlock.Point?) -> Void)?
    @Environment(\.widgetEntered) private var entered
    @State private var hover: Int?

    var body: some View {
        let points = block.points ?? []
        let values = points.compactMap(\.v)
        if values.isEmpty {
            Text("No history yet").font(.caption).foregroundStyle(Theme.text.opacity(0.6)).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let fromZero = block.signed == true || block.style == "bar"
            let lo = fromZero ? min(0, values.min() ?? 0) : (values.min() ?? 0)
            let hi = fromZero ? max(0, values.max() ?? 0) : (values.max() ?? 0)
            let scale = SparkScale(points: points, lo: lo, span: hi - lo == 0 ? 1 : hi - lo)
            GeometryReader { geo in
                let rect = CGRect(origin: .zero, size: geo.size)
                Group {
                    if block.style != "bar" {
                        ZStack {
                            SparkLine(scale: scale, area: true).fill(Theme.accent.opacity(0.14))
                            SparkLine(scale: scale).stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        }
                        // The line wipes in from the left.
                        .mask(alignment: .leading) { Rectangle().frame(width: entered ? geo.size.width : 0) }
                    } else {
                        let strong = hover ?? points.lastIndex { $0.v != nil }
                        let positive: Color = block.signed == true ? Theme.tonePositive : Theme.accent
                        ZStack {
                            SparkBars(scale: scale, positive: block.signed == true ? true : nil, latest: strong, past: true).fill(positive.opacity(0.6))
                            SparkBars(scale: scale, positive: block.signed == true ? true : nil, latest: strong, past: false).fill(positive)
                            if block.signed == true {
                                SparkBars(scale: scale, positive: false, latest: strong, past: true).fill(Theme.toneNegative.opacity(0.6))
                                SparkBars(scale: scale, positive: false, latest: strong, past: false).fill(Theme.toneNegative)
                            }
                        }
                        // The bars grow out of the zero line.
                        .scaleEffect(x: 1, y: entered ? 1 : 0.02, anchor: UnitPoint(x: 0.5, y: geo.size.height > 0 ? scale.y(0, in: rect) / geo.size.height : 1))
                        SparkBaseline(scale: scale).stroke(Theme.text.opacity(0.18), lineWidth: 1)
                    }
                }
                .overlay(alignment: .topLeading) {
                    if block.style != "bar", let i = hover, i < points.count {
                        let step = scale.step(in: rect)
                        let x = CGFloat(i) * step + step / 2
                        Rectangle().fill(Theme.text.opacity(0.28)).frame(width: 1, height: geo.size.height).offset(x: x - 0.5)
                        if let v = points[i].v {
                            Circle().fill(Theme.accent).frame(width: 7, height: 7)
                                .overlay(Circle().strokeBorder(Theme.solid, lineWidth: 1.5))
                                .offset(x: x - 3.5, y: scale.y(v, in: rect) - 3.5)
                        }
                    }
                }
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let at):
                        let i = WidgetInteract.nearestIndex(Double(at.x), width: Double(geo.size.width), count: points.count)
                        guard i >= 0, i != hover else { return }
                        hover = i
                        onPoint?(points[i])
                    case .ended:
                        hover = nil
                        onPoint?(nil)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }
}

/// Where a trend's points fall in the rectangle its chart is given.
private struct SparkScale {
    let points: [WidgetBlock.Point]
    let lo: Double
    let span: Double

    func step(in rect: CGRect) -> CGFloat { rect.width / CGFloat(max(points.count, 2)) }
    func y(_ v: Double, in rect: CGRect) -> CGFloat { rect.height - CGFloat((v - lo) / span) * rect.height }
}

private struct SparkBars: Shape {
    let scale: SparkScale
    /// The bars at or above zero, those below it, or all of them for nil.
    var positive: Bool?
    /// The index of the bar drawn at full strength (the latest, or the one under the pointer), and
    /// whether to draw the bars but that one (true) or that bar alone (false); nil draws every bar.
    var latest: Int?
    var past: Bool?

    func path(in rect: CGRect) -> Path {
        let step = scale.step(in: rect), zero = scale.y(0, in: rect)
        var path = Path()
        for (i, point) in scale.points.enumerated() {
            guard let v = point.v, positive == nil || (v >= 0) == positive else { continue }
            if let past, (i == latest) == past { continue }
            let y = scale.y(v, in: rect)
            let width = max(step * 0.7, 1)
            path.addRoundedRect(in: CGRect(x: CGFloat(i) * step + step * 0.15, y: min(y, zero), width: width, height: max(abs(y - zero), 1)),
                                cornerSize: CGSize(width: width * 0.17, height: width * 0.17))
        }
        return path
    }
}

private struct SparkBaseline: Shape {
    let scale: SparkScale

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 0, y: scale.y(0, in: rect)))
        path.addLine(to: CGPoint(x: rect.width, y: scale.y(0, in: rect)))
        return path
    }
}

private struct SparkLine: Shape {
    let scale: SparkScale
    /// The area under each unbroken run of two or more points, down to the chart's floor, instead
    /// of the line itself.
    var area = false

    func path(in rect: CGRect) -> Path {
        let step = scale.step(in: rect)
        var path = Path()
        var run: [CGPoint] = []
        func close() {
            if area, run.count > 1, let first = run.first, let last = run.last {
                path.move(to: CGPoint(x: first.x, y: rect.height))
                run.forEach { path.addLine(to: $0) }
                path.addLine(to: CGPoint(x: last.x, y: rect.height))
                path.closeSubpath()
            }
            run = []
        }
        for (i, point) in scale.points.enumerated() {
            guard let v = point.v else {
                close()
                continue
            }
            let at = CGPoint(x: CGFloat(i) * step + step / 2, y: scale.y(v, in: rect))
            if !area { if run.isEmpty { path.move(to: at) } else { path.addLine(to: at) } }
            run.append(at)
        }
        close()
        return path
    }
}

struct ProgressBar: View {
    let block: WidgetBlock
    @Environment(\.widgetEntered) private var entered

    var body: some View {
        Capsule().fill(Theme.hairline)
            .overlay { ProgressFill(fraction: entered ? block.fraction : 0).fill(block.tone != nil && block.tone != .neutral ? block.tone!.color : Theme.accent) }
            .frame(height: 6)
            .accessibilityHidden(true)
    }
}

/// The filled part of a progress bar: a capsule over the leading share of its track.
private struct ProgressFill: Shape {
    var fraction: Double

    var animatableData: Double {
        get { fraction }
        set { fraction = newValue }
    }

    func path(in rect: CGRect) -> Path {
        let width = rect.width * fraction
        return Path(roundedRect: CGRect(x: 0, y: 0, width: width, height: rect.height), cornerRadius: min(width, rect.height) / 2)
    }
}

/// A gauge's scale: its zones in their tones, and a marker where the value is.
struct GaugeScale: View {
    let block: WidgetBlock
    @Environment(\.widgetEntered) private var entered

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                if let zones = block.zones, !zones.isEmpty {
                    ForEach(Array(segments(zones).enumerated()), id: \.offset) { _, s in
                        Rectangle().fill(s.tone.color.opacity(0.85))
                            .frame(width: max(geo.size.width * (s.end - s.start), 0))
                            .offset(x: geo.size.width * s.start)
                    }
                } else {
                    Rectangle().fill(Theme.hairline)
                }
            }
            .frame(width: geo.size.width, height: 6, alignment: .leading)
            .clipShape(Capsule())
            .overlay(alignment: .leading) {
                if let value = block.value {
                    // A round marker ringed in the card's surface, so it stands off the zones; it slides in from the left.
                    Circle().fill(Theme.text).frame(width: 12, height: 12)
                        .padding(3).background(Theme.solid, in: Circle())
                        .shadow(color: .black.opacity(0.3), radius: 2, y: 1)
                        .offset(x: (entered ? geo.size.width * block.position(value) : 0) - 9)
                        .opacity(entered ? 1 : 0)
                }
            }
            .frame(height: 12)
        }
        .frame(height: 12)
        .accessibilityHidden(true)
    }

    private func segments(_ zones: [WidgetBlock.Zone]) -> [(start: Double, end: Double, tone: BlockTone)] {
        var from = block.min ?? 0
        return zones.map { z in
            let s = (block.position(from), block.position(Swift.min(z.to, block.max ?? 100)), z.tone)
            from = z.to
            return s
        }
    }
}

/// Up to three upright tanks side by side, each with its name and a short value (WidgetBlocks.tsx `Tanks`).
struct TanksView: View {
    let block: WidgetBlock
    var small = false
    @Environment(\.widgetEntered) private var entered

    var body: some View {
        HStack(alignment: .bottom, spacing: small ? 10 : 8) {
            ForEach(Array((block.tanks ?? []).enumerated()), id: \.offset) { _, tank in
                let name = tank.label.text()
                let value = tank.shown()
                if small {
                    HStack(spacing: 6) {
                        TankShape(tank: tank, grow: entered ? 1 : 0).frame(width: 22, height: 29)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: name).font(.caption2).foregroundStyle(Theme.text.opacity(0.6)).lineLimit(1)
                            Text(verbatim: value ?? missing()).font(.caption.weight(.semibold)).monospacedDigit().foregroundStyle(value == nil ? Theme.text.opacity(0.6) : Theme.text).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    VStack(spacing: 2) {
                        TankShape(tank: tank, grow: entered ? 1 : 0).frame(width: 48, height: 63)
                        Text(verbatim: name).font(.caption).foregroundStyle(Theme.text.opacity(0.6)).lineLimit(1).truncationMode(.tail)
                        Text(verbatim: value ?? missing()).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(value == nil ? Theme.text.opacity(0.6) : Theme.text).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(maxWidth: .infinity)
    }
}

/// One cylinder filled to value / max in the tank's tone (the accent without one); past max it fills
/// and spills over the rim. Drawn in the web panel's units, a 64 x 84 box. `grow` (0 to 1) fills it
/// in as the card's entrance plays.
struct TankShape: View, Animatable {
    let tank: WidgetBlock.Tank
    var grow: Double = 1

    var animatableData: Double {
        get { grow }
        set { grow = newValue }
    }

    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / 64, sy = size.height / 84
            let l = 8.0, r = 56.0, top = 12.0, bottom = 72.0, rx = 24.0, ry = 6.0, cx = 32.0
            func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGRect { CGRect(x: x * sx, y: y * sy, width: w * sx, height: h * sy) }
            func ellipse(_ x: Double, _ y: Double, _ ex: Double, _ ey: Double) -> Path { Path(ellipseIn: rect(x - ex, y - ey, ex * 2, ey * 2)) }
            /// The side from height `y` down, with the rounded bottom.
            func side(_ x1: Double, _ x2: Double, _ y: Double) -> Path {
                var p = Path(rect(x1, y, x2 - x1, bottom - y))
                p.addPath(Path(ellipseIn: rect(x1, bottom - ry, x2 - x1, ry * 2)))
                return p
            }
            let level = tank.level * grow
            let color = tank.tone.flatMap { $0 == .neutral ? nil : $0.color } ?? Theme.accent
            ctx.fill(ellipse(cx, bottom + ry + 3, rx + 4, 3), with: .color(Theme.text.opacity(0.14)))
            ctx.fill(side(l, r, top), with: .color(Theme.text.opacity(0.09)))
            ctx.stroke(side(l, r, top), with: .color(Theme.text.opacity(0.22)), lineWidth: 1)
            if tank.value != nil, level > 0.002 {
                let y = bottom - min(1, level) * (bottom - top)
                ctx.fill(side(l + 1.5, r - 1.5, y), with: .color(color))
                var shade = ctx
                shade.clip(to: Path(rect(cx + 8, 0, r - cx - 8, 84)))
                shade.fill(side(l + 1.5, r - 1.5, y), with: .color(.black.opacity(0.14)))
                ctx.fill(ellipse(cx, y, rx - 1.5, ry - 0.8), with: .color(color))
                ctx.fill(ellipse(cx, y, rx - 1.5, ry - 0.8), with: .color(.white.opacity(0.28)))
            }
            ctx.fill(Path(rect(l + 5, top + 4, 3, bottom - top - 5)), with: .color(.white.opacity(0.22)))
            ctx.fill(ellipse(cx, top, rx, ry), with: .color(Theme.text.opacity(0.07)))
            ctx.stroke(ellipse(cx, top, rx, ry), with: .color(Theme.text.opacity(0.32)), lineWidth: 1.2)
            if level > 1 {
                var spill = Path()
                spill.addEllipse(in: rect(cx - 13, top - 3, 14, 7))
                spill.addRoundedRect(in: rect(cx - 9, top, 6, 20), cornerSize: CGSize(width: 3 * sx, height: 3 * sy))
                ctx.fill(spill, with: .color(color))
            }
        }
        .accessibilityHidden(true)
    }
}
