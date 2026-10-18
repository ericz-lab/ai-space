import Foundation

struct SSEMessage: Equatable {
    var id: Int?
    var data: String
}

/// Reads the lines of a server-sent event stream as src/space/agents/runtime.ts writes them:
/// an optional `id: <seq>` line, then one `data:` line per event; `:` lines are keep-alives.
struct SSEParser {
    private var id: Int?

    mutating func feed(_ line: String) -> SSEMessage? {
        if line.isEmpty {
            id = nil
            return nil
        }
        if line.hasPrefix(":") { return nil }
        let (field, value) = Self.split(line)
        switch field {
        case "id":
            id = Int(value)
            return nil
        case "data":
            defer { id = nil }
            return SSEMessage(id: id, data: value)
        default:
            return nil
        }
    }

    private static func split(_ line: String) -> (String, String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        var value = line[line.index(after: colon)...]
        if value.first == " " { value = value.dropFirst() }
        return (String(line[..<colon]), String(value))
    }
}

/// The Web panel's three write-access choices (src/web/Chat.tsx).
enum ChatPermission: String, CaseIterable, Identifiable {
    case readOnly = ""
    case editFiles = "acceptEdits"
    case all = "bypassPermissions"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .readOnly: return String(localized: "Read-only")
        case .editFiles: return String(localized: "Edit files")
        case .all: return String(localized: "All permissions")
        }
    }

    /// A shell refusal needs all permissions; an edit first tries acceptEdits.
    func granting(_ denied: [String]) -> ChatPermission {
        denied.contains("Bash") || self != .readOnly ? .all : .editFiles
    }
}

/// Capture the controls at send time, as queuedChatTurn does in the Web client.
struct ChatTurnRequest: Equatable {
    var message: String
    var permission: ChatPermission

    func body(sessionID: String?) -> [String: Any] {
        var body: [String: Any] = ["message": message]
        if permission != .readOnly { body["permissionMode"] = permission.rawValue }
        if let sessionID { body["sessionId"] = sessionID }
        return body
    }
}

/// What a chat turn shows while it runs.
enum ChatActivity: Equatable {
    case starting
    case reconnecting
    case thinking(model: String)
    case running(tool: String)
}

/// One chat turn's reply, built from the run's events the way the panel's Chat.tsx reads them:
/// Claude-style stream-json, which every runtime adapter emits, followed by `error` and `done`.
struct ChatReply: Equatable {
    var sessionID: String?
    var finishedText = ""
    var streaming = ""
    var tools: [String] = []
    var activity: ChatActivity? = .starting
    var note: String?
    /// The run's own error as the Space reported it, apart from the reply text, so a client can
    /// show it as a failure of the turn rather than as words of the agent.
    var failure: String?
    var stopped = false
    var finished = false
    var denied: [String] = []
    private var seenTools: Set<String> = []
    private var toolNames: [String: String] = [:]

    /// What the agent wrote, without any note.
    var body: String {
        finishedText + (streaming.isEmpty ? "" : (finishedText.isEmpty ? "" : "\n\n") + streaming)
    }

    var text: String {
        guard let note else { return body }
        return body.isEmpty ? note : body + "\n\n" + note
    }

    mutating func apply(_ line: String) {
        guard let data = line.data(using: .utf8),
              let ev = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = ev["type"] as? String
        else { return }
        switch type {
        case "system" where ev["subtype"] as? String == "init":
            sessionID = ev["session_id"] as? String ?? sessionID
            activity = .thinking(model: ev["model"] as? String ?? "")
        case "stream_event":
            let event = ev["event"] as? [String: Any]
            let delta = event?["delta"] as? [String: Any]
            if delta?["type"] as? String == "text_delta", let t = delta?["text"] as? String {
                streaming += t
                activity = nil
            }
        case "assistant":
            let blocks = (ev["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            let text = blocks.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined()
            if !text.isEmpty {
                finishedText += (finishedText.isEmpty ? "" : "\n\n") + text
                streaming = ""
                activity = nil
            }
            for b in blocks where b["type"] as? String == "tool_use" {
                guard let id = b["id"] as? String, !seenTools.contains(id) else { continue }
                seenTools.insert(id)
                let name = b["name"] as? String ?? "tool"
                toolNames[id] = name
                tools.append(name)
                activity = .running(tool: name)
            }
        case "user":
            let blocks = (ev["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in blocks where block["type"] as? String == "tool_result" && block["is_error"] as? Bool == true {
                let text = (block["content"] as? String) ?? (block["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: " ")
                guard text.range(of: "requires approval|permission|granted|denied", options: [.regularExpression, .caseInsensitive]) != nil else { continue }
                let tool = toolNames[block["tool_use_id"] as? String ?? ""] ?? "tool"
                if !denied.contains(tool) { denied.append(tool) }
            }
        case "result":
            sessionID = ev["session_id"] as? String ?? sessionID
            if ev["is_error"] as? Bool == true && finishedText.isEmpty && streaming.isEmpty {
                note = String(describing: ev["result"] ?? ev["subtype"] ?? "error")
            }
        case "error":
            if ev["status"] as? String == "stopped" {
                stopped = true
            } else {
                let error = String(describing: ev["error"] ?? "error")
                failure = error
                note = "⚠️ " + error
            }
        case "done":
            finished = true
            activity = nil
        default:
            break
        }
    }
}

/// A failed chat turn told in words a person can act on. The Space hands on what the runtime
/// said, which may be a status line from the model service ("429 Too Many Requests") or, when the
/// runtime said nothing, only its exit code ("runtime exited with 1"); the raw text stays as the
/// detail.
struct ChatFailure: Equatable {
    enum Kind: Equatable {
        /// The model service turned the request down for now: rate or usage limit, overload.
        case busy
        /// The runtime on the Space is not signed in to its model service.
        case signedOut
        case timedOut
        /// The runtime stopped with this exit code and said nothing more.
        case exited(Int32)
        /// The runtime could not be started at all.
        case unavailable
        /// The stream from the Space broke before the run said how it ended.
        case connection
        case other
    }

    var kind: Kind
    var detail: String

    init(kind: Kind, detail: String) {
        self.kind = kind
        self.detail = detail
    }

    init(_ raw: String) {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        self.detail = detail
        let text = detail.lowercased()
        func has(_ words: String...) -> Bool { words.contains { text.contains($0) } }
        if has("429", "too many requests", "rate limit", "rate_limit", "usage limit", "quota", "overloaded", "529", "capacity") {
            kind = .busy
        } else if has("not logged in", "log in", "login", "please run /login", "unauthorized", "401", "invalid api key", "authentication") {
            kind = .signedOut
        } else if has("timed out", "timeout") {
            kind = .timedOut
        } else if let code = Self.exitCode(text) {
            kind = .exited(code)
        } else if has("could not run", "not found", "enoent", "no such file") {
            kind = .unavailable
        } else {
            kind = .other
        }
    }

    /// Whether sending the same message again may well work: the cause passes by itself.
    var retryable: Bool {
        switch kind {
        case .busy, .timedOut, .exited, .connection, .other: return true
        case .signedOut, .unavailable: return false
        }
    }

    /// The code of a bare `runtime exited with N`, the Space's words when the runtime said nothing.
    private static func exitCode(_ text: String) -> Int32? {
        guard let range = text.range(of: "exited with ") else { return nil }
        let digits = text[range.upperBound...].prefix { $0.isNumber || $0 == "-" }
        return Int32(digits)
    }
}
