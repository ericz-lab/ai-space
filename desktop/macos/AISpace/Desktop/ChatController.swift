import Foundation

struct ChatMessage: Identifiable, Equatable {
    enum Role { case user, agent }
    let id = UUID()
    var role: Role
    var text: String
    var tools: [String] = []
    var activity: ChatActivity?
    var live = false
}

/// One native conversation with an agent, shared by the main window and Quick Chat. Each turn is
/// a background run on the Space: a dropped stream reattaches after the last event it saw, and
/// only Stop ends the run, so closing a window or losing the network never resends a prompt.
@MainActor
final class ChatController: ObservableObject {
    let agent: AgentInfo
    private let api: SpaceAPI
    @Published private(set) var messages: [ChatMessage] = []
    @Published private(set) var busy = false
    @Published var draft = ""
    @Published private(set) var error: String?

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
        start(source: .new(text))
    }

    func stop() {
        guard let runID else { task?.cancel(); return }
        Task { try? await api.send("POST", "\(agent.base)/runs/\(SpacePath.escape(runID))/stop", json: [:]) }
    }

    func newConversation() {
        guard !busy else { return }
        messages = []
        sessionID = nil
        error = nil
    }

    private enum Source {
        case new(String)
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
                    } else if case .new(let text) = source {
                        var body: [String: Any] = ["message": text]
                        if let sessionID { body["sessionId"] = sessionID }
                        opened = try await api.events("POST", "\(agent.base)/chat", json: body)
                        runID = opened.runID
                    } else { break }
                    for try await message in opened.stream {
                        if let id = message.id { lastSeq = id }
                        reply.apply(message.data)
                        failures = 0
                        update(index, reply)
                    }
                } catch SpaceAPIError.authenticationRequired {
                    error = String(localized: "Sign in on the panel first, then try again.")
                    break
                } catch {
                    // A turn that never got a run cannot be reattached; one that did is resumed.
                    if runID == nil { self.error = error.localizedDescription; break }
                }
                if reply.finished || Task.isCancelled { break }
                failures += 1
                if failures > 20 { error = String(localized: "The connection to the agent was lost."); break }
                reply.activity = .reconnecting
                update(index, reply)
                try? await Task.sleep(for: .seconds(min(10, failures * 2)))
            }
            if let sid = reply.sessionID { sessionID = sid }
            reply.activity = nil
            update(index, reply)
            messages[index].live = false
            busy = false
            runID = nil
        }
    }

    private func update(_ index: Int, _ reply: ChatReply) {
        guard messages.indices.contains(index) else { return }
        var text = reply.text
        if reply.stopped { text += (text.isEmpty ? "" : "\n\n") + String(localized: "(stopped)") }
        messages[index].text = text
        messages[index].tools = reply.tools
        messages[index].activity = reply.activity
    }
}
