import Foundation

/// What a widget card does when it is touched (docs/app-spec.md#views-copy-and-actions): the
/// payload's views, copy text and write-back actions as the Space sends them, and the pure rules of
/// the web panel's src/web/widget-interact.ts (the spark's nearest point, paging, what changed
/// between two payloads, the chosen view per widget). Foundation only, shared by the Mac and the
/// iPhone; a field this version cannot read is dropped, never fatal.

/// A field decoded on its own: when it is malformed it is nil and the rest of the widget still decodes.
struct Lenient<Value: Decodable & Hashable>: Decodable, Hashable {
    var value: Value?

    init(_ value: Value?) { self.value = value }

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

/// A write-back control: on a block a `check` or a `button`, on the card an `input` or a `button`.
struct WidgetAction: Decodable, Hashable {
    enum Kind: String, Decodable, Hashable {
        case check, button, input

        /// The kinds a block may carry; the card's footer takes `input` and `button`.
        var onBlock: Bool { self == .check || self == .button }
        var onCard: Bool { self == .input || self == .button }
    }

    static let maxCopy = 8000
    /// The longest text an `input` sends (src/space/panel/blocks.ts `MAX_ACTION_VALUE`).
    static let maxValue = 2000
    static let maxCardActions = 3

    var id: String
    var kind: Kind
    var label: BlockText
    var placeholder: BlockText?
    var confirm: BlockText?

    private enum CodingKeys: String, CodingKey { case id, kind, label, placeholder, confirm }

    init(id: String, kind: Kind, label: BlockText, placeholder: BlockText? = nil, confirm: BlockText? = nil) {
        (self.id, self.kind, self.label, self.placeholder, self.confirm) = (id, kind, label, placeholder, confirm)
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard Self.isID(id) else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not an action id") }
        // An unknown kind fails here, so the action is skipped.
        kind = try c.decode(Kind.self, forKey: .kind)
        label = try c.decode(BlockText.self, forKey: .label)
        placeholder = kind == .input ? try? c.decode(BlockText.self, forKey: .placeholder) : nil
        confirm = try? c.decode(BlockText.self, forKey: .confirm)
    }

    /// 1 to 128 of `[A-Za-z0-9._:-]`, as the Space checks it.
    static func isID(_ s: String) -> Bool {
        !s.isEmpty && s.count <= 128 && s.unicodeScalars.allSatisfy { c in
            (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "." || c == "_" || c == ":" || c == "-"
        }
    }
}

/// One view of a card: a read-only switch between sets of blocks.
struct WidgetViewDef: Decodable, Hashable, Identifiable {
    var id: String
    var label: BlockText
    var blocks: [WidgetBlock]

    private enum CodingKeys: String, CodingKey { case id, label, blocks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard Self.isID(id) else { throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not a view id") }
        label = try c.decode(BlockText.self, forKey: .label)
        blocks = Array(try c.decode(Lossy<WidgetBlock>.self, forKey: .blocks).elements.prefix(12))
        guard !blocks.isEmpty else { throw DecodingError.dataCorruptedError(forKey: .blocks, in: c, debugDescription: "a view without blocks") }
    }

    /// `^[a-z0-9][a-z0-9_-]{0,31}$`
    static func isID(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first, s.count <= 32 else { return false }
        func lower(_ c: Unicode.Scalar) -> Bool { (c >= "a" && c <= "z") || (c >= "0" && c <= "9") }
        return lower(first) && s.unicodeScalars.dropFirst().allSatisfy { lower($0) || $0 == "_" || $0 == "-" }
    }
}

extension CatalogWidget {
    /// The card's views when it has at least two usable ones (2 to 4, unique ids), else nil.
    var cardViews: [WidgetViewDef]? {
        guard ok != false, let all = views?.value?.elements else { return nil }
        var seen = Set<String>()
        let unique = all.filter { seen.insert($0.id).inserted }.prefix(4)
        return unique.count >= 2 ? Array(unique) : nil
    }

    /// The card's own controls (at most three, one `input`), for a widget of this Space only: a
    /// peer's widget has none, whatever its payload says.
    var cardActions: [WidgetAction] {
        guard ok != false, peer == nil else { return [] }
        var out: [WidgetAction] = []
        var input = false
        for a in actions?.value?.elements ?? [] where a.kind.onCard && out.count < WidgetAction.maxCardActions {
            if a.kind == .input { if input { continue }; input = true }
            out.append(a)
        }
        return out
    }

    /// The frame the Space keeps for this card, if any.
    var storedFrame: WidgetFrame? { frame?.value }

    /// Every action id the payload declares, card and blocks, in every view: only these are sent.
    var declaredActions: Set<String> {
        guard peer == nil else { return [] }
        var ids = Set(cardActions.map(\.id))
        for b in (blocks?.elements ?? []) + (cardViews ?? []).flatMap(\.blocks) { if let a = b.action { ids.insert(a.id) } }
        return ids
    }
}

/// The Space's answer to `POST /api/widgets/:app/:name/action` or `/refresh`.
enum WidgetAnswer: Equatable {
    case ok(CatalogWidget, message: BlockText?)
    case failed(String)

    private struct Body: Decodable {
        var ok: Bool?
        var error: String?
        var widget: CatalogWidget?
        var message: Lenient<BlockText>?
    }

    /// `{ ok: true, widget, message? }`, else the error the Space or the app gave, else the HTTP status.
    static func decode(status: Int, data: Data) -> WidgetAnswer {
        let body = try? JSONDecoder().decode(Body.self, from: data)
        if let body, body.ok == true, let widget = body.widget { return .ok(widget, message: body.message?.value) }
        if let error = body?.error, !error.isEmpty { return .failed(error) }
        return .failed("HTTP \(status)")
    }
}

/// How a block's value changed between two payloads.
enum BlockChange: String, Equatable {
    case up, down, text
}

enum WidgetInteract {
    /// The point of a spark under the pointer: each point owns a slot of equal width, as it is drawn.
    static func nearestIndex(_ x: Double, width: Double, count n: Int) -> Int {
        guard n > 0, width > 0 else { return -1 }
        // The chart is at least two slots wide (one point alone sits in the first slot).
        let slots = Double(Swift.max(n, 2))
        return Swift.max(0, Swift.min(n - 1, Int((x / width * slots).rounded(.down))))
    }

    /// Rows split into pages of `per`; a single page when they fit.
    static func pages<T>(_ rows: [T], per: Int) -> [[T]] {
        guard per > 0, rows.count > per else { return [rows] }
        return stride(from: 0, to: rows.count, by: per).map { Array(rows[$0..<Swift.min($0 + per, rows.count)]) }
    }

    /// The page to show after a horizontal swipe of `dx` (`dy` vertical), or the same page.
    static func swipePage(_ page: Int, pages: Int, dx: Double, dy: Double) -> Int {
        if abs(dx) < 40 || abs(dx) < abs(dy) * 1.5 { return page }
        return Swift.max(0, Swift.min(pages - 1, page + (dx < 0 ? 1 : -1)))
    }

    /// The page a Left or Right arrow moves to, within bounds.
    static func step(_ page: Int, pages: Int, forward: Bool) -> Int {
        Swift.max(0, Swift.min(pages - 1, page + (forward ? 1 : -1)))
    }

    private enum Measure: Equatable {
        case number(Double)
        case missing
        case text(BlockText)
    }

    /// The value a block's change is measured on: a number, else its text (status), else nothing.
    private static func measure(_ b: WidgetBlock) -> Measure? {
        switch b.type {
        case .metric, .progress, .gauge: return b.value.map(Measure.number) ?? .missing
        case .trend: return b.points?.last { $0.v != nil }?.v.map(Measure.number) ?? .missing
        case .status: return b.statusText.map(Measure.text) ?? .missing
        case .tanks: return nil
        }
    }

    /// How each block of `next` changed from the block at the same place in `prev`, when both have the
    /// same type and label (the same thing measured): up or down for a number, `text` for anything else.
    static func blockChanges(_ prev: [WidgetBlock]?, _ next: [WidgetBlock]) -> [BlockChange?] {
        next.enumerated().map { i, b in
            guard let prev, i < prev.count else { return nil }
            let a = prev[i]
            guard a.type == b.type, a.label == b.label, let x = measure(a), let y = measure(b), x != y else { return nil }
            if case .number(let u) = x, case .number(let v) = y { return v > u ? .up : .down }
            return .text
        }
    }

    /// Whether a point's time is finer than a day (then its readout shows the time too).
    static func isTimed(_ t: String) -> Bool {
        guard t.count > 10 else { return false }
        guard let r = t.range(of: "T00:00") else { return true }
        // Midnight, with or without seconds and fractions, in UTC or at a zero offset, is a whole day.
        var rest = t[r.upperBound...]
        if rest.hasPrefix(":00") {
            rest = rest.dropFirst(3)
            if rest.hasPrefix(".") { rest = rest.dropFirst().drop { $0 == "0" } }
        }
        return !(rest.isEmpty || rest == "Z" || rest == "+00:00" || rest == "-00:00" || rest == "+0000" || rest == "-0000")
    }
}

/// The view the reader last chose on each widget, on this device (the web keeps it in the browser's
/// `panel-widget-views`): a map from widget id to view id.
enum WidgetViewChoice {
    static let key = "panel-widget-views"

    private static func all(_ defaults: UserDefaults) -> [String: String] {
        defaults.dictionary(forKey: key)?.compactMapValues { $0 as? String } ?? [:]
    }

    /// The view chosen last on this widget, when it still has it; else its first.
    static func load(_ widget: String, ids: [String], defaults: UserDefaults = .standard) -> String? {
        if let saved = all(defaults)[widget], ids.contains(saved) { return saved }
        return ids.first
    }

    static func save(_ widget: String, view: String, defaults: UserDefaults = .standard) {
        var next = all(defaults)
        next[widget] = view
        defaults.set(next, forKey: key)
    }
}
