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
    /// True while the catalogue on show is not the latest refresh's answer: the saved one of an
    /// earlier launch, or this launch's while the Space has stopped answering since.
    @Published private(set) var isLastKnown = false
    @Published private(set) var isRefreshing = false
    var onCatalogue: (Catalogue) -> Void = { _ in }

    private let cache: CatalogueCache
    /// Counts the sign-outs; see `forget()`.
    private var session = 0
    /// Reads one route of the Space; the API's own call unless a test supplies the answers.
    private let fetch: @MainActor (String) async throws -> Data

    init(connection: Connection, cache: CatalogueCache, cookies: @escaping @MainActor () async -> [HTTPCookie],
         fetch: (@MainActor (String) async throws -> Data)? = nil) {
        self.connection = connection
        self.cache = cache
        let api = SpaceAPI(base: connection.url, cookies: cookies)
        self.api = api
        self.fetch = fetch ?? { try await api.data($0) }
        if let saved = cache.load(connection.id), let c = try? Catalogue.decode(saved) {
            catalogue = c
            isLastKnown = true
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        // An answer counts only for the session that asked: `forget()` moves on to the next one.
        let session = self.session
        let outcome: Status
        do {
            async let apps = fetch("/api/apps")
            async let agents = fetch("/api/agents")
            async let widgets = fetch("/api/widgets")
            // A Space without peers, screens or a router still has a catalogue.
            async let peers = try? fetch("/api/peers")
            async let layout = try? fetch(SpaceCheck.path)
            async let router = try? fetch("/api/router")
            let payload = CataloguePayload(apps: try await apps, agents: try await agents, widgets: try await widgets,
                                           peers: await peers, layout: await layout, router: await router, fetchedAt: Date())
            let fresh = try Catalogue.decode(payload)
            guard session == self.session else { return }
            cache.save(payload, connection.id)
            catalogue = fresh
            outcome = .ok
        } catch SpaceAPIError.authenticationRequired {
            outcome = .signInNeeded
        } catch SpaceAPIError.http(let code, let message) {
            outcome = .incompatible("HTTP \(code) \(message)")
        } catch SpaceAPIError.invalidResponse {
            outcome = .incompatible(String(localized: "not an ai-space response"))
        } catch CatalogueError.notASpace(let route) {
            outcome = .incompatible(String(localized: "not an ai-space response") + " (\(route))")
        } catch {
            outcome = .unreachable(error.localizedDescription)
        }
        guard session == self.session else { return }
        isRefreshing = false
        status = outcome
        isLastKnown = outcome != .ok && catalogue != nil
        if outcome == .ok, let catalogue { onCatalogue(catalogue) }
        #if DEBUG
        NSLog("ai-space: catalogue %@ %@ apps=%d agents=%d widgets=%d", connection.name, String(describing: status),
              catalogue?.apps.count ?? -1, catalogue?.agents.count ?? -1, catalogue?.widgets.count ?? -1)
        #endif
    }

    /// Signing out forgets what the Space showed, not only the session. A refresh on its way
    /// belongs to the session that ended: its answer is dropped, and it does not hold up the next one.
    func forget() {
        session += 1
        isRefreshing = false
        cache.remove(connection.id)
        catalogue = nil
        isLastKnown = false
        status = .loading
    }
}
