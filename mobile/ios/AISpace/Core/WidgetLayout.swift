import Foundation

/// The widget area's layout without any view (docs/panel.md#resize-a-widget), ported from the web
/// panel's src/web/widget-layout.ts with the same constants and rules, so every client places the
/// same cards in the same boxes: a flow of cards with a fixed gap, wrapped into rows. Each card has a
/// frame `{ w, h }`: `w` a fraction of the area's width, `h` a height in points. A card `w` wide is
/// `w * (W + gap) - gap` in an area `W` wide, so fractions that sum to 1 fill a row exactly with the
/// gap between the cards at any width. Every card of a row takes the row's height, the largest `h`
/// in it, and rows are the gap apart. Foundation only: the Mac and the iPhone compile it, and the
/// tests port the web's (WidgetLayoutTests.swift).

/// A card's frame: `w` a fraction of the area's width, `h` a height.
struct WidgetFrame: Codable, Hashable {
    var w: Double
    var h: Double

    init(w: Double, h: Double) {
        self.w = w
        self.h = h
    }

    /// A stored frame as the Space sends it; anything but two finite numbers is no frame.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let w = try c.decode(Double.self, forKey: .w), h = try c.decode(Double.self, forKey: .h)
        guard w.isFinite, h.isFinite, w > 0, h > 0 else { throw DecodingError.dataCorruptedError(forKey: .w, in: c, debugDescription: "not a frame") }
        self.w = w
        self.h = h
    }

    private enum CodingKeys: String, CodingKey { case w, h }

    var json: [String: Any] { ["w": w, "h": h] }
}

/// Where a row that does not fill the area puts its free space (`widgetAlign` of the panel layout).
enum WidgetAlign: String, Codable, Hashable {
    case start, center
}

/// A card's box in the area, and the row it is on.
struct WidgetBox: Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var row: Int
}

/// Every card's box, the rows as card indices, and the area's height.
struct WidgetPlaced: Equatable {
    var boxes: [WidgetBox]
    var rows: [[Int]]
    var height: Double
}

/// A write to the layout: frames by widget id (a nil frame removes one), sizes alongside, the
/// alignment. `PUT /api/panel/layout` takes its `json`.
struct LayoutWrite: Equatable {
    /// nil: the write leaves frames alone. A nil value removes that widget's frame.
    var frames: [String: WidgetFrame?]?
    var sizes: [String: String]?
    var widgetAlign: WidgetAlign?

    init(frames: [String: WidgetFrame?]? = nil, sizes: [String: String]? = nil, widgetAlign: WidgetAlign? = nil) {
        self.frames = frames
        self.sizes = sizes
        self.widgetAlign = widgetAlign
    }

    var isEmpty: Bool { (frames ?? [:]).isEmpty && (sizes ?? [:]).isEmpty && widgetAlign == nil }

    /// The same write without its frames and alignment: what a Space that only knows sizes takes.
    var sizesOnly: LayoutWrite? {
        guard let sizes, !sizes.isEmpty else { return nil }
        return LayoutWrite(sizes: sizes)
    }

    var json: [String: Any] {
        var out: [String: Any] = [:]
        if let frames {
            var f: [String: Any] = [:]
            for (id, frame) in frames { f[id] = frame.map { $0.json } ?? NSNull() }
            out["frames"] = f
        }
        if let sizes { out["sizes"] = sizes }
        if let widgetAlign { out["widgetAlign"] = widgetAlign.rawValue }
        return out
    }
}

/// A card as the layout stores it: its id, its classic size, its frame when it has one.
struct LayoutCard: Equatable {
    var id: String
    var size: String
    var frame: WidgetFrame?
}

enum WidgetLayout {
    static let gap = 20.0
    static let minW = 200.0
    static let minH = 140.0
    static let maxH = 900.0
    /// The smallest fraction the server keeps (src/space/panel/layout.ts).
    static let minFraction = 0.1
    /// Below this width the area is one column of cards sized by their content (the web's 700px breakpoint).
    static let oneColumnBelow = 700.0
    /// The old grid's column and the height a card without a frame gets per row.
    static let oldColumn = 320.0
    static let rowH = 300.0
    /// How close an edge has to come to a candidate to snap to it.
    static let snapDistance = 8.0
    /// The equal divisions of the area an edge snaps to.
    static let divisions: [Double] = [1.0 / 4, 1.0 / 3, 1.0 / 2, 2.0 / 3, 3.0 / 4, 1]
    /// Row sums may exceed 1 by this much (stored fractions are rounded) and still fit.
    static let epsilon = 1e-4
    /// The size class thresholds and the band around them that keeps a dragged card from flickering.
    static let wideAt = 560.0
    static let tallAt = 480.0
    static let hysteresis = 16.0
    /// The reference area the nearest classic size is judged in.
    static let referenceW = 1100.0

    /// JavaScript's `Math.round`: halves go up.
    static func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }

    private static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { Swift.min(hi, Swift.max(lo, v)) }

    static func px(_ w: Double, _ W: Double) -> Double { w * (W + gap) - gap }
    static func fraction(_ px: Double, _ W: Double) -> Double { (px + gap) / (W + gap) }

    /// The smallest fraction a card can be in an area `W` wide: 200, or the whole area when it is narrower.
    static func minFrac(_ W: Double) -> Double {
        W <= minW ? 1 : Swift.min(1, Swift.max(minFraction, fraction(minW, W)))
    }

    static func clampH(_ h: Double) -> Double {
        Swift.min(maxH, Swift.max(minH, jsRound(h.isFinite ? h : rowH)))
    }

    /// The number of 320+ columns the old grid had in an area `W` wide.
    static func oldColumns(_ W: Double) -> Int { Swift.max(1, Int(((W + gap) / (oldColumn + gap)).rounded(.down))) }

    /// A classic size's columns and rows; anything else is 1x1.
    static func span(_ size: String?) -> (columns: Int, rows: Int) {
        switch size {
        case "2x1": return (2, 1)
        case "1x2": return (1, 2)
        case "2x2": return (2, 2)
        default: return (1, 1)
        }
    }

    /// The frame of a card without one: its size's columns of the old grid at this width, and its rows' height.
    static func defaultFrame(_ size: String?, _ W: Double) -> WidgetFrame {
        let n = oldColumns(W)
        let s = span(size)
        return WidgetFrame(w: Double(Swift.min(s.columns, n)) / Double(n), h: s.rows == 1 ? rowH : 2 * rowH + gap)
    }

    /// A frame as drawn in an area `W` wide: at least the minimum width, the height within its bounds.
    static func effective(_ f: WidgetFrame, _ W: Double) -> WidgetFrame {
        WidgetFrame(w: clamp(f.w.isFinite ? f.w : 1, minFrac(W), 1), h: clampH(f.h))
    }

    /// The frames of an area's cards as drawn: the stored frame, else the default from the size.
    static func resolveFrames(_ cards: [(size: String?, frame: WidgetFrame?)], _ W: Double) -> [WidgetFrame] {
        cards.map { effective($0.frame ?? defaultFrame($0.size, W), W) }
    }

    /// Rows of card indices: a card goes on the current row while the row's fractions stay at most 1.
    static func breakRows(_ ws: [Double]) -> [[Int]] {
        var rows: [[Int]] = []
        var cur: [Int] = []
        var used = 0.0
        for (i, w) in ws.enumerated() {
            if !cur.isEmpty && used + w > 1 + epsilon {
                rows.append(cur)
                cur = []
                used = 0
            }
            cur.append(i)
            used += w
        }
        if !cur.isEmpty { rows.append(cur) }
        return rows
    }

    /// The width a row's cards take, gaps between them included.
    static func rowWidth(_ frames: [WidgetFrame], _ row: [Int], _ W: Double) -> Double {
        Swift.min(W, row.reduce(0) { $0 + frames[$1].w } * (W + gap) - gap)
    }

    /// Where every card goes; `frames` are as drawn (`effective`).
    static func place(_ frames: [WidgetFrame], _ W: Double, _ align: WidgetAlign = .start) -> WidgetPlaced {
        let rows = breakRows(frames.map(\.w))
        var boxes = [WidgetBox](repeating: WidgetBox(x: 0, y: 0, width: 0, height: 0, row: 0), count: frames.count)
        var y = 0.0
        for (r, row) in rows.enumerated() {
            let height = row.map { frames[$0].h }.max() ?? 0
            var x = align == .center ? Swift.max(0, (W - rowWidth(frames, row, W)) / 2) : 0
            for i in row {
                let width = Swift.min(W, px(frames[i].w, W))
                boxes[i] = WidgetBox(x: x, y: y, width: width, height: height, row: r)
                x += width + gap
            }
            y += height + gap
        }
        return WidgetPlaced(boxes: boxes, rows: rows, height: Swift.max(0, y - gap))
    }

    /// Card `i` set to `px` wide. The default moves the boundary with the next card of its row, which
    /// takes or gives the difference (both stay above the minimum); the last card of a row grows into
    /// the row's free space and no further. `reflow` (Shift) changes this card only and lets the cards
    /// after it wrap.
    static func setWidth(_ frames: [WidgetFrame], _ W: Double, _ i: Int, _ px: Double, reflow: Bool = false) -> [WidgetFrame] {
        var out = frames
        let lo = minFrac(W)
        let want = fraction(px, W)
        if reflow {
            out[i].w = clamp(want, lo, 1)
            return out
        }
        guard let row = breakRows(frames.map(\.w)).first(where: { $0.contains(i) }), let k = row.firstIndex(of: i) else { return out }
        if k + 1 < row.count {
            let next = row[k + 1]
            let pair = frames[i].w + frames[next].w
            out[i].w = clamp(want, lo, Swift.max(lo, pair - lo))
            out[next].w = pair - out[i].w
            return out
        }
        let free = Swift.max(0, 1 - row.reduce(0) { $0 + frames[$1].w })
        out[i].w = clamp(want, lo, Swift.max(lo, frames[i].w + free))
        return out
    }

    /// Every card in card `i`'s row set to `h` tall.
    static func setRowHeight(_ frames: [WidgetFrame], _ i: Int, _ h: Double) -> [WidgetFrame] {
        guard let row = breakRows(frames.map(\.w)).first(where: { $0.contains(i) }) else { return frames }
        return frames.enumerated().map { j, f in row.contains(j) ? WidgetFrame(w: f.w, h: clampH(h)) : f }
    }

    /// The nearest candidate within `within` of `value`, or nil.
    static func snap(_ value: Double, _ candidates: [Double], within: Double = snapDistance) -> Double? {
        var best: Double?
        for c in candidates where abs(c - value) <= within && (best == nil || abs(c - value) < abs(best! - value)) { best = c }
        return best
    }

    /// Where card `i`'s right edge may snap, measured from its row's left edge: the area's equal
    /// divisions, and the edges of the cards in other rows (a right edge, and a left edge less the gap,
    /// so the card after this one lines up with it). In a centred area the other rows' edges are taken
    /// relative to this row's offset at the start of the drag.
    static func edgeCandidates(_ placed: WidgetPlaced, _ W: Double, _ i: Int) -> [Double] {
        let me = placed.boxes[i]
        let off = placed.boxes[placed.rows[me.row][0]].x
        var out = divisions.map { px($0, W) }
        for (j, b) in placed.boxes.enumerated() where b.row != me.row && j != i {
            out.append(b.x + b.width - off)
            out.append(b.x - gap - off)
        }
        return out.filter { $0 > 0 && $0 <= W + 0.5 }
    }

    /// The other rows' edges in the area's own coordinates, for a centred row (both sides move).
    static func absoluteEdges(_ placed: WidgetPlaced, _ i: Int) -> [Double] {
        let me = placed.boxes[i]
        return placed.boxes.enumerated().flatMap { j, b in b.row == me.row || j == i ? [] : [b.x + b.width, b.x - gap] }
    }

    /// The heights of the rows other than card `i`'s, which its row's height may snap to.
    static func heightCandidates(_ placed: WidgetPlaced, _ i: Int) -> [Double] {
        let me = placed.boxes[i].row
        var out: [Double] = []
        for (r, row) in placed.rows.enumerated() where r != me {
            let h = placed.boxes[row[0]].height
            if !out.contains(h) { out.append(h) }
        }
        return out
    }

    /// Align: in every row each boundary moves to the nearest twelfth of the area (every card kept above
    /// the minimum), and rows whose heights are within 24 of each other take the tallest of them.
    static func alignTwelfths(_ frames: [WidgetFrame], _ W: Double) -> [WidgetFrame] {
        var out = frames
        let lo = minFrac(W)
        let rows = breakRows(frames.map(\.w))
        for row in rows {
            var prev = 0.0
            var cum = 0.0
            for (k, i) in row.enumerated() {
                cum += frames[i].w
                let rest = Double(row.count - 1 - k)
                let min = prev + lo
                let max = Swift.max(min, 1 - rest * lo)
                var c = jsRound(cum * 12) / 12
                if c < min - 1e-9 { c = (min * 12 - 1e-9).rounded(.up) / 12 }
                if c > max + 1e-9 { c = (max * 12 + 1e-9).rounded(.down) / 12 }
                c = clamp(c, min, max)
                out[i].w = c - prev
                prev = c
            }
        }
        let heights = rows.map { row in row.map { frames[$0].h }.max() ?? 0 }
        // Tallest first; rows of the same height keep their order (the web's sort is stable).
        let order = heights.enumerated().sorted { $0.element != $1.element ? $0.element > $1.element : $0.offset < $1.offset }
        var top = Double.infinity
        for (r, h) in order {
            if top - h > 24 { top = h }
            for i in rows[r] { out[i].h = top }
        }
        return out
    }

    /// Split evenly: the cards of every row get equal widths that fill it, every row the median height.
    static func splitEvenly(_ frames: [WidgetFrame]) -> [WidgetFrame] {
        var out = frames
        let rows = breakRows(frames.map(\.w))
        let heights = rows.map { row in row.map { frames[$0].h }.max() ?? 0 }.sorted()
        guard !heights.isEmpty else { return out }
        let mid = heights.count >> 1
        let median = heights.count % 2 == 1 ? heights[mid] : jsRound((heights[mid - 1] + heights[mid]) / 2)
        for row in rows { for i in row { out[i] = WidgetFrame(w: 1 / Double(row.count), h: median) } }
        return out
    }

    /// A frame as stored: rounded, within the server's bounds.
    static func tidy(_ f: WidgetFrame) -> WidgetFrame {
        WidgetFrame(w: jsRound(clamp(f.w, minFraction, 1) * 1e6) / 1e6, h: clampH(f.h))
    }

    static func sameFrame(_ a: WidgetFrame?, _ b: WidgetFrame?) -> Bool {
        guard let a, let b else { return false }
        return abs(a.w - b.w) < 1e-6 && abs(a.h - b.h) < 0.5
    }

    /// The classic size closest to a frame, for clients that only know `sizes`: judged in a 1100 area.
    static func nearestSize(_ f: WidgetFrame) -> String {
        let cols = px(f.w, referenceW) >= wideAt ? 2 : 1
        let rows = f.h >= tallAt ? 2 : 1
        return "\(cols)x\(rows)"
    }

    /// The size class a card's inner layout follows (`1x1`, `2x1`, `1x2`, `2x2`), from its drawn box:
    /// wide at 560, tall at 480. Once wide or tall it stays so until 16 below, so a dragged edge near a
    /// threshold does not flip the layout back and forth.
    static func sizeClass(_ prev: String?, _ width: Double, _ height: Double) -> String {
        let p: (columns: Int, rows: Int) = prev.map(span) ?? (0, 0)
        let wide = p.columns == 2 ? width >= wideAt - hysteresis : width >= wideAt
        let tall = p.rows == 2 ? height >= tallAt - hysteresis : height >= tallAt
        return "\(wide ? 2 : 1)x\(tall ? 2 : 1)"
    }

    /// The write that takes an area from `before` to `after` (frames as drawn), with the one that undoes
    /// it. Only the cards whose frame changed are written; each also gets its nearest classic size.
    static func framesWrite(_ cards: [LayoutCard], _ before: [WidgetFrame], _ after: [WidgetFrame]) -> (write: LayoutWrite, undo: LayoutWrite)? {
        var wf: [String: WidgetFrame?] = [:], ws: [String: String] = [:]
        var uf: [String: WidgetFrame?] = [:], us: [String: String] = [:]
        for (i, c) in cards.enumerated() where i < before.count && i < after.count {
            if sameFrame(before[i], after[i]) { continue }
            let f = tidy(after[i])
            wf[c.id] = .some(f)
            ws[c.id] = nearestSize(f)
            uf[c.id] = .some(c.frame)
            us[c.id] = c.size
        }
        guard !wf.isEmpty else { return nil }
        return (LayoutWrite(frames: wf, sizes: ws), LayoutWrite(frames: uf, sizes: us))
    }

    /// One card after a layout write, as the server stores it: a size written without a frame for the
    /// same widget drops its frame (a client that only knows sizes). nil when the write leaves it alone.
    static func applied(_ write: LayoutWrite, id: String, size: String?, frame: WidgetFrame?) -> (size: String?, frame: WidgetFrame?)? {
        let framed = write.frames?.keys.contains(id) == true
        let newSize = write.sizes?[id]
        guard framed || newSize != nil else { return nil }
        let f: WidgetFrame? = framed ? (write.frames?[id] ?? nil) : nil
        return (newSize ?? size, f)
    }

    /// A layout write applied to a list of cards (frames and sizes), as the server stores it.
    static func applyWrite(_ cards: [LayoutCard], _ write: LayoutWrite) -> [LayoutCard] {
        cards.map { c in
            guard let a = applied(write, id: c.id, size: c.size, frame: c.frame) else { return c }
            return LayoutCard(id: c.id, size: a.size ?? c.size, frame: a.frame)
        }
    }

    /// How many compact rows a card of a fixed height shows per page: the most rows such that every page
    /// (its rows laid out in `cols` columns, a grid row as tall as its tallest cell, `gap` apart) fits in
    /// the `avail` under the hero; all of them when they fit at once, else with the pager's `pagerH` kept
    /// free. Never fewer than one row per column.
    static func rowsThatFit(_ avail: Double, _ heights: [Double], gap: Double, cols: Int, pagerH: Double) -> Int {
        let total = heights.count
        let c = Swift.max(1, cols)
        if total == 0 { return 1 }
        func pageHeight(_ rows: ArraySlice<Double>) -> Double {
            var h = 0.0
            var k = rows.startIndex
            while k < rows.endIndex {
                let cell = rows[k..<Swift.min(k + c, rows.endIndex)]
                h += (cell.max() ?? 0) + (k > rows.startIndex ? gap : 0)
                k += c
            }
            return h
        }
        func fits(_ n: Int, _ room: Double) -> Bool {
            var k = 0
            while k < total {
                if pageHeight(heights[k..<Swift.min(k + n, total)]) > room + 0.5 { return false }
                k += n
            }
            return true
        }
        if fits(total, avail) { return total }
        var n = total - 1
        while n > c {
            if fits(n, avail - pagerH) { return n }
            n -= 1
        }
        return c
    }

    // MARK: Before the stepless layout

    /// Compact rows beside the hero, per card size (ROWS in WidgetBlocks.tsx), for a card sized by its content.
    static func rows(size: String?) -> Int {
        switch size {
        case "2x1": return 4
        case "1x2": return 6
        case "2x2": return 10
        default: return 2
        }
    }

    /// Whether the payload is older than the app said it stays true.
    static func isOutdated(asOf: String?, staleAfterMs: Double?, now: Date = Date()) -> Bool {
        guard let asOf, let staleAfterMs, staleAfterMs > 0, let date = ISO8601.parse(asOf) else { return false }
        return now.timeIntervalSince(date) * 1000 > staleAfterMs
    }
}
