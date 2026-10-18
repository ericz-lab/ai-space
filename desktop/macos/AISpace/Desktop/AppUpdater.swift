import AppKit
import Foundation

/// The Local edition app replacing itself with a newer published release (docs/local.md#updates).
/// It checks the release feed, downloads the Local DMG, checks it against the SHA-256 in the
/// release's manifest, and accepts the app inside only when it is a Local release of that version,
/// its signature verifies, Gatekeeper accepts it, and it is signed by the same team as this app.
/// Then it puts the new app where this one is and relaunches; the new app updates the background
/// service once the Space has no work in progress (LocalManager.autoUpdate).
@MainActor
final class AppUpdater: ObservableObject {
    enum Phase: Equatable {
        case idle
        case checking
        case upToDate
        case available(AppUpdate)
        case installing(AppUpdate, String)
        case failed(String, page: URL?)
    }

    @Published private(set) var phase: Phase = .idle
    let current: String
    private var lastCheck: Date?
    private var checking = false
    private static let interval: TimeInterval = 6 * 3600

    init(current: String) {
        self.current = current
    }

    var available: AppUpdate? {
        if case .available(let u) = phase { return u }
        return nil
    }

    /// At most every six hours unless `force`; a failed check stays quiet unless it was asked for.
    func check(force: Bool = false) async {
        if case .installing = phase { return }
        guard !checking else { return }
        if !force, let last = lastCheck, Date().timeIntervalSince(last) < Self.interval { return }
        checking = true
        defer { checking = false }
        lastCheck = Date()
        if force { phase = .checking }
        do {
            let release: AppUpdateFeed.Release = try await fetchJSON(AppUpdateFeed.latest)
            guard let manifestURL = AppUpdateFeed.manifestURL(release) else { phase = .upToDate; return }
            let manifest: AppUpdateFeed.Manifest = try await fetchJSON(manifestURL)
            phase = AppUpdateFeed.pick(release, manifest: manifest, current: current).map { .available($0) } ?? .upToDate
        } catch {
            phase = force ? .failed("Could not check for updates: \(error.localizedDescription)", page: nil) : .idle
        }
    }

    private func fetchJSON<T: Decodable>(_ url: URL) async throws -> T {
        var r = URLRequest(url: url)
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: r)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Download, verify, put the new app in place of this one, and relaunch.
    func install(_ update: AppUpdate) async {
        guard available == update, !checking else { return }
        let app = Bundle.main.bundleURL
        let parent = app.deletingLastPathComponent()
        if app.path.contains("/AppTranslocation/") {
            phase = .failed("Move AI Space to the Applications folder, open it from there, then update.", page: update.page)
            return
        }
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            phase = .failed("AI Space cannot replace itself in \(parent.path). Download the update and drag it there.", page: update.page)
            return
        }
        phase = .installing(update, "Downloading \(update.version)…")
        let staged = parent.appendingPathComponent(".AI Space \(UUID().uuidString).update.app")
        do {
            let dmg = try await download(update)
            defer { try? FileManager.default.removeItem(at: dmg) }
            phase = .installing(update, "Checking the download…")
            try await Task.detached(priority: .userInitiated) {
                try Self.verifyAndStage(dmg: dmg, update: update, running: app, staged: staged)
            }.value
            try? FileManager.default.removeItem(at: dmg)
            phase = .installing(update, "Restarting AI Space…")
            try relaunch(replacing: app, with: staged)
        } catch {
            try? FileManager.default.removeItem(at: staged)
            phase = .failed(error.localizedDescription, page: update.page)
        }
    }

    private func download(_ update: AppUpdate) async throws -> URL {
        let (tmp, response) = try await URLSession.shared.download(from: update.dmg)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw UpdateError("The download failed.") }
        let size = try FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? NSNumber
        guard size?.intValue == update.size else { throw UpdateError("The download has the wrong size.") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ai-space-update", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dmg = dir.appendingPathComponent(update.dmgName)
        try? FileManager.default.removeItem(at: dmg)
        try FileManager.default.moveItem(at: tmp, to: dmg)
        return dmg
    }

    struct UpdateError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    nonisolated private static func run(_ tool: String, _ args: [String]) -> (code: Int32, output: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    nonisolated private static func team(_ app: URL) -> String? {
        AppUpdateFeed.teamIdentifier(codesignOutput: run("/usr/bin/codesign", ["-dv", app.path]).output)
    }

    nonisolated private static func verifyAndStage(dmg: URL, update: AppUpdate, running: URL, staged: URL) throws {
        guard try AppUpdateFeed.sha256(of: dmg) == update.sha256 else {
            throw UpdateError("The download does not match the release's checksum.")
        }
        guard let ours = team(running) else {
            throw UpdateError("This copy of AI Space is not signed by a developer, so it cannot check that an update is genuine. Download it from the release page.")
        }
        let mount = FileManager.default.temporaryDirectory.appendingPathComponent("ai-space-update-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        let attach = run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        guard attach.code == 0 else { throw UpdateError("Could not open the update: \(attach.output.suffix(200))") }
        defer {
            _ = run("/usr/bin/hdiutil", ["detach", "-force", mount.path])
            try? FileManager.default.removeItem(at: mount)
        }
        let app = mount.appendingPathComponent("AI Space.app")
        guard let bundle = LocalBundle.find(resources: app.appendingPathComponent("Contents/Resources")), bundle.version == update.version else {
            throw UpdateError("The download is not AI Space \(update.version) with the Local edition inside.")
        }
        guard let identity = Bundle(url: running)?.bundleIdentifier,
              Bundle(url: app)?.bundleIdentifier == identity else {
            throw UpdateError("The update has a different application identity.")
        }
        guard run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app.path]).code == 0 else {
            throw UpdateError("The update's signature does not verify.")
        }
        guard team(app) == ours else { throw UpdateError("The update is signed by someone else than this app.") }
        guard run("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path]).code == 0 else {
            throw UpdateError("macOS does not accept the update (not notarized).")
        }
        try? FileManager.default.removeItem(at: staged)
        let copy = run("/usr/bin/ditto", [app.path, staged.path])
        guard copy.code == 0 else { throw UpdateError("Could not copy the update: \(copy.output.suffix(200))") }
    }

    /// A small shell script, outliving this process, swaps the bundles once it has quit and opens
    /// the new one. If the swap fails, the old app is put back and opened.
    private func relaunch(replacing app: URL, with staged: URL) throws {
        let aside = app.deletingLastPathComponent().appendingPathComponent("AI Space Previous \(UUID().uuidString).app")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", AppReplacement.script, "ai-space-update", String(ProcessInfo.processInfo.processIdentifier), app.path, staged.path, aside.path, "/usr/bin/open"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        NSApp.terminate(nil)
    }
}
