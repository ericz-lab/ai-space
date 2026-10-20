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

    @Published private(set) var devices: [DeviceUsageRow] = []
    @Published private(set) var devicesError: String?
    @Published private(set) var devicesLoaded = false
    private let fetch: (String) async throws -> Data

    init(api: SpaceAPI, fetch: ((String) async throws -> Data)? = nil) {
        self.fetch = fetch ?? { try await api.data($0) }
        super.init(api: api)
    }

    override func load() async throws {
        let (w, k) = (window, kind)
        let q = k == "all" ? "" : "&kind=\(k)"
        devicesLoaded = false
        devicesError = nil
        devices = []
        // Device support can be unavailable on an older Space without hiding application use.
        await loadDevices(window: w)
        let fresh = try Hub.rows(AppUsageRow.self, "usage", from: try await fetch("/api/usage?window=\(w)\(q)"))
        var thirty = fresh
        if w != "30d", let data = try? await fetch("/api/usage?window=30d\(q)") {
            thirty = (try? Hub.rows(AppUsageRow.self, "usage", from: data)) ?? []
        }
        guard w == window, k == kind else { return }
        rows = fresh
        month = Dictionary(thirty.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    private func loadDevices(window asked: String) async {
        do {
            struct Response: Decodable { var devices: [DeviceUsageRow] }
            let answer = try Hub.decode(Response.self, from: try await fetch("/api/usage/devices?window=\(asked)"))
            guard asked == window, !Task.isCancelled else { return }
            devices = answer.devices
            devicesLoaded = true
        } catch {
            guard asked == window, !Task.isCancelled else { return }
            devicesError = HubStore.message(error)
        }
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
        /// The turn's work: an approval waiting on the person, or a message they added while it ran.
        var steps: [ChatStep] = []
        /// Messages added to the running turn that the agent has not read yet.
        var pending: [String] = []
        /// The questions among the approvals, by the approval step's id, with the answers once given.
        var asks: [String: Ask] = [:]
        /// What the turn ended with besides the agent's words: an error, a lost connection, a stop.
        var note: String?
        /// The pictures sent with the person's message.
        var images: [ChatImage] = []
        var live = false
    }

    struct Ask: Equatable {
        var questions: [ChatRows.Question]
        var answers: [String: [String]]?
    }

    let api: SpaceAPI
    let base: String
    @Published var draft = ""
    /// Pictures to go with the next message (docs/panel.md#agent-chat-images).
    @Published var images: [ChatImage] = []
    @Published var imageError: String?
    @Published private(set) var bubbles: [Bubble] = []
    @Published private(set) var isRunning = false
    @Published private(set) var sessions: [ChatSessionInfo] = []
    @Published private(set) var error: String?
    private var sessionID: String?
    private var runID: String?
    private var task: Task<Void, Never>?
    private static let reconnects = 5

    /// One thread's identity: New Chat and opening an earlier chat start another one, so a late
    /// answer for a steer of the old thread cannot land in the new one.
    private var conversation = UUID()
    /// Turns written while one runs that it could not take, each tied to the message it answers so
    /// its reply is inserted right after that message.
    private struct QueuedTurn {
        let bubble: UUID
        let text: String
        let images: [ChatImage]
        let intentID: String?
        let timezone: String?
    }
    private var queue: [QueuedTurn] = []
    private var pending: [String] = []
    private var steersSeen = 0
    private var stopRequested = false

    init(api: SpaceAPI, base: String) {
        self.api = api
        self.base = base
    }

    var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty }

    /// Adds a picture to the next message within the Space's limits; false when it does not fit.
    @discardableResult
    func attach(_ image: ChatImage) -> Bool {
        guard ChatImage.validate(images + [image]) else {
            imageError = String(localized: "Add up to 4 images, 5 MB each and 10 MB in total.")
            return false
        }
        images.append(image)
        imageError = nil
        return true
    }

    func loadSessions() async {
        guard let data = try? await api.data("\(base)/sessions") else { return }
        sessions = (try? Hub.rows(ChatSessionInfo.self, "sessions", from: data)) ?? []
    }

    func newChat() {
        guard !isRunning else { return }
        sessionID = nil
        conversation = UUID()
        bubbles = []
        error = nil
        imageError = nil
    }

    /// Shows a stored conversation; the next message continues it.
    func open(_ session: ChatSessionInfo) async {
        guard !isRunning else { return }
        // Choosing another thread already ends the one on screen: a late answer for a message
        // written in it must not land in the history about to be shown.
        conversation = UUID()
        do {
            let stored = try Hub.rows(ChatStored.self, "messages", from: try await api.data("\(base)/sessions/\(SpacePath.escape(session.sid))"))
            bubbles = stored.compactMap { m in
                let isUser = m.role == "user"
                let steps = isUser ? [] : ChatRows.steps(of: m)
                guard !(m.text ?? "").isEmpty || !steps.isEmpty else { return nil }
                return Bubble(isUser: isUser, text: m.text ?? "", steps: steps)
            }
            sessionID = session.sid
            error = nil
        } catch {
            self.error = HubStore.message(error)
        }
    }

    func send(intentID: String? = nil, timezone: String? = nil) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = self.images
        guard !text.isEmpty || !images.isEmpty else { return }
        draft = ""
        self.images = []
        imageError = nil
        error = nil
        // A message written while a turn runs joins that turn (docs/runtimes.md#live-chat); a turn
        // that cannot take it is queued and sent next. An intent keeps its own route through chat,
        // so it is queued instead.
        if isRunning {
            if intentID != nil || !queue.isEmpty || stopRequested {
                enqueue(text: text, images: images, intentID: intentID, timezone: timezone)
            } else {
                steer(text: text, images: images, intentID: intentID, timezone: timezone)
            }
            return
        }
        let bubble = Bubble(isUser: true, text: text, images: images)
        bubbles.append(bubble)
        start(QueuedTurn(bubble: bubble.id, text: text, images: images, intentID: intentID, timezone: timezone))
    }

    /// The person's answer to one of the running turn's approvals, or to its questions (`answers`;
    /// nil skips them). Returns nil when it reached the Space, else what the card shows.
    func answer(_ requestID: String, allow: Bool, answers: [String: [String]]? = nil) async -> String? {
        guard let runID else { return String(localized: "The answer did not reach the agent: no turn is running") }
        do {
            _ = try await api.send("POST", "\(base)/runs/\(SpacePath.escape(runID))/approvals/\(SpacePath.escape(requestID))", json: ChatRows.approvalBody(allow: allow, answers: answers))
            return nil
        } catch {
            return String(localized: "The answer did not reach the agent: \(HubStore.message(error))")
        }
    }

    /// Hands the message to the running turn; when that is refused (the turn just ended, or its
    /// runtime has no live chat) it becomes the next turn.
    private func steer(text: String, images: [ChatImage], intentID: String?, timezone: String?) {
        guard let runID else {
            enqueue(text: text, images: images, intentID: intentID, timezone: timezone)
            drain()
            return
        }
        let conversation = self.conversation
        // A picture-only message reads as the panel's label for it (src/web/Chat.tsx).
        let label = text.isEmpty ? "🖼 ×\(images.count)" : text
        markPending(label, add: true)
        var body: [String: Any] = ["message": text]
        if !images.isEmpty { body["images"] = images.map(\.body) }
        Task { [weak self, body] in
            guard let self else { return }
            do {
                _ = try await api.send("POST", "\(base)/runs/\(SpacePath.escape(runID))/steer", json: body)
            } catch {
                // The person moved to another thread while the answer was on its way: the message
                // belongs to the one that is gone, not to the new one.
                guard self.conversation == conversation else { return }
                markPending(label, add: false)
                enqueue(text: text, images: images, intentID: intentID, timezone: timezone)
                drain()
            }
        }
    }

    private func markPending(_ text: String, add: Bool) {
        if add {
            pending.append(text)
        } else if let at = pending.lastIndex(of: text) {
            pending.remove(at: at)
        }
        guard let i = bubbles.lastIndex(where: { !$0.isUser && $0.live }) else { return }
        bubbles[i].pending = pending
    }

    /// The reply took one added message in: its text names it. A picture-only message is named
    /// by the Space's own words for it, so the oldest waiting one goes instead, as on the panel.
    private func takePending(_ text: String) {
        guard !pending.isEmpty else { return }
        pending.remove(at: pending.firstIndex(of: text) ?? 0)
    }

    private func enqueue(text: String, images: [ChatImage], intentID: String?, timezone: String?) {
        let bubble = Bubble(isUser: true, text: text, images: images)
        bubbles.append(bubble)
        queue.append(QueuedTurn(bubble: bubble.id, text: text, images: images, intentID: intentID, timezone: timezone))
    }

    private func takeQueued() -> QueuedTurn? {
        queue.isEmpty ? nil : queue.removeFirst()
    }

    /// Starts the next waiting turn when nothing runs.
    private func drain() {
        guard !isRunning, let next = takeQueued() else { return }
        start(next)
    }

    private func start(_ turn: QueuedTurn) {
        let reply = Bubble(isUser: false, text: "", activity: .starting, live: true)
        // A queued turn's reply belongs right after its own message: with two waiting, appending it
        // at the end would separate each message from the turn that answers it.
        let index: Int
        if let at = bubbles.firstIndex(where: { $0.id == turn.bubble }) {
            index = at + 1
            bubbles.insert(reply, at: index)
        } else {
            index = bubbles.count
            bubbles.append(reply)
        }
        isRunning = true
        stopRequested = false
        runID = nil
        pending = []
        steersSeen = 0
        task = Task { [weak self] in
            await self?.follow(turn, into: index)
        }
    }

    private func follow(_ turn: QueuedTurn, into index: Int) async {
        var reply = ChatReply()
        var lastSeq = 0
        var tries = 0
        var asks: [String: Ask] = [:]
        var body: [String: Any] = ["message": turn.text, "interactive": true]
        if !turn.images.isEmpty { body["images"] = turn.images.map(\.body) }
        if let sessionID { body["sessionId"] = sessionID }
        if let intentID = turn.intentID {
            body["intentId"] = intentID
            body["timezone"] = turn.timezone ?? TimeZone.current.identifier
        }
        func show() {
            guard bubbles.indices.contains(index) else { return }
            bubbles[index].text = reply.stopped ? [reply.text, String(localized: "Stopped.")].filter { !$0.isEmpty }.joined(separator: "\n\n") : reply.text
            bubbles[index].note = Self.note(of: reply)
            bubbles[index].tools = reply.tools
            bubbles[index].steps = reply.steps
            bubbles[index].asks = asks
            bubbles[index].activity = reply.activity
            while steersSeen < reply.consumedSteers.count {
                takePending(reply.consumedSteers[steersSeen])
                steersSeen += 1
            }
            bubbles[index].pending = pending
        }
        do {
            var (id, stream) = try await api.events("POST", "\(base)/chat", json: body)
            runID = id
            while !reply.finished {
                do {
                    for try await message in stream {
                        if let seq = message.id { lastSeq = seq }
                        reply.apply(message.data)
                        switch ChatRows.questionEvent(message.data) {
                        case .asked(let step, let questions)?: asks[step] = asks[step] ?? Ask(questions: questions)
                        case .answered(let step, let answers)?: asks[step]?.answers = answers
                        case nil: break
                        }
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
        reply.endSteps()
        reply.activity = nil
        sessionID = reply.sessionID ?? sessionID
        runID = nil
        if bubbles.indices.contains(index) {
            bubbles[index].text = reply.stopped ? [reply.text, String(localized: "Stopped.")].filter { !$0.isEmpty }.joined(separator: "\n\n") : reply.text
            bubbles[index].note = Self.note(of: reply)
            bubbles[index].tools = reply.tools
            bubbles[index].steps = reply.steps
            bubbles[index].asks = asks
            bubbles[index].activity = nil
            bubbles[index].pending = []
            bubbles[index].live = false
        }
        pending = []
        // A message that could not join this turn goes now, in the order it was written.
        if let next = takeQueued() {
            start(next)
        } else {
            stopRequested = false
            isRunning = false
        }
    }

    /// What a reply drawn as its steps shows after them: the note the steps do not carry, and a stop.
    private static func note(of reply: ChatReply) -> String? {
        let parts = [reply.note, reply.stopped ? String(localized: "Stopped.") : nil].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    }

    /// Stops the run on the Space; the stream then ends by itself.
    func stop() {
        stopRequested = true
        guard let run = runID else { return }
        Task { _ = try? await api.send("POST", "\(base)/runs/\(SpacePath.escape(run))/stop", json: [:]) }
    }
}
