import Foundation

/// How the phone lays out one agent reply, after the panel's chat (src/web/chat-steps.ts,
/// ChatToolRow.tsx): text and tool calls in the order they happened, consecutive calls stacked as
/// one tight list, each call a single row of its kind, title and first line.
enum ChatRows {
    /// The kind of a tool call, which picks its glyph and title.
    enum Tool: Equatable {
        case bash, read, write, edit, search, web, code, task, plan, other
    }

    private static let tools: [(Set<String>, Tool)] = [
        (["bash", "pwsh", "shell", "exec", "exec_command", "command", "command_execution", "local_shell", "run_command", "terminal"], .bash),
        (["read", "read_file", "read_image", "view", "notebookread", "cat"], .read),
        (["write", "write_file", "create_file"], .write),
        (["edit", "multiedit", "notebookedit", "apply_patch", "patch", "file_change", "str_replace"], .edit),
        (["grep", "glob", "ls", "list", "search", "find", "toolsearch", "codebase_search"], .search),
        (["webfetch", "websearch", "web_fetch", "web_search", "fetch", "browse"], .web),
        (["run_code", "code"], .code),
        (["task", "agent", "subagent", "spawn_agent", "send_message", "wait_agent"], .task),
        (["todowrite", "todo_write", "update_plan"], .plan),
    ]

    /// The kind of a tool by its name; an MCP tool (`mcp__<server>__<tool>`) by its own part.
    static func tool(_ name: String) -> Tool {
        var bare = name.lowercased()
        if bare.hasPrefix("mcp__"), let last = bare.range(of: "__", options: .backwards), last.lowerBound > bare.index(bare.startIndex, offsetBy: 3) {
            bare = String(bare[last.upperBound...])
        }
        return tools.first { $0.0.contains(bare) }?.1 ?? .other
    }

    /// An unknown tool's own name, readable: `mcp__github__search` becomes `github · search`.
    static func plainName(_ name: String) -> String {
        var out = name
        if out.hasPrefix("mcp__") { out.removeFirst(5) }
        return out.replacingOccurrences(of: "__", with: " · ")
    }

    /// The first non-empty line, so a long command or a patch still reads as one row.
    static func summary(_ text: String) -> String {
        text.split(separator: "\n", omittingEmptySubsequences: false)
            .lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    /// Whether a row opens: it has a result, or its input is more than the line shown.
    static func expandable(_ step: ChatStep) -> Bool {
        !step.output.isEmpty || step.text.trimmingCharacters(in: .whitespacesAndNewlines) != summary(step.text)
    }

    /// One entry of a reply: a step of its own, or a run of consecutive tool calls.
    enum Group: Identifiable, Equatable {
        case step(ChatStep)
        case tools([ChatStep])

        var id: String {
            switch self {
            case .step(let step): return step.id
            case .tools(let steps): return "tools:" + (steps.first?.id ?? "")
            }
        }
    }

    /// Whether a run of calls is all commands, so a folded run's line can say what ran.
    static func allCommands(_ steps: [ChatStep]) -> Bool {
        !steps.isEmpty && steps.allSatisfy { $0.kind == .tool && tool($0.title) == .bash }
    }

    /// Whether a run of calls opens folded to one line: two or more calls of a past conversation.
    /// A turn being followed keeps every call in view as it runs.
    static func folds(_ run: [ChatStep], historic: Bool) -> Bool { historic && run.count > 1 }

    static func groups(_ steps: [ChatStep]) -> [Group] {
        var out: [Group] = []
        for step in steps {
            if step.kind != .tool {
                out.append(.step(step))
            } else if case .tools(var run)? = out.last {
                run.append(step)
                out[out.count - 1] = .tools(run)
            } else {
                out.append(.tools([step]))
            }
        }
        return out
    }

    // MARK: Past conversations

    /// One message of a stored conversation (`GET …/sessions/:sid`, docs/panel.md): the assistant's
    /// `steps` in order where the runtime recorded them, else the flat `tools` of older Spaces.
    static func steps(of stored: ChatStored) -> [ChatStep] {
        if let steps = stored.steps, !steps.isEmpty {
            return steps.enumerated().map { i, step in
                step.kind == "tool"
                    ? ChatStep(id: "history:\(i)", kind: .tool, title: step.name ?? "tool", text: step.input ?? "", output: step.output ?? "", state: step.failed == true ? .failed : .succeeded)
                    : ChatStep(id: "history:\(i)", kind: .text, text: step.text ?? "", state: .succeeded)
            }
        }
        let tools = (stored.tools ?? []).enumerated().map { i, tool in
            ChatStep(id: "history-tool:\(i)", kind: .tool, title: tool.name, text: tool.hint ?? "", state: .incomplete)
        }
        guard !tools.isEmpty else { return [] }
        let text = stored.text ?? ""
        return tools + (text.isEmpty ? [] : [ChatStep(id: "history-text", kind: .text, text: text, state: .succeeded)])
    }

    // MARK: Pictures

    /// The largest picture a message carries as it is (docs/panel.md#agent-chat-images).
    static let maxImageBytes = 5 * 1024 * 1024

    /// The formats the Space takes, by their first bytes; anything else has to be re-encoded.
    static func imageType(of data: Data) -> (mime: String, ext: String)? {
        let b = [UInt8](data.prefix(12))
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return ("image/png", "png") }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return ("image/jpeg", "jpg") }
        if b.starts(with: Array("GIF8".utf8)) { return ("image/gif", "gif") }
        if b.count == 12, b.starts(with: Array("RIFF".utf8)), Array(b.suffix(4)) == Array("WEBP".utf8) { return ("image/webp", "webp") }
        return nil
    }

    // MARK: Questions

    /// A question the agent asks while its turn runs (docs/runtimes.md#live-chat): an
    /// `approval_request` with `questions`. The person picks options or types an answer.
    struct Question: Decodable, Identifiable, Equatable {
        struct Option: Decodable, Equatable {
            var label: String
            var description: String?
        }
        var id: String
        var header: String?
        var question: String
        var options: [Option] = []
        var multiSelect: Bool?

        var multiple: Bool { multiSelect == true }

        private enum CodingKeys: String, CodingKey { case id, header, question, options, multiSelect }

        init(id: String, header: String? = nil, question: String, options: [Option] = [], multiSelect: Bool? = nil) {
            self.id = id
            self.header = header
            self.question = question
            self.options = options
            self.multiSelect = multiSelect
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            header = try c.decodeIfPresent(String.self, forKey: .header)
            question = try c.decodeIfPresent(String.self, forKey: .question) ?? ""
            options = try c.decodeIfPresent([Option].self, forKey: .options) ?? []
            multiSelect = try c.decodeIfPresent(Bool.self, forKey: .multiSelect)
        }
    }

    /// What one event says of questions: those of a new request, or the answers of a settled one,
    /// keyed by the approval step's id (`approval:<id>`). Nil for any other event.
    enum QuestionEvent: Equatable {
        case asked(step: String, questions: [Question])
        case answered(step: String, answers: [String: [String]])
    }

    static func questionEvent(_ line: String) -> QuestionEvent? {
        struct Event: Decodable {
            var type: String
            var id: String?
            var questions: [Question]?
            var answers: [String: [String]]?
        }
        guard line.contains("\"questions\"") || line.contains("\"answers\""),
              let event = try? JSONDecoder().decode(Event.self, from: Data(line.utf8)), let id = event.id else { return nil }
        switch event.type {
        case "approval_request":
            guard let questions = event.questions, !questions.isEmpty else { return nil }
            return .asked(step: "approval:" + id, questions: questions)
        case "approval_resolved":
            guard let answers = event.answers else { return nil }
            return .answered(step: "approval:" + id, answers: answers)
        default:
            return nil
        }
    }

    /// One question's answer as the panel sends it: the typed text alone for a single choice, the
    /// picked labels and then the typed text for several.
    static func answer(to question: Question, picked: [String], typed: String) -> [String] {
        let own = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !question.multiple { return own.isEmpty ? picked : [own] }
        return picked + (own.isEmpty ? [] : [own])
    }

    /// The body of an answer to an approval (`POST …/runs/:id/approvals/:rid`): a question answered
    /// is `allow` with its answers; skipped, it is `deny`.
    static func approvalBody(allow: Bool, answers: [String: [String]]? = nil) -> [String: Any] {
        var body: [String: Any] = ["decision": allow ? "allow" : "deny"]
        if allow, let answers { body["answers"] = answers }
        return body
    }
}
