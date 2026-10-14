import Foundation

/// A machine a shell can open on: the Space itself, or one of its peers (docs/terminal.md).
struct TerminalMachine: Decodable, Identifiable, Equatable {
    var name: String
    /// Set for a peer; its routes are under `/api/peers/<peer>/terminal`.
    var peer: String?
    /// Whether that machine offers a terminal at all.
    var enabled: Bool
    var health: String

    var id: String { peer ?? "" }
    var isDown: Bool { health != "ok" }
    var canOpen: Bool { enabled && !isDown }

    init(name: String, peer: String? = nil, enabled: Bool = true, health: String = "ok") {
        self.name = name
        self.peer = peer
        self.enabled = enabled
        self.health = health
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        peer = try c.decodeIfPresent(String.self, forKey: .peer)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        health = (try? c.decode(String.self, forKey: .health)) ?? "ok"
    }

    private enum CodingKeys: String, CodingKey { case name, peer, enabled, health }
}

/// One row of the Space's audit trail: a session that ran or still runs. Times are epoch milliseconds.
struct TerminalRecent: Decodable, Identifiable, Equatable {
    var id: String
    var startedAt: Double
    var endedAt: Double?
    var exitCode: Int?
    /// Why it ended: exit, closed (the client left), idle, killed, lost (ai-space restarted).
    var reason: String?
    var bytesIn: Int
    var bytesOut: Int

    var isOpen: Bool { endedAt == nil }
    var started: Date { Date(timeIntervalSince1970: startedAt / 1000) }
    var duration: TimeInterval? { endedAt.map { max($0 - startedAt, 0) / 1000 } }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        startedAt = (try? c.decode(Double.self, forKey: .startedAt)) ?? 0
        endedAt = try? c.decode(Double.self, forKey: .endedAt)
        exitCode = try? c.decode(Int.self, forKey: .exitCode)
        reason = try? c.decode(String.self, forKey: .reason)
        bytesIn = (try? c.decode(Int.self, forKey: .bytesIn)) ?? 0
        bytesOut = (try? c.decode(Int.self, forKey: .bytesOut)) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case id, startedAt, endedAt, exitCode, reason, bytesIn, bytesOut }
}

/// `GET /api/terminal`: whether this Space offers a shell, where one can open, and what ran.
struct TerminalStatus: Decodable, Equatable {
    var enabled: Bool
    var shell: String
    /// A passphrase is asked for before the first session on the Space's own machine.
    var passphrase: Bool
    var idleMs: Double
    var maxSessions: Int
    var machines: [TerminalMachine]
    var recent: [TerminalRecent]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        shell = (try? c.decode(String.self, forKey: .shell)) ?? ""
        passphrase = (try? c.decode(Bool.self, forKey: .passphrase)) ?? false
        idleMs = (try? c.decode(Double.self, forKey: .idleMs)) ?? 0
        maxSessions = (try? c.decode(Int.self, forKey: .maxSessions)) ?? 0
        machines = (try? c.decode([TerminalMachine].self, forKey: .machines)) ?? []
        recent = (try? c.decode([TerminalRecent].self, forKey: .recent)) ?? []
    }

    private enum CodingKeys: String, CodingKey { case enabled, shell, passphrase, idleMs, maxSessions, machines, recent }
}

/// The terminal's routes and frames, as the panel's page uses them (src/web/Terminal.tsx).
enum TerminalRoute {
    static let status = "/api/terminal"
    static let passphraseHeader = "x-terminal-passphrase"

    static func base(_ machine: TerminalMachine) -> String {
        guard let peer = machine.peer else { return "/api/terminal" }
        return "/api/peers/\(peer.addingPercentEncoding(withAllowedCharacters: segment) ?? peer)/terminal"
    }

    static func sessions(_ machine: TerminalMachine) -> String { base(machine) + "/sessions" }

    /// The session's socket: the Space's own address with the scheme a socket takes, and the one-time ticket.
    static func socket(_ machine: TerminalMachine, ticket: String, space: URL) -> URL? {
        guard var c = URLComponents(url: space, resolvingAgainstBaseURL: true) else { return nil }
        c.scheme = c.scheme?.lowercased() == "http" ? "ws" : "wss"
        // Already encoded: a peer's name is a segment of it.
        c.percentEncodedPath = base(machine) + "/ws"
        c.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        c.fragment = nil
        return c.url
    }

    /// The text frame that tells the shell its window.
    static func resize(cols: Int, rows: Int) -> String {
        "{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}"
    }

    /// As encodeURIComponent leaves a path segment.
    private static let segment = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
}

/// What the Space answered to the request that opens a session.
enum TerminalTicket: Equatable {
    case ticket(String)
    /// The machine wants its passphrase, or the one given was wrong; the Space's own words.
    case passphrase(String)
    /// The access layer wants a sign-in.
    case signIn
    case refused(String)

    static func read(status: Int, data: Data) -> TerminalTicket {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let message = body?["error"] as? String
        switch status {
        case 200..<300:
            if let ticket = body?["ticket"] as? String, !ticket.isEmpty { return .ticket(ticket) }
            return .refused(message ?? "no ticket")
        // The terminal's own 401 names the passphrase; any other is the access layer's.
        case 401 where message?.hasPrefix("passphrase") == true: return .passphrase(message ?? "")
        case 300..<400, 401: return .signIn
        case 403 where message == nil: return .signIn
        default: return .refused(message ?? "HTTP \(status)")
        }
    }
}

/// A control message on the session's socket: a JSON text frame from the Space.
enum TerminalControl: Equatable {
    case ready
    /// The shell ended; no code when a signal ended it. `detail` is why it could not start.
    case exit(code: Int?, detail: String?)
    case error(String)
    /// The Space is closing the session: idle, killed or shutdown.
    case closed(reason: String)

    static func read(_ text: String) -> TerminalControl? {
        guard let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
        switch o["type"] as? String {
        case "ready": return .ready
        case "exit": return .exit(code: o["code"] as? Int, detail: (o["detail"] as? String).flatMap { $0.isEmpty ? nil : $0 })
        case "error": return (o["error"] as? String).map { .error($0) }
        case "closed": return .closed(reason: o["reason"] as? String ?? "")
        default: return nil
        }
    }
}

/// Lines the client writes into the terminal itself, as the panel's page does: dim for what
/// happened to the session, red for what went wrong.
enum TerminalNotice {
    static func dim(_ text: String) -> String { "\r\n\u{1B}[2m[\(text)]\u{1B}[0m\r\n" }
    static func red(_ text: String) -> String { "\r\n\u{1B}[31m\(text)\u{1B}[0m\r\n" }

    /// The reasons the Space names before it closes a socket; any other close reason is shown as it came.
    static let knownReasons: Set<String> = ["idle", "killed", "shutdown", "exit"]
}
