import Foundation

/// One card's live side (src/web/ChatCards.tsx `ChatCard`): its items' current state, read from the
/// app each time the card is shown and merged over what was printed; Undo through the token; and
/// read-only once ai-space says the token is gone. Shared by the Mac and the iPhone.
@MainActor
final class ChatCardStore: ObservableObject {
    /// Posts a JSON body to a route of the Space and hands back the status and the body.
    typealias Post = (_ path: String, _ body: [String: Any]) async throws -> (status: Int, data: Data)

    let shown: ShownChatCard
    @Published private(set) var states: [String: ChatCardItemState] = [:]
    @Published private(set) var busy = false
    /// What the last action said: the read-only note, or an error.
    @Published private(set) var note: String?
    @Published private(set) var readOnly = false
    private let route: ChatCardRoute?
    private let post: Post

    init(shown: ShownChatCard, route: ChatCardRoute?, post: @escaping Post) {
        self.shown = shown
        self.route = route
        self.post = post
    }

    /// Reads the items' state from the card's `state` capability; a card without one shows what was printed.
    func refresh() async {
        guard shown.card.state != nil, let route else { return }
        guard let answer = try? await post(route.state, ChatCardRules.stateBody(agent: route.agent, card: shown.card)),
              case .items(let items) = ChatCardRules.outcome(status: answer.status, data: answer.data) else { return }
        merge(items)
    }

    /// Takes the items back; only the token, the card's index and the ids go to ai-space.
    func undo(_ ids: [String]) async {
        guard let route, let token = shown.token, !ids.isEmpty, !busy else { return }
        busy = true
        note = nil
        defer { busy = false }
        do {
            let answer = try await post(route.action, ChatCardRules.undoBody(token: token, card: shown.index, items: ids))
            switch ChatCardRules.outcome(status: answer.status, data: answer.data) {
            case .readOnly:
                readOnly = true
                note = String(localized: "Read-only now: the conversation has moved on.")
            case .failed(let message):
                note = message
            case .items(let items):
                merge(items)
            }
        } catch {
            note = HubStore.message(error)
        }
    }

    private func merge(_ items: [ChatCardItemState]) {
        for item in items { states[item.id] = item }
    }
}

/// The card stores of one conversation, kept while it is, so a card scrolled away and back keeps
/// what an Undo said; each showing still reads the state again.
@MainActor
final class ChatCardStores {
    private var stores: [String: ChatCardStore] = [:]
    private let route: ChatCardRoute?
    private let post: ChatCardStore.Post

    init(route: ChatCardRoute?, post: @escaping ChatCardStore.Post) {
        self.route = route
        self.post = post
    }

    /// The Space's routes through its session: the base of the agent's chat routes names the app,
    /// the agent and, for a peer's agent, the peer.
    convenience init(api: SpaceAPI, base: String) {
        self.init(route: ChatCardRoute(base: base)) { [weak api] path, body in
            guard let api else { throw CancellationError() }
            return try await api.answer("POST", path, json: body)
        }
    }

    func store(for shown: ShownChatCard) -> ChatCardStore {
        if let store = stores[shown.id] { return store }
        let store = ChatCardStore(shown: shown, route: route, post: post)
        stores[shown.id] = store
        return store
    }
}
