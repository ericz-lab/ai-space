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
