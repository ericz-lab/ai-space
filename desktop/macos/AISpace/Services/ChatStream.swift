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
    var stopped = false
    var finished = false
    private var seenTools: Set<String> = []

    var text: String {
        let body = finishedText + (streaming.isEmpty ? "" : (finishedText.isEmpty ? "" : "\n\n") + streaming)
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
                tools.append(name)
                activity = .running(tool: name)
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
                note = "⚠️ " + String(describing: ev["error"] ?? "error")
            }
        case "done":
            finished = true
            activity = nil
        default:
            break
        }
    }
}
