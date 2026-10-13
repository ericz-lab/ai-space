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
/// a signed or bar trend is drawn from zero.
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
            let span = hi - lo == 0 ? 1 : hi - lo
            GeometryReader { geo in
                let step = geo.size.width / CGFloat(max(points.count, 2))
                let y: (Double) -> CGFloat = { geo.size.height - CGFloat(($0 - lo) / span) * geo.size.height }
                if block.style == "bar" {
                    ZStack(alignment: .topLeading) {
                        if block.signed == true {
                            Path { p in
                                p.move(to: CGPoint(x: 0, y: y(0)))
                                p.addLine(to: CGPoint(x: geo.size.width, y: y(0)))
                            }
                            .stroke(Theme.hairline, lineWidth: 1)
                        }
                        ForEach(Array(points.enumerated()), id: \.offset) { i, point in
                            if let v = point.v {
                                let top = min(y(v), y(0))
                                Rectangle()
                                    .fill(block.signed == true ? (v >= 0 ? Theme.success : Theme.danger) : Theme.accent)
                                    .frame(width: max(step * 0.7, 1), height: max(abs(y(v) - y(0)), 1))
                                    .offset(x: CGFloat(i) * step + step * 0.15, y: top)
                            }
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                } else {
                    Path { p in
                        var pen = false
                        for (i, point) in points.enumerated() {
                            guard let v = point.v else {
                                pen = false
                                continue
                            }
                            let at = CGPoint(x: CGFloat(i) * step + step / 2, y: y(v))
                            if pen { p.addLine(to: at) } else { p.move(to: at) }
                            pen = true
                        }
                    }
                    .stroke(Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                }
            }
            .accessibilityHidden(true)
        }
    }
}

struct ProgressBar: View {
    let block: WidgetBlock

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.hairline)
                Capsule().fill(block.tone != nil && block.tone != .neutral ? block.tone!.color : Theme.accent)
                    .frame(width: geo.size.width * block.fraction)
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
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
