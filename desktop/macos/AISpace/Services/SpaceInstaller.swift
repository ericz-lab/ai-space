import Foundation

/// Installing AI Space on this Mac from the desktop app's first launch
/// (docs/macos-desktop.md#connections-and-first-launch). The app carries no installer: it
/// downloads the release's own one-command installer (`release/get.sh`, published as
/// `install.sh`; docs/release.md#one-command-install) and runs it as the user would in Terminal.
/// After that the service is AI Space's own: the app never upgrades, stops or removes it.
struct SpaceInstaller {
    static let latest = "https://github.com/ericz-lab/ai-space/releases/latest/download"
    /// What the installer needs and a GUI app's bare `PATH` may lack: curl, tar, launchctl.
    static let systemPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]

    struct Command: Equatable {
        var executable: URL
        var arguments: [String]
        var environment: [String: String]
    }

    enum Outcome: Equatable {
        case installed
        /// The installer could not be fetched; nothing ran.
        case downloadFailed(String)
        /// The installer ran and ended with this exit code.
        case failed(Int32)
    }

    var environment: [String: String] = ProcessInfo.processInfo.environment
    var temporary: URL = FileManager.default.temporaryDirectory
    var download: (URL) async throws -> Data = SpaceInstaller.fetch
    /// Runs the command, hands over each line it prints, returns its exit code.
    var run: (Command, @escaping (String) -> Void) async throws -> Int32 = SpaceInstaller.execute

    /// Where the installer comes from: the latest release, or `<AI_SPACE_DOWNLOAD>/install.sh`
    /// for a mirror or a test, the variable the installer itself takes its archive from.
    static func scriptURL(environment: [String: String]) -> URL {
        var base = environment["AI_SPACE_DOWNLOAD"]?.trimmingCharacters(in: .whitespaces) ?? ""
        while base.hasSuffix("/") { base.removeLast() }
        if base.isEmpty { base = latest }
        return URL(string: base + "/install.sh") ?? URL(string: latest + "/install.sh")!
    }

    /// `/bin/bash <script>` in the app's environment, told not to open a browser (the app shows
    /// the Space itself), with the system's tools on `PATH` ahead of whatever else was there.
    static func command(script: URL, environment: [String: String]) -> Command {
        var env = environment
        env["AI_SPACE_NO_OPEN"] = "1"
        let inherited = (environment["PATH"] ?? "").split(separator: ":").map(String.init).filter { !systemPath.contains($0) }
        env["PATH"] = (systemPath + inherited).joined(separator: ":")
        if env["HOME"] == nil { env["HOME"] = NSHomeDirectory() }
        return Command(executable: URL(fileURLWithPath: "/bin/bash"), arguments: [script.path], environment: env)
    }

    /// The end of the output, for the failure screen: the installer says why on its last lines.
    static func tail(_ lines: [String], count: Int = 12) -> [String] {
        Array(lines.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.suffix(count))
    }

    /// Downloads the installer to a temporary file of its own, runs it and removes the file.
    func install(onLine: @escaping (String) -> Void) async -> Outcome {
        let source = Self.scriptURL(environment: environment)
        let data: Data
        do {
            data = try await download(source)
            if data.isEmpty { return .downloadFailed("\(source.absoluteString): empty file") }
        } catch {
            return .downloadFailed("\(source.absoluteString): \(error.localizedDescription)")
        }
        let folder = temporary.appendingPathComponent("ai-space-installer-\(UUID().uuidString)", isDirectory: true)
        let script = folder.appendingPathComponent("install.sh")
        defer { try? FileManager.default.removeItem(at: folder) }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try data.write(to: script, options: .atomic)
            let code = try await run(Self.command(script: script, environment: environment), onLine)
            return code == 0 ? .installed : .failed(code)
        } catch {
            onLine(error.localizedDescription)
            return .failed(-1)
        }
    }

    // MARK: The real download and process

    struct HTTPFailure: LocalizedError {
        let status: Int
        var errorDescription: String? { "HTTP \(status)" }
    }

    static func fetch(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 { throw HTTPFailure(status: http.statusCode) }
        return data
    }

    /// Standard output and error arrive as one stream of lines, in the order they were written.
    static func execute(_ command: Command, onLine: @escaping (String) -> Void) async throws -> Int32 {
        try await Task.detached(priority: .userInitiated) { try executeBlocking(command, onLine: onLine) }.value
    }

    private static func executeBlocking(_ command: Command, onLine: @escaping (String) -> Void) throws -> Int32 {
        let p = Process()
        p.executableURL = command.executable
        p.arguments = command.arguments
        p.environment = command.environment
        p.currentDirectoryURL = URL(fileURLWithPath: command.environment["HOME"] ?? NSHomeDirectory(), isDirectory: true)
        let pipe = Pipe()
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = pipe
        p.standardError = pipe
        try p.run()
        try? pipe.fileHandleForWriting.close()
        let drained = DispatchSemaphore(value: 0)
        let reader = Thread {
            var buffer = LineBuffer()
            while true {
                let chunk = pipe.fileHandleForReading.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk).forEach(onLine)
            }
            buffer.finish().forEach(onLine)
            drained.signal()
        }
        reader.start()
        p.waitUntilExit()
        // A process the installer left behind may still hold the pipe; do not wait on it for long.
        _ = drained.wait(timeout: .now() + 2)
        return p.terminationStatus
    }
}

/// Cuts a stream of bytes into lines as they complete.
struct LineBuffer {
    private var pending = Data()

    mutating func append(_ chunk: Data) -> [String] {
        pending.append(chunk)
        var lines: [String] = []
        while let end = pending.firstIndex(of: 0x0A) {
            lines.append(Self.text(pending[pending.startIndex..<end]))
            pending = Data(pending[pending.index(after: end)...])
        }
        return lines
    }

    /// What is left when the stream ends without a final newline.
    mutating func finish() -> [String] {
        defer { pending = Data() }
        return pending.isEmpty ? [] : [Self.text(pending)]
    }

    private static func text(_ bytes: Data) -> String {
        var s = String(decoding: bytes, as: UTF8.self)
        if s.hasSuffix("\r") { s.removeLast() }
        return s
    }
}

/// The one progress bar the first launch shows while AI Space is installed
/// (docs/editions.md#ai-space-client). The installer prints no percentages, so the bar moves by
/// the lines it prints at each step (the same in `release/get.sh` and `release/install.ps1`), and
/// creeps on within a step, slowing as it nears the step's ceiling, so a long download never
/// looks stuck. Each step starts above the ceiling of the one before: the bar only goes forward.
struct InstallProgress: Equatable {
    enum Stage: Int, Comparable, CaseIterable {
        /// The app fetches the installer itself.
        case fetching
        /// "ai-space: looking for the latest release …"
        case looking
        /// "ai-space: downloading ai-space-<version>-<os>-<arch>.tar.gz"
        case downloading
        /// "ai-space <version> (<commit>) in <dir>": the program is in place, the service starts.
        case placing
        /// "ai-space core: installed, answering …": the default apps are set up.
        case apps
        /// The installer ended well ("ai-space is running"); the app waits for the Space.
        case starting

        static func < (a: Stage, b: Stage) -> Bool { a.rawValue < b.rawValue }

        /// Where the bar starts in this step, the ceiling it creeps toward, and the step's usual length.
        var span: (from: Double, to: Double, seconds: Double) {
            switch self {
            case .fetching: return (0.00, 0.05, 4)
            case .looking: return (0.05, 0.10, 4)
            case .downloading: return (0.10, 0.55, 45)
            case .placing: return (0.60, 0.80, 20)
            case .apps: return (0.85, 0.95, 40)
            case .starting: return (0.95, 0.99, 8)
            }
        }
    }

    /// The step a line of the installer's output begins, if it begins one.
    static func stage(of line: String) -> Stage? {
        let l = line.trimmingCharacters(in: .whitespaces)
        if l.hasPrefix("ai-space: looking for") { return .looking }
        if l.hasPrefix("ai-space: downloading ") { return .downloading }
        if l.hasPrefix("ai-space core: installed") { return .apps }
        if l.hasPrefix("ai-space is running") { return .starting }
        if l.range(of: #"^ai-space \S+ \(\S+\) in "#, options: .regularExpression) != nil { return .placing }
        return nil
    }

    private(set) var stage: Stage = .fetching
    private(set) var since: Date

    init(at start: Date = Date()) { since = start }

    /// Moves to `next` when it is a later step; an earlier or the same one changes nothing.
    mutating func enter(_ next: Stage, at time: Date = Date()) {
        guard next > stage else { return }
        stage = next
        since = time
    }

    mutating func read(_ line: String, at time: Date = Date()) {
        if let next = Self.stage(of: line) { enter(next, at: time) }
    }

    /// The bar's value, 0 to 1 (1 only once the Space answers, which is not a step here).
    func value(at time: Date = Date()) -> Double {
        let s = stage.span
        let elapsed = max(0, time.timeIntervalSince(since))
        return s.from + (s.to - s.from) * (1 - exp(-elapsed / s.seconds))
    }
}
