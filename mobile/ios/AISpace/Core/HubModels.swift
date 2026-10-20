import Foundation

/// What the Space's own pages read (src/web/api.ts has the full shapes): tasks, model usage, app
/// usage, app models, events, packages, the inbox and chat. Every field a page can live without
/// is optional, so a newer or older Space still decodes; a malformed row is skipped.

enum Hub {
    /// The rows under one key of a route's answer: `{"ok":true,"tasks":[…]}`.
    static func rows<T: Decodable>(_ type: T.Type, _ key: String, from data: Data) throws -> [T] {
        let decoder = JSONDecoder()
        decoder.userInfo[Keyed<T>.key] = key
        return try decoder.decode(Keyed<T>.self, from: data).rows
    }

    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(T.self, from: data)
    }

    private struct Keyed<T: Decodable>: Decodable {
        static var key: CodingUserInfoKey { CodingUserInfoKey(rawValue: "hub.key")! }
        var rows: [T]

        init(from decoder: Decoder) throws {
            let key = decoder.userInfo[Self.key] as? String ?? ""
            let c = try decoder.container(keyedBy: AnyKey.self)
            rows = try c.decodeIfPresent(Lossy<T>.self, forKey: AnyKey(key))?.elements ?? []
        }
    }

    struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ s: String) { stringValue = s }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
}

/// Any JSON value, for an event's free-form data.
enum JSONValue: Decodable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    /// The value on one line: a string bare, anything else as JSON.
    var compact: String {
        switch self {
        case .null: return "null"
        case .bool(let b): return b ? "true" : "false"
        case .number(let n): return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        case .string(let s): return s
        case .array(let a): return "[" + a.map(\.quoted).joined(separator: ",") + "]"
        case .object(let o): return "{" + o.sorted { $0.key < $1.key }.map { "\"\($0.key)\":\($0.value.quoted)" }.joined(separator: ",") + "}"
        }
    }

    private var quoted: String {
        if case .string(let s) = self { return "\"\(s)\"" }
        return compact
    }
}

/// An app's name and icon for a heading; `GET /api/apps?all=1` also names headless and hidden apps.
struct AppLabel: Decodable, Hashable {
    var name: String
    var title: String
    var i18n: I18n?
    var icon: String?

    var displayTitle: String { Lang.pick(title, i18n, \.title) }
}

/// A runtime and tier a task or an app's calls may run on.
struct ModelChoice: Decodable, Hashable, Identifiable {
    struct Capabilities: Decodable, Hashable {
        var agent: Bool?
        var complete: Bool?
    }

    var value: String
    var runtime: String?
    var tier: String?
    var model: String?
    var capabilities: Capabilities?

    var id: String { value }
    var label: String {
        let parts = [runtime, tier.map { $0.prefix(1).uppercased() + $0.dropFirst() }, model].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? value : parts.joined(separator: " · ")
    }
}

// MARK: Tasks (docs/scheduler.md)

struct TaskSchedule: Decodable, Hashable {
    var kind: String
    var at: String?
    var everyMs: Double?
    var expr: String?
    var tz: String?
}

struct SpaceTask: Decodable, Hashable, Identifiable {
    struct Target: Decodable, Hashable { var kind: String? }
    struct Trigger: Decodable, Hashable { var event: String }
    struct Overrides: Decodable, Hashable {
        var enabled: Bool?
        var schedule: TaskSchedule?
        var model: String?

        var isEmpty: Bool { enabled == nil && schedule == nil && model == nil }
    }
    struct Base: Decodable, Hashable { var model: String? }
    struct Pending: Decodable, Hashable {
        var events: Int
        var dueAt: String?
    }
    struct State: Decodable, Hashable {
        var nextRunAt: String?
        var runningAt: String?
        var lastRunAt: String?
        var lastStatus: String?
        var lastError: String?
        var lastDurationMs: Double?
        var consecutiveErrors: Int?
        var pending: Pending?
    }

    var id: String
    var app: String
    var name: String
    var description: String?
    var source: String?
    var orphaned: Bool?
    var enabled: Bool?
    var schedule: TaskSchedule
    var target: Target?
    var triggers: [Trigger]?
    var overrides: Overrides?
    var model: String?
    var modelSelectable: Bool?
    var base: Base?
    var state: State?

    enum Status: Equatable {
        /// Its app or manifest entry is gone.
        case orphaned
        case off
        case running
        case ok
        /// Failed, this many times in a row.
        case error(Int)
        case skipped
        case neverRan
    }

    /// As the panel's row reads it (Tasks.tsx `rowStatus`).
    var status: Status {
        if orphaned == true { return .orphaned }
        if enabled == false { return .off }
        if state?.runningAt != nil { return .running }
        switch state?.lastStatus {
        case "ok": return .ok
        case "error": return .error(max(state?.consecutiveErrors ?? 1, 1))
        case "skipped": return .skipped
        default: return .neverRan
        }
    }

    var isActive: Bool { enabled != false && orphaned != true }
    var isFailing: Bool { isActive && state?.lastStatus == "error" }

    /// The models this task may be given: an agent task needs a runtime that runs agents.
    func eligible(_ options: [ModelChoice]) -> [ModelChoice] {
        options.filter { target?.kind == "agent" ? $0.capabilities?.agent == true : $0.capabilities?.complete == true }
    }
}

struct TaskRun: Decodable, Hashable, Identifiable {
    var id: Int
    /// Milliseconds since 1970.
    var startedAt: Double
    var endedAt: Double?
    var status: String
    var error: String?
    var output: String?
    var trigger: String?
    var eventIds: [Int]?

    var started: Date { Date(timeIntervalSince1970: startedAt / 1000) }
    var durationMs: Double? { endedAt.map { $0 - startedAt } }
}

// MARK: Model usage (docs/model.md)

struct ModelTotals: Decodable, Hashable {
    var calls: Double?
    var errors: Double?
    var inputTokens: Double?
    var cacheWriteTokens: Double?
    var cacheReadTokens: Double?
    var outputTokens: Double?
    var tokens: Double?
    var costUsd: Double?
    var durationMs: Double?
}

/// Totals for one app, tag, model, backend or day: the totals and whichever names the row has.
struct ModelUsageRow: Decodable, Hashable {
    var totals: ModelTotals
    var app: String?
    var tag: String?
    var model: String?
    var backend: String?
    var origin: String?
    var day: String?

    private enum CodingKeys: String, CodingKey { case app, tag, model, backend, origin, day }

    init(from decoder: Decoder) throws {
        totals = try ModelTotals(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try? c.decode(String.self, forKey: .app)
        tag = try? c.decode(String.self, forKey: .tag)
        model = try? c.decode(String.self, forKey: .model)
        backend = try? c.decode(String.self, forKey: .backend)
        origin = try? c.decode(String.self, forKey: .origin)
        day = try? c.decode(String.self, forKey: .day)
    }
}

struct ModelUsage: Decodable, Hashable {
    struct History: Decodable, Hashable {
        var firstAt: String?
        var totals: ModelTotals?
        var days: Lossy<ModelUsageRow>?
    }

    var window: String?
    var backend: String?
    var totals: ModelTotals
    var byApp: Lossy<ModelUsageRow>?
    var byTag: Lossy<ModelUsageRow>?
    var byModel: Lossy<ModelUsageRow>?
    var history: History?

    /// Whole days since the first recorded call, at least one.
    func daysRecorded(now: Date = Date()) -> Int {
        guard let first = history?.firstAt.flatMap(ISO8601.parse) else { return 0 }
        return max(1, Int((now.timeIntervalSince(first) / 86400).rounded(.up)))
    }

    /// The last weeks' totals of one figure, oldest first; weeks are UTC and start on Monday,
    /// like the ledger's days (Usage.tsx `History`).
    func weekly(_ figure: KeyPath<ModelTotals, Double?>, last count: Int = 12) -> [(week: Date, value: Double)] {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let parser = DateFormatter()
        parser.calendar = calendar
        parser.timeZone = calendar.timeZone
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.dateFormat = "yyyy-MM-dd"
        var sums: [Date: Double] = [:]
        for row in history?.days?.elements ?? [] {
            guard let day = row.day.flatMap(parser.date), let week = calendar.dateInterval(of: .weekOfYear, for: day)?.start else { continue }
            sums[week, default: 0] += row.totals[keyPath: figure] ?? 0
        }
        return sums.sorted { $0.key < $1.key }.suffix(count).map { ($0.key, $0.value) }
    }
}

struct ModelCall: Decodable, Hashable, Identifiable {
    struct Tokens: Decodable, Hashable {
        var inputTokens: Double?
        var cacheWriteTokens: Double?
        var cacheReadTokens: Double?
        var outputTokens: Double?

        var total: Double { (inputTokens ?? 0) + (cacheWriteTokens ?? 0) + (cacheReadTokens ?? 0) + (outputTokens ?? 0) }
    }

    var id: Int
    var app: String
    var tag: String?
    var model: String?
    var status: String?
    var error: String?
    var startedAt: String?
    var durationMs: Double?
    var usage: Tokens?
    var costUsd: Double?
}

// MARK: App usage (docs/usage.md)

struct AppUsageRow: Decodable, Hashable, Identifiable {
    struct Day: Decodable, Hashable {
        var day: String
        var opens: Double?
        var activeMs: Double?
    }

    var kind: String
    var key: String
    var opens: Int
    /// nil when the entry does not measure time in use.
    var activeMs: Double?
    var sessions: Int?
    var lastAt: String?
    var daily: [Day]?

    var id: String { "\(kind):\(key)" }
    var averageMs: Double? {
        guard let activeMs, let sessions, sessions > 0 else { return nil }
        return activeMs / Double(sessions)
    }

    /// The last UTC days as bars: time in use when the entry measures it, opens otherwise.
    func spark(days: Int = 30, now: Date = Date()) -> [Double] {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        let byDay = Dictionary((daily ?? []).map { ($0.day, $0) }, uniquingKeysWith: { a, _ in a })
        return (0..<days).map { i in
            guard let d = byDay[f.string(from: now.addingTimeInterval(-Double(days - 1 - i) * 86400))] else { return 0 }
            return (activeMs != nil ? d.activeMs : d.opens) ?? 0
        }
    }
}

/// Device foreground intervals, independent of the application's own usage metric.
struct DeviceAppUsageRow: Decodable, Hashable, Identifiable {
    var key: String
    var opens: Int
    var activeMs: Double?
    var lastAt: String
    var id: String { key }
}

struct DeviceUsageRow: Decodable, Hashable, Identifiable {
    var apps: [DeviceAppUsageRow]?
    var deviceId: String
    var client: String
    var sessions: Int
    var activeMs: Double
    var lastAt: String
    var id: String { "\(client):\(deviceId)" }
    var clientName: String {
        switch client {
        case "ios": return "iOS"
        case "macos": return "macOS"
        case "android": return "Android"
        case "web": return "Web"
        default: return client
        }
    }
    var shortID: String { String(deviceId.suffix(8)) }
}

// MARK: App models (docs/model.md#app-models)

struct AppModelRows: Decodable, Hashable, Identifiable {
    struct Row: Decodable, Hashable, Identifiable {
        /// nil is the row for the whole app.
        var tag: String?
        /// What space.yaml declares.
        var manifest: String?
        /// What the panel set over it.
        var override: String?
        /// What the calls run on now.
        var model: String
        var source: String?

        var id: String { tag ?? "" }
    }

    var app: String
    var rows: [Row]

    var id: String { app }
}

// MARK: Events (docs/events.md)

struct SpaceEvent: Decodable, Hashable, Identifiable {
    var id: Int
    var name: String
    var app: String?
    var at: String
    var peer: String?
    var data: [String: JSONValue]?

    /// The first few fields of the data on one line (Events.tsx `previewData`).
    var preview: String {
        let s = (data ?? [:]).sorted { $0.key < $1.key }.prefix(4).map { "\($0.key): \($0.value.compact)" }.joined(separator: " · ")
        return s.count > 120 ? String(s.prefix(119)) + "…" : s
    }
}

struct EventDelivery: Decodable, Hashable, Identifiable {
    var id: Int
    var app: String
    var kind: String?
    var method: String?
    var path: String?
    var status: String
    var attempts: Int?
    var lastError: String?
}

struct CapabilityApp: Decodable, Hashable, Identifiable {
    struct Provided: Decodable, Hashable {
        var name: String
        var description: String?
        var method: String?
        var path: String?
    }
    struct Published: Decodable, Hashable {
        var name: String
        var description: String?
    }
    struct Consumed: Decodable, Hashable {
        var event: String
        var kind: String?
        var task: String?
        var method: String?
        var path: String?
    }
    struct Stat: Decodable, Hashable {
        var capability: String
        var calls: Int?
        var failures: Int?
    }

    var app: String
    var peer: String?
    var provides: [Provided]?
    var publishes: [Published]?
    var consumes: [Consumed]?
    var stats: [Stat]?

    var id: String { peer.map { "\($0)/\(app)" } ?? app }
    var isEmpty: Bool { (provides ?? []).isEmpty && (publishes ?? []).isEmpty && (consumes ?? []).isEmpty }
}

// MARK: Packages and connections (docs/packages.md)

struct PackageApp: Decodable, Hashable, Identifiable {
    var app: String
    var title: String?
    var version: String?
    var url: String?
    var page: Bool?
    var state: String?

    var id: String { app }
}

struct PackageCatalogue: Decodable, Hashable {
    struct Remote: Decodable, Hashable, Identifiable {
        var connectionId: String
        var spaceId: String?
        var available: Bool?
        var apps: Lossy<PackageApp>?

        var id: String { connectionId }
    }

    var spaceId: String?
    var apps: Lossy<PackageApp>?
    var remotes: Lossy<Remote>?
}

/// A connection to another Space, and the apps this Space shares over it.
struct SpaceLink: Decodable, Hashable, Identifiable {
    var id: String
    var remoteSpaceId: String?
    var direction: String?
    var url: String?
    var apps: [String]?
    var enabled: Bool?
    var connected: Bool?
}

// MARK: Inbox (docs/notify.md#inbox)

struct InboxThread: Decodable, Hashable, Identifiable {
    var thread: String
    var app: String
    var level: String?
    var title: String?
    var text: String
    var url: String?
    var count: Int?
    var firstAt: String?
    var lastAt: String?
    /// The level asks for something (alert or warn).
    var action: Bool?
    var unread: Bool?
    var done: Bool?

    var id: String { thread }
    /// The row's heading: the title, or the text's first line.
    var heading: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? Self.firstLine(text) }

    static func firstLine(_ text: String) -> String {
        let line = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return line.count > 140 ? String(line.prefix(139)) + "…" : line
    }
}

enum InboxFilter: String, CaseIterable, Identifiable {
    case all, unread, handle, done

    var id: String { rawValue }
    /// The query of `GET /api/inbox` (Inbox.tsx `QUERY`).
    var query: String {
        switch self {
        case .all: return "filter=all"
        case .unread: return "filter=unread"
        case .handle: return "filter=open&action=1"
        case .done: return "filter=done"
        }
    }
}

// MARK: Chat (docs/panel.md#chat)

struct ChatSessionInfo: Decodable, Hashable, Identifiable {
    var sid: String
    var title: String?
    /// Milliseconds since 1970.
    var ts: Double?
    var model: String?

    var id: String { sid }
}

/// One message of a stored session. An assistant's message names the tools it called and, from
/// Spaces that record them, its text and tool calls in order with their input and output (`steps`,
/// `TranscriptStep` in src/space/runtimes/types.ts). Unreadable tools or steps are left out rather
/// than losing the conversation.
struct ChatStored: Decodable, Hashable {
    struct Tool: Decodable, Hashable {
        var name: String
        var hint: String?
    }
    struct Step: Decodable, Hashable {
        /// `text` or `tool`.
        var kind: String
        var text: String?
        var name: String?
        var input: String?
        var output: String?
        var failed: Bool?
    }

    var role: String
    var text: String?
    var tools: [Tool]?
    var steps: [Step]?

    private enum CodingKeys: String, CodingKey { case role, text, tools, steps }

    init(role: String, text: String?, tools: [Tool]? = nil, steps: [Step]? = nil) {
        self.role = role
        self.text = text
        self.tools = tools
        self.steps = steps
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        role = try c.decode(String.self, forKey: .role)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        tools = try? c.decodeIfPresent([Tool].self, forKey: .tools)
        steps = try? c.decodeIfPresent([Step].self, forKey: .steps)
    }
}

enum ChatRoute {
    /// The route base of an agent's chat from its catalogue ref: `<app>/<name>`, behind `<peer>/`
    /// when the agent lives on a peer (src/web/api.ts `agentBase`).
    static func base(ref: String, peer: String?) -> String? {
        var parts = ref.split(separator: "/").map(String.init)
        if let peer, parts.first == peer { parts.removeFirst() }
        guard parts.count == 2 else { return nil }
        let prefix = peer.map { "/api/peers/\(SpacePath.escape($0))" } ?? "/api"
        return "\(prefix)/agents/\(SpacePath.escape(parts[0]))/\(SpacePath.escape(parts[1]))"
    }
}

// MARK: Figures

enum HubFormat {
    /// 1234 → 1.2K, 1234567 → 1.23M, 2689400000 → 2.69B; a missing figure is a dash (Usage.tsx `fmtTokens`).
    static func tokens(_ n: Double?) -> String {
        guard let n else { return "–" }
        if n >= 1e9 { return String(format: "%.2fB", n / 1e9) }
        if n >= 1e6 { return String(format: n >= 1e7 ? "%.1fM" : "%.2fM", n / 1e6) }
        if n >= 1e3 { return String(format: n >= 1e4 ? "%.0fK" : "%.1fK", n / 1e3) }
        return String(Int(n))
    }

    static func cost(_ usd: Double?) -> String {
        guard let usd else { return "–" }
        if usd >= 100 { return String(format: "$%.0f", usd) }
        if usd >= 1 { return String(format: "$%.2f", usd) }
        return String(format: "$%.3f", usd)
    }

    static func count(_ n: Double?) -> String {
        guard let n else { return "–" }
        return Int(n).formatted()
    }

    /// A length of time in at most two units, in the reader's language; under a second in milliseconds.
    static func duration(ms: Double?) -> String {
        guard let ms else { return "–" }
        if ms < 1000 { return "\(Int(max(0, ms.rounded()))) ms" }
        let f = DateComponentsFormatter()
        f.unitsStyle = .abbreviated
        f.allowedUnits = [.day, .hour, .minute, .second]
        f.maximumUnitCount = 2
        return f.string(from: (ms / 1000).rounded()) ?? "\(Int(ms / 1000)) s"
    }

    /// "in 5 min" or "2 hr ago".
    static func relative(_ date: Date, now: Date = Date()) -> String {
        date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
    }
}
