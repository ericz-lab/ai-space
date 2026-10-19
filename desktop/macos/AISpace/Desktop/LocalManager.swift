import AppKit
import Foundation
import Security

/// The Local edition's side of the app (docs/local.md): it reads where this Mac stands, installs
/// or upgrades the service from the app bundle, starts, stops and removes the background service,
/// and keeps the app signed in to it with its device credential. Every change goes through
/// `space local` with the bundled Bun; the service process belongs to launchd, so quitting the
/// app leaves it running.
@MainActor
final class LocalManager: ObservableObject {
    let bundle: LocalBundle?
    @Published private(set) var status: LocalStatus?
    @Published private(set) var busy: String?
    @Published var failure: LocalFailure?
    /// Set once the managed Space answers without a default model: the first run asks for one.
    @Published var needsModelChoice = false
    /// Agent CLIs the user pointed the app at, by name (`claude`, `codex`, `dsh`), when the search misses them.
    @Published private(set) var chosenRuntimes: [String: String] = LocalManager.loadChosenRuntimes()
    @Published private(set) var checkingRuntime: String?
    @Published private(set) var lastApps: [LocalInstallResult.App] = []
    /// The work an automatic update is waiting for; nil when it is not waiting.
    @Published private(set) var updateWaitingFor: SpaceActivity?
    private var retry: Task<Void, Never>?

    init(bundle: LocalBundle? = LocalBundle.find()) {
        self.bundle = bundle
    }

    var available: Bool { bundle != nil }

    // MARK: Commands

    private func run<T: Decodable>(_ type: T.Type, _ args: [String]) async throws -> T {
        guard let bundle else { throw LocalFailure(code: "no-bundle", error: "this app does not carry the Local edition") }
        let data = try await Task.detached(priority: .userInitiated) { () throws -> Data in
            let p = Process()
            p.executableURL = bundle.bun
            p.arguments = [bundle.entry.path, "local"] + args + ["--json"]
            p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            // A GUI app's environment is not a terminal's: give the command a plain, known one.
            var env = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
            if let user = ProcessInfo.processInfo.environment["USER"] { env["USER"] = user }
            p.environment = env
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            try p.run()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return data
        }.value
        return try LocalOutput.decode(T.self, from: data)
    }

    private func perform(_ what: String, _ work: () async throws -> Void) async {
        guard busy == nil else { return }
        busy = what
        failure = nil
        defer { busy = nil }
        do { try await work() } catch let f as LocalFailure {
            failure = f
            if let s = f.status { status = s }
        } catch {
            failure = LocalFailure(code: "error", error: error.localizedDescription)
        }
    }

    // MARK: Agent CLIs

    private static let chosenKey = "local.chosenRuntimes"

    private static func loadChosenRuntimes() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: chosenKey) as? [String: String] ?? [:]
    }

    /// `--claude <path> --codex <path> --dsh <path>`: what the user chose, for every `space local` command.
    private var runtimeArgs: [String] {
        ["claude", "codex", "dsh"].flatMap { name in chosenRuntimes[name].map { ["--\(name)", $0] } ?? [] }
    }

    /// Lets the user pick the CLI's program file when it is installed where the search does not look.
    func chooseRuntime(_ name: String) async {
        guard checkingRuntime == nil else { return }
        let panel = NSOpenPanel()
        panel.title = String(localized: "Choose the \(name) program")
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = true
        panel.showsHiddenFiles = true
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        guard panel.runModal() == .OK, let url = panel.url else { return }
        checkingRuntime = name
        defer { checkingRuntime = nil }
        chosenRuntimes[name] = url.path
        UserDefaults.standard.set(chosenRuntimes, forKey: Self.chosenKey)
        await refresh()
    }

    func forgetRuntimeChoice(_ name: String) async {
        chosenRuntimes[name] = nil
        UserDefaults.standard.set(chosenRuntimes, forKey: Self.chosenKey)
        await refresh()
    }

    func refresh() async {
        guard available else { return }
        do { status = try await run(LocalStatus.self, ["status"] + runtimeArgs) } catch let f as LocalFailure { failure = f } catch {
            failure = LocalFailure(code: "error", error: error.localizedDescription)
        }
    }

    /// What an upgrade does while the Space has work in progress (`space local install`).
    enum WhenBusy { case refuse, wait, now }

    /// Install or upgrade, then make sure the app has its Space saved and is signed in to it. An
    /// upgrade while the Space is busy is refused with the work (`failure.activity`), waits for
    /// it (`.wait`, up to 30 minutes), or drains it now (`.now`).
    func install(migrate: Bool = false, whenBusy: WhenBusy = .refuse, defaultModel: String? = nil, into model: AppModel) async {
        guard busy == nil else { return }
        retry?.cancel()
        retry = nil
        updateWaitingFor = nil
        let label = migrate ? "Migrating…" : whenBusy == .wait ? "Waiting for the work in progress, then updating…" : (status?.state == .managed ? "Updating…" : "Setting up…")
        await perform(label) {
            let current = try await run(LocalStatus.self, ["status"] + runtimeArgs)
            status = current
            let needsDevice = current.needsDeviceCredential(hasStoredToken: DeviceKeychain.token(for: workspaceKey) != nil)
            var args = ["install"]
            if migrate { args.append("--migrate") }
            switch whenBusy {
            case .refuse: break
            case .wait: args.append("--wait")
            case .now: args.append("--now")
            }
            if needsDevice { args += ["--device", Host.current().localizedName ?? "This Mac"] }
            args += runtimeArgs
            if let defaultModel { args += ["--default-model", defaultModel] }
            let result = try await run(LocalInstallResult.self, args)
            if let device = result.device {
                DeviceKeychain.save(device.token, for: result.workspace)
                lastSignIn = nil
            }
            lastApps = result.apps
            status = try await run(LocalStatus.self, ["status"] + runtimeArgs)
            guard let url = URL(string: result.url) else { return }
            model.adoptLocal(url: url)
        }
    }

    /// The app carries a newer release than the one installed (it was replaced, or updated
    /// itself): update the service without asking, once the Space has no work in progress. While
    /// it has, try again every two minutes. A service the user stopped is left as it is.
    func autoUpdate(into model: AppModel) async {
        retry?.cancel()
        retry = nil
        guard let s = status, s.updateAvailable, s.installed != nil, !s.service.disabled, busy == nil else {
            updateWaitingFor = nil
            return
        }
        await install(into: model)
        if let f = failure, f.code == "busy" {
            failure = nil
            updateWaitingFor = f.activity
            retry = Task { [weak self, weak model] in
                try? await Task.sleep(for: .seconds(120))
                guard !Task.isCancelled, let self, let model else { return }
                await self.refresh()
                await self.autoUpdate(into: model)
            }
        } else {
            updateWaitingFor = nil
        }
    }

    func start() async { await lifecycle("Starting…", "start") }
    func stop() async { await lifecycle("Stopping…", "stop") }
    func restart() async { await lifecycle("Restarting…", "restart") }

    /// Before deleting the app: stops and unregisters the background service. The workspace stays.
    func removeService(model: AppModel) async {
        await lifecycle("Removing…", "remove-service")
        if failure == nil, let c = model.store.managedConnection { model.store.setManaged(c.id, url: c.url, managed: false) }
    }

    private func lifecycle(_ what: String, _ verb: String) async {
        retry?.cancel()
        retry = nil
        updateWaitingFor = nil
        await perform(what) { status = try await run(LocalStatus.self, [verb] + runtimeArgs) }
    }

    // MARK: Signing in

    /// The workspace the device token belongs to: the status's, else the default.
    private var workspaceKey: String {
        status?.workspace.path ?? (NSHomeDirectory() as NSString).appendingPathComponent(".ai-space")
    }

    private var lastSignIn: Date?

    /// Exchanges the device credential for a session cookie in the Space's web data, so the native
    /// views and the pages are signed in. At most once every 20 seconds, so a refusal cannot loop.
    @discardableResult
    func signIn(_ connection: Connection, cookies: WebCookieSession) async -> Bool {
        guard connection.managed, let token = DeviceKeychain.token(for: workspaceKey) else { return false }
        if let last = lastSignIn, Date().timeIntervalSince(last) < 20 { return false }
        lastSignIn = Date()
        do {
            let (_, response) = try await URLSession.shared.data(for: DeviceSession.request(base: connection.url, token: token))
            guard let http = response as? HTTPURLResponse else { return false }
            if http.statusCode == 401 {
                // Revoked, or a workspace that never knew it: Repair (install) makes a new one.
                DeviceKeychain.delete(for: workspaceKey)
                failure = LocalFailure(code: "device", error: "This Mac's sign-in to its Space is no longer valid. Use Repair to make a new one.")
                return false
            }
            guard http.statusCode == 200 else { return false }
            for cookie in DeviceSession.cookies(from: http, base: connection.url) {
                await cookies.dataStore.httpCookieStore.setCookie(cookie)
            }
            return true
        } catch {
            return false
        }
    }

    /// Whether the Space's web data already holds a session cookie for it.
    static func hasSession(_ cookies: [HTTPCookie], for url: URL) -> Bool {
        cookies.contains { $0.name == "space_session" && ($0.domain == url.host || $0.domain == "." + (url.host ?? "")) && ($0.expiresDate.map { $0 > Date() } ?? true) }
    }

    func openLog() {
        guard let status else { return }
        let log = URL(fileURLWithPath: status.workspace.path).appendingPathComponent("logs/space.log")
        NSWorkspace.shared.open(log)
    }
}

/// The device credential, in the login keychain, by workspace path (docs/local.md#signing-in).
enum DeviceKeychain {
    static let service = "dev.ai-space.local.device"

    static func token(for workspace: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: workspace,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(for workspace: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: workspace]
        SecItemDelete(query as CFDictionary)
    }

    static func save(_ token: String, for workspace: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: workspace,
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        add[kSecAttrLabel as String] = "AI Space on this Mac"
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { NSLog("ai-space: could not keep the device credential: %d", status) }
    }
}
