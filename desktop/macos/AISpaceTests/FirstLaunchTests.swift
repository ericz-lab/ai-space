import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct FirstLaunchTests {
    static let identity = Data(#"{"product":"ai-space","api":1}"#.utf8)

    /// What the made-up Mac does: whether a Space answers, and how the installer ends.
    final class Mac: @unchecked Sendable {
        private let lock = NSLock()
        private var _answering = false
        private var _installs = 0
        var answering: Bool {
            get { lock.withLock { _answering } }
            set { lock.withLock { _answering = newValue } }
        }
        var installs: Int { lock.withLock { _installs } }
        func installed() { lock.withLock { _installs += 1 } }
    }

    /// `exit`: the installer's exit code; `starts`: whether the Space answers after a clean install.
    private func launch(_ mac: Mac, exit: Int32 = 0, starts: Bool = true, download: Bool = true) -> (FirstLaunch, () -> [URL]) {
        let probe = LocalSpaceProbe(envText: { nil }, fetch: { _ in
            mac.answering ? (status: 200, body: Self.identity) : nil
        }, sleep: { _ in })
        var installer = SpaceInstaller(environment: [:], temporary: FileManager.default.temporaryDirectory)
        installer.download = { _ in
            if !download { throw SpaceInstaller.HTTPFailure(status: 503) }
            return Data("true\n".utf8)
        }
        installer.run = { _, onLine in
            mac.installed()
            onLine("ai-space: stand-in")
            if exit == 0 && starts { mac.answering = true }
            return exit
        }
        let first = FirstLaunch(probe: probe, installer: installer)
        let found = Found()
        first.found = { found.urls.append($0) }
        return (first, { found.urls })
    }

    final class Found { var urls: [URL] = [] }

    @Test func theLookAtLaunchOnlySaysWhatIsHere() async {
        let mac = Mac()
        mac.answering = true
        let (first, found) = launch(mac)
        await first.look()
        #expect(first.here == .found(URL(string: "http://127.0.0.1:8700/")!))
        #expect(first.phase == .choose)
        #expect(found().isEmpty)
        #expect(mac.installs == 0)
    }

    @Test func withoutOneTheEntriesWaitAndNothingIsInstalled() async {
        let mac = Mac()
        let (first, found) = launch(mac)
        await first.look()
        #expect(first.here == .none)
        #expect(first.phase == .choose)
        #expect(found().isEmpty)
        #expect(mac.installs == 0)
    }

    @Test func connectingToALocalSpaceThatIsHereConnectsStraightAway() async {
        let mac = Mac()
        mac.answering = true
        let (first, found) = launch(mac)
        await first.look()
        await first.connectLocal()
        #expect(found().map(\.absoluteString) == ["http://127.0.0.1:8700/"])
        #expect(mac.installs == 0)
    }

    @Test func connectingToALocalSpaceThatIsNotHereInstallsItFirst() async {
        let mac = Mac()
        let (first, found) = launch(mac)
        await first.look()
        await first.connectLocal()
        #expect(mac.installs == 1)
        #expect(found().map(\.absoluteString) == ["http://127.0.0.1:8700/"])
        #expect(first.progress == 1)
        for _ in 0..<50 where first.lines.isEmpty { await Task.yield() }
        #expect(first.lines == ["ai-space: stand-in"])
    }

    @Test func aSpaceThatCameUpMeanwhileIsUsedAndNotInstalledOver() async {
        let mac = Mac()
        let (first, found) = launch(mac)
        await first.look()
        mac.answering = true
        await first.connectLocal()
        #expect(mac.installs == 0)
        #expect(found().count == 1)
    }

    @Test func aFailedInstallerCanBeRunAgain() async {
        let mac = Mac()
        let (first, found) = launch(mac, exit: 3)
        await first.connectLocal()
        #expect(first.phase == .failed(.exit(3)))
        await first.retry()
        #expect(mac.installs == 2)
        #expect(found().isEmpty)
        first.dismissFailure()
        #expect(first.phase == .choose)
    }

    @Test func aFailedDownloadSaysSoAndRunsNothing() async {
        let mac = Mac()
        let (first, _) = launch(mac, download: false)
        await first.connectLocal()
        guard case .failed(.download(let why)) = first.phase else {
            Issue.record("expected a failed download, got \(first.phase)")
            return
        }
        #expect(why.hasSuffix("HTTP 503"))
        #expect(mac.installs == 0)
    }

    @Test func anInstalledSpaceThatDoesNotAnswerIsLookedForAgainNotReinstalled() async {
        let mac = Mac()
        let (first, found) = launch(mac, starts: false)
        await first.connectLocal()
        #expect(first.phase == .failed(.notAnswering))
        mac.answering = true
        await first.retry()
        #expect(mac.installs == 1)
        #expect(found().count == 1)
    }
}
