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

/// The Web panel's three write-access choices (src/web/Chat.tsx). On a live turn (docs/runtimes.md#live-chat)
/// the read-only choice asks before an edit or a command instead of refusing it.
enum ChatPermission: String, CaseIterable, Identifiable {
    case readOnly = ""
    case editFiles = "acceptEdits"
    case all = "bypassPermissions"

    var id: String { rawValue }
    var label: String {
        switch self {
        case .readOnly: return String(localized: "Ask before changes")
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
    var images: [ChatImage] = []

    func body(sessionID: String?) -> [String: Any] {
        // Every turn is interactive: the conversation's live process can ask for an approval and
        // take messages while it runs (docs/runtimes.md#live-chat). A runtime without live chat
        // ignores the flag and runs the turn as before.
        var body: [String: Any] = ["message": message, "interactive": true]
        if !images.isEmpty { body["images"] = images.map(\.body) }
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

/// Where a turn's reply belongs in a thread. A turn that waited in the queue is answered right
/// after the message that asked for it, not at the end: with two messages waiting, appending would
/// separate each message from its reply.
enum ChatThread {
    /// The index after `message` in a thread of message ids; nil when the message is gone.
    static func replyIndex(after message: UUID, in ids: [UUID]) -> Int? {
        ids.firstIndex(of: message).map { $0 + 1 }
    }
}

/// A question the agent asks while its turn runs: an `approval_request` with `questions`
/// (src/space/runtimes/types.ts `AgentQuestion`). The person picks options or types an answer.
struct ChatQuestion: Decodable, Equatable, Identifiable {
    struct Option: Decodable, Equatable {
        var label: String
        var description: String = ""

        init(label: String, description: String = "") {
            self.label = label
            self.description = description
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        }

        private enum CodingKeys: String, CodingKey { case label, description }
    }

    var id: String
    var header: String = ""
    var question: String
    var options: [Option] = []
    var multiSelect = false

    init(id: String, header: String = "", question: String, options: [Option] = [], multiSelect: Bool = false) {
        self.id = id
        self.header = header
        self.question = question
        self.options = options
        self.multiSelect = multiSelect
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        header = try c.decodeIfPresent(String.self, forKey: .header) ?? ""
        question = try c.decodeIfPresent(String.self, forKey: .question) ?? ""
        options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
        multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
    }

    private enum CodingKeys: String, CodingKey { case id, header, question, options, multiSelect }

    /// The questions of an `approval_request` event; empty for an ordinary approval.
    static func list(_ raw: Any?) -> [ChatQuestion] {
        guard let raw, JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return [] }
        return (try? JSONDecoder().decode([ChatQuestion].self, from: data)) ?? []
    }

    /// What goes back for this question (QuestionStep `answerOf` in src/web/Chat.tsx): a single
    /// choice is the typed answer when there is one, else the picked option; a multiple choice is
    /// every picked option and the typed answer after them.
    func answer(picked: [String], typed: String) -> [String] {
        let own = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !multiSelect { return own.isEmpty ? Array(picked.prefix(1)) : [own] }
        return picked + (own.isEmpty ? [] : [own])
    }
}

/// Ordered, observable work in one turn. Tool IDs remain stable from start to result. A live turn
/// adds two kinds: an action the agent waits for (`approval`: `title` the tool, `text` what it wants
/// to do, `output` why) and a message the person added while it ran (`steer`). An approval with
/// `questions` is a question the agent asks; `answers` is what the person chose.
struct ChatStep: Identifiable, Equatable {
    enum Kind: Equatable { case text, tool, approval, steer }
    enum State: Equatable { case running, succeeded, failed, incomplete, waiting, allowed, denied, cancelled }
    var id: String
    var kind: Kind
    var title: String = ""
    var text: String = ""
    var output: String = ""
    var state: State = .running
    var questions: [ChatQuestion] = []
    var answers: [String: [String]] = [:]
}

/// How a tool row is drawn, after the web panel's `toolVariant` and `toolSummary`
/// (src/web/chat-steps.ts): one kind per family of tools across runtimes, and the call's first line.
enum ChatToolKind: String, Equatable {
    case bash, read, write, edit, search, web, code, task, plan, other

    private static let families: [(ChatToolKind, Set<String>)] = [
        (.bash, ["bash", "pwsh", "shell", "exec", "exec_command", "command", "command_execution", "local_shell", "run_command", "terminal"]),
        (.read, ["read", "read_file", "read_image", "view", "notebookread", "cat"]),
        (.write, ["write", "write_file", "create_file"]),
        (.edit, ["edit", "multiedit", "notebookedit", "apply_patch", "patch", "file_change", "str_replace"]),
        (.search, ["grep", "glob", "ls", "list", "search", "find", "toolsearch", "codebase_search"]),
        (.web, ["webfetch", "websearch", "web_fetch", "web_search", "fetch", "browse"]),
        (.code, ["run_code", "code"]),
        (.task, ["task", "agent", "subagent", "spawn_agent", "send_message", "wait_agent"]),
        (.plan, ["todowrite", "todo_write", "update_plan"]),
    ]

    init(tool name: String) {
        var bare = name
        // An MCP tool `mcp__server__tool` is known by its own name.
        if bare.hasPrefix("mcp__"), let last = bare.range(of: "__", options: .backwards), last.lowerBound > bare.index(bare.startIndex, offsetBy: 3) {
            bare = String(bare[last.upperBound...])
        }
        let key = bare.lowercased()
        self = Self.families.first { $0.1.contains(key) }?.0 ?? .other
    }

    /// The row's title: the family's name, or an unknown tool's own (`mcp__a__b` as `a · b`).
    static func title(_ name: String) -> String {
        switch ChatToolKind(tool: name) {
        case .bash: return String(localized: "Bash")
        case .read: return String(localized: "Read")
        case .write: return String(localized: "Write")
        case .edit: return String(localized: "Edit")
        case .search: return String(localized: "Search")
        case .web: return String(localized: "Web")
        case .code: return String(localized: "Code")
        case .task: return String(localized: "Agent")
        case .plan: return String(localized: "Plan")
        case .other:
            let bare = name.hasPrefix("mcp__") ? String(name.dropFirst(5)) : name
            return bare.replacingOccurrences(of: "__", with: " · ")
        }
    }

    /// The first non-empty line, so a long command or a patch still reads as one row.
    static func summary(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
    }
}

/// Runs of consecutive tool calls become one group, so they stack as a tight list between
/// paragraphs (src/web/chat-steps.ts `stepGroups`).
enum ChatStepGroup: Identifiable, Equatable {
    case single(ChatStep)
    case tools([ChatStep])

    var id: String {
        switch self {
        case .single(let step): return step.id
        case .tools(let steps): return "tools:" + (steps.first?.id ?? "")
        }
    }

    static func groups(_ steps: [ChatStep]) -> [ChatStepGroup] {
        var groups: [ChatStepGroup] = []
        for step in steps {
            if step.kind != .tool {
                groups.append(.single(step))
            } else if case .tools(let run)? = groups.last {
                groups[groups.count - 1] = .tools(run + [step])
            } else {
                groups.append(.tools([step]))
            }
        }
        return groups
    }
}

/// One message of a stored conversation (`GET …/sessions/:sid`): the person's text, or the agent's
/// with the tools it called and, where the runtime's records have them, its text and tool calls in
/// order (`TranscriptMessage` in src/space/runtimes/types.ts).
struct ChatHistoryMessage: Decodable, Equatable {
    struct Tool: Decodable, Equatable {
        var name: String
        var hint: String?
    }

    struct Step: Decodable, Equatable {
        var kind: String
        var text: String?
        var name: String?
        var input: String?
        var output: String?
        var failed: Bool?
    }

    var role: String
    var text: String?
    var tools: [Tool]?
    var steps: [Step]?

    var isUser: Bool { role == "user" }

    /// The steps drawn like a finished live turn (src/web/chat-steps.ts `historySteps`).
    var chatSteps: [ChatStep] {
        (steps ?? []).enumerated().compactMap { i, step in
            switch step.kind {
            case "text":
                return ChatStep(id: "history:\(i)", kind: .text, text: step.text ?? "", state: .succeeded)
            case "tool":
                return ChatStep(id: "history:\(i)", kind: .tool, title: step.name ?? "tool", text: step.input ?? "",
                                output: step.output ?? "", state: step.failed == true ? .failed : .succeeded)
            default:
                return nil
            }
        }
    }
}

/// One chat turn's reply, built from the run's events the way the panel's Chat.tsx reads them:
/// Claude-style stream-json, which every runtime adapter emits, followed by `error` and `done`.
struct ChatReply: Equatable {
    var sessionID: String?
    var finishedText = ""
    var streaming = ""
    var tools: [String] = []
    var steps: [ChatStep] = []
    private var streamingStep: String?

    private mutating func recordText(_ text: String, final: Bool) {
        if let id = streamingStep, let index = steps.firstIndex(where: { $0.id == id }) {
            if final { steps[index].text = text } else { steps[index].text += text }
            if final { steps[index].state = .succeeded }
        } else {
            let id = UUID().uuidString
            steps.append(ChatStep(id: id, kind: .text, text: text, state: final ? .succeeded : .running))
            if !final { streamingStep = id }
        }
        if final { streamingStep = nil }
    }

    private static func detail(_ value: Any?) -> String {
        guard let value else { return "" }
        if let text = value as? String { return String(text.prefix(12000)) }
        if let blocks = value as? [[String: Any]], blocks.contains(where: { $0["type"] as? String == "text" }) {
            return String(blocks.compactMap { $0["text"] as? String }.joined(separator: "\n").prefix(12000))
        }
        guard JSONSerialization.isValidJSONObject(value),
              let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
              let text = String(data: bytes, encoding: .utf8) else { return "" }
        return String(text.prefix(12000))
    }

    mutating func endSteps() {
        for i in steps.indices {
            if steps[i].state == .running {
                steps[i].state = steps[i].kind == .text ? .succeeded : .incomplete
            }
            // An approval nobody answered before the turn ended is not left waiting.
            if steps[i].state == .waiting { steps[i].state = .cancelled }
        }
    }

    var activity: ChatActivity? = .starting
    var note: String?
    /// The run's own error as the Space reported it, apart from the reply text, so a client can
    /// show it as a failure of the turn rather than as words of the agent.
    var failure: String?
    var stopped = false
    var finished = false
    var denied: [String] = []
    /// The messages the agent has read that the person added while the turn ran, one per `steer`
    /// event: the reply no longer shows them waiting.
    var consumedSteers: [String] = []
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
        case "approval_request":
            guard let id = ev["id"] as? String else { return }
            let step = ChatStep(
                id: "approval:" + id,
                kind: .approval,
                title: ev["tool"] as? String ?? "tool",
                text: ev["title"] as? String ?? "",
                output: ev["detail"] as? String ?? "",
                state: .waiting,
                questions: ChatQuestion.list(ev["questions"]))
            if !steps.contains(where: { $0.id == step.id }) { steps.append(step) }
            // The turn is not running anything now; it waits for the person's answer.
            activity = nil
        case "approval_resolved":
            guard let id = ev["id"] as? String,
                  let i = steps.firstIndex(where: { $0.id == "approval:" + id }) else { return }
            switch ev["decision"] as? String {
            case "allow": steps[i].state = .allowed
            case "deny": steps[i].state = .denied
            default: steps[i].state = .cancelled
            }
            if let answers = ev["answers"] as? [String: [String]] { steps[i].answers = answers }
        case "steer":
            let text = ev["text"] as? String ?? ""
            consumedSteers.append(text)
            steps.append(ChatStep(id: "steer:" + UUID().uuidString, kind: .steer, text: text, state: .succeeded))
        case "system" where ev["subtype"] as? String == "init":
            sessionID = ev["session_id"] as? String ?? sessionID
            activity = .thinking(model: ev["model"] as? String ?? "")
        case "stream_event":
            let event = ev["event"] as? [String: Any]
            let delta = event?["delta"] as? [String: Any]
            if delta?["type"] as? String == "text_delta", let t = delta?["text"] as? String {
                recordText(t, final: false)
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
            for b in blocks {
                if b["type"] as? String == "text", let text = b["text"] as? String, !text.isEmpty {
                    recordText(text, final: true)
                    continue
                }
                guard b["type"] as? String == "tool_use", let id = b["id"] as? String else { continue }
                let input = b["input"] as? [String: Any] ?? [:]
                let hint = Self.detail(input["command"] ?? input["file_path"] ?? input["path"] ?? input["query"] ?? input)
                if let i = steps.firstIndex(where: { $0.id == "tool:" + id }) {
                    if !hint.isEmpty { steps[i].text = hint }
                    continue
                }
                let name = b["name"] as? String ?? "tool"
                toolNames[id] = name
                tools.append(name)
                steps.append(ChatStep(id: "tool:" + id, kind: .tool, title: name, text: hint))
                activity = .running(tool: name)
            }
        case "user":
            let blocks = (ev["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
            for block in blocks where block["type"] as? String == "tool_result" {
                let text = Self.detail(block["content"])
                let id = "tool:" + (block["tool_use_id"] as? String ?? "")
                if let i = steps.firstIndex(where: { $0.id == id }) {
                    steps[i].output = text
                    steps[i].state = block["is_error"] as? Bool == true ? .failed : .succeeded
                }
                activity = steps.last(where: { $0.kind == .tool && $0.state == .running }).map { .running(tool: $0.title) } ?? .thinking(model: "")
                guard block["is_error"] as? Bool == true else { continue }
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
            endSteps()
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
