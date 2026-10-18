import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, agent }
    let id = UUID()
    var role: Role
    var text: String
    var tools: [String] = []
    var steps: [ChatStep] = []
    var denied: [String] = []
    var activity: ChatActivity?
    var live = false
    /// Why the turn failed, shown in the thread under what the agent wrote, with a retry.
    var failure: ChatFailure?
}

/// One native conversation with an agent, shared by the main window and Quick Chat. Each turn is
/// a background run on the Space: a dropped stream reattaches after the last event it saw, and
/// only Stop ends the run, so closing a window or losing the network never resends a prompt.
@MainActor
final class ChatController: ObservableObject {
    let agent: AgentInfo
    let api: SpaceAPI
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var busy = false
    @Published var draft = ""
    @Published private(set) var error: String?
    /// The agent's stored conversations, newest first, to pick one up again.
    @Published private(set) var sessions: [ChatSessionInfo] = []

    /// A turn may install or change apps, even when it ends with an error or Stop.
    var onTurnEnded: () -> Void = {}

    private var sessionID: String?
    private var runID: String?
    private var task: Task<Void, Never>?

    init(agent: AgentInfo, api: SpaceAPI) {
        self.agent = agent
        self.api = api
    }

    /// Picks up a turn of this agent still running on the server, from any client.
    func attachRunning(_ runs: [ChatRun]) {
        guard !busy, messages.isEmpty, let run = runs.first(where: { $0.agent == "\(agent.app)/\(agent.name)" && $0.status == "running" }) else { return }
        messages.append(ChatMessage(role: .user, text: run.message))
        start(source: .attach(run.id))
    }

    func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        draft = ""
        messages.append(ChatMessage(role: .user, text: text))
        start(source: .new(ChatTurnRequest(message: text, permission: Preferences.shared.chatPermission)))
    }

    /// The message of the last turn when that turn failed: what Try Again sends once more.
    var retryableMessage: String? {
        guard !busy, let last = messages.last, last.role == .agent, last.failure != nil,
              let prompt = messages.dropLast().last, prompt.role == .user else { return nil }
        return prompt.text
    }

    /// Sends the failed turn's message again in place of the failed reply; the draft is untouched.
    func retry() {
        guard let text = retryableMessage else { return }
        messages.removeLast()
        start(source: .new(ChatTurnRequest(message: text, permission: Preferences.shared.chatPermission)))
    }

    /// Like Web's Grant and retry: continue the session, keeping an unsent draft intact.
    func grantAndRetry() {
        guard !busy, let last = messages.last, last.role == .agent, !last.denied.isEmpty else { return }
        let permission = Preferences.shared.chatPermission.granting(last.denied)
        Preferences.shared.chatPermission = permission
        let text = String(localized: "I have granted more permissions. Please finish the step that was refused for lack of permission.")
        messages.append(ChatMessage(role: .user, text: text))
        start(source: .new(ChatTurnRequest(message: text, permission: permission)))
    }

    func stop() {
        guard let runID else { task?.cancel(); return }
        Task { try? await api.send("POST", "\(agent.base)/runs/\(SpacePath.escape(runID))/stop", json: [:]) }
    }

    func loadSessions() async {
        guard let data = try? await api.data("\(agent.base)/sessions") else { return }
        sessions = (try? Hub.rows(ChatSessionInfo.self, "sessions", from: data)) ?? []
    }

    /// Shows a stored conversation; the next message continues it.
    func open(_ session: ChatSessionInfo) async {
        guard !busy else { return }
        do {
            let stored = try Hub.rows(ChatStored.self, "messages", from: try await api.data("\(agent.base)/sessions/\(SpacePath.escape(session.sid))"))
            messages = stored.compactMap { m in
                (m.text ?? "").isEmpty ? nil : ChatMessage(role: m.role == "user" ? .user : .agent, text: m.text ?? "")
            }
            sessionID = session.sid
            error = nil
        } catch {
            self.error = HubStore.message(error)
        }
    }

    func newConversation() {
        guard !busy else { return }
        messages = []
        sessionID = nil
        error = nil
    }

    private enum Source {
        case new(ChatTurnRequest)
        case attach(String)
    }

    private func start(source: Source) {
        busy = true
        error = nil
        var first = ChatReply()
        if case .attach = source { first.activity = .reconnecting }
        let initial = first
        messages.append(ChatMessage(role: .agent, text: "", activity: initial.activity, live: true))
        let index = messages.count - 1
        if case .attach(let id) = source { runID = id } else { runID = nil }

        task = Task { [weak self] in
            guard let self else { return }
            var reply = initial
            var lastSeq = 0
            var failures = 0
            while !reply.finished && !Task.isCancelled {
                do {
                    let opened: (runID: String?, stream: AsyncThrowingStream<SSEMessage, Error>)
                    if let runID {
                        opened = try await api.events("GET", "\(agent.base)/runs/\(SpacePath.escape(runID))/events?after=\(lastSeq)")
                    } else if case .new(let turn) = source {
                        let body = turn.body(sessionID: sessionID)
                        opened = try await api.events("POST", "\(agent.base)/chat", json: body)
                        runID = opened.runID
                    } else { break }
                    for try await message in opened.stream {
                        if let id = message.id {
                            guard id > lastSeq else { continue }
                            lastSeq = id
                        }
                        reply.apply(message.data)
                        failures = 0
                        update(index, reply)
                    }
                } catch SpaceAPIError.authenticationRequired {
                    fail(index, ChatFailure(kind: .connection, detail: String(localized: "Sign in on the panel first, then try again.")))
                    break
                } catch {
                    // A turn that never got a run cannot be reattached; one that did is resumed.
                    if runID == nil { fail(index, ChatFailure(kind: .connection, detail: error.localizedDescription)); break }
                }
                if reply.finished || Task.isCancelled { break }
                failures += 1
                if failures > 20 { fail(index, ChatFailure(kind: .connection, detail: String(localized: "The connection to the agent was lost."))); break }
                reply.activity = .reconnecting
                update(index, reply)
                try? await Task.sleep(for: .seconds(min(10, failures * 2)))
            }
            if let sid = reply.sessionID { sessionID = sid }
            reply.activity = nil
            reply.endSteps()
            update(index, reply)
            messages[index].live = false
            busy = false
            runID = nil
            onTurnEnded()
        }
    }

    private func update(_ index: Int, _ reply: ChatReply) {
        guard messages.indices.contains(index) else { return }
        // A failure is drawn as its own card, so the text keeps only what the agent wrote.
        var text = reply.failure == nil ? reply.text : reply.body
        if reply.stopped { text += (text.isEmpty ? "" : "\n\n") + String(localized: "(stopped)") }
        messages[index].text = text
        messages[index].tools = reply.tools
        messages[index].steps = reply.steps
        messages[index].denied = reply.denied
        messages[index].activity = reply.activity
        if let failure = reply.failure { messages[index].failure = ChatFailure(failure) }
    }

    private func fail(_ index: Int, _ failure: ChatFailure) {
        guard messages.indices.contains(index) else { return }
        messages[index].activity = nil
        messages[index].failure = failure
    }
}
