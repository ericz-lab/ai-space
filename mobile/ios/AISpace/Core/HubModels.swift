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
    /// The layout id: a peer's app is `<peer>/<app>`, as its calls and model rows name it.
    var id: String?
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
    /// Why it is shown but cannot be picked: `signed-out` or `offline` (docs/model-machines.md#inventory).
    var unavailable: String?

    var id: String { value }
    var label: String {
        let parts = [runtime, tier.map { $0.prefix(1).uppercased() + $0.dropFirst() }, model].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? value : parts.joined(separator: " · ")
    }
    var isAvailable: Bool { (unavailable ?? "").isEmpty }
    /// The label with the reason it cannot be picked.
    var shownLabel: String { ModelChoiceText.label(label, unavailable: unavailable) }
}

/// How every model picker shows a choice (src/web/model-choices.tsx): the Space already left out
/// what is missing on its machine; one that is not signed in, or on a peer that is offline, comes
/// with `unavailable` and is shown greyed with the reason; a saved choice that is no longer
/// offered stays selected, marked, so nothing is rewritten behind the person's back.
enum ModelChoiceText {
    static func reason(_ unavailable: String?) -> String? {
        guard let unavailable, !unavailable.isEmpty else { return nil }
        return unavailable == "offline" ? String(localized: "offline") : String(localized: "not signed in")
    }

    static func label(_ label: String, unavailable: String?) -> String {
        reason(unavailable).map { "\(label) (\($0))" } ?? label
    }

    /// A saved value the Space no longer offers.
    static func saved(_ value: String) -> String { "\(value) (\(String(localized: "not available")))" }
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
    /// The machine that ran the calls, when not the Space's own (docs/model-machines.md#ledger).
    var machine: String?

    /// The model with the machine that ran it: `david:gpt-6-luna` (Usage.tsx `modelOn`).
    var modelOn: String? { model.map { ModelMachine.on($0, machine) } }

    private enum CodingKeys: String, CodingKey { case app, tag, model, backend, origin, day, machine }

    init(from decoder: Decoder) throws {
        totals = try ModelTotals(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try? c.decode(String.self, forKey: .app)
        tag = try? c.decode(String.self, forKey: .tag)
        model = try? c.decode(String.self, forKey: .model)
        backend = try? c.decode(String.self, forKey: .backend)
        origin = try? c.decode(String.self, forKey: .origin)
        day = try? c.decode(String.self, forKey: .day)
        machine = try? c.decode(String.self, forKey: .machine)
    }
}

enum ModelMachine {
    static func on(_ model: String, _ machine: String?) -> String {
        guard let machine, !machine.isEmpty else { return model }
        return "\(machine):\(model)"
    }
}

struct ModelUsage: Decodable, Hashable {
    struct History: Decodable, Hashable {
        var firstAt: String?
        var totals: ModelTotals?
        var days: Lossy<ModelUsageRow>?
    }

    /// On a hub: each peer, whether its rows are in, and from when.
    struct Peer: Decodable, Hashable {
        var name: String
        var ok: Bool?
        var asOf: String?
        var error: String?
    }

    var window: String?
    var backend: String?
    /// The Space whose ledger this is; its apps' calls, including those it sent to another machine.
    var space: String?
    var peers: Lossy<Peer>?
    var totals: ModelTotals
    var byApp: Lossy<ModelUsageRow>?
    var byTag: Lossy<ModelUsageRow>?
    var byModel: Lossy<ModelUsageRow>?
    var history: History?

    /// The peers whose rows are stale or missing.
    var peersOff: [Peer] { (peers?.elements ?? []).filter { $0.ok != true } }

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
    /// `<peer>/<app>` for a peer's call on a hub.
    var app: String
    var tag: String?
    var model: String?
    /// The machine that ran it, when not this one.
    var machine: String?
    /// The peer this call comes from, on a hub.
    var peer: String?
    var origin: String?
    var status: String?
    var error: String?
    var startedAt: String?
    var durationMs: Double?
    var usage: Tokens?
    var costUsd: Double?

    var modelOn: String? { model.map { ModelMachine.on($0, machine) } }
    /// Two calls from different peers may share an id.
    var key: String { "\(peer ?? "")#\(id)" }
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

/// One peer's part of App models (src/web/AppModels.tsx `PeerModels`): its apps' rows and its own
/// choices, since their calls run there, or why there are none. Read through
/// `GET /api/peers/:peer/model/apps`; a peer app is keyed `<peer>/<app>`.
struct PeerAppModels: Hashable, Identifiable {
    var peer: String
    var apps: [AppModelRows]?
    var options: [ModelChoice]?
    var error: String?
    /// Its core does not have the route yet.
    var old = false

    var id: String { peer }
    var isLoading: Bool { apps == nil && error == nil && !old }

    /// The peer's answer. An older core answers a path it does not know with its page, not JSON.
    static func read(peer: String, data: Data) -> PeerAppModels {
        struct Body: Decodable {
            var ok: Bool?
            var error: String?
            var apps: Lossy<AppModelRows>?
            var options: Lossy<ModelChoice>?
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data) else { return PeerAppModels(peer: peer, old: true) }
        if body.ok == false { return PeerAppModels(peer: peer, error: body.error ?? "") }
        return PeerAppModels(peer: peer, apps: body.apps?.elements ?? [], options: body.options?.elements ?? [])
    }

    /// A 404 that is not about the peer itself: a core without the route, not a failure.
    static func isOlderCore(status: Int, error: String) -> Bool { status == 404 && !error.hasPrefix("unknown peer") }
}

// MARK: Agent CLIs by machine (docs/model-machines.md#inventory)

/// One agent CLI on one machine (`GET /api/model/inventory`): whether it is there, its version,
/// whether it is signed in, and which runtimes use it. Fields not yet probed are absent.
struct CliInfo: Decodable, Hashable, Identifiable {
    var cli: String
    var kind: String?
    var installed: Bool?
    var signedIn: Bool?
    var version: String?
    /// Where it was found; only on the Space's own row.
    var path: String?
    var detail: String?
    var checkedAt: String?
    var configured: Bool?
    var runtimes: [String]?

    var id: String { cli }

    enum State: Equatable {
        case unknown, missing, signedIn, signedOut
        /// Installed; whether it is signed in is not known.
        case installed
    }

    var state: State {
        guard let installed else { return .unknown }
        if !installed { return .missing }
        switch signedIn {
        case true?: return .signedIn
        case false?: return .signedOut
        case nil: return .installed
        }
    }
}

/// One machine's agent CLIs: the Space's own (`via` local), a `machines:` entry over ssh, or a peer.
struct MachineInventory: Decodable, Hashable, Identifiable {
    /// "" for the Space's own machine.
    var machine: String
    var via: String?
    /// False when the ssh login failed.
    var reachable: Bool?
    /// A peer that does not answer: its row is its last snapshot.
    var stale: Bool?
    /// A peer that runs an older ai-space, whose snapshot has no list.
    var old: Bool?
    var clis: Lossy<CliInfo>?

    var id: String { machine }
    var isLocal: Bool { via == "local" }
    var isOff: Bool { stale == true || reachable == false }
    var entries: [CliInfo] { old == true ? [] : clis?.elements ?? [] }

    /// A CLI found on the Space's own machine that no runtime uses can be added to runtimes.yaml
    /// (operator only); a peer's row is changed on that peer. A kind just added waits for a restart.
    func canAdd(_ c: CliInfo, pending: Set<String>) -> Bool {
        guard isLocal, c.installed == true, c.configured != true, let kind = c.kind else { return false }
        return !pending.contains(kind)
    }

    /// What the row says about the machine itself (MachineClis.tsx `machineNote`).
    var note: String? {
        if old == true { return String(localized: "Older ai-space: no list") }
        if stale == true { return String(localized: "Offline · last known") }
        if reachable == false { return String(localized: "Unreachable") }
        switch via {
        case "ssh": return "ssh"
        case "peer": return String(localized: "peer")
        default: return nil
        }
    }

    /// When the CLIs were last probed, on any machine.
    static func lastChecked(_ rows: [MachineInventory]) -> Date? {
        rows.flatMap(\.entries).compactMap { $0.checkedAt.flatMap(ISO8601.parse) }.max()
    }

    /// The answer of `GET /api/model/inventory` and of a re-probe.
    static func decode(_ data: Data) throws -> [MachineInventory] {
        struct Body: Decodable { var machines: Lossy<MachineInventory> }
        return try Hub.decode(Body.self, from: data).machines.elements
    }
}

// MARK: Feedback (docs/feedback.md)

/// The settings of the feedback button on app pages and of the Fix Engineer
/// (`GET /api/panel/feedback/settings`, src/web/FeedbackSettings.tsx). Read leniently, as the Linux
/// client does: a value it does not know falls back to the Space's default.
struct FeedbackSettings: Decodable, Equatable {
    static let efforts = ["high", "xhigh", "max"]

    /// The main switch: off, no app shows the button.
    var enabled = false
    /// Apps with no switch of their own show the button when this is true.
    var appsDefault = true
    /// Per-app switches, `on` or `off`; an app missing here follows `appsDefault`.
    var apps: [String: String] = [:]
    /// `auto` fixes at once, `later` records it to be fixed together.
    var mode = "auto"
    /// Where the Fix Engineer runs: "" for the Space's own machine, else a peer's name.
    var machine = ""
    /// `runtime/model`; "" for the default chat model.
    var model = ""
    var effort = "xhigh"
    /// Whether the page sends the last script errors it saw.
    var errors = true

    private enum CodingKeys: String, CodingKey { case enabled, appsDefault, apps, mode, machine, model, effort, errors }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) == true
        appsDefault = (try? c.decode(Bool.self, forKey: .appsDefault)) != false
        apps = ((try? c.decode([String: String].self, forKey: .apps)) ?? [:]).filter { $0.value == "on" || $0.value == "off" }
        mode = (try? c.decode(String.self, forKey: .mode)) == "later" ? "later" : "auto"
        machine = (try? c.decode(String.self, forKey: .machine)) ?? ""
        model = (try? c.decode(String.self, forKey: .model)) ?? ""
        let effort = try? c.decode(String.self, forKey: .effort)
        self.effort = effort.flatMap { Self.efforts.contains($0) ? $0 : nil } ?? "xhigh"
        errors = (try? c.decode(Bool.self, forKey: .errors)) != false
    }

    /// Whether an app's pages show the button.
    func shown(_ app: String) -> Bool { enabled && (apps[app].map { $0 == "on" } ?? appsDefault) }
}

/// One change to the feedback settings, as `PUT /api/panel/feedback/settings` takes it.
enum FeedbackChange: Equatable {
    case enabled(Bool)
    case appsDefault(Bool)
    /// An app's switch: `default`, `on` or `off`. A peer's apps take the same switches (the hub sends them on).
    case app(String, String)
    case mode(String)
    case machine(String)
    case model(String)
    case effort(String)
    case errors(Bool)

    var json: [String: Any] {
        switch self {
        case .enabled(let v): return ["enabled": v]
        case .appsDefault(let v): return ["appsDefault": v]
        case .app(let app, let v): return ["apps": [app: v]]
        case .mode(let v): return ["mode": v]
        case .machine(let v): return ["machine": v]
        case .model(let v): return ["model": v]
        case .effort(let v): return ["effort": v]
        case .errors(let v): return ["errors": v]
        }
    }
}

struct FeedbackApp: Decodable, Hashable, Identifiable {
    var app: String
    var title: String?
    var zh: String?
    var enabled: Bool?

    var id: String { app }
    func displayTitle(lang: String = Lang.current) -> String {
        if lang == "zh", let zh, !zh.isEmpty { return zh }
        return title.flatMap { $0.isEmpty ? nil : $0 } ?? app
    }
}

/// A peer's apps, which follow these settings: the hub sends them on (docs/feedback.md#apps-on-a-peer).
struct FeedbackPeer: Decodable, Hashable, Identifiable {
    var name: String
    var ok: Bool?
    var error: String?
    /// The settings reached the peer.
    var synced: Bool?
    var apps: Lossy<FeedbackApp>?
    var counts: [String: Int]?

    var id: String { name }
    var appList: [FeedbackApp] { apps?.elements ?? [] }
    var waiting: Int { counts?["later"] ?? 0 }
}

struct FeedbackView: Decodable, Equatable {
    struct Machine: Decodable, Hashable, Identifiable {
        var value: String
        var label: String
        var id: String { value }
    }

    var settings: FeedbackSettings
    var apps: [FeedbackApp]
    /// Absent from an older Space.
    var peers: [FeedbackPeer]
    var machines: [Machine]
    var models: [ModelChoice]
    var counts: [String: Int]
    var shortcut: String

    private enum CodingKeys: String, CodingKey { case settings, apps, peers, machines, models, counts, shortcut }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = (try? c.decode(FeedbackSettings.self, forKey: .settings)) ?? FeedbackSettings()
        apps = (try? c.decode(Lossy<FeedbackApp>.self, forKey: .apps))?.elements ?? []
        peers = (try? c.decode(Lossy<FeedbackPeer>.self, forKey: .peers))?.elements ?? []
        machines = (try? c.decode(Lossy<Machine>.self, forKey: .machines))?.elements ?? []
        models = (try? c.decode(Lossy<ModelChoice>.self, forKey: .models))?.elements ?? []
        counts = (try? c.decode([String: Int].self, forKey: .counts)) ?? [:]
        shortcut = (try? c.decode(String.self, forKey: .shortcut)) ?? "Alt+Shift+F"
    }

    /// Feedback waiting to be fixed here.
    var waiting: Int { counts["later"] ?? 0 }

    /// The view with a change applied the way the Space applies it (FeedbackSettings.tsx
    /// `withPatch`): an app set to `default` loses its own switch, and each app's shown or hidden
    /// follows. The page shows a choice at once and saves in the background.
    func applying(_ change: FeedbackChange) -> FeedbackView {
        var next = self
        switch change {
        case .enabled(let v): next.settings.enabled = v
        case .appsDefault(let v): next.settings.appsDefault = v
        case .app(let app, let v): next.settings.apps[app] = v == "default" ? nil : v
        case .mode(let v): next.settings.mode = v
        case .machine(let v): next.settings.machine = v
        case .model(let v): next.settings.model = v
        case .effort(let v): next.settings.effort = v
        case .errors(let v): next.settings.errors = v
        }
        let s = next.settings
        func follow(_ apps: [FeedbackApp]) -> [FeedbackApp] { apps.map { var a = $0; a.enabled = s.shown(a.app); return a } }
        next.apps = follow(apps)
        next.peers = peers.map { p in
            guard p.ok == true else { return p }
            var q = p
            q.apps?.elements = follow(p.appList)
            return q
        }
        return next
    }

    /// An app's title, here or on a peer; its id when neither lists it.
    func title(_ app: String, peer: String?, lang: String = Lang.current) -> String {
        let rows = peer.map { name in peers.first { $0.name == name }?.appList ?? [] } ?? apps
        return rows.first { $0.app == app }?.displayTitle(lang: lang) ?? app
    }
}

/// One piece of feedback sent lately (`GET /api/panel/feedback`), a peer's too on a hub.
struct FeedbackItem: Decodable, Hashable, Identifiable {
    var id: Int
    var peer: String?
    var app: String
    var text: String
    var status: String
    var todoId: Int?
    var todoUrl: String?
    var runMachine: String?
    var note: String?
    /// Milliseconds since 1970.
    var createdAt: Double?

    /// Two Spaces may have the same id.
    var key: String { "\(peer ?? "")-\(id)" }
    /// The peer it was sent on; nil for this Space's own (which the route marks with "").
    var peerName: String? { peer.flatMap { $0.isEmpty ? nil : $0 } }
    /// The Fix Engineer is at it or about to be: the list follows it.
    var isActive: Bool { status == "fixing" || status == "queued" }
    /// Fix now (waiting) or Fix again (not fixed, needs a person, to review), for a row with a task.
    var canFix: Bool { todoId != nil && ["failed", "skipped", "review", "later"].contains(status) }
    /// The engineer's note, shown on the rows where it says why.
    var shownNote: String? {
        guard let note, ["failed", "skipped", "recorded"].contains(status) else { return nil }
        let line = note.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        return String(line.prefix(120))
    }

    /// The status in words (`feedback.status.*`).
    static func statusText(_ status: String) -> String {
        switch status {
        case "later": return String(localized: "Waiting to be fixed")
        case "queued": return String(localized: "Queued")
        case "fixing": return String(localized: "Fixing")
        case "review": return String(localized: "Fixed — to review")
        case "failed": return String(localized: "Not fixed")
        case "skipped": return String(localized: "Needs a person")
        case "recorded": return String(localized: "Recorded")
        case "accepted": return String(localized: "Accepted")
        case "dropped": return String(localized: "Dropped in ai-todo")
        default: return status
        }
    }
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
