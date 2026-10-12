import AppKit
import Combine
import WebKit

/// An agent of a connection, as `<connection id> <agent id>` in preferences.
struct AgentRef: Hashable {
    var connection: UUID
    var agent: String

    var key: String { "\(connection.uuidString) \(agent)" }

    init(connection: UUID, agent: String) {
        self.connection = connection
        self.agent = agent
    }

    init?(key: String) {
        let parts = key.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, let id = UUID(uuidString: String(parts[0])) else { return nil }
        self.init(connection: id, agent: String(parts[1]))
    }
}

/// What the main window shows for the selected connection.
enum Destination: Hashable {
    case panel
    case inbox
    case agent(String)
    /// An app open as a tab of the main window, by app id.
    case app(String)
}

/// An app open in the main window: its page lives as long as the tab, wherever the tab goes.
struct AppTab: Identifiable {
    let app: AppInfo
    let session: PanelSession

    var id: String { app.id }
}

/// The app's state: saved connections, the live data of each, panel pages, conversations and
/// app windows. Leaving a connection keeps everything of it; removing or changing it discards it.
@MainActor
final class AppModel: ObservableObject {
    let store: ConnectionStore
    let prefs = Preferences.shared
    let appWindows = AppWindows()
    let notifier = Notifier()

    @Published private(set) var selectedID: UUID?
    @Published var destination: Destination = .panel
    @Published private(set) var lives: [UUID: SpaceLive] = [:]
    @Published private(set) var quickChatAgentRef: AgentRef?
    /// Apps open as tabs of the main window, per connection, in the order they were opened.
    @Published private(set) var tabs: [UUID: [AppTab]] = [:]

    /// Set by the app delegate, which owns the windows.
    var showWindow: () -> Void = {}
    var quickChat: (() -> Void)?

    private var sessions: [UUID: PanelSession] = [:]
    private var dataStores: [UUID: WKWebsiteDataStore] = [:]
    private var chats: [AgentRef: ChatController] = [:]
    private var watchers: Set<AnyCancellable> = []
    private var wake: NSObjectProtocol?

    init(store: ConnectionStore) {
        self.store = store
        selectedID = store.defaultConnection?.id
        quickChatAgentRef = prefs.quickChatAgent.flatMap(AgentRef.init(key:))
        appWindows.onChange = { [weak self] in self?.objectWillChange.send() }
        appWindows.onMoveBack = { [weak self] app, connection, session in
            self?.adoptTab(AppTab(app: app, session: session), connection: connection)
        }
        notifier.onOpen = { [weak self] id, url in self?.openInboxItem(connection: id, url: url) }
        notifier.onMark = { [weak self] id, thread, done in
            Task { await self?.lives[id]?.mark([thread], read: true, done: done ? true : nil) }
        }
        store.$connections.sink { [weak self] list in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.syncLives(list) } }
        }.store(in: &watchers)
        wake = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.sessions.values.forEach { $0.recoverIfFailed() }
                self?.lives.values.forEach { live in Task { await live.refresh() } }
            }
        }
    }

    // MARK: Connections

    var selected: Connection? { selectedID.flatMap(store.connection) }

    var selectedLive: SpaceLive? { selectedID.flatMap { lives[$0] } }

    func dataStore(_ id: UUID) -> WKWebsiteDataStore {
        if let s = dataStores[id] { return s }
        let s = WKWebsiteDataStore(forIdentifier: id)
        dataStores[id] = s
        return s
    }

    func session(for connection: Connection) -> PanelSession {
        if let s = sessions[connection.id], s.connection.url == connection.url { return s }
        let s = PanelSession(connection: connection, dataStore: dataStore(connection.id))
        s.openLink = { [weak self] url in self?.openLink(url, from: connection) }
        // Signing in on the panel is what lets the native views in: refresh them right away.
        s.onStateChange = { [weak self] state in
            if state == .ready, let live = self?.lives[connection.id], live.status != .ok {
                Task { await live.refresh(catalogue: true) }
            }
        }
        sessions[connection.id] = s
        // Called while a view is being built; start loading after that update.
        DispatchQueue.main.async { s.load() }
        return s
    }

    func select(_ id: UUID) {
        guard store.connection(id) != nil, id != selectedID else { return }
        selectedID = id
        destination = .panel
    }

    func add(name: String, url: URL) {
        let c = store.add(name: name, url: url)
        selectedID = c.id
        destination = .panel
    }

    /// A changed URL starts a fresh page; the old one's unsent drafts are gone, which the form says.
    func update(_ id: UUID, name: String, url: URL) {
        let changed = store.connection(id)?.url != url
        store.update(id, name: name, url: url)
        if changed { discard(id) }
        objectWillChange.send()
    }

    /// Forgets the connection on this Mac. The Space itself, its agents and its data are untouched.
    func remove(_ id: UUID, clearSignIn: Bool) async {
        discard(id)
        dataStores[id] = nil
        SpaceLive.forget(id)
        store.remove(id)
        if selectedID == id { selectedID = store.defaultConnection?.id }
        guard clearSignIn else { return }
        // The store can be removed only once its web views are gone; windows let go on their next update.
        for attempt in 1...5 {
            do {
                try await WKWebsiteDataStore.remove(forIdentifier: id)
                return
            } catch {
                if attempt == 5 { NSLog("ai-space: could not remove saved sign-in data: \(error.localizedDescription)") }
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    private func discard(_ id: UUID) {
        sessions[id] = nil
        tabs[id]?.forEach { $0.session.webView.stopLoading() }
        tabs[id] = nil
        appWindows.close(connection: id)
        chats = chats.filter { $0.key.connection != id }
        lives[id]?.stop()
        lives[id] = nil
        if quickChatAgentRef?.connection == id { quickChatAgentRef = nil }
    }

    private func syncLives(_ list: [Connection]) {
        let ids = Set(list.map(\.id))
        for (id, live) in lives where !ids.contains(id) {
            live.stop()
            lives[id] = nil
        }
        for c in list where lives[c.id]?.connection.url != c.url {
            lives[c.id]?.stop()
            let cookieStore = dataStore(c.id).httpCookieStore
            let live = SpaceLive(connection: c) { await cookieStore.allCookies() }
            live.onNewInbox = { [weak self] items in
                guard let self else { return }
                notifier.post(items, from: c, showName: store.connections.count > 1)
            }
            live.onRefresh = { [weak self] in self?.livesChanged() }
            lives[c.id] = live
            live.start()
        }
        if selectedID.map({ !ids.contains($0) }) ?? true { selectedID = store.defaultConnection?.id }
    }

    private func livesChanged() {
        notifier.setBadge(lives.values.reduce(0) { $0 + $1.summary.unread })
        objectWillChange.send()
    }

    // MARK: Main window

    func reload() {
        guard let c = selected else { return }
        session(for: c).reload()
        if let live = lives[c.id] { Task { await live.refresh(catalogue: true) } }
    }

    func openInBrowser() {
        if let c = selected { NSWorkspace.shared.open(session(for: c).browserURL) }
    }

    func showMainWindow(connection: UUID? = nil, _ destination: Destination? = nil) {
        if let connection, store.connection(connection) != nil { selectedID = connection }
        if let destination { self.destination = destination }
        showWindow()
    }

    // MARK: Apps and links

    /// Opens an app as a tab of the main window, or brings forward the window it was moved to.
    func openApp(_ app: AppInfo, connection: Connection, url: URL? = nil) {
        if appWindows.focus(app.id, connection: connection.id, url: url) { return }
        if let tab = tab(app.id, connection: connection.id) {
            if let url, tab.session.webView.url != url { tab.session.webView.load(URLRequest(url: url)) }
        } else {
            guard let home = url ?? app.pageURL(space: connection.url) else { return }
            let session = PanelSession(connection: connection, dataStore: dataStore(connection.id), home: home)
            session.openLink = { [weak self] link in self?.openLink(link, from: connection) }
            tabs[connection.id, default: []].append(AppTab(app: app, session: session))
            DispatchQueue.main.async { session.load() }
        }
        showMainWindow(connection: connection.id, .app(app.id))
    }

    func tab(_ app: String, connection: UUID) -> AppTab? {
        tabs[connection]?.first { $0.app.id == app }
    }

    /// Moves a tab into its own window; the page keeps its state.
    func moveToWindow(_ app: String, connection: UUID) {
        guard let c = store.connection(connection), let tab = takeTab(app, connection: connection) else { return }
        appWindows.show(tab.session, app: tab.app, connection: c)
    }

    func closeTab(_ app: String, connection: UUID) {
        takeTab(app, connection: connection)?.session.webView.stopLoading()
    }

    /// Moves the front app between the main window and its own window (⌥⌘T).
    func toggleAppPlacement() {
        if let key = appWindows.keyWindowApp {
            appWindows.moveBack(key)
        } else if case .app(let id) = destination, let c = selectedID {
            moveToWindow(id, connection: c)
        }
    }

    private func takeTab(_ app: String, connection: UUID) -> AppTab? {
        guard let i = tabs[connection]?.firstIndex(where: { $0.app.id == app }), let tab = tabs[connection]?.remove(at: i) else { return nil }
        if selectedID == connection, destination == .app(app) {
            let rest = tabs[connection] ?? []
            destination = rest.isEmpty ? .panel : .app(rest[min(i, rest.count - 1)].app.id)
        }
        return tab
    }

    private func adoptTab(_ tab: AppTab, connection: Connection) {
        guard store.connection(connection.id) != nil else { return }
        if self.tab(tab.app.id, connection: connection.id) == nil { tabs[connection.id, default: []].append(tab) }
        showMainWindow(connection: connection.id, .app(tab.app.id))
    }

    /// A link leaving a page: an app of the connection opens as its window, anything else in the browser.
    func openLink(_ url: URL, from connection: Connection) {
        if let live = lives[connection.id], let app = AppRoutes.app(for: url, in: live.apps, space: connection.url) {
            openApp(app, connection: connection, url: url)
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    func openInboxItem(connection id: UUID, url: String?) {
        guard let c = store.connection(id) else { return }
        if let url, let target = URL(string: url, relativeTo: c.url)?.absoluteURL {
            openLink(target, from: c)
        } else {
            showMainWindow(connection: id, .inbox)
        }
    }

    // MARK: Conversations

    func chat(_ ref: AgentRef) -> ChatController? {
        if let c = chats[ref] { return c }
        guard let live = lives[ref.connection], let agent = live.agent(ref.agent) else { return nil }
        let c = ChatController(agent: agent, api: live.api)
        c.attachRunning(live.running)
        chats[ref] = c
        return c
    }

    /// The agent Quick Chat talks to: the last one picked, else the first of the selected connection.
    var quickChatResolvedRef: AgentRef? {
        if let ref = quickChatAgentRef, lives[ref.connection]?.agent(ref.agent) != nil { return ref }
        for c in [selected].compactMap({ $0 }) + store.connections {
            if let a = lives[c.id]?.agents.first { return AgentRef(connection: c.id, agent: a.id) }
        }
        return nil
    }

    var quickChatController: ChatController? { quickChatResolvedRef.flatMap(chat) }

    var quickChatLive: SpaceLive? { quickChatResolvedRef.flatMap { lives[$0.connection] } }

    /// Accepts a full `<connection> <agent>` key or a bare agent id (`app/name`, from a link).
    func quickChatSelect(agentID: String) {
        var ref = AgentRef(key: agentID)
        if ref == nil {
            let order = [selected].compactMap { $0 } + store.connections
            if let c = order.first(where: { lives[$0.id]?.agent(agentID) != nil }) { ref = AgentRef(connection: c.id, agent: agentID) }
        }
        guard let ref else { return }
        quickChatAgentRef = ref
        prefs.quickChatAgent = ref.key
    }

    func openQuickChatInMainWindow() {
        guard let ref = quickChatResolvedRef else { return }
        showMainWindow(connection: ref.connection, .agent(ref.agent))
    }
}
