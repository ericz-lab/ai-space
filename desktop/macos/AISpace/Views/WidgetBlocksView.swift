import SwiftUI

/// A widget's blocks as a state card, as the panel draws them (src/web/WidgetBlocks.tsx): the
/// first block is the hero, the rest compact rows, as many as the card's size holds.
struct WidgetBlocksView: View {
    let blocks: [WidgetBlock]
    let size: String?
    /// Opens a block's link.
    let open: (String) -> Void

    var body: some View {
        if let hero = blocks.first {
            let rows = Array(blocks.dropFirst().prefix(WidgetLayout.rows(size: size)))
            VStack(alignment: .leading, spacing: 12) {
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
    }

    @ViewBuilder private func linked<Content: View>(_ block: WidgetBlock, @ViewBuilder _ content: () -> Content) -> some View {
        if let url = block.url, !url.isEmpty {
            Button { open(url) } label: { content().contentShape(Rectangle()) }.buttonStyle(.plain)
        } else {
            content()
        }
    }
}

extension BlockTone {
    var color: Color {
        switch self {
        case .positive: return Theme.success
        case .negative: return Theme.danger
        case .warning: return Theme.warning
        case .neutral: return .secondary
        }
    }
}

private func missing() -> String { String(localized: "No data") }

/// The first block, drawn large: its label, its value, and what its type adds.
struct BlockHero: View {
    let block: WidgetBlock

    var body: some View {
        let value = block.shown()
        let tone = block.effectiveTone
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: block.label.text()).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            if block.type == .status {
                HStack(spacing: 8) {
                    Circle().fill(tone?.color ?? Color.secondary).frame(width: 10, height: 10)
                    Text(verbatim: value ?? "").font(.title3.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                }
                if let date = block.time.flatMap(Times.parse) {
                    Text(verbatim: Times.ago(date)).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: value ?? missing())
                        .font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit()
                        .foregroundStyle(value == nil ? Color.secondary : (block.type == .gauge && tone != nil && tone != .neutral ? tone!.color : Theme.text))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    if block.type == .metric, let delta = block.delta { BlockDelta(delta: delta, showsLabel: true) }
                }
            }
            switch block.type {
            case .trend: Spark(block: block).frame(height: 48)
            case .progress: ProgressBar(block: block)
            case .gauge: GaugeScale(block: block)
            default: EmptyView()
            }
            if let caption = block.caption?.text(), !caption.isEmpty {
                Text(verbatim: caption).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A block after the first, on one line: label left, value right, its drawing below.
struct BlockRow: View {
    let block: WidgetBlock

    var body: some View {
        let value = block.shown()
        let tone = block.effectiveTone
        let toned = (block.type == .gauge || block.type == .metric) && tone != nil && tone != .neutral
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if block.type == .status {
                    Circle().fill(tone?.color ?? Color.secondary).frame(width: 7, height: 7).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
                }
                Text(verbatim: block.label.text()).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                Text(verbatim: value ?? missing())
                    .font(.subheadline.weight(.medium)).monospacedDigit()
                    .foregroundStyle(value == nil ? Color.secondary : (toned ? tone!.color : Theme.text))
                    .lineLimit(1).layoutPriority(1)
                if block.type == .metric, let delta = block.delta { BlockDelta(delta: delta, showsLabel: false) }
                if block.type == .status, let date = block.time.flatMap(Times.parse) {
                    Text(verbatim: Times.ago(date)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            switch block.type {
            case .trend: Spark(block: block).frame(height: 22)
            case .progress: ProgressBar(block: block)
            case .gauge: GaugeScale(block: block)
            default: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
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
            .foregroundStyle(delta.tone?.color ?? Color.secondary)
            .lineLimit(1)
    }
}

/// A trend's points as a line or bars. A line breaks at a missing point rather than bridging it;
/// a signed or bar trend is drawn from zero. Each part is one shape: a view per bar made a card
/// with a chart many times heavier to lay out and to scroll than one without.
struct Spark: View {
    let block: WidgetBlock

    var body: some View {
        let points = block.points ?? []
        let values = points.compactMap(\.v)
        if values.isEmpty {
            Text("No history yet").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let fromZero = block.signed == true || block.style == "bar"
            let lo = fromZero ? min(0, values.min() ?? 0) : (values.min() ?? 0)
            let hi = fromZero ? max(0, values.max() ?? 0) : (values.max() ?? 0)
            let scale = SparkScale(points: points, lo: lo, span: hi - lo == 0 ? 1 : hi - lo)
            Group {
                if block.style != "bar" {
                    SparkLine(scale: scale).stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                } else if block.signed == true {
                    ZStack {
                        SparkBaseline(scale: scale).stroke(Theme.hairline, lineWidth: 1)
                        SparkBars(scale: scale, positive: true).fill(Theme.success)
                        SparkBars(scale: scale, positive: false).fill(Theme.danger)
                    }
                } else {
                    SparkBars(scale: scale).fill(Theme.accent)
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

    func path(in rect: CGRect) -> Path {
        let step = scale.step(in: rect), zero = scale.y(0, in: rect)
        var path = Path()
        for (i, point) in scale.points.enumerated() {
            guard let v = point.v, positive == nil || (v >= 0) == positive else { continue }
            let y = scale.y(v, in: rect)
            path.addRect(CGRect(x: CGFloat(i) * step + step * 0.15, y: min(y, zero), width: max(step * 0.7, 1), height: max(abs(y - zero), 1)))
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

    func path(in rect: CGRect) -> Path {
        let step = scale.step(in: rect)
        var path = Path()
        var pen = false
        for (i, point) in scale.points.enumerated() {
            guard let v = point.v else {
                pen = false
                continue
            }
            let at = CGPoint(x: CGFloat(i) * step + step / 2, y: scale.y(v, in: rect))
            if pen { path.addLine(to: at) } else { path.move(to: at) }
            pen = true
        }
        return path
    }
}

struct ProgressBar: View {
    let block: WidgetBlock

    var body: some View {
        Capsule().fill(Theme.hairline)
            .overlay { ProgressFill(fraction: block.fraction).fill(block.tone != nil && block.tone != .neutral ? block.tone!.color : Theme.accent) }
            .frame(height: 6)
            .accessibilityHidden(true)
    }
}

/// The filled part of a progress bar: a capsule over the leading share of its track.
private struct ProgressFill: Shape {
    let fraction: Double

    func path(in rect: CGRect) -> Path {
        let width = rect.width * fraction
        return Path(roundedRect: CGRect(x: 0, y: 0, width: width, height: rect.height), cornerRadius: min(width, rect.height) / 2)
    }
}

/// A gauge's scale: its zones in their tones, and a marker where the value is.
struct GaugeScale: View {
    let block: WidgetBlock

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
                    Capsule().fill(Theme.text).frame(width: 3, height: 12)
                        .overlay(Capsule().strokeBorder(Theme.solid, lineWidth: 0.5))
                        .offset(x: geo.size.width * block.position(value) - 1.5)
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
