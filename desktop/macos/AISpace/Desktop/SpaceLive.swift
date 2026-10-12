import AppKit

/// What the native interface knows about one connection: its apps and agents, the inbox and
/// the agent runs in progress, refreshed in the background from the Space's own routes.
@MainActor
final class SpaceLive: ObservableObject {
    enum Status: Equatable {
        case unknown
        case ok
        case signInNeeded
        case offline(String)
    }

    let connection: Connection
    let api: SpaceAPI
    @Published private(set) var status: Status = .unknown
    @Published private(set) var apps: [AppInfo] = []
    @Published private(set) var agents: [AgentInfo] = []
    @Published private(set) var inbox: [InboxItem] = []
    @Published private(set) var summary = InboxSummary(unread: 0, open: 0)
    @Published private(set) var running: [ChatRun] = []
    @Published private(set) var lastRefresh: Date?

    /// Called with threads that became unread since the last look.
    var onNewInbox: ([InboxItem]) -> Void = { _ in }
    /// Called after every refresh, for the Dock badge and the menu bar.
    var onRefresh: () -> Void = {}

    private var seen: InboxSeen
    private var loop: Task<Void, Never>?
    private var catalogueAt: Date?
    private var images: [String: NSImage] = [:]
    private var loadingImages: Set<String> = []
    private var refreshing = false

    init(connection: Connection, cookies: @escaping @MainActor () async -> [HTTPCookie]) {
        self.connection = connection
        api = SpaceAPI(base: connection.url, cookies: cookies)
        seen = Self.loadSeen(connection.id)
    }

    func start() {
        loop?.cancel()
        loop = Task { [weak self] in
            await self?.refresh(catalogue: true)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await self?.refresh()
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
    }

    /// Inbox and runs every time; apps and agents when asked or every five minutes.
    func refresh(catalogue: Bool = false) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        do {
            if catalogue || apps.isEmpty || catalogueAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true {
                async let a = api.get("/api/apps", as: AppsResponse.self)
                async let g = api.get("/api/agents", as: AgentsResponse.self)
                let (appsResponse, agentsResponse) = try await (a, g)
                apps = appsResponse.apps.filter { $0.hidden != true && $0.url?.isEmpty == false && $0.status != "archived" }
                agents = agentsResponse.agents
                catalogueAt = Date()
            }
            let box = try await api.get("/api/inbox?filter=open&limit=100", as: InboxResponse.self)
            inbox = box.items
            summary = box.summary
            let fresh = seen.fresh(box.items)
            Self.saveSeen(seen, connection.id)
            if !fresh.isEmpty { onNewInbox(fresh) }
            // A peer without the runs route still counts as reachable.
            running = (try? await api.get("/api/agents/runs?recent=0", as: RunsResponse.self).runs.filter { $0.status == "running" }) ?? []
            status = .ok
        } catch SpaceAPIError.authenticationRequired {
            status = .signInNeeded
        } catch {
            status = .offline(error.localizedDescription)
        }
        lastRefresh = Date()
        #if DEBUG
        NSLog("ai-space: live %@ %@ apps=%d agents=%d unread=%d running=%d", connection.name, String(describing: status), apps.count, agents.count, summary.unread, running.count)
        #endif
        onRefresh()
    }

    func mark(_ threads: [String], read: Bool? = nil, done: Bool? = nil) async {
        var body: [String: Any] = ["threads": threads]
        if let read { body["read"] = read }
        if let done { body["done"] = done }
        _ = try? await api.send("POST", "/api/inbox/mark", json: body)
        await refresh()
    }

    func agent(_ id: String) -> AgentInfo? { agents.first { $0.id == id } }

    func app(named name: String) -> AppInfo? { apps.first { $0.name == name || $0.id == name } }

    /// An icon or avatar: an emoji is returned as text; a path loads once through the API.
    func image(_ path: String?) -> NSImage? {
        guard let path, path.hasPrefix("/") || path.hasPrefix("http") else { return nil }
        if let cached = images[path] { return cached }
        if !loadingImages.contains(path) {
            loadingImages.insert(path)
            Task {
                if let data = try? await api.data(path), let image = NSImage(data: data) {
                    images[path] = image
                    objectWillChange.send()
                }
            }
        }
        return nil
    }

    private static func loadSeen(_ id: UUID) -> InboxSeen {
        guard let data = UserDefaults.standard.data(forKey: "inboxSeen.\(id.uuidString)"),
              let seen = try? JSONDecoder().decode(InboxSeen.self, from: data)
        else { return InboxSeen() }
        return seen
    }

    private static func saveSeen(_ seen: InboxSeen, _ id: UUID) {
        if let data = try? JSONEncoder().encode(seen) { UserDefaults.standard.set(data, forKey: "inboxSeen.\(id.uuidString)") }
    }

    static func forget(_ id: UUID) {
        UserDefaults.standard.removeObject(forKey: "inboxSeen.\(id.uuidString)")
    }
}
