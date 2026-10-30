import Foundation

/// Widget blocks (docs/app-spec.md#blocks-a-state-card-instead-of-a-list, src/space/panel/blocks.ts):
/// the structured values an `items` widget may send next to its list. The Space has already
/// checked them; a block of a type this version does not know is dropped by `Lossy`.

/// A string, or the same text by language tag.
enum BlockText: Decodable, Hashable {
    case plain(String)
    case byLanguage([String: String])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .plain(s) } else { self = .byLanguage(try c.decode([String: String].self)) }
    }

    func text(lang: String = Lang.current) -> String {
        switch self {
        case .plain(let s): return s
        case .byLanguage(let t):
            return t[lang] ?? t.first { $0.key.split(separator: "-").first.map(String.init) == lang }?.value
                ?? t["en"] ?? t.sorted { $0.key < $1.key }.first?.value ?? ""
        }
    }
}

enum BlockTone: String, Decodable, Hashable {
    case positive, negative, warning, neutral
}

/// How a block's number is written.
struct BlockNumber: Decodable, Hashable {
    var format: String?
    var currency: String?
    var decimals: Int?
    var unit: BlockText?
}

struct WidgetBlock: Decodable, Hashable {
    enum Kind: String, Decodable {
        case metric, trend, progress, gauge, status, tanks
    }

    struct Delta: Decodable, Hashable {
        var value: Double
        var format: String?
        var currency: String?
        var decimals: Int?
        var unit: BlockText?
        var label: BlockText?
        var tone: BlockTone?

        var number: BlockNumber { BlockNumber(format: format, currency: currency, decimals: decimals, unit: unit) }
    }

    struct Point: Decodable, Hashable {
        var t: String
        var v: Double?
    }

    /// One upright tank of a `tanks` block: `value` of `max`, spilling over past it.
    struct Tank: Decodable, Hashable {
        var label: BlockText
        var value: Double?
        var max: Double
        var display: BlockText?
        var tone: BlockTone?
        var url: String?

        private enum CodingKeys: String, CodingKey { case label, value, max, display, tone, url }

        init(label: BlockText, value: Double?, max: Double, display: BlockText? = nil, tone: BlockTone? = nil, url: String? = nil) {
            (self.label, self.value, self.max, self.display, self.tone, self.url) = (label, value, max, display, tone, url)
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(BlockText.self, forKey: .label)
            value = try? c.decode(Double.self, forKey: .value)
            max = (try? c.decode(Double.self, forKey: .max)) ?? 100
            display = try? c.decode(BlockText.self, forKey: .display)
            tone = try? c.decode(BlockTone.self, forKey: .tone)
            url = try? c.decode(String.self, forKey: .url)
        }

        /// How full the tank is, 0…; above 1 it spills over.
        var level: Double {
            guard let value, max > 0 else { return 0 }
            return Swift.max(0, value / max)
        }

        /// The app's own text, else the share of `max` in percent (WidgetBlocks.tsx `tankValue`).
        func shown(lang: String = Lang.current) -> String? {
            if let display { return display.text(lang: lang) }
            guard let value, max > 0 else { return nil }
            return BlockFormat.string(value / max * 100, BlockNumber(format: "percent", decimals: 0), lang: lang)
        }
    }

    struct Zone: Decodable, Hashable {
        var to: Double
        var tone: BlockTone
        var label: BlockText?
    }

    var type: Kind
    var label: BlockText
    var caption: BlockText?
    var url: String?
    var tone: BlockTone?
    var number: BlockNumber
    /// The number of a metric, progress or gauge; nil when the app could not obtain it.
    var value: Double?
    /// The text of a status.
    var statusText: BlockText?
    var display: BlockText?
    var delta: Delta?
    var style: String?
    var signed: Bool?
    var points: [Point]?
    var min: Double?
    var max: Double?
    var zones: [Zone]?
    var time: String?
    var tanks: [Tank]?

    private enum CodingKeys: String, CodingKey {
        case type, label, caption, url, tone, value, display, delta, style, signed, points, min, max, zones, time, tanks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        type = try c.decode(Kind.self, forKey: .type)
        label = try c.decode(BlockText.self, forKey: .label)
        caption = try? c.decode(BlockText.self, forKey: .caption)
        url = try? c.decode(String.self, forKey: .url)
        tone = try? c.decode(BlockTone.self, forKey: .tone)
        number = (try? BlockNumber(from: decoder)) ?? BlockNumber()
        if type == .status {
            statusText = try c.decode(BlockText.self, forKey: .value)
        } else {
            value = try? c.decode(Double.self, forKey: .value)
        }
        display = try? c.decode(BlockText.self, forKey: .display)
        delta = try? c.decode(Delta.self, forKey: .delta)
        style = try? c.decode(String.self, forKey: .style)
        signed = try? c.decode(Bool.self, forKey: .signed)
        points = try? c.decode([Point].self, forKey: .points)
        min = try? c.decode(Double.self, forKey: .min)
        max = try? c.decode(Double.self, forKey: .max)
        zones = try? c.decode([Zone].self, forKey: .zones)
        time = try? c.decode(String.self, forKey: .time)
        tanks = try? c.decode([Tank].self, forKey: .tanks)
    }

    /// The value the block leads with, or nil when the app could not obtain it (WidgetBlocks.tsx `shown`).
    func shown(lang: String = Lang.current) -> String? {
        switch type {
        case .metric, .progress:
            if let display { return display.text(lang: lang) }
            return value.map { BlockFormat.string($0, number, lang: lang) }
        case .gauge:
            if let display { return display.text(lang: lang) }
            return value.map { BlockFormat.string($0, BlockNumber(), lang: lang) }
        case .trend:
            return points?.last { $0.v != nil }?.v.map { BlockFormat.string($0, number, lang: lang, signed: signed == true) }
        case .status:
            return statusText?.text(lang: lang)
        case .tanks:
            return nil
        }
    }

    /// The tone the value is drawn in: the block's own, or for a gauge the zone its value is in.
    var effectiveTone: BlockTone? {
        if let tone { return tone }
        guard type == .gauge, let value else { return nil }
        return zones?.first { value <= $0.to }?.tone
    }

    /// A progress as a share of its bar, 0…1.
    var fraction: Double {
        guard let value, let max, max > 0 else { return 0 }
        return Swift.max(0, Swift.min(1, value / max))
    }

    /// Where a value sits on a gauge's scale, 0…1.
    func position(_ v: Double) -> Double {
        let lo = min ?? 0, hi = max ?? 100
        guard hi > lo else { return 0 }
        return Swift.max(0, Swift.min(1, (v - lo) / (hi - lo)))
    }
}

/// Numbers in the reader's language, as the panel writes them (WidgetBlocks.tsx `fmt`).
enum BlockFormat {
    static func string(_ v: Double, _ n: BlockNumber, lang: String = Lang.current, signed: Bool = false) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: lang == "zh" ? "zh-Hans" : lang)
        var value = v
        var suffix = ""
        let d = n.decimals
        switch n.format {
        case "percent":
            f.numberStyle = .percent
            value = v / 100
            f.minimumFractionDigits = d ?? 0
            f.maximumFractionDigits = d ?? 1
        case "currency":
            f.numberStyle = .currency
            f.currencyCode = n.currency ?? "USD"
            if abs(v) >= 100_000 {
                (value, suffix) = compact(v, lang: lang)
                f.minimumFractionDigits = 0
                f.maximumFractionDigits = d ?? 2
            } else {
                f.minimumFractionDigits = d ?? 2
                f.maximumFractionDigits = d ?? 2
            }
        case "compact":
            f.numberStyle = .decimal
            (value, suffix) = compact(v, lang: lang)
            f.minimumFractionDigits = 0
            f.maximumFractionDigits = d ?? 1
        default:
            f.numberStyle = .decimal
            f.minimumFractionDigits = d ?? 0
            f.maximumFractionDigits = d ?? 2
        }
        if signed && v > 0 { f.positivePrefix = "+" + (f.positivePrefix ?? "") }
        let s = (f.string(from: NSNumber(value: value)) ?? "\(v)") + suffix
        let unit = n.unit?.text(lang: lang) ?? ""
        return unit.isEmpty ? s : "\(s) \(unit)"
    }

    /// A large number in the units its language counts in: thousands, millions and billions, or 万 and 亿.
    static func compact(_ v: Double, lang: String) -> (Double, String) {
        let a = abs(v)
        if lang == "zh" {
            if a >= 1e8 { return (v / 1e8, "亿") }
            if a >= 1e4 { return (v / 1e4, "万") }
            return (v, "")
        }
        if a >= 1e12 { return (v / 1e12, "T") }
        if a >= 1e9 { return (v / 1e9, "B") }
        if a >= 1e6 { return (v / 1e6, "M") }
        if a >= 1e3 { return (v / 1e3, "K") }
        return (v, "")
    }
}

enum WidgetLayout {
    /// Compact rows beside the hero, per card size (ROWS in WidgetBlocks.tsx).
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

/// The API's instants: ISO 8601 in UTC, with or without fractional seconds (docs/time.md).
enum ISO8601 {
    /// Made once: a formatter costs far more to make than to use, and a card parses several instants.
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let whole = ISO8601DateFormatter()

    static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? whole.date(from: text)
    }
}
