import Foundation

/// The catalogue of one saved Space, read from the Space's own panel routes with the cookies of
/// that Space's web session. It says plainly where it stands: a sign-in is needed, the Space
/// cannot be reached, or the address is not ai-space; the last known catalogue stays on show,
/// marked as such, while it cannot be refreshed.
@MainActor
final class CatalogueLoader: ObservableObject {
    enum Status: Equatable {
        case loading
        case ok
        case signInNeeded
        case unreachable(String)
        case incompatible(String)
    }

    let connection: Connection
    let api: SpaceAPI
    @Published private(set) var status: Status = .loading
    @Published private(set) var catalogue: Catalogue?
    /// True while the catalogue on show is the saved one, not this launch's answer.
    @Published private(set) var isLastKnown = false
    @Published private(set) var isRefreshing = false
    var onCatalogue: (Catalogue) -> Void = { _ in }

    private let cache: CatalogueCache

    init(connection: Connection, cache: CatalogueCache, cookies: @escaping @MainActor () async -> [HTTPCookie]) {
        self.connection = connection
        self.cache = cache
        api = SpaceAPI(base: connection.url, cookies: cookies)
        if let saved = cache.load(connection.id), let c = try? Catalogue.decode(saved) {
            catalogue = c
            isLastKnown = true
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let apps = api.data("/api/apps")
            async let agents = api.data("/api/agents")
            async let widgets = api.data("/api/widgets")
            // A Space without peers, screens or a router still has a catalogue.
            async let peers = try? api.data("/api/peers")
            async let layout = try? api.data(SpaceCheck.path)
            async let router = try? api.data("/api/router")
            let payload = CataloguePayload(apps: try await apps, agents: try await agents, widgets: try await widgets,
                                           peers: await peers, layout: await layout, router: await router, fetchedAt: Date())
            let fresh = try Catalogue.decode(payload)
            cache.save(payload, connection.id)
            catalogue = fresh
            isLastKnown = false
            status = .ok
            onCatalogue(fresh)
        } catch SpaceAPIError.authenticationRequired {
            status = .signInNeeded
        } catch SpaceAPIError.http(let code, let message) {
            status = .incompatible("HTTP \(code) \(message)")
        } catch SpaceAPIError.invalidResponse {
            status = .incompatible(String(localized: "not an ai-space response"))
        } catch CatalogueError.notASpace(let route) {
            status = .incompatible(String(localized: "not an ai-space response") + " (\(route))")
        } catch {
            status = .unreachable(error.localizedDescription)
        }
        #if DEBUG
        NSLog("ai-space: catalogue %@ %@ apps=%d agents=%d widgets=%d", connection.name, String(describing: status),
              catalogue?.apps.count ?? -1, catalogue?.agents.count ?? -1, catalogue?.widgets.count ?? -1)
        #endif
    }

    /// Signing out forgets what the Space showed, not only the session.
    func forget() {
        cache.remove(connection.id)
        catalogue = nil
        isLastKnown = false
        status = .loading
    }
}
