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

/// What the main window shows for the selected connection: the launcher (Home, the screens,
/// Settings, side by side), or something over it, as the iPhone client puts its covers.
enum Destination: Hashable {
    case launcher
    /// A page of the Space drawn by the app.
    case hub(HubPage)
    /// An app open as a tab of the main window, by app id.
    case app(String)
    /// The Space's web panel: the sign-in, package installs and what the app does not draw.
    case panel
}

/// The pages the launcher moves through, left to right: Home, each screen, Settings. A screen's
/// page is its id; these two are not screen ids (those are letters, digits, - and _ only).
enum Pager {
    static let home = "#home"
    static let settings = "#settings"
}

/// The page on show in the launcher, as an object of its own, so a page change re-renders the
/// pager and its indicator and not every view that observes the model.
@MainActor
final class PagerPosition: ObservableObject {
    @Published var id = Screens.home
}

/// Where the app keeps its own files: saved Spaces and screens under Application Support (as
/// ConnectionStore does), the last catalogue and the icons under Caches.
enum DesktopPaths {
    static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ai-space", isDirectory: true)
    }

    static var caches: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "dev.ai-space.desktop", isDirectory: true)
    }

    static var screens: URL { support.appendingPathComponent("screens.json") }

    static func icons(_ connection: UUID) -> URL {
        caches.appendingPathComponent("icons", isDirectory: true).appendingPathComponent(connection.uuidString, isDirectory: true)
    }
}

/// An app open in the main window: its page lives as long as the tab, wherever the tab goes.
struct AppTab: Identifiable {
    let app: AppInfo
    let session: PanelSession

    var id: String { app.id }
}

/// The app's state: saved connections, the catalogue, live data and screens of each, panel
/// pages, conversations and app windows. Leaving a connection keeps everything of it; signing
/// out, removing or changing it discards it.
@MainActor
final class AppModel: ObservableObject {
    let store: ConnectionStore
    let screens: ScreenStore
    let prefs = Preferences.shared
    let appWindows = AppWindows()
    let notifier = Notifier()
    /// The Local edition's service on this Mac; `available` is false in the Client edition.
    let local = LocalManager()
    let updater = AppUpdater(current: LocalBundle.find()?.version ?? "0.0.0")
    private let cache = CatalogueCache(directory: DesktopPaths.caches)

    @Published private(set) var selectedID: UUID? {
        didSet { if usageActive && oldValue != selectedID { setUsageActive(true, restart: true) } }
    }
    @Published var destination: Destination = .launcher {
        didSet {
            deviceUsage.refresh()
            if destination == .launcher && oldValue != .launcher { refreshCatalogue() }
        }
    }
    /// Where the launcher stands, observed by the pager and its indicator (PagerPosition).
    let pager = PagerPosition()
    /// The page on show: `Pager.home`, a screen's id, or `Pager.settings`. The window opens on the
    /// first screen; the library is one page to its left.
    var pagerID: String {
        get { pager.id }
        set {
            pager.id = newValue
            if newValue != Pager.home, newValue != Pager.settings { homePage = newValue }
        }
    }
    /// The screen last shown, for the screen actions and for coming back to the screens.
    private(set) var homePage = Screens.home
    @Published var query = ""
    /// Asks the library's search field for the keyboard (⌘F).
    let focusSearch = PassthroughSubject<Void, Never>()
    /// The screen whose entries are being rearranged, in a sheet.
    @Published var editingScreen: String?
    @Published var confirmingDeleteScreen = false
    @Published var confirmingResetScreens = false
    @Published var confirmingSignOut = false
    /// Set when the web panel was opened to sign in, so a finished sign-in returns to the launcher.
    private var closeWebPanelAfterSignIn = false
    @Published private(set) var lives: [UUID: SpaceLive] = [:]
    @Published private(set) var quickChatAgentRef: AgentRef?
    /// Apps open as tabs of the main window, per connection, in the order they were opened.
    @Published private(set) var tabs: [UUID: [AppTab]] = [:]

    /// Set by the app delegate, which owns the windows.
    var showWindow: () -> Void = {}
    var quickChat: (() -> Void)?

    lazy var pictureSharing = PictureSharing(app: self)
    private var shareSignedOut = Set<UUID>()

    func prepareSharing() async {
        // Ad-hoc CLI builds use in-app import without cross-process credentials.
        guard let shared = try? ShareAccess.store() else { return }
        do { try shared.publish(store.connections) }
        catch { NSLog("ai-space: share setup: %@", error.localizedDescription) }
        for connection in store.connections where !shareSignedOut.contains(connection.id) {
            _ = await cookieSession(connection.id).cookies()
        }
    }

    private var sessions: [UUID: PanelSession] = [:]
    private var cookieSessions: [UUID: WebCookieSession] = [:]
    private var loaders: [UUID: CatalogueLoader] = [:]
    private var iconStores: [UUID: IconStore] = [:]
    private var settingsLoaders: [UUID: SettingsLoader] = [:]
    private var terminals: [UUID: TerminalStore] = [:]
    private var chats: [AgentRef: ChatController] = [:]
    private var watchers: Set<AnyCancellable> = []
    private var wake: NSObjectProtocol?

    init(store: ConnectionStore, screens: ScreenStore? = nil) {
        self.store = store
        let screens = screens ?? ScreenStore(fileURL: DesktopPaths.screens)
        self.screens = screens
        NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification).sink { [weak self] _ in
            guard let self else { return }
            self.deviceUsage.refresh()
        }.store(in: &watchers)
        NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification).sink { [weak self] _ in
            // Resolve after AppKit has chosen the next key window (which may be none).
            DispatchQueue.main.async { self?.deviceUsage.refresh() }
        }.store(in: &watchers)
        selectedID = store.defaultConnection?.id
        screens.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &watchers)
        // A swipe moves the pager without the model; the screen it lands on is the one last shown.
        pager.$id.sink { [weak self] id in
            if id != Pager.home, id != Pager.settings { self?.homePage = id }
        }.store(in: &watchers)
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
        if local.available {
            updater.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &watchers)
            Task { [weak self] in await self?.updater.check() }
            local.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &watchers)
            Task { [weak self] in
                await self?.local.refresh()
                await self?.ensureLocalSignIn()
                if let self { await self.local.autoUpdate(into: self) }
            }
        }
        wake = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.sessions.values.forEach { $0.recoverIfFailed() }
                self?.lives.values.forEach { live in Task { await live.refresh() } }
                self?.loaders.values.forEach { loader in Task { await loader.refresh() } }
            }
        }
    }

    // MARK: Connections

    private let deviceUsage = DeviceUsageReporter()
    private var usageActive = false

    func setUsageActive(_ active: Bool, restart: Bool = false) {
        guard restart || usageActive != active else { return }
        usageActive = active
        deviceUsage.setActive(active) { [weak self] in
            guard let self else { return nil }
            if let front = self.appWindows.foregroundApp {
                return (self.loader(for: front.connection).api, front.app)
            }
            guard let connection = self.selected else { return nil }
            let app: String?
            if NSApp.keyWindow?.identifier?.rawValue == "SpaceMain", case .app(let id) = self.destination { app = id }
            else { app = nil }
            return (self.loader(for: connection).api, app)
        }
    }

    var selected: Connection? { selectedID.flatMap(store.connection) }

    var selectedLive: SpaceLive? { selectedID.flatMap { lives[$0] } }

    func dataStore(_ id: UUID) -> WKWebsiteDataStore {
        cookieSession(id).dataStore
    }

    private func cookieSession(_ id: UUID) -> WebCookieSession {
        if let s = cookieSessions[id] { return s }
        let s = WebCookieSession(identifier: id)
        s.onCookies = { [weak self] cookies in
            guard let self, !self.shareSignedOut.contains(id), let connection = self.store.connection(id),
                  (try? ShareAccess.store()) != nil else { return }
            do { try ShareAccess.publish(cookies, for: connection) }
            catch { NSLog("ai-space: share session: %@", error.localizedDescription) }
        }
        cookieSessions[id] = s
        return s
    }

    /// The Space's catalogue (apps, agents, widgets, peers, the panel's screens), as the iPhone reads it.
    func loader(for connection: Connection) -> CatalogueLoader {
        if let l = loaders[connection.id], l.connection.url == connection.url { return l }
        let cookies = cookieSession(connection.id)
        let l = CatalogueLoader(connection: connection, cache: cache) { await cookies.cookies() }
        l.onCatalogue = { [weak self] catalogue in
            guard let self else { return }
            screens.seed(connection.id, from: catalogue.panelScreens)
            screens.merge(connection.id, groups: catalogue.agentGroups)
            iconStores[connection.id]?.retryFailed()
        }
        loaders[connection.id] = l
        iconStores[connection.id] = IconStore(api: l.api, directory: DesktopPaths.icons(connection.id))
        DispatchQueue.main.async { Task { await l.refresh() } }
        return l
    }

    func icons(for connection: Connection) -> IconStore {
        if let s = iconStores[connection.id], loaders[connection.id]?.connection.url == connection.url { return s }
        _ = loader(for: connection)
        return iconStores[connection.id]!
    }

    func icons(_ id: UUID) -> IconStore? { store.connection(id).map(icons(for:)) }

    func settings(for connection: Connection) -> SettingsLoader {
        if let s = settingsLoaders[connection.id] { return s }
        let s = SettingsLoader(api: loader(for: connection).api)
        settingsLoaders[connection.id] = s
        return s
    }

    /// The Space's shells open on this Mac, kept while the app runs as the chats are.
    func terminal(for connection: Connection) -> TerminalStore {
        if let s = terminals[connection.id] { return s }
        let s = TerminalStore(api: loader(for: connection).api)
        s.openLink = { NSWorkspace.shared.open($0) }
        terminals[connection.id] = s
        return s
    }

    /// Reads the catalogue again; failed icons are tried once more after it.
    func refreshCatalogue() {
        guard let c = selected else { return }
        let l = loader(for: c)
        Task { await l.refresh(afterCurrent: true) }
    }

    func session(for connection: Connection) -> PanelSession {
        if let s = sessions[connection.id], s.connection.url == connection.url { return s }
        let s = PanelSession(connection: connection, dataStore: dataStore(connection.id))
        s.openLink = { [weak self] url in self?.openLink(url, from: connection) }
        // Signing in on the panel is what lets the native views in: refresh them right away.
        s.onStateChange = { [weak self, weak s] state in
            // The Local edition's own Space: sign in again with the device credential, then reload.
            if state == .authenticationRequired, connection.managed, let self, let s {
                Task {
                    if await self.local.signIn(connection, cookies: self.cookieSession(connection.id)) { s.load() }
                }
                return
            }
            guard let self, state == .ready, self.sessions[connection.id] === s else { return }
            self.shareSignedOut.remove(connection.id)
            Task { await self.prepareSharing() }
            if let live = lives[connection.id], live.status != .ok { Task { await live.refresh(catalogue: true) } }
            if let loader = loaders[connection.id], loader.status != .ok { Task { await loader.refresh() } }
            if closeWebPanelAfterSignIn, selectedID == connection.id, destination == .panel {
                closeWebPanelAfterSignIn = false
                destination = .launcher
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
        query = ""
        editingScreen = nil
        homePage = Screens.home
        pagerID = Screens.home
        destination = .launcher
    }

    func add(name: String, url: URL) {
        let c = store.add(name: name, url: url)
        selectedID = c.id
        homePage = Screens.home
        pagerID = Screens.home
        destination = .launcher
    }

    /// A changed URL starts a fresh page; the old one's unsent drafts are gone, which the form says.
    func update(_ id: UUID, name: String, url: URL) {
        let changed = store.connection(id)?.url != url
        if changed, let previous = store.connection(id) {
            cookieSessions[id]?.invalidateSharedCookies()
            try? ShareAccess.clear(previous)
        }
        store.update(id, name: name, url: url)
        if changed { discard(id) }
        objectWillChange.send()
    }

    // MARK: Local edition

    /// Saves (or re-points) the Local edition's own Space after an install, selects it and signs
    /// in to it with the device credential.
    func adoptLocal(url: URL) {
        let c: Connection
        if let existing = store.managedConnection ?? store.connections.first(where: { ConnectionRules.sameOrigin($0.url, url) }) {
            store.setManaged(existing.id, url: url)
            c = store.connection(existing.id)!
        } else {
            c = store.add(name: "This Mac", url: url, makeDefault: true, managed: true)
        }
        store.setDefault(c.id)
        selectedID = c.id
        destination = .launcher
        Task { await signInLocal(c, force: true) }
    }

    /// At launch: the managed Space's web data has no session cookie yet (or it expired).
    func ensureLocalSignIn() async {
        guard let c = store.managedConnection else { return }
        await signInLocal(c, force: false)
    }

    private func signInLocal(_ c: Connection, force: Bool) async {
        let cookies = cookieSession(c.id)
        let signedIn = force ? false : LocalManager.hasSession(await cookies.cookies(), for: c.url)
        if !signedIn {
            guard await local.signIn(c, cookies: cookies) else { return }
            _ = await cookies.cookies()
            sessions[c.id]?.load()
            if let loader = loaders[c.id] { await loader.refresh() }
            await lives[c.id]?.refresh(catalogue: true)
        }
        await askForDefaultModel(c)
    }

    /// The first run's last step (docs/local.md#first-run): the Space on this Mac has no default
    /// model yet, so its agents would run on whatever the environment falls back to. Ask once it
    /// answers with the models it offers.
    private func askForDefaultModel(_ c: Connection) async {
        let s = settings(for: c)
        await s.refresh()
        guard let models = s.settings?.models, models.defaultModel == nil, !models.options.isEmpty else { return }
        local.needsModelChoice = true
    }

    /// Forgets the connection on this Mac. The Space itself, its agents and its data are untouched.
    func remove(_ id: UUID, clearSignIn: Bool) async {
        shareSignedOut.insert(id)
        cookieSessions[id]?.invalidateSharedCookies()
        if let connection = store.connection(id) { try? ShareAccess.clear(connection) }
        discard(id)
        loaders[id]?.forget()
        loaders[id] = nil
        iconStores[id]?.clear()
        try? FileManager.default.removeItem(at: DesktopPaths.icons(id))
        iconStores[id] = nil
        settingsLoaders[id] = nil
        cookieSessions[id] = nil
        screens.forget(id)
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

    /// Ends the Space's session on this Mac: cookies and every other piece of website data of its
    /// store, the saved catalogue, icons and open pages. The address and the screens stay.
    func signOut(_ connection: Connection) {
        shareSignedOut.insert(connection.id)
        cookieSessions[connection.id]?.invalidateSharedCookies()
        try? ShareAccess.clear(connection)
        let id = connection.id
        iconStores[id]?.clear()
        terminals[id]?.closeAll()
        sessions[id]?.webView.stopLoading()
        sessions[id] = nil
        tabs[id]?.forEach { $0.session.webView.stopLoading() }
        tabs[id] = nil
        appWindows.close(connection: id)
        chats = chats.filter { $0.key.connection != id }
        let loader = loaders[id]
        loader?.forget()
        settingsLoaders[id]?.forget()
        if selectedID == id {
            destination = .launcher
            pagerID = Pager.home
        }
        dataStore(id).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
            Task { @MainActor in
                // Again, for a refresh that started while the cookies were still there.
                loader?.forget()
                await loader?.refresh()
                await self?.lives[id]?.refresh(catalogue: true)
            }
        }
        objectWillChange.send()
    }

    private func discard(_ id: UUID) {
        sessions[id] = nil
        terminals[id]?.closeAll()
        terminals[id] = nil
        tabs[id]?.forEach { $0.session.webView.stopLoading() }
        tabs[id] = nil
        appWindows.close(connection: id)
        chats = chats.filter { $0.key.connection != id }
        lives[id]?.stop()
        lives[id] = nil
        if quickChatAgentRef?.connection == id { quickChatAgentRef = nil }
    }

    private func syncLives(_ list: [Connection]) {
        Task { await prepareSharing() }
        let ids = Set(list.map(\.id))
        for (id, live) in lives where !ids.contains(id) {
            live.stop()
            lives[id] = nil
        }
        for c in list where lives[c.id]?.connection.url != c.url {
            lives[c.id]?.stop()
            let cookies = cookieSession(c.id)
            let live = SpaceLive(connection: c) { await cookies.cookies() }
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

    /// Reloads what is on show: the app's page, the web panel, or the launcher's catalogue.
    func reload() {
        guard let c = selected else { return }
        switch destination {
        case .app(let id): tab(id, connection: c.id)?.session.reload()
        case .panel: session(for: c).reload()
        case .launcher: refreshCatalogue()
        case .hub: NotificationCenter.default.post(name: .reloadHubPage, object: nil)
        }
        if let live = lives[c.id] { Task { await live.refresh(catalogue: true) } }
    }

    func openInBrowser() {
        guard let c = selected else { return }
        if case .app(let id) = destination, let url = tab(id, connection: c.id)?.session.webView.url {
            NSWorkspace.shared.open(url)
        } else {
            NSWorkspace.shared.open(session(for: c).browserURL)
        }
    }

    /// Back to the launcher, on the page it was on; apps stay open as tabs.
    func returnToSpace() {
        destination = .launcher
    }

    /// Shows the Space's web panel over the launcher.
    func openWebPanel() {
        destination = .panel
        if let c = selected { session(for: c).recoverIfFailed() }
    }

    func signIn() {
        closeWebPanelAfterSignIn = true
        openWebPanel()
    }

    func webPanelFromHub() { openWebPanel() }

    /// A link on one of the Space's pages: it opens as any other address does.
    func openFromHub(_ url: URL, title: String, in connection: Connection) {
        openLink(url, from: connection)
    }

    /// Moves the launcher one page left or right (⌘← and ⌘→, or a swipe).
    func movePage(by step: Int) {
        guard let c = selected else { return }
        if destination != .launcher { destination = .launcher }
        let ids = [Pager.home] + screens.screens(c.id).map(\.id)
        let i = ids.firstIndex(of: pagerID) ?? 1
        pagerID = ids[max(0, min(ids.count - 1, i + step))]
    }

    /// ⌘F: the command box on the first screen, where the window opens.
    func search() {
        showPage(Screens.home)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.focusSearch.send() }
    }

    func showPage(_ id: String) {
        // Settings is not a page of the pager any more but opens over it, as on the web panel.
        if id == Pager.settings { return openSettings() }
        pagerID = id
        destination = .launcher
    }

    /// Settings of the Space, over the launcher (src/web/App.tsx `openSettings`).
    func openSettings() {
        destination = .hub(.settings)
    }

    /// One of the panel's own windows (src/web/screens.ts `BUILTINS`), from its tile.
    func openBuiltin(_ builtin: Builtin) {
        switch builtin {
        case .settings: openSettings()
        case .inbox: destination = .hub(.inbox)
        case .terminal: destination = .hub(.terminal)
        }
    }

    /// The screens, at the one last shown.
    func showScreens() {
        let ids = selected.map { c in screens.screens(c.id).map(\.id) } ?? []
        showPage(ids.contains(homePage) ? homePage : Screens.home)
    }

    // MARK: Screens

    /// Pins the entry to the screen, or takes it off when it is there. This Mac's layout only.
    func togglePin(_ key: String, screen: String, in connection: Connection) {
        let pinned = screens.isPinned(key, screen: screen, connection.id)
        screens.edit(connection.id) { pinned ? Screens.unpin($0, screen, key) : Screens.pin($0, screen, key) }
    }

    /// A new empty screen after the last one, shown at once.
    func addScreen(in connection: Connection) {
        guard let made = Screens.add(screens.screens(connection.id)) else { return }
        screens.edit(connection.id) { _ in made.screens }
        pagerID = made.id
    }

    func removeScreen(_ id: String, in connection: Connection) {
        guard id != Screens.home else { return }
        let all = screens.screens(connection.id)
        let before = all.firstIndex { $0.id == id }.map { all[max($0 - 1, 0)].id } ?? Screens.home
        if homePage == id { homePage = before }
        if pagerID == id { pagerID = before }
        if editingScreen == id { editingScreen = nil }
        screens.edit(connection.id) { Screens.remove($0, id) }
    }

    /// Throws this Mac's layout away for the panel's as it is now.
    func resetScreens(in connection: Connection) {
        guard let catalogue = loaders[connection.id]?.catalogue else { return }
        homePage = Screens.home
        if pagerID != Pager.home, pagerID != Pager.settings { pagerID = Screens.home }
        editingScreen = nil
        screens.reset(connection.id, from: catalogue.panelScreens)
    }

    /// The screen the screen actions are about: the one on show, else the one last shown.
    var actionScreen: String { homePage }

    // MARK: Opening entries

    /// An entry of the library or a screen: an app opens as a tab, an agent as its conversation,
    /// a widget at its link.
    func open(_ entry: CatalogueEntry) {
        guard let c = selected else { return }
        switch entry.kind {
        case .agent:
            destination = .hub(.chat(agent: preferredAgent(entry, in: c).ref))
        case .app:
            guard let url = entry.pageURL(space: c.url) else { return openWebPanel() }
            // A plain link to another site is the browser's; an app of the Space is a tab.
            if entry.reach == .link, !isSpace(url, c) {
                NSWorkspace.shared.open(url)
                return
            }
            let app = lives[c.id]?.apps.first { $0.id == entry.ref }
                ?? AppInfo(id: entry.ref, name: entry.ref.split(separator: "/").last.map(String.init) ?? entry.ref, peer: entry.peer,
                           stale: nil, title: entry.title, description: entry.detail, i18n: entry.i18n, icon: entry.icon,
                           url: entry.link, status: nil, hidden: nil)
            openApp(app, connection: c, url: url)
        case .widget:
            guard let url = entry.pageURL(space: c.url) else { return openWebPanel() }
            openLink(url, from: c)
        }
    }

    /// The Space's own origin, or an app host under the domain its router serves.
    func isSpace(_ url: URL, _ connection: Connection) -> Bool {
        if ConnectionRules.sameOrigin(url, connection.url) { return true }
        guard let host = url.host?.lowercased(), let domain = loaders[connection.id]?.catalogue?.domain else { return false }
        return host == domain || host.hasSuffix("." + domain)
    }

    /// The first apps and agents of the first screen, for the Dock menu.
    func dockEntries() -> [CatalogueEntry] {
        guard let c = selected, let catalogue = loaders[c.id]?.catalogue else { return [] }
        let pins = screens.screens(c.id).first?.items ?? []
        return Array(pins.compactMap { catalogue.entry($0) }.filter { $0.kind != .widget }.prefix(8))
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
            destination = rest.isEmpty ? .launcher : .app(rest[min(i, rest.count - 1)].app.id)
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
            showMainWindow(connection: id, .hub(.inbox))
        }
    }

    // MARK: Conversations

    /// The machine an agent opens on: the one picked last time on this Mac while it answers, else
    /// the local one (AgentGroups.preferred).
    func preferredAgent(_ entry: CatalogueEntry, in connection: Connection) -> CatalogueEntry {
        guard let group = loaders[connection.id]?.catalogue?.agentGroup(entry) else { return entry }
        return AgentGroups.preferred(group, remembered: MachineChoice.remembered(group.key, space: connection.id))
    }

    /// Whether a conversation already open in this app is running a turn.
    func isChatBusy(_ ref: AgentRef) -> Bool { chats[ref]?.busy == true }

    func chat(_ ref: AgentRef) -> ChatController? {
        if let c = chats[ref] { return c }
        guard let live = lives[ref.connection], let agent = live.agent(ref.agent) else { return nil }
        let c = ChatController(agent: agent, api: live.api)
        c.onTurnEnded = { [weak self] in
            guard let self, let connection = self.store.connection(ref.connection) else { return }
            let catalogue = self.loader(for: connection)
            Task { await catalogue.refresh(afterCurrent: true) }
            Task { await live.refresh(catalogue: true) }
        }
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

    /// The Home box's question for Space Assistant (docs/panel.md#omnibox): a new conversation on
    /// the selected Space, shown in the main window. While the assistant still answers, the
    /// question waits in the field for Return instead of stopping that turn.
    func ask(_ text: String) {
        guard let c = selected, let agent = lives[c.id]?.agents.first(where: { $0.app == "space" && $0.peer == nil }),
              let chat = chat(AgentRef(connection: c.id, agent: agent.id)) else { return }
        query = ""
        if chat.busy {
            chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n\n" + text
        } else {
            chat.newConversation()
            chat.draft = text
            chat.send()
        }
        destination = .hub(.chat(agent: agent.id))
    }

    func openQuickChatInMainWindow() {
        guard let ref = quickChatResolvedRef else { return }
        showMainWindow(connection: ref.connection, .hub(.chat(agent: ref.agent)))
    }
}
