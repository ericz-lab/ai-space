import Combine
import SwiftUI
import UIKit
import WebKit

/// Home is everything the Space has; Panel is this phone's screens; Settings is the Space's
/// settings and the phone's own.
enum MainTab: Hashable {
    case home, panel, settings
}

/// How the app is drawn on this phone, whatever the panel in a browser is set to.
enum Appearance: String, CaseIterable {
    case system, light, dark
}

/// The pages the app swipes through, left to right: Home, each screen, Settings. A screen's
/// page is its id; these two are not screen ids (those are letters, digits, - and _ only).
enum Pager {
    static let home = "#home"
    static let settings = "#settings"
}

/// The page on show in the pager, as an object of its own. A published property of AppModel
/// would make every view that observes the model, each page of the pager among them, evaluate
/// again in the middle of a swipe, when the page under the finger changes.
@MainActor
final class PagerPosition: ObservableObject {
    @Published var id = Screens.home {
        didSet {
            if id != Pager.home, id != Pager.settings { lastScreenID = id }
        }
    }
    var lastScreenID = Screens.home
}

/// An app's page on show over the tabs.
struct OpenPage: Identifiable {
    let id = UUID()
    /// The catalogue entry it was opened from, when there is one (for the pin to the home screen).
    let key: String?
    let title: String
    let connection: UUID
    let session: WebSession
    /// The launcher page from which this tab was created.
    let originPage: String
}

/// The app's state: saved Spaces, the catalogue, web sessions and screens of each, and what is
/// on show. Leaving a Space keeps its sign-in; signing out or removing it discards it. Leaving a Space keeps its sign-in; signing out or removing it discards it.
@MainActor
final class AppModel: ObservableObject {
    let store: ConnectionStore
    let screens: ScreenStore
    private let cache = CatalogueCache(directory: AppPaths.caches)

    @Published private(set) var selectedID: UUID? {
        didSet { if usageActive && oldValue != selectedID { setUsageActive(true, restart: true) } }
    }
    /// Where the pager stands, observed by the pager alone (PagerPosition).
    let pager = PagerPosition()
    /// The page on show: `Pager.home`, a screen's id, or `Pager.settings`. The app opens on the
    /// first screen of the panel; the library is one swipe to its left.
    var pagerID: String {
        get { pager.id }
        set {
            pager.id = newValue
        }
    }
    /// This phone's own display choices, kept in the app's defaults.
    @Published var appearance = Appearance(rawValue: UserDefaults.standard.string(forKey: "appearance") ?? "") ?? .system {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appearance") }
    }
    /// The theme this phone is drawn in, by the id of one of the panel's presets.
    @Published var themeID = UserDefaults.standard.string(forKey: "theme") ?? ThemePreset.aurora.id {
        didSet {
            UserDefaults.standard.set(themeID, forKey: "theme")
            Theme.current = ThemePreset.named(themeID)
        }
    }
    @Published var showsWidgets = !UserDefaults.standard.bool(forKey: "hidesWidgets") {
        didSet { UserDefaults.standard.set(!showsWidgets, forKey: "hidesWidgets") }
    }
    /// The actions on the screens, asked for by a long press on a screen.
    @Published var showingScreenMenu = false
    @Published var query = ""
    /// The screen the Panel tab opens on: the one last shown. Not published, as the page on
    /// show is not: it changes with every swipe, and the views read it only when acted on.
    private(set) var homePage: String {
        get { pager.lastScreenID }
        set { pager.lastScreenID = newValue }
    }
    /// The Space's web panel over the tabs: the sign-in, package installs and what the app does not draw.
    @Published var showingWebPanel = false
    /// A page of the Space drawn by the app, over the tabs.
    @Published var hubPage: HubPage?
    /// The screen whose entries are being rearranged, in a sheet.
    @Published var editingScreen: String?
    @Published var confirmingDeleteScreen = false
    @Published var confirmingResetScreens = false
    @Published var page: OpenPage?
    /// Retained web pages, isolated by Space; returning home does not close a tab.
    @Published private(set) var appTabs: [OpenPage] = []
    @Published var showingAdd = false
    @Published var confirmingSignOut = false
    /// Set when the web panel was opened to sign in, so a finished sign-in closes it again.
    private var closeWebPanelAfterSignIn = false
    /// A link that arrived before the catalogue of the Space it was opened in did.
    private var pendingLink: (link: DeepLink, connection: UUID)?

    /// Hands an address to the system browser; every way out of the app goes through here.
    var openInBrowser: (URL) -> Void = { UIApplication.shared.open($0) }

    private var loaders: [UUID: CatalogueLoader] = [:]
    private var icons: [UUID: IconStore] = [:]
    private var settings: [UUID: SettingsLoader] = [:]
    private var omniboxes: [UUID: OmniboxStore] = [:]
    private var chats: [String: ChatStore] = [:]
    private var terminals: [UUID: TerminalStore] = [:]
    private var backdrops: [UUID: BackdropStore] = [:]
    private var panels: [UUID: WebSession] = [:]
    private var cookieSessions: [UUID: WebCookieSession] = [:]
    private var watchers: Set<AnyCancellable> = []
    /// A screenshot taken in the app, offered to the Space's Spark.
    let screenshots = ScreenshotCapture()
    private var screenshotOverlay: ScreenshotOverlay?

    init(store: ConnectionStore? = nil, screens: ScreenStore? = nil) {
        self.store = store ?? ConnectionStore(fileURL: AppPaths.connections)
        Theme.current = ThemePreset.named(UserDefaults.standard.string(forKey: "theme") ?? "")
        self.screens = screens ?? ScreenStore(fileURL: AppPaths.screens)
        // Downloads are handed to the share sheet and not kept: what an earlier launch left goes.
        try? FileManager.default.removeItem(at: AppPaths.downloads)
        selectedID = self.store.defaultConnection?.id
        self.store.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &watchers)
        self.screens.objectWillChange.sink { [weak self] in
            self?.objectWillChange.send()
            DispatchQueue.main.async { self?.publishQuickActions() }
        }.store(in: &watchers)
        screenshots.openPage = { [weak self] url in
            guard let self, let connection = self.selected else { return }
            self.open(url, title: String(localized: "Spark"), in: connection)
        }
    }

    /// iOS told the app a screenshot was just taken.
    func screenshotTaken() {
        guard let connection = selected else { return }
        if screenshotOverlay == nil { screenshotOverlay = ScreenshotOverlay(capture: screenshots) }
        screenshots.use(loader(for: connection).api)
        screenshots.screenshotTaken()
    }

    /// The tab the page on show belongs to; choosing Panel returns to the screen last shown.
    var tab: MainTab {
        get { pagerID == Pager.home ? .home : (pagerID == Pager.settings ? .settings : .panel) }
        set {
            switch newValue {
            case .home: pagerID = Pager.home
            case .settings: pagerID = Pager.settings
            case .panel: pagerID = selected.map { c in screens.screens(c.id).contains { $0.id == homePage } } == true ? homePage : Screens.home
            }
        }
    }

    // MARK: Spaces

    private let deviceUsage = DeviceUsageReporter()
    private var usageActive = false

    func setUsageActive(_ active: Bool, restart: Bool = false) {
        guard restart || usageActive != active else { return }
        usageActive = active
        deviceUsage.setActive(active) { [weak self] in
            guard let self, let connection = self.selected else { return nil }
            return self.loader(for: connection).api
        }
    }

    var selected: Connection? { selectedID.flatMap(store.connection) ?? store.defaultConnection }

    func dataStore(_ id: UUID) -> WKWebsiteDataStore {
        cookieSession(id).dataStore
    }

    private func cookieSession(_ id: UUID) -> WebCookieSession {
        if let session = cookieSessions[id] { return session }
        let session = WebCookieSession(identifier: id)
        cookieSessions[id] = session
        return session
    }

    func loader(for connection: Connection) -> CatalogueLoader {
        if let l = loaders[connection.id], l.connection.url == connection.url { return l }
        let cookieSession = cookieSession(connection.id)
        let l = CatalogueLoader(connection: connection, cache: cache) { await cookieSession.cookies() }
        l.onCatalogue = { [weak self] catalogue in
            guard let self else { return }
            self.screens.seed(connection.id, from: catalogue.panelScreens)
            self.icons[connection.id]?.retryFailed()
            self.backdrops[connection.id]?.retryFailed()
            self.publishQuickActions()
            if let pending = self.pendingLink, pending.connection == connection.id {
                self.pendingLink = nil
                // The operator may have moved to another Space while this one was loading.
                if self.selected?.id == connection.id { self.handle(pending.link) }
            }
        }
        loaders[connection.id] = l
        icons[connection.id] = IconStore(api: l.api, directory: AppPaths.icons(connection.id))
        Task { await l.refresh() }
        return l
    }

    func icons(for connection: Connection) -> IconStore {
        if let s = icons[connection.id] { return s }
        _ = loader(for: connection)
        return icons[connection.id]!
    }

    func settings(for connection: Connection) -> SettingsLoader {
        if let s = settings[connection.id] { return s }
        let s = SettingsLoader(api: loader(for: connection).api)
        settings[connection.id] = s
        return s
    }

    func omnibox(for connection: Connection) -> OmniboxStore {
        if let store = omniboxes[connection.id] { return store }
        let store = OmniboxStore(api: loader(for: connection).api)
        omniboxes[connection.id] = store
        return store
    }

    /// An agent's conversation, kept while the app runs so leaving the page does not lose it.
    func chat(for connection: Connection, base: String) -> ChatStore {
        let key = "\(connection.id)|\(base)"
        if let s = chats[key] { return s }
        let s = ChatStore(api: loader(for: connection).api, base: base)
        chats[key] = s
        return s
    }

    /// The Space's shells open on this phone, kept while the app runs as the chats are.
    func terminal(for connection: Connection) -> TerminalStore {
        if let s = terminals[connection.id] { return s }
        let s = TerminalStore(api: loader(for: connection).api)
        s.openLink = { [weak self] in self?.openInBrowser($0) }
        terminals[connection.id] = s
        return s
    }

    /// The artwork of the themes that have one, as this Space serves it.
    func backdrops(for connection: Connection) -> BackdropStore {
        if let s = backdrops[connection.id] { return s }
        let s = BackdropStore(space: connection.url, dataStore: dataStore(connection.id), directory: AppPaths.backdrops(connection.id))
        backdrops[connection.id] = s
        return s
    }

    func hosts(for connection: Connection) -> SpaceHosts {
        SpaceHosts(space: connection.url, catalogue: loaders[connection.id]?.catalogue)
    }

    /// The Space's web panel: chat, inbox, tasks and settings as the browser has them.
    func panel(for connection: Connection) -> WebSession {
        if let s = panels[connection.id], s.space == connection.url { return s }
        let s = WebSession(space: connection.url, dataStore: dataStore(connection.id)) { [weak self] in
            self?.hosts(for: connection) ?? SpaceHosts(space: connection.url)
        }
        s.openExternally = { [weak self] in self?.openInBrowser($0) }
        // Signing in on the panel is what lets the native catalogue in: refresh it right away.
        s.onStateChange = { [weak self] state in
            guard let self, state == .ready, let loader = self.loaders[connection.id] else { return }
            if loader.status != .ok { Task { await loader.refresh() } }
            if self.closeWebPanelAfterSignIn {
                self.closeWebPanelAfterSignIn = false
                self.showingWebPanel = false
            }
        }
        panels[connection.id] = s
        return s
    }

    func select(_ id: UUID) {
        guard store.connection(id) != nil else { return }
        page = nil
        selectedID = id
        query = ""
        homePage = Screens.home
        tab = .panel
        editingScreen = nil
        showingWebPanel = false
        hubPage = nil
        publishQuickActions()
    }

    // MARK: Screens

    /// Pins the entry to the screen, or takes it off when it is there. This phone's layout only.
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
        // The page before it comes up, as when a page of the home screen is removed.
        let all = screens.screens(connection.id)
        let before = all.firstIndex { $0.id == id }.map { all[max($0 - 1, 0)].id } ?? Screens.home
        if homePage == id { homePage = before }
        if pagerID == id { pagerID = before }
        if editingScreen == id { editingScreen = nil }
        screens.edit(connection.id) { Screens.remove($0, id) }
    }

    /// Throws this phone's layout away for the panel's as it is now.
    func resetScreens(in connection: Connection) {
        guard let catalogue = loaders[connection.id]?.catalogue else { return }
        homePage = Screens.home
        if tab == .panel { pagerID = Screens.home }
        editingScreen = nil
        screens.reset(connection.id, from: catalogue.panelScreens)
    }

    func add(name: String, url: URL) {
        let c = store.add(name: name, url: url)
        showingAdd = false
        select(c.id)
    }

    func remove(_ id: UUID) {
        discard(id)
        screens.forget(id)
        store.remove(id)
        if selectedID == id { selectedID = store.defaultConnection?.id }
        // The store's files go once WebKit has let go of it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            WKWebsiteDataStore.remove(forIdentifier: id) { _ in }
        }
        publishQuickActions()
    }

    /// Ends the Space's session on this phone: cookies and every other piece of website data of
    /// its store, the saved catalogue and the open pages. The address and the screens stay.
    func signOut(_ connection: Connection) {
        omniboxes[connection.id]?.clear()
        query = ""
        let data = dataStore(connection.id)
        icons[connection.id]?.clear()
        try? FileManager.default.removeItem(at: AppPaths.icons(connection.id))
        discardTabs(for: connection.id)
        terminals[connection.id]?.closeAll()
        panels[connection.id]?.stop()
        panels[connection.id] = nil
        let loader = loaders[connection.id]
        loader?.forget()
        settings[connection.id]?.forget()
        showingWebPanel = false
        data.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
            Task { @MainActor in
                // Again, for a refresh that started while the cookies were still there.
                loader?.forget()
                await loader?.refresh()
            }
        }
        tab = .home
        objectWillChange.send()
    }

    func signIn() {
        closeWebPanelAfterSignIn = true
        openWebPanel()
    }

    /// Shows the Space's web panel over the tabs.
    func openWebPanel() {
        showingWebPanel = true
        if let c = selected { panel(for: c).recoverIfFailed() }
    }

    /// One cover at a time: the page on show leaves before the next comes up.
    private func afterHub(_ next: @escaping () -> Void) {
        guard hubPage != nil else { return next() }
        hubPage = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { next() }
    }

    func webPanelFromHub() {
        afterHub { [weak self] in self?.openWebPanel() }
    }

    /// A link on one of the Space's pages: the page closes and the address opens as any other.
    func openFromHub(_ url: URL, title: String, in connection: Connection) {
        afterHub { [weak self] in self?.open(url, title: title, in: connection) }
    }

    private func discard(_ id: UUID) {
        discardTabs(for: id)
        panels[id]?.stop()
        panels[id] = nil
        loaders[id]?.forget()
        loaders[id] = nil
        settings[id] = nil
        backdrops[id] = nil
        try? FileManager.default.removeItem(at: AppPaths.backdrops(id))
        omniboxes.removeValue(forKey: id)
        chats = chats.filter { !$0.key.hasPrefix("\(id)|") }
        terminals[id]?.closeAll()
        terminals[id] = nil
        icons[id]?.clear()
        // A Space can be removed before its icon store has been opened in this launch.
        try? FileManager.default.removeItem(at: AppPaths.icons(id))
        icons[id] = nil
        cookieSessions[id] = nil
    }

    /// The phone came back to the app: failed pages try again and the catalogue catches up.
    func becameActive() {
        screenshots.recheck()
        guard let c = selected else { return }
        panels[c.id]?.recoverIfFailed()
        page?.session.recoverIfFailed()
        if let l = loaders[c.id] { Task { await l.refresh() } }
    }

    // MARK: Opening

    func open(_ entry: CatalogueEntry) {
        guard let connection = selected else { return }
        guard let url = entry.pageURL(space: connection.url) else {
            // An agent has no page: it is talked to.
            if entry.kind == .agent { hubPage = .chat(agent: entry.key) } else { openWebPanel() }
            return
        }
        open(url, title: entry.displayTitle(), key: entry.key, in: connection)
    }

    /// A page of the Space opens in the app with the Space's session; any other address is Safari's.
    func open(_ url: URL, title: String, key: String? = nil, in connection: Connection) {
        guard hosts(for: connection).contains(url) else {
            openInBrowser(url)
            return
        }
        if let existing = appTabs.first(where: {
            $0.connection == connection.id && $0.key == key && $0.session.home == url
        }) {
            showTab(existing.id)
            return
        }
        let session = WebSession(space: connection.url, home: url, dataStore: dataStore(connection.id)) { [weak self] in
            self?.hosts(for: connection) ?? SpaceHosts(space: connection.url)
        }
        session.openExternally = { [weak self] in self?.openInBrowser($0) }
        // An app's host may sit behind its own access rule; a sign-in finished there counts for the catalogue too.
        session.onStateChange = { [weak self] state in
            guard state == .ready, let loader = self?.loaders[connection.id], loader.status != .ok else { return }
            Task { await loader.refresh() }
        }
        let opened = OpenPage(key: key, title: title, connection: connection.id, session: session, originPage: pagerID)
        appTabs.insert(opened, at: 0)
        page = opened
    }

    func returnToSpace() {
        if let page {
            let origin = page.originPage
            pagerID = origin == Pager.home || origin == Pager.settings || screens.screens(page.connection).contains { $0.id == origin }
                ? origin : Screens.home
        }
        page = nil
    }

    func showTab(_ id: UUID) {
        guard let index = appTabs.firstIndex(where: { $0.id == id && $0.connection == selected?.id }) else { return }
        let next = appTabs[index]
        if index != 0 {
            appTabs.remove(at: index)
            appTabs.insert(next, at: 0)
        }
        next.session.showControls()
        next.session.recoverIfFailed()
        page = next
    }

    func closeTab(_ id: UUID) {
        guard let index = appTabs.firstIndex(where: { $0.id == id }) else { return }
        let closed = appTabs.remove(at: index)
        closed.session.stop()
        if page?.id == id {
            let remaining = appTabs.filter { $0.connection == closed.connection }
            page = remaining.first
            page?.session.showControls()
        }
    }

    private func discardTabs(for connection: UUID) {
        if page?.connection == connection { page = nil }
        appTabs.filter { $0.connection == connection }.forEach { $0.session.stop() }
        appTabs.removeAll { $0.connection == connection }
    }

    func handle(_ url: URL) {
        guard let link = DeepLink(url) else { return }
        handle(link)
    }

    /// `aispace://` links and home-screen quick actions. A link only ever shows something: it
    /// cannot send a message or change the Space, since any web page can open one.
    func handle(_ link: DeepLink) {
        guard let connection = selected else { return }
        switch link {
        case .show:
            page = nil
            showingWebPanel = false
            tab = .home
        case .inbox:
            page = nil
            showingWebPanel = false
            hubPage = .inbox
        case .chat(let agent, let text):
            page = nil
            showingWebPanel = false
            let entry = agent.flatMap { id in loaders[connection.id]?.catalogue?.agents.first { $0.ref == id } }
            // The text is put in the field, never sent: any web page can open a link.
            if let entry, let text, let base = ChatRoute.base(ref: entry.ref, peer: entry.peer) { chat(for: connection, base: base).draft = text }
            hubPage = .chat(agent: entry?.key)
        case .open(let app):
            guard let catalogue = loaders[connection.id]?.catalogue ?? loader(for: connection).catalogue else {
                pendingLink = (link, connection.id)
                return
            }
            if let entry = catalogue.app(named: app) { open(entry) }
        }
    }

    /// A home-screen quick action opens the app of the Space it was made for, whichever Space is
    /// on show; one for a Space that has been removed since does nothing.
    func handle(_ action: QuickAction.Target) {
        if let space = action.space {
            guard store.connection(space) != nil else { return }
            if selected?.id != space { select(space) }
        }
        handle(action.url)
    }

    private func publishQuickActions() {
        guard let c = selected, let catalogue = loaders[c.id]?.catalogue else {
            UIApplication.shared.shortcutItems = []
            return
        }
        UIApplication.shared.shortcutItems = QuickAction.items(pins: screens.screens(c.id).first?.items ?? [], catalogue: catalogue).map { action in
            UIApplicationShortcutItem(type: QuickAction.type, localizedTitle: action.title, localizedSubtitle: action.subtitle,
                                      icon: UIApplicationShortcutIcon(systemImageName: "star"),
                                      userInfo: action.userInfo(space: c.id).mapValues { $0 as NSString })
        }
    }
}
