import Foundation

/// The Local edition's service on this Mac, as `space local <verb> --json` reports it
/// (src/space/local.ts, docs/local.md). The app carries the service in `Resources/space` and
/// runs these commands with the Bun inside it; it never starts the service process itself.

/// The release inside the app bundle, when this build is the Local edition.
struct LocalBundle: Equatable {
    let root: URL
    let version: String
    let commit: String

    var bun: URL { root.appendingPathComponent("runtime/bun") }
    var entry: URL { root.appendingPathComponent("src/index.ts") }

    /// Reads `<resources>/space/RELEASE.json`; nil for the Client edition, which has none.
    static func find(resources: URL? = Bundle.main.resourceURL) -> LocalBundle? {
        guard let root = resources?.appendingPathComponent("space", isDirectory: true),
              let data = try? Data(contentsOf: root.appendingPathComponent("RELEASE.json")),
              let info = try? JSONDecoder().decode(Release.self, from: data),
              info.product == "ai-space", info.edition == "local"
        else { return nil }
        return LocalBundle(root: root, version: info.version, commit: info.commit)
    }
}

struct Release: Codable, Equatable {
    var product: String?
    var edition: String
    var version: String
    var commit: String
}

/// `space local status --json`.
struct LocalStatus: Codable, Equatable {
    enum State: String, Codable { case absent, managed, foreign }

    struct Workspace: Codable, Equatable {
        var path: String
        var exists: Bool
        var locked: Bool?
    }

    struct Identity: Codable, Equatable {
        var version: String
        var edition: String
        var installation: String?
    }

    struct Service: Codable, Equatable {
        var label: String
        var plist: Bool
        var loaded: Bool
        var running: Bool
        var disabled: Bool
        var pid: Int
        var detail: String
    }

    struct Runtimes: Codable, Equatable {
        var claude: String?
        var codex: String?

        var any: Bool { claude != nil || codex != nil }
    }

    var state: State
    var reason: String?
    var bundle: Release?
    var installed: Release?
    var workspace: Workspace
    var port: Int
    var url: String
    var running: Identity?
    var service: Service
    var runtimes: Runtimes

    /// Only a newer version is offered automatically; Repair can reinstall a development build.
    var updateAvailable: Bool {
        guard state == .managed, let bundle, let installed else { return false }
        return AppUpdateFeed.newer(bundle.version, than: installed.version)
    }

    /// Whether the running service is the one this app installed.
    var ownServiceRunning: Bool { running?.installation == "managed" && running?.edition == "local" }
}

/// `space local install --json`.
struct LocalInstallResult: Codable, Equatable {
    struct Device: Codable, Equatable {
        var id: Int
        var name: String
        var token: String
    }

    struct App: Codable, Equatable {
        var file: String
        var app: String?
        var version: String?
        var status: String
        var detail: String?
    }

    var version: String
    var url: String
    var workspace: String
    var migrated: Bool
    var upgraded: Bool
    var device: Device?
    var apps: [App]
}

/// What the running Space is doing (`GET /api/space/activity`): an update waits for it.
struct SpaceActivity: Codable, Equatable {
    struct Item: Codable, Equatable {
        var kind: String
        var label: String
        var since: Double?
    }

    var busy: Bool
    var items: [Item]

    var summary: String { items.map(\.label).joined(separator: ", ") }
}

/// A refusal from `space local`: `{ ok: false, code, error, status, activity? }`.
struct LocalFailure: Codable, Error, Equatable, LocalizedError {
    var code: String
    var error: String
    var status: LocalStatus?

    init(code: String, error: String, status: LocalStatus? = nil, activity: SpaceActivity? = nil) {
        self.code = code
        self.error = error
        self.status = status
        self.activity = activity
    }
    /// For `busy`: the work an upgrade would cut off.
    var activity: SpaceActivity?

    var errorDescription: String? { error }
}

enum LocalOutput {
    private struct Envelope: Decodable { var ok: Bool }

    /// Decodes a command's JSON: the value on `ok: true`, the refusal on `ok: false`.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else {
            let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            throw LocalFailure(code: "output", error: text.isEmpty ? "space local printed nothing" : String(text.suffix(400)))
        }
        if !envelope.ok { throw try decoder.decode(LocalFailure.self, from: data) }
        return try decoder.decode(T.self, from: data)
    }
}

/// The cookie a device credential is exchanged for: `POST /api/auth/device/session`.
enum DeviceSession {
    static let path = "/api/auth/device/session"

    static func request(base: URL, token: String) -> URLRequest {
        var r = URLRequest(url: base.appendingPathComponent(String(path.dropFirst())))
        r.httpMethod = "POST"
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        r.timeoutInterval = 10
        return r
    }

    /// The session cookies a successful answer sets.
    static func cookies(from response: HTTPURLResponse, base: URL) -> [HTTPCookie] {
        let fields = response.allHeaderFields.reduce(into: [String: String]()) { out, kv in
            if let k = kv.key as? String, let v = kv.value as? String { out[k] = v }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: fields, for: base)
    }
}
