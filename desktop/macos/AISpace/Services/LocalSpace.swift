import Foundation

/// Finding an AI Space that already runs on this Mac (docs/macos-desktop.md#connections-and-first-launch).
/// The desktop app looks once at first launch, when no Space is saved: it asks the ports a
/// standard installation uses who answers there, and saves the one that says it is ai-space.
/// It only reads; nothing here starts, stops or changes a service.
enum LocalSpaceRules {
    /// The default `SPACE_PORT` in src/space/config.ts.
    static let defaultPort = 8700
    /// The name a Space on this Mac is saved under, as the Local edition's is (AppModel.adoptLocal).
    static let name = "This Mac"

    /// The workspace's `.env`: `$SPACE_HOME/.env`, else `~/.ai-space/.env`.
    static func envFile(environment: [String: String], home: URL) -> URL {
        let custom = environment["SPACE_HOME"]?.trimmingCharacters(in: .whitespaces) ?? ""
        let workspace = custom.isEmpty
            ? home.appendingPathComponent(".ai-space", isDirectory: true)
            : URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        return workspace.appendingPathComponent(".env")
    }

    /// `SPACE_PORT` as a `.env` file's text sets it, or nil. The last assignment counts, as it
    /// does for the service that loads the file; quotes, `export` and a trailing comment are allowed.
    static func port(fromEnv text: String) -> Int? {
        var found: Int?
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
            guard line.hasPrefix("SPACE_PORT") else { continue }
            let rest = line.dropFirst("SPACE_PORT".count).trimmingCharacters(in: .whitespaces)
            guard rest.hasPrefix("=") else { continue }
            var value = rest.dropFirst().trimmingCharacters(in: .whitespaces)
            if let quote = value.first, quote == "\"" || quote == "'" {
                value = String(value.dropFirst().prefix { $0 != quote })
            } else if let comment = value.firstIndex(of: "#") {
                value = value[..<comment].trimmingCharacters(in: .whitespaces)
            }
            if let port = Int(value), (1...65535).contains(port) { found = port }
        }
        return found
    }

    /// The ports to ask, in order: the workspace's own `SPACE_PORT` when its `.env` can be read, then the default.
    static func candidatePorts(envText: String?) -> [Int] {
        var ports: [Int] = []
        if let text = envText, let port = port(fromEnv: text) { ports.append(port) }
        if !ports.contains(defaultPort) { ports.append(defaultPort) }
        return ports
    }

    /// The panel address of a Space on this Mac's loopback.
    static func url(port: Int) -> URL { URL(string: "http://127.0.0.1:\(port)/")! }

    static func identityRequest(port: Int, timeout: TimeInterval = 2) -> URLRequest {
        var r = URLRequest(url: url(port: port).appendingPathComponent(String(SpaceCheck.identityPath.dropFirst())))
        r.timeoutInterval = timeout
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }
}

/// Asks the candidate ports and says which Space, if any, is on this Mac.
struct LocalSpaceProbe {
    /// The text of the workspace's `.env`, or nil when it cannot be read.
    var envText: () -> String?
    /// The answer to a request: its status and body, or nil when nothing answered in time.
    var fetch: (URLRequest) async -> (status: Int, body: Data)?
    var sleep: (TimeInterval) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }

    /// The first candidate port that answers as ai-space; a reachable port alone is not one.
    func find() async -> URL? {
        for port in LocalSpaceRules.candidatePorts(envText: envText()) {
            if let answer = await fetch(LocalSpaceRules.identityRequest(port: port)),
               SpaceCheck.isSpace(status: answer.status, body: answer.body) {
                return LocalSpaceRules.url(port: port)
            }
        }
        return nil
    }

    /// After an install: the service needs a moment to come up, so look again until it answers.
    func wait(attempts: Int = 30, interval: TimeInterval = 1) async -> URL? {
        for attempt in 0..<max(1, attempts) {
            if let url = await find() { return url }
            if attempt + 1 < attempts { await sleep(interval) }
        }
        return nil
    }
}

extension LocalSpaceProbe {
    /// The probe the app uses: this user's workspace and a 2-second request that goes straight
    /// to the loopback, past any system proxy.
    static func live(environment: [String: String] = ProcessInfo.processInfo.environment,
                     home: URL = FileManager.default.homeDirectoryForCurrentUser) -> LocalSpaceProbe {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2
        config.timeoutIntervalForResource = 4
        config.connectionProxyDictionary = [:]
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        return LocalSpaceProbe(
            envText: { try? String(contentsOf: LocalSpaceRules.envFile(environment: environment, home: home), encoding: .utf8) },
            fetch: { request in
                guard let (data, response) = try? await session.data(for: request),
                      let http = response as? HTTPURLResponse
                else { return nil }
                return (http.statusCode, data)
            }
        )
    }
}
