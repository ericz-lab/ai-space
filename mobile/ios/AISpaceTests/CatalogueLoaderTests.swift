import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// A Space whose answers the test holds back and lets go, so a refresh can be caught half way.
@MainActor
final class FakeSpace {
    enum Answer {
        case catalogue
        case signIn
        case offline
    }

    var answer = Answer.catalogue
    /// While true, every request waits for `release()`.
    var holds = false
    private(set) var requests = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func fetch(_ path: String) async throws -> Data {
        requests += 1
        // The answer is decided when the request is made, as a server decides it by the cookie it was sent.
        let answer = self.answer
        if holds { await withCheckedContinuation { waiting.append($0) } }
        switch answer {
        case .signIn: throw SpaceAPIError.authenticationRequired
        case .offline: throw URLError(.notConnectedToInternet)
        case .catalogue:
            switch path {
            case "/api/apps": return Data(Fixture.apps.utf8)
            case "/api/agents": return Data(Fixture.agents.utf8)
            case "/api/widgets": return Data(Fixture.widgets.utf8)
            case "/api/peers": return Data(Fixture.peers.utf8)
            case "/api/router": return Data(Fixture.router.utf8)
            default: return Data(Fixture.layout.utf8)
            }
        }
    }

    func release() {
        holds = false
        let held = waiting
        waiting = []
        held.forEach { $0.resume() }
    }

    /// Lets the tasks already started run until they have made `count` requests, or gives up
    /// so that a refresh that never asks fails the test instead of hanging it.
    func reached(_ count: Int) async {
        for _ in 0..<10_000 where requests < count { await Task.yield() }
    }
}

@MainActor
struct CatalogueLoaderTests {
    let connection = Connection(name: "Space", url: URL(string: "https://space.example.com/")!)
    let cache = CatalogueCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent("aispace-loader-\(UUID().uuidString)"))
    let space = FakeSpace()

    func loader() -> CatalogueLoader {
        CatalogueLoader(connection: connection, cache: cache, cookies: { [] }, fetch: space.fetch)
    }

    @Test func aRefreshShowsAndSavesTheCatalogue() async {
        let l = loader()
        var seen = 0
        l.onCatalogue = { _ in seen += 1 }
        await l.refresh()
        #expect(l.status == .ok)
        #expect(l.catalogue?.apps.isEmpty == false)
        #expect(!l.isLastKnown)
        #expect(!l.isRefreshing)
        #expect(cache.load(connection.id) != nil)
        #expect(seen == 1)
        // The next launch starts from the saved catalogue, marked as last known.
        let next = loader()
        #expect(next.catalogue == l.catalogue)
        #expect(next.isLastKnown)
    }

    @Test func anAnswerThatArrivesAfterSigningOutIsDropped() async {
        let l = loader()
        var seen = 0
        l.onCatalogue = { _ in seen += 1 }
        space.holds = true
        let old = Task { await l.refresh() }
        await space.reached(6)
        l.forget()
        space.release()
        await old.value
        #expect(l.catalogue == nil)
        #expect(cache.load(connection.id) == nil)
        #expect(l.status == .loading)
        #expect(seen == 0)
        #expect(!l.isRefreshing)
    }

    @Test func aFailureThatArrivesAfterSigningOutIsDroppedToo() async {
        let l = loader()
        space.answer = .offline
        space.holds = true
        let old = Task { await l.refresh() }
        await space.reached(6)
        l.forget()
        space.release()
        await old.value
        #expect(l.status == .loading)
    }

    @Test func signingOutDoesNotBlockTheNextRefresh() async {
        let l = loader()
        space.holds = true
        let old = Task { await l.refresh() }
        await space.reached(6)
        l.forget()
        // The signed-out session's refresh starts while the old requests are still on their way.
        space.answer = .signIn
        let new = Task { await l.refresh() }
        await space.reached(12)
        space.release()
        await old.value
        await new.value
        #expect(space.requests == 12)
        #expect(l.status == .signInNeeded)
        #expect(l.catalogue == nil)
        #expect(cache.load(connection.id) == nil)
        #expect(!l.isRefreshing)
        // Signing in again loads the catalogue as usual.
        space.answer = .catalogue
        await l.refresh()
        #expect(l.status == .ok)
        #expect(l.catalogue != nil)
    }

    @Test func aSecondRefreshWaitsForTheOneOnItsWay() async {
        let l = loader()
        space.holds = true
        let first = Task { await l.refresh() }
        await space.reached(6)
        await l.refresh()
        #expect(space.requests == 6)
        space.release()
        await first.value
        #expect(l.status == .ok)
    }

    @Test func theCatalogueIsLastKnownWheneverTheSpaceStopsAnswering() async {
        let l = loader()
        await l.refresh()
        #expect(!l.isLastKnown)
        space.answer = .offline
        await l.refresh()
        guard case .unreachable = l.status else {
            Issue.record("expected unreachable, got \(l.status)")
            return
        }
        #expect(l.catalogue != nil)
        #expect(l.isLastKnown)
        space.answer = .signIn
        await l.refresh()
        #expect(l.status == .signInNeeded)
        #expect(l.isLastKnown)
        space.answer = .catalogue
        await l.refresh()
        #expect(l.status == .ok)
        #expect(!l.isLastKnown)
    }

    @Test func nothingIsLastKnownWithoutACatalogue() async {
        let l = loader()
        space.answer = .offline
        await l.refresh()
        #expect(l.catalogue == nil)
        #expect(!l.isLastKnown)
    }
}
