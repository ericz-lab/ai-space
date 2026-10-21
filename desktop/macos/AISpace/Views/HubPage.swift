import SwiftUI

/// A page of the Space drawn by the app from the Space's own routes, over the launcher: what the
/// web panel keeps under Settings, the inbox and the chat. The same pages as the iPhone client's.
enum HubPage: Identifiable, Hashable {
    case inbox, tasks, modelUsage, appUsage, appModels, events, packages, terminal
    /// The agents to talk to, or one agent's conversation by its id (`<app>/<name>`, behind its peer).
    case chat(agent: String?)

    var id: String {
        switch self {
        case .inbox: return "inbox"
        case .tasks: return "tasks"
        case .modelUsage: return "modelUsage"
        case .appUsage: return "appUsage"
        case .appModels: return "appModels"
        case .events: return "events"
        case .packages: return "packages"
        case .terminal: return "terminal"
        case .chat(let agent): return "chat:\(agent ?? "")"
        }
    }

    /// The rows of Settings that lead to a page, in the iPhone's order.
    static let rows: [(title: LocalizedStringKey, symbol: String, page: HubPage)] = [
        ("Inbox", "tray", .inbox),
        ("Chat", "bubble.left.and.text.bubble.right", .chat(agent: nil)),
        ("Scheduled tasks", "calendar.badge.clock", .tasks),
        ("Model usage", "chart.bar", .modelUsage),
        ("App usage", "chart.line.uptrend.xyaxis", .appUsage),
        ("App models", "cpu", .appModels),
        ("Events and calls", "bolt.horizontal", .events),
        ("Apps and connections", "shippingbox", .packages),
        ("Terminal", "terminal", .terminal),
    ]
}

/// The page with its own navigation, over the launcher: its rows can lead further in, and the
/// toolbar's first button goes back to the Space.
struct HubContainer: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let page: HubPage
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .toolbar {
                    ToolbarItem(placement: .navigation) {
                        Button { model.returnToSpace() } label: { Label("Back to Space", systemImage: "square.grid.2x2") }
                            .help("Back to Space (⇧⌘H)")
                    }
                }
        }
        .id(page)
        .background(Theme.ground)
    }

    @ViewBuilder private var content: some View {
        let api = loader.api
        switch page {
        case .inbox: InboxPage(model: model, api: api)
        case .tasks: TasksPage(api: api, icons: icons)
        case .modelUsage: ModelUsagePage(api: api)
        case .appUsage: AppUsagePage(api: api, catalogue: loader.catalogue)
        case .appModels: AppModelsPage(api: api, icons: icons)
        case .events: EventsPage(api: api)
        case .packages: PackagesPage(model: model, connection: connection, api: api)
        case .terminal: TerminalPage(store: model.terminal(for: connection))
        case .chat(let agent):
            if let agent, let chat = model.chat(AgentRef(connection: connection.id, agent: agent)) {
                HStack(spacing: 0) {
                    ChatSidebar(model: model, connection: connection, loader: loader, icons: icons, chat: chat, current: agent)
                    Divider()
                    ChatView(chat: chat, icons: icons, compact: false)
                }
                .navigationTitle(Text(verbatim: chat.agent.displayTitle))
            } else if agent != nil, model.lives[connection.id]?.status == .unknown {
                Connecting()
            } else {
                AgentsPage(model: model, connection: connection, loader: loader, icons: icons)
            }
        }
    }
}

/// The agents of the Space, each leading to its conversation.
struct AgentsPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        let agents = loader.catalogue?.agents ?? []
        let running = model.lives[connection.id]?.running ?? []
        List {
            if agents.isEmpty { Text("This Space has no agents.").foregroundStyle(.secondary) }
            ForEach(agents) { agent in
                Button { model.destination = .hub(.chat(agent: agent.ref)) } label: {
                    HStack(spacing: 12) {
                        EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 36, isRound: true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: agent.displayTitle()).foregroundStyle(Theme.text)
                            if let detail = agent.displayDetail() { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        if running.contains(where: { $0.agent == agent.ref || agent.ref.hasSuffix("/" + $0.agent) }) {
                            ProgressView().controlSize(.small).help("Working")
                        }
                        if let peer = agent.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.tertiary) }
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 3)
                .disabled(agent.reach == .peerOffline)
            }
        }
        .navigationTitle(Text("Chat"))
        .reloadable { await loader.refresh() }
    }
}

/// Beside the main window's conversation (src/web/Chat.tsx `chat-side`): New Conversation, the
/// agents to switch to (a busy one marked) and the shown agent's recent sessions, kept in view
/// rather than behind a menu.
struct ChatSidebar: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var chat: ChatController
    /// The agent on show, by its id.
    let current: String

    var body: some View {
        let agents = loader.catalogue?.agents ?? []
        let locked = chat.busy || chat.pendingImageImports > 0
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                Button { chat.newConversation() } label: {
                    Label("New Conversation", systemImage: "square.and.pencil")
                        .font(.callout.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 7)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.text)
                .disabled(locked)
                .help("New Conversation")
                if agents.count > 1 {
                    heading("Agents")
                    ForEach(agents) { agent in
                        item(on: agent.ref == current, action: { model.destination = .hub(.chat(agent: agent.ref)) }) {
                            EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 20, isRound: true)
                            Text(verbatim: agent.displayTitle()).lineLimit(1)
                            Spacer(minLength: 4)
                            if busy(agent.ref) {
                                Circle().fill(Theme.accent).frame(width: 7, height: 7).help("Working")
                            }
                        }
                        .disabled(agent.reach == .peerOffline)
                    }
                }
                heading("Recent")
                if chat.sessions.isEmpty {
                    Text("No earlier chats").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 8)
                }
                ForEach(chat.sessions.prefix(30)) { session in
                    let title = session.title.flatMap { $0.isEmpty ? nil : $0 } ?? String(localized: "Untitled")
                    item(on: session.sid == chat.sessionID, action: { Task { await chat.open(session) } }) {
                        Text(verbatim: title).lineLimit(1)
                        Spacer(minLength: 4)
                        if let ts = session.ts {
                            Text(verbatim: Times.ago(Date(timeIntervalSince1970: ts / 1000))).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .help(title)
                    .disabled(locked)
                }
            }
            .padding(10)
        }
        .frame(width: 230)
        .background(.thinMaterial)
    }

    private func busy(_ ref: String) -> Bool {
        if ref == current { return chat.busy }
        if model.isChatBusy(AgentRef(connection: connection.id, agent: ref)) { return true }
        let running = model.lives[connection.id]?.running ?? []
        return running.contains { $0.agent == ref || ref.hasSuffix("/" + $0.agent) }
    }

    private func heading(_ title: LocalizedStringKey) -> some View {
        Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            .accessibilityAddTraits(.isHeader)
            .padding(.horizontal, 8).padding(.top, 14).padding(.bottom, 4)
    }

    private func item<Content: View>(on: Bool, action: @escaping () -> Void, @ViewBuilder _ content: () -> Content) -> some View {
        Button(action: action) {
            HStack(spacing: 8) { content() }
                .font(.callout)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(on ? Theme.text.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
