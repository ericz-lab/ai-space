import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, agent }
    let id = UUID()
    var role: Role
    var text: String
    var images: [ChatImage] = []
    var tools: [String] = []
    var steps: [ChatStep] = []
    var denied: [String] = []
    var activity: ChatActivity?
    var live = false
    /// Messages added to the running turn that the agent has not read yet.
    var pending: [String] = []
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
    @Published var images: [ChatImage] = []
    @Published var imageError: String?
    @Published var pendingImageImports = 0
    @Published private(set) var error: String?
    /// The agent's stored conversations, newest first, to pick one up again.
    @Published private(set) var sessions: [ChatSessionInfo] = []

    /// A turn may install or change apps, even when it ends with an error or Stop.
    var onTurnEnded: () -> Void = {}

    private var sessionID: String?
    private var runID: String?
    private var task: Task<Void, Never>?
    /// One thread's identity: New Conversation and opening an earlier chat start another one, so a
    /// late answer for a steer of the old thread cannot land in the new one.
    private var conversation = UUID()
    /// Turns written while another one runs that the running turn could not take (`/steer` refused,
    /// or none was open yet): each keeps the message it belongs to, so its reply is inserted right
    /// after that message rather than at the end of whatever came later.
    private struct QueuedTurn {
        let message: UUID
        let turn: ChatTurnRequest
    }
    private var queue: [QueuedTurn] = []
    /// Messages added to the running turn that the agent has not read yet, and how many of the
    /// reply's `steer` events have already taken one out.
    private var pending: [String] = []
    private var steersSeen = 0
    /// Stop was asked for: a message written now must not be added to the turn being stopped.
    private var stopRequested = false

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
        guard (!text.isEmpty || !images.isEmpty), pendingImageImports == 0 else { return }
        draft = ""
        let turn = ChatTurnRequest(message: text, permission: Preferences.shared.chatPermission, images: images)
        images = []
        imageError = nil
        // A message written while a turn runs is added to that turn (docs/runtimes.md#live-chat):
        // the agent reads it after its current step. A turn that cannot take it is queued and sent
        // next, in order, so nothing is lost.
        if busy {
            if let runID, queue.isEmpty, !stopRequested { steer(turn, runID: runID) }
            else { enqueue(turn) }
            return
        }
        messages.append(ChatMessage(role: .user, text: text, images: turn.images))
        start(source: .new(turn))
    }

    /// The person's answer to one of the running turn's approvals (`allow` runs the action once).
    /// A question is answered with `allow` and its `answers`; `deny` skips it.
    /// Returns nil when it reached the Space, else what to show in the card.
    func answer(_ requestID: String, allow: Bool, answers: [String: [String]]? = nil) async -> String? {
        guard let runID else { return String(localized: "The answer did not reach the agent: no turn is running") }
        var body: [String: Any] = ["decision": allow ? "allow" : "deny"]
        if let answers { body["answers"] = answers }
        do {
            _ = try await api.send("POST", "\(agent.base)/runs/\(SpacePath.escape(runID))/approvals/\(SpacePath.escape(requestID))", json: body)
            return nil
        } catch {
            return String(localized: "The answer did not reach the agent: \(HubStore.message(error))")
        }
    }

    /// Hands the message to the running turn; when that is refused (the turn just ended, or its
    /// runtime has no live chat) it becomes the next turn and is shown in the thread straight away.
    private func steer(_ turn: ChatTurnRequest, runID: String) {
        let label = turn.message.isEmpty ? "🖼 ×\(turn.images.count)" : turn.message
        let conversation = self.conversation
        markPending(label, add: true)
        Task { [weak self] in
            guard let self else { return }
            do {
                var body: [String: Any] = ["message": turn.message]
                if !turn.images.isEmpty { body["images"] = turn.images.map(\.body) }
                _ = try await api.send("POST", "\(agent.base)/runs/\(SpacePath.escape(runID))/steer", json: body)
            } catch {
                // The person moved to another thread while the answer was on its way: the message
                // belongs to the one that is gone, not to the new one.
                guard self.conversation == conversation else { return }
                markPending(label, add: false)
                enqueue(turn)
                if !busy, let next = takeQueued() { start(source: .new(next.turn), replyingTo: next.message) }
            }
        }
    }

    /// Shows (or takes back) one message's "the agent has not read it yet" line in the live reply.
    private func markPending(_ label: String, add: Bool) {
        if add {
            pending.append(label)
        } else if let at = pending.lastIndex(of: label) {
            pending.remove(at: at)
        }
        guard let index = messages.lastIndex(where: { $0.role == .agent && $0.live }) else { return }
        messages[index].pending = pending
    }

    /// The reply took one added message in: its text names it, except for an image-only message,
    /// which replays without text and takes the oldest waiting one.
    private func takePending(_ text: String) {
        let wanted = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let at = pending.firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines) == wanted }) {
            pending.remove(at: at)
        } else if !pending.isEmpty {
            pending.removeFirst()
        }
    }

    /// A message for after the running turn: kept in the thread and sent in order, with the reply
    /// that answers it.
    private func enqueue(_ turn: ChatTurnRequest) {
        let message = ChatMessage(role: .user, text: turn.message, images: turn.images)
        messages.append(message)
        queue.append(QueuedTurn(message: message.id, turn: turn))
    }

    private func takeQueued() -> QueuedTurn? {
        queue.isEmpty ? nil : queue.removeFirst()
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
        start(source: .new(ChatTurnRequest(message: text, permission: Preferences.shared.chatPermission, images: messages.last?.images ?? [])))
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
        stopRequested = true
        guard let runID else { task?.cancel(); return }
        Task { try? await api.send("POST", "\(agent.base)/runs/\(SpacePath.escape(runID))/stop", json: [:]) }
    }

    func loadSessions() async {
        guard let data = try? await api.data("\(agent.base)/sessions") else { return }
        sessions = (try? Hub.rows(ChatSessionInfo.self, "sessions", from: data)) ?? []
    }

    /// Shows a stored conversation; the next message continues it.
    func open(_ session: ChatSessionInfo) async {
        guard !busy, pendingImageImports == 0 else { return }
        do {
            let stored = try Hub.rows(ChatHistoryMessage.self, "messages", from: try await api.data("\(agent.base)/sessions/\(SpacePath.escape(session.sid))"))
            // The agent's text and tool calls come back in order, drawn like a finished live turn.
            messages = stored.compactMap { m in
                let steps = m.isUser ? [] : m.chatSteps
                guard !(m.text ?? "").isEmpty || !steps.isEmpty else { return nil }
                return ChatMessage(role: m.isUser ? .user : .agent, text: m.text ?? "",
                                   tools: (m.tools ?? []).map(\.name), steps: steps)
            }
            sessionID = session.sid
            conversation = UUID()
            error = nil
        } catch {
            self.error = HubStore.message(error)
        }
    }

    func newConversation() {
        guard !busy, pendingImageImports == 0 else { return }
        messages = []
        images = []
        imageError = nil
        sessionID = nil
        conversation = UUID()
        error = nil
    }

    private enum Source {
        case new(ChatTurnRequest)
        case attach(String)
    }

    private func start(source: Source, replyingTo user: UUID? = nil) {
        busy = true
        error = nil
        stopRequested = false
        pending = []
        steersSeen = 0
        var first = ChatReply()
        if case .attach = source { first.activity = .reconnecting }
        let initial = first
        let placeholder = ChatMessage(role: .agent, text: "", activity: initial.activity, live: true)
        // A queued turn's reply belongs right after its own message: with two messages waiting,
        // appending it at the end would separate them from the turns they answer.
        let index: Int
        if let user, let at = ChatThread.replyIndex(after: user, in: messages.map(\.id)) {
            index = at
            messages.insert(placeholder, at: at)
        } else {
            index = messages.count
            messages.append(placeholder)
        }
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
            messages[index].pending = []
            runID = nil
            onTurnEnded()
            // A message that could not join this turn goes now, in the order it was written.
            if let next = takeQueued() {
                start(source: .new(next.turn), replyingTo: next.message)
            } else {
                pending = []
                stopRequested = false
                busy = false
            }
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
        // The reply says which added messages the agent has read; the rest still wait.
        while steersSeen < reply.consumedSteers.count {
            takePending(reply.consumedSteers[steersSeen])
            steersSeen += 1
        }
        messages[index].pending = pending
        messages[index].activity = reply.activity
        if let failure = reply.failure { messages[index].failure = ChatFailure(failure) }
    }

    private func fail(_ index: Int, _ failure: ChatFailure) {
        guard messages.indices.contains(index) else { return }
        messages[index].activity = nil
        messages[index].failure = failure
    }
}
