import Foundation

/// What one of the Space's pages has read, asked from the Space with its session each time the
/// page comes up and when it is pulled down. Nothing is kept on the phone.
@MainActor
class HubStore: ObservableObject {
    let api: SpaceAPI
    @Published private(set) var isLoading = false
    /// The first answer has arrived.
    @Published private(set) var loaded = false
    /// Why the last read failed, until one succeeds.
    @Published private(set) var error: String?
    /// Why the last change was not taken, until the next one is.
    @Published var saveError: String?
    @Published private(set) var isSaving = false
    /// A refresh was asked for while one was on its way (the window or filter changed): read again after it.
    private var again = false

    init(api: SpaceAPI) {
        self.api = api
    }

    /// Subclasses read their routes here.
    func load() async throws {}

    func refresh() async {
        if isLoading {
            again = true
            return
        }
        isLoading = true
        repeat {
            again = false
            do {
                try await load()
                error = nil
                loaded = true
            } catch where Task.isCancelled || (error as? URLError)?.code == .cancelled || error is CancellationError {
                // The page that asked went away; nothing was learnt.
            } catch {
                self.error = Self.message(error)
            }
        } while again
        isLoading = false
    }

    /// One change to the Space; the page reads again after it.
    func save(_ work: () async throws -> Void) async {
        guard !isSaving else { return }
        isSaving = true
        do {
            try await work()
            saveError = nil
        } catch {
            saveError = Self.message(error)
        }
        isSaving = false
    }

    static func message(_ error: Error) -> String {
        switch error as? SpaceAPIError {
        case .authenticationRequired: return String(localized: "Sign in to this Space first.")
        case .http(let code, let text): return "\(text) (HTTP \(code))"
        case .invalidResponse: return String(localized: "The Space's answer could not be read.")
        case nil: return error.localizedDescription
        }
    }

    /// Names and icons of every app, headless and hidden ones too; a failure leaves the bare names.
    /// Asked once, beside the page's own rows, which do not wait for it.
    @Published private(set) var labels: [String: AppLabel] = [:]
    private var askedLabels = false

    func loadLabels() {
        Task { await fetchLabels() }
    }

    /// For a page that orders its rows by these names: it waits, so the rows do not move under the reader.
    func fetchLabels() async {
        guard !askedLabels else { return }
        askedLabels = true
        guard let data = try? await api.data("/api/apps?all=1"), let apps = try? Hub.rows(AppLabel.self, "apps", from: data) else {
            askedLabels = false
            return
        }
        labels = Dictionary(apps.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
    }

    func title(_ app: String) -> String { labels[app]?.displayTitle ?? app }
}

final class TasksStore: HubStore {
    @Published private(set) var tasks: [SpaceTask] = []
    @Published private(set) var options: [ModelChoice] = []
    @Published private(set) var runs: [String: [TaskRun]] = [:]
    @Published private(set) var runErrors: [String: String] = [:]

    override func load() async throws {
        if options.isEmpty {
            Task {
                guard let data = try? await api.data("/api/tasks/models") else { return }
                options = (try? Hub.rows(ModelChoice.self, "models", from: data)) ?? []
            }
        }
        async let names: Void = fetchLabels()
        let fresh = try Hub.rows(SpaceTask.self, "tasks", from: try await api.data("/api/tasks"))
        await names
        tasks = fresh
    }

    /// The tasks by app, apps by title, tasks by name.
    var groups: [(app: String, tasks: [SpaceTask])] {
        Dictionary(grouping: tasks, by: \.app)
            .map { (app: $0.key, tasks: $0.value.sorted { $0.name < $1.name }) }
            .sorted { title($0.app).localizedCaseInsensitiveCompare(title($1.app)) == .orderedAscending }
    }

    func task(_ id: String) -> SpaceTask? { tasks.first { $0.id == id } }

    func loadRuns(_ id: String) async {
        do {
            runs[id] = try Hub.rows(TaskRun.self, "runs", from: try await api.data("/api/tasks/\(SpacePath.escape(id))/runs?limit=20"))
            runErrors[id] = nil
        } catch {
            runErrors[id] = Self.message(error)
        }
    }

    /// Sets the model the task runs on from its next run, or returns it to its default with nil.
    func setModel(_ id: String, _ value: String?) async {
        await save {
            let answer = try await api.send("PATCH", "/api/panel/tasks/\(SpacePath.escape(id))/model", json: ["model": value ?? NSNull()])
            struct Body: Decodable { var task: SpaceTask }
            if let fresh = try? Hub.decode(Body.self, from: answer).task, let i = tasks.firstIndex(where: { $0.id == id }) { tasks[i] = fresh }
        }
    }
}

final class ModelUsageStore: HubStore {
    static let windows = ["5h", "24h", "7d", "30d"]
    @Published var window = "24h"
    @Published private(set) var usage: ModelUsage?
    @Published private(set) var calls: [ModelCall] = []

    override func load() async throws {
        loadLabels()
        let asked = window
        async let recent = try? api.data("/api/model/calls?limit=30")
        let fresh = try Hub.decode(ModelUsage.self, from: try await api.data("/api/model/usage?window=\(asked)"))
        let c = await recent
        // The window changed while this one was on its way.
        guard asked == window else { return }
        usage = fresh
        calls = c.flatMap { try? Hub.rows(ModelCall.self, "calls", from: $0) } ?? []
    }
}

final class AppUsageStore: HubStore {
    static let windows = ["7d", "30d", "90d", "all"]
    static let kinds = ["all", "app", "agent", "builtin"]
    @Published var window = "30d"
    @Published var kind = "all"
    @Published private(set) var rows: [AppUsageRow] = []
    /// The same entries over 30 days, for the trend, whatever the window.
    @Published private(set) var month: [String: AppUsageRow] = [:]

    override func load() async throws {
        let (w, k) = (window, kind)
        let q = k == "all" ? "" : "&kind=\(k)"
        let fresh = try Hub.rows(AppUsageRow.self, "usage", from: try await api.data("/api/usage?window=\(w)\(q)"))
        var thirty = fresh
        if w != "30d", let data = try? await api.data("/api/usage?window=30d\(q)") {
            thirty = (try? Hub.rows(AppUsageRow.self, "usage", from: data)) ?? []
        }
        guard w == window, k == kind else { return }
        rows = fresh
        month = Dictionary(thirty.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    var opens: Int { rows.reduce(0) { $0 + $1.opens } }
    var activeMs: Double { rows.reduce(0) { $0 + ($1.activeMs ?? 0) } }
}

final class AppModelsStore: HubStore {
    @Published private(set) var apps: [AppModelRows] = []
    @Published private(set) var options: [ModelChoice] = []

    override func load() async throws {
        async let names: Void = fetchLabels()
        let data = try await api.data("/api/model/apps")
        await names
        options = (try? Hub.rows(ModelChoice.self, "options", from: data)) ?? []
        apps = try Hub.rows(AppModelRows.self, "apps", from: data)
    }

    /// The apps by title.
    var sorted: [AppModelRows] {
        apps.sorted { title($0.app).localizedCaseInsensitiveCompare(title($1.app)) == .orderedAscending }
    }

    /// Sets the panel's override for an app's calls, or for one tag of them; nil clears it.
    func setModel(app: String, tag: String?, _ value: String?) async {
        await save {
            var body: [String: Any] = ["model": value ?? NSNull()]
            if let tag { body["tag"] = tag }
            let answer = try await api.send("PATCH", "/api/panel/apps/\(SpacePath.escape(app))/model", json: body)
            if let fresh = try? Hub.decode(AppModelRows.self, from: answer), let i = apps.firstIndex(where: { $0.app == app }) { apps[i] = fresh }
        }
    }
}

final class EventsStore: HubStore {
    @Published private(set) var events: [SpaceEvent] = []
    @Published private(set) var capabilities: [CapabilityApp] = []
    @Published private(set) var deliveries: [Int: [EventDelivery]] = [:]
    @Published private(set) var deliveryErrors: [Int: String] = [:]

    override func load() async throws {
        events = try Hub.rows(SpaceEvent.self, "events", from: try await api.data("/api/events?limit=100"))
        if let data = try? await api.data("/api/capabilities") {
            capabilities = ((try? Hub.rows(CapabilityApp.self, "apps", from: data)) ?? []).filter { !$0.isEmpty }
        }
    }

    func loadDeliveries(_ id: Int) async {
        do {
            deliveries[id] = try Hub.rows(EventDelivery.self, "deliveries", from: try await api.data("/api/events/\(id)"))
            deliveryErrors[id] = nil
        } catch {
            deliveryErrors[id] = Self.message(error)
        }
    }
}

final class PackagesStore: HubStore {
    @Published private(set) var catalogue: PackageCatalogue?
    @Published private(set) var links: [SpaceLink] = []

    override func load() async throws {
        catalogue = try Hub.decode(PackageCatalogue.self, from: try await api.data("/api/panel/package-catalogue"))
        if let data = try? await api.data("/api/panel/connections") {
            links = (try? Hub.rows(SpaceLink.self, "connections", from: data)) ?? []
        }
    }

    /// Turns a connection on or off. The connection itself stays.
    func setEnabled(_ link: SpaceLink, _ on: Bool) async {
        await save { _ = try await api.send("PATCH", "/api/panel/connections/\(SpacePath.escape(link.id))", json: ["enabled": on]) }
        await refresh()
    }

    /// Shares one of this Space's packages over a connection, or stops sharing it.
    func setShared(_ link: SpaceLink, app: String, _ on: Bool) async {
        let apps = (link.apps ?? []).filter { $0 != app } + (on ? [app] : [])
        await save { _ = try await api.send("PATCH", "/api/panel/connections/\(SpacePath.escape(link.id))", json: ["apps": apps]) }
        await refresh()
    }
}

final class InboxStore: HubStore {
    @Published var filter = InboxFilter.all
    @Published private(set) var items: [InboxThread] = []
    @Published private(set) var summary: InboxSummary?

    private struct Body: Decodable {
        var items: Lossy<InboxThread>?
        var summary: InboxSummary?
    }

    override func load() async throws {
        let asked = filter
        let body = try Hub.decode(Body.self, from: try await api.data("/api/inbox?\(asked.query)&limit=200"))
        guard asked == filter else { return }
        items = body.items?.elements ?? []
        summary = body.summary ?? summary
    }

    func item(_ thread: String) -> InboxThread? { items.first { $0.thread == thread } }

    func mark(_ thread: String, read: Bool? = nil, done: Bool? = nil) async {
        var body: [String: Any] = ["threads": [thread]]
        if let read { body["read"] = read }
        if let done { body["done"] = done }
        // Shown at once; the next read says what the Space kept.
        if let i = items.firstIndex(where: { $0.thread == thread }) {
            if let read { items[i].unread = !read }
            if let done { items[i].done = done }
        }
        await save { _ = try await api.send("POST", "/api/inbox/mark", json: body) }
        await refresh()
    }

    func readAll() async {
        await save { _ = try await api.send("POST", "/api/inbox/read-all", json: [:]) }
        await refresh()
    }
}

/// One agent's conversation. A turn is a background run on the Space (docs/panel.md#chat): the
/// reply is followed over its event stream and survives the page closing; a stream that breaks
/// is picked up again from the last event seen.
@MainActor
final class ChatStore: ObservableObject {
    struct Bubble: Identifiable, Equatable {
        let id = UUID()
        var isUser: Bool
        var text: String
        var tools: [String] = []
        var activity: ChatActivity?
    }

    let api: SpaceAPI
    let base: String
    @Published var draft = ""
    @Published private(set) var bubbles: [Bubble] = []
    @Published private(set) var isRunning = false
    @Published private(set) var sessions: [ChatSessionInfo] = []
    @Published private(set) var error: String?
    private var sessionID: String?
    private var runID: String?
    private var turn: Task<Void, Never>?
    private static let reconnects = 5

    init(api: SpaceAPI, base: String) {
        self.api = api
        self.base = base
    }

    var canSend: Bool { !isRunning && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    func loadSessions() async {
        guard let data = try? await api.data("\(base)/sessions") else { return }
        sessions = (try? Hub.rows(ChatSessionInfo.self, "sessions", from: data)) ?? []
    }

    func newChat() {
        guard !isRunning else { return }
        sessionID = nil
        bubbles = []
        error = nil
    }

    /// Shows a stored conversation; the next message continues it.
    func open(_ session: ChatSessionInfo) async {
        guard !isRunning else { return }
        do {
            let stored = try Hub.rows(ChatStored.self, "messages", from: try await api.data("\(base)/sessions/\(SpacePath.escape(session.sid))"))
            bubbles = stored.compactMap { m in (m.text ?? "").isEmpty ? nil : Bubble(isUser: m.role == "user", text: m.text ?? "") }
            sessionID = session.sid
            error = nil
        } catch {
            self.error = HubStore.message(error)
        }
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isRunning else { return }
        draft = ""
        error = nil
        bubbles.append(Bubble(isUser: true, text: text))
        bubbles.append(Bubble(isUser: false, text: "", activity: .starting))
        let index = bubbles.count - 1
        isRunning = true
        runID = nil
        turn = Task { [weak self] in
            await self?.follow(text, into: index)
        }
    }

    private func follow(_ text: String, into index: Int) async {
        var reply = ChatReply()
        var lastSeq = 0
        var tries = 0
        var body: [String: Any] = ["message": text]
        if let sessionID { body["sessionId"] = sessionID }
        func show() {
            guard bubbles.indices.contains(index) else { return }
            bubbles[index].text = reply.stopped ? [reply.text, String(localized: "Stopped.")].filter { !$0.isEmpty }.joined(separator: "\n\n") : reply.text
            bubbles[index].tools = reply.tools
            bubbles[index].activity = reply.activity
        }
        do {
            var (id, stream) = try await api.events("POST", "\(base)/chat", json: body)
            runID = id
            while !reply.finished {
                do {
                    for try await message in stream {
                        if let seq = message.id { lastSeq = seq }
                        reply.apply(message.data)
                        show()
                        if reply.finished { break }
                    }
                } catch {
                    if Task.isCancelled { break }
                }
                if reply.finished || Task.isCancelled { break }
                // The stream ended without the run saying it was done: follow the run again.
                guard let run = runID, tries < Self.reconnects else {
                    reply.note = String(localized: "The connection was lost; the reply may still be running on the Space.")
                    break
                }
                tries += 1
                reply.activity = .reconnecting
                show()
                try await Task.sleep(nanoseconds: 1_000_000_000)
                (_, stream) = try await api.events("GET", "\(base)/runs/\(SpacePath.escape(run))/events?after=\(lastSeq)")
            }
        } catch {
            if !Task.isCancelled { reply.note = "⚠️ " + HubStore.message(error) }
        }
        reply.activity = nil
        show()
        sessionID = reply.sessionID ?? sessionID
        runID = nil
        isRunning = false
    }

    /// Stops the run on the Space; the stream then ends by itself.
    func stop() {
        guard let run = runID else { return }
        Task { _ = try? await api.send("POST", "\(base)/runs/\(SpacePath.escape(run))/stop", json: [:]) }
    }
}
