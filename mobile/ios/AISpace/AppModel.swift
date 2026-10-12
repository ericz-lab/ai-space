import Combine
import SwiftUI
import UIKit
import WebKit

enum MainTab: Hashable {
    case home, panel, settings
}

/// An app's page on show over the tabs.
struct OpenPage: Identifiable {
    let id = UUID()
    /// The catalogue entry it was opened from, when there is one (for the favourite star).
    let key: String?
    let title: String
    let connection: UUID
    let session: WebSession
}

/// The app's state: saved Spaces, the catalogue, web sessions and favourites of each, and what
/// is on show. Leaving a Space keeps its sign-in; signing out or removing it discards it.
@MainActor
final class AppModel: ObservableObject {
    let store: ConnectionStore
    let favorites: FavoritesStore
    private let cache = CatalogueCache(directory: AppPaths.caches)

    @Published private(set) var selectedID: UUID?
    @Published var tab: MainTab = .home
    @Published var query = ""
    @Published var page: OpenPage?
    @Published var showingAdd = false
    @Published var confirmingSignOut = false
    /// Set when the operator went to the panel to sign in, so a finished sign-in returns to Home.
    private var returnHomeAfterSignIn = false
    /// A link that arrived before the catalogue of the Space it was opened in did.
    private var pendingLink: (link: DeepLink, connection: UUID)?

    /// Hands an address to the system browser; every way out of the app goes through here.
    var openInBrowser: (URL) -> Void = { UIApplication.shared.open($0) }

    private var loaders: [UUID: CatalogueLoader] = [:]
    private var icons: [UUID: IconStore] = [:]
    private var panels: [UUID: WebSession] = [:]
    private var dataStores: [UUID: WKWebsiteDataStore] = [:]
    private var watchers: Set<AnyCancellable> = []

    init() {
        store = ConnectionStore(fileURL: AppPaths.connections)
        favorites = FavoritesStore(fileURL: AppPaths.favorites)
        // Downloads are handed to the share sheet and not kept: what an earlier launch left goes.
        try? FileManager.default.removeItem(at: AppPaths.downloads)
        selectedID = store.defaultConnection?.id
        store.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &watchers)
        favorites.objectWillChange.sink { [weak self] in
            self?.objectWillChange.send()
            DispatchQueue.main.async { self?.publishQuickActions() }
        }.store(in: &watchers)
    }

    // MARK: Spaces

    var selected: Connection? { selectedID.flatMap(store.connection) ?? store.defaultConnection }

    func dataStore(_ id: UUID) -> WKWebsiteDataStore {
        if let s = dataStores[id] { return s }
        let s = WKWebsiteDataStore(forIdentifier: id)
        dataStores[id] = s
        return s
    }

    func loader(for connection: Connection) -> CatalogueLoader {
        if let l = loaders[connection.id], l.connection.url == connection.url { return l }
        let cookieStore = dataStore(connection.id).httpCookieStore
        let l = CatalogueLoader(connection: connection, cache: cache) { await cookieStore.allCookies() }
        l.onCatalogue = { [weak self] catalogue in
            guard let self else { return }
            self.favorites.seed(connection.id, pins: catalogue.homePins)
            self.icons[connection.id]?.retryFailed()
            self.publishQuickActions()
            if let pending = self.pendingLink, pending.connection == connection.id {
                self.pendingLink = nil
                // The operator may have moved to another Space while this one was loading.
                if self.selected?.id == connection.id { self.handle(pending.link) }
            }
        }
        loaders[connection.id] = l
        icons[connection.id] = IconStore(api: l.api)
        Task { await l.refresh() }
        return l
    }

    func icons(for connection: Connection) -> IconStore {
        if let s = icons[connection.id] { return s }
        _ = loader(for: connection)
        return icons[connection.id]!
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
            if self.returnHomeAfterSignIn {
                self.returnHomeAfterSignIn = false
                self.tab = .home
            }
        }
        panels[connection.id] = s
        return s
    }

    func select(_ id: UUID) {
        guard store.connection(id) != nil else { return }
        selectedID = id
        query = ""
        tab = .home
        publishQuickActions()
    }

    func add(name: String, url: URL) {
        let c = store.add(name: name, url: url)
        showingAdd = false
        select(c.id)
    }

    func remove(_ id: UUID) {
        discard(id)
        favorites.forget(id)
        store.remove(id)
        if selectedID == id { selectedID = store.defaultConnection?.id }
        // The store's files go once WebKit has let go of it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            WKWebsiteDataStore.remove(forIdentifier: id) { _ in }
        }
        publishQuickActions()
    }

    /// Ends the Space's session on this phone: cookies and every other piece of website data of
    /// its store, the saved catalogue and the open pages. Favourites and the address stay.
    func signOut(_ connection: Connection) {
        let data = dataStore(connection.id)
        if page?.connection == connection.id { page = nil }
        panels[connection.id]?.stop()
        panels[connection.id] = nil
        let loader = loaders[connection.id]
        loader?.forget()
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
        returnHomeAfterSignIn = true
        tab = .panel
        if let c = selected { panel(for: c).recoverIfFailed() }
    }

    private func discard(_ id: UUID) {
        if page?.connection == id { page = nil }
        panels[id]?.stop()
        panels[id] = nil
        loaders[id]?.forget()
        loaders[id] = nil
        icons[id] = nil
        dataStores[id] = nil
    }

    /// The phone came back to the app: failed pages try again and the catalogue catches up.
    func becameActive() {
        guard let c = selected else { return }
        panels[c.id]?.recoverIfFailed()
        page?.session.recoverIfFailed()
        if let l = loaders[c.id] { Task { await l.refresh() } }
    }

    // MARK: Opening

    func open(_ entry: CatalogueEntry) {
        guard let connection = selected else { return }
        guard let url = entry.pageURL(space: connection.url) else {
            // Agents talk in the panel's chat in this version.
            tab = .panel
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
        let session = WebSession(space: connection.url, home: url, dataStore: dataStore(connection.id)) { [weak self] in
            self?.hosts(for: connection) ?? SpaceHosts(space: connection.url)
        }
        session.openExternally = { [weak self] in self?.openInBrowser($0) }
        // An app's host may sit behind its own access rule; a sign-in finished there counts for the catalogue too.
        session.onStateChange = { [weak self] state in
            guard state == .ready, let loader = self?.loaders[connection.id], loader.status != .ok else { return }
            Task { await loader.refresh() }
        }
        page = OpenPage(key: key, title: title, connection: connection.id, session: session)
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
            tab = .home
        case .inbox, .chat:
            page = nil
            tab = .panel
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
        UIApplication.shared.shortcutItems = QuickAction.items(favorites: favorites.keys(c.id), catalogue: catalogue).map { action in
            UIApplicationShortcutItem(type: QuickAction.type, localizedTitle: action.title, localizedSubtitle: action.subtitle,
                                      icon: UIApplicationShortcutIcon(systemImageName: "star"),
                                      userInfo: action.userInfo(space: c.id).mapValues { $0 as NSString })
        }
    }
}
