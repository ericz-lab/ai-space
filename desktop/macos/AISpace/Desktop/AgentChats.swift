import Combine
import Foundation

/// Every conversation with one agent open on this Mac, and the one on show: the main window and
/// Quick Chat both show `current`. New Conversation opens another one beside a turn still running,
/// and showing another conversation never stops one; the rules are `ChatRoster`'s.
@MainActor
final class AgentChats: ObservableObject {
    let agent: AgentInfo
    let api: SpaceAPI
    /// Open conversations, in the order they were opened.
    @Published private(set) var conversations: [ChatController]
    @Published private(set) var current: ChatController
    /// The agent's stored conversations, newest first, to pick one up again.
    @Published private(set) var sessions: [ChatSessionInfo] = []

    /// A turn may install or change apps, even when it ends with an error or Stop.
    var onTurnEnded: () -> Void = {}

    private var watchers: [UUID: AnyCancellable] = [:]
    private var shown: [UUID: Int] = [:]
    private var opened: [UUID: Int] = [:]
    private var clock = 0
    /// Runs followed by conversations already let go, so a stale run list cannot bring one back.
    private var retired: Set<String> = []

    init(agent: AgentInfo, api: SpaceAPI) {
        self.agent = agent
        self.api = api
        let first = ChatController(agent: agent, api: api)
        conversations = [first]
        current = first
        adopt(first)
        mark(first)
    }

    /// Whether any of its conversations runs a turn.
    var busy: Bool { conversations.contains { $0.busy } }

    /// The agent's name in the Space's run list, which holds this machine's turns only.
    private var runAgent: String? { agent.peer == nil ? "\(agent.app)/\(agent.name)" : nil }

    func show(_ chat: ChatController) {
        guard conversations.contains(where: { $0 === chat }) else { return }
        current = chat
        mark(chat)
        prune()
    }

    /// Shows an empty conversation: the one on show when nothing was said in it yet, else a new one.
    func newConversation() {
        if let id = ChatRoster.blankConversation(items, current: current.id), let chat = conversation(id) {
            show(chat)
        } else {
            show(make())
        }
    }

    /// Shows a stored conversation: the open one that continues it, else loaded into an empty one.
    func open(_ session: ChatSessionInfo) async {
        if let id = ChatRoster.showing(session.sid, in: items), let chat = conversation(id) { return show(chat) }
        let target = current.blank && !current.composing ? current : make()
        await target.load(session)
        show(target)
    }

    /// Shows the conversation of a running turn, following it first if none does.
    func show(run: ChatRun) {
        if let chat = conversations.first(where: { $0.runIDs.contains(run.id) }) { return show(chat) }
        attach([run])
        if let chat = conversations.first(where: { $0.runIDs.contains(run.id) }) { show(chat) }
    }

    /// Follows every turn of the agent running on the Space that no conversation here follows yet:
    /// one started on the web panel or another device shows up as a conversation of its own.
    func attach(_ runs: [ChatRun]) {
        guard let runAgent else { return }
        let followed = retired.union(conversations.flatMap(\.runIDs))
        for plan in ChatRoster.attachments(runs: runs, agent: runAgent, items: items, current: current.id, followed: followed) {
            (plan.into.flatMap { conversation($0) } ?? make()).follow(plan.run)
        }
    }

    func loadSessions() async {
        guard let data = try? await api.data("\(agent.base)/sessions") else { return }
        sessions = (try? Hub.rows(ChatSessionInfo.self, "sessions", from: data)) ?? []
    }

    /// The sidebar's rows (ChatRoster.rows).
    func rows(running: [ChatRun]) -> [ChatRoster.Row] {
        ChatRoster.rows(items, sessions: sessions, runs: running, agent: runAgent)
    }

    func conversation(_ id: UUID) -> ChatController? { conversations.first { $0.id == id } }

    private var items: [ChatRoster.Item] {
        conversations.map { c in
            ChatRoster.Item(id: c.id, sessionID: c.sessionID, runID: c.runID, busy: c.busy, hasMessages: c.hasMessages,
                            composing: c.composing, title: c.title, shown: shown[c.id] ?? 0, opened: opened[c.id] ?? 0)
        }
    }

    private func make() -> ChatController {
        let chat = ChatController(agent: agent, api: api)
        conversations.append(chat)
        adopt(chat)
        return chat
    }

    /// Wires a new conversation: its turn's end reaches the app and the history, and what the
    /// sidebar draws of it (busy, stored, title) redraws whatever watches this object.
    private func adopt(_ chat: ChatController) {
        clock += 1
        opened[chat.id] = clock
        chat.onTurnEnded = { [weak self] in
            guard let self else { return }
            self.onTurnEnded()
            Task { await self.loadSessions() }
        }
        let thread = chat.$messages.map { messages -> String in
            "\(messages.isEmpty) \(messages.first(where: { $0.role == .user })?.text ?? "")"
        }
        watchers[chat.id] = Publishers.CombineLatest3(chat.$busy, chat.$sessionID, thread)
            .map { busy, sid, thread -> String in "\(busy) \(sid ?? "") \(thread)" }
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.objectWillChange.send() }
    }

    private func mark(_ chat: ChatController) {
        clock += 1
        shown[chat.id] = clock
    }

    private func prune() {
        let drop = ChatRoster.pruned(items, current: current.id)
        guard !drop.isEmpty else { return }
        for chat in conversations where drop.contains(chat.id) {
            retired.formUnion(chat.runIDs)
            watchers[chat.id] = nil
            shown[chat.id] = nil
            opened[chat.id] = nil
        }
        conversations.removeAll { drop.contains($0.id) }
    }
}
