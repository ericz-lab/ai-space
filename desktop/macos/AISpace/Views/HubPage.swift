import SwiftUI

/// A page of the Space drawn by the app from the Space's own routes, over the launcher: what the
/// web panel keeps under Settings, the inbox and the chat. The same pages as the iPhone client's.
enum HubPage: Identifiable, Hashable {
    case inbox, tasks, modelUsage, appUsage, appModels, events, packages, terminal
    /// Settings of the Space, opened from its tile (src/web/App.tsx `openSettings`).
    case settings
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
        case .settings: return "settings"
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
        .background {
            // Settings keeps the Space's backdrop behind it, as when it was a page of the launcher.
            if page == .settings {
                SpaceBackdrop(space: connection.url, dataStore: model.dataStore(connection.id))
            } else {
                Theme.ground
            }
        }
    }

    private var content: some View {
        HubPageContent(model: model, connection: connection, page: page, loader: loader, icons: icons)
    }
}

/// What a page of the Space shows: over the launcher in HubContainer, or inside Settings' pane.
struct HubPageContent: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let page: HubPage
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
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
        case .settings:
            SettingsPage(model: model, connection: connection, loader: loader, settings: model.settings(for: connection), icons: icons, prefs: model.prefs)
                .navigationTitle(Text("Settings"))
        case .chat(let agent):
            if let agent, let live = model.lives[connection.id], let chats = model.conversations(AgentRef(connection: connection.id, agent: agent)) {
                AgentChatPage(model: model, connection: connection, loader: loader, icons: icons, live: live, chats: chats, agent: agent)
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
                let machines = loader.catalogue?.agentGroup(agent)?.machines ?? [agent]
                Button { model.destination = .hub(.chat(agent: model.preferredAgent(agent, in: connection).ref)) } label: {
                    HStack(spacing: 12) {
                        EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 36, isRound: true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: agent.displayTitle()).foregroundStyle(Theme.text)
                            if let detail = agent.displayDetail() { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        if machines.contains(where: { m in running.contains { $0.agent == m.ref || m.ref.hasSuffix("/" + $0.agent) } }) {
                            ProgressView().controlSize(.small).help("Working")
                        }
                        if machines.count > 1 || agent.peer != nil {
                            Text(verbatim: machines.map { $0.peer ?? String(localized: "This machine") }.joined(separator: ", "))
                                .font(.caption).foregroundStyle(.tertiary).lineLimit(1)
                        }
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                    .accessibilityElement(children: .combine)
                }
                .buttonStyle(.plain)
                .padding(.vertical, 3)
                .disabled(machines.allSatisfy(\.isOffline))
            }
        }
        .navigationTitle(Text("Chat"))
        .reloadable { await loader.refresh() }
    }
}

/// One agent's conversations in the main window: the sidebar, and the conversation on show. A
/// conversation keeps running while another one is shown.
struct AgentChatPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    let live: SpaceLive
    @ObservedObject var chats: AgentChats
    /// The agent on show, by its id.
    let agent: String

    var body: some View {
        let entry = loader.catalogue?.agent("agent:\(agent)")
        let group = entry.flatMap { loader.catalogue?.agentGroup($0) }
        HStack(spacing: 0) {
            ChatSidebar(model: model, connection: connection, loader: loader, icons: icons, live: live, chats: chats, current: agent)
            Divider()
            VStack(spacing: 0) {
                if let group, group.isShared {
                    MachineMenu(model: model, connection: connection, group: group, current: agent)
                }
                ChatView(chat: chats.current, icons: icons, compact: false,
                         offlineMachine: entry?.isOffline == true ? entry?.peer ?? String(localized: "This machine") : nil)
                    .id(chats.current.id)
            }
        }
        .navigationTitle(Text(verbatim: chats.agent.displayTitle))
    }
}

/// Beside the main window's conversation (src/web/Chat.tsx `chat-side`): New Conversation, the
/// agents to switch to (a busy one marked) and the shown agent's conversations, kept in view
/// rather than behind a menu: the ones open here and not stored yet, then the stored ones, each
/// marked while a turn runs in it, here or on another client.
struct ChatSidebar: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var live: SpaceLive
    @ObservedObject var chats: AgentChats
    /// The agent on show, by its id.
    let current: String

    var body: some View {
        let groups = loader.catalogue?.agentGroups ?? []
        let rows = chats.rows(running: live.running)
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                Button { chats.newConversation() } label: {
                    Label("New Conversation", systemImage: "square.and.pencil")
                        .font(.callout.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 7)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.text)
                .disabled(chats.current.blank)
                .help("New Conversation")
                // One entry per agent whatever its machines; the menu above the chat picks the machine.
                if groups.count > 1 {
                    heading("Agents")
                    ForEach(groups) { group in
                        let agent = group.primary
                        let on = group.machines.contains { $0.ref == current }
                        item(on: on, action: { if !on { model.destination = .hub(.chat(agent: model.preferredAgent(agent, in: connection).ref)) } }) {
                            EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 20, isRound: true)
                            Text(verbatim: agent.displayTitle()).lineLimit(1)
                            Spacer(minLength: 4)
                            if group.machines.contains(where: { busy($0.ref) }) {
                                Circle().fill(Theme.accent).frame(width: 7, height: 7).help("Working")
                            }
                        }
                        .disabled(group.machines.allSatisfy(\.isOffline))
                    }
                }
                heading("Recent")
                if rows.isEmpty {
                    Text("No earlier chats").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 8)
                }
                ForEach(rows.prefix(30)) { row in
                    let title = row.title ?? (row.sid == nil ? String(localized: "New Conversation") : String(localized: "Untitled"))
                    item(on: row.conversation == chats.current.id, action: { pick(row) }) {
                        Text(verbatim: title).lineLimit(1)
                        Spacer(minLength: 4)
                        if row.busy {
                            Circle().fill(Theme.accent).frame(width: 7, height: 7).help("Working")
                        } else if let ts = row.ts {
                            Text(verbatim: Times.ago(Date(timeIntervalSince1970: ts / 1000))).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .help(title)
                }
            }
            .padding(10)
        }
        .frame(width: 230)
        .background(.thinMaterial)
        .task { await chats.loadSessions() }
        // A turn started on the web panel or another device shows up as a conversation here.
        .onReceive(live.$running) { chats.attach($0) }
    }

    /// Shows a row's conversation: the open one, else the stored session loaded.
    private func pick(_ row: ChatRoster.Row) {
        if let id = row.conversation, let chat = chats.conversation(id) {
            chats.show(chat)
        } else if let sid = row.sid, let session = chats.sessions.first(where: { $0.sid == sid }) {
            Task { await chats.open(session) }
        }
    }

    private func busy(_ ref: String) -> Bool {
        if ref == current { return chats.busy }
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

/// Above a conversation with an agent that runs on several machines (src/web/Chat.tsx): which
/// machine it is talking to. Each machine keeps its own conversation; an offline one is shown
/// and cannot be picked. The choice is remembered on this Mac.
struct MachineMenu: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let group: AgentGroup
    /// The variant on show, by its ref.
    let current: String

    var body: some View {
        let shown = group.machines.first { $0.ref == current }
        HStack {
            Spacer(minLength: 0)
            Menu {
                ForEach(group.machines) { m in
                    Button {
                        guard m.ref != current, !m.isOffline else { return }
                        MachineChoice.remember(group.key, peer: m.peer, space: connection.id)
                        model.destination = .hub(.chat(agent: m.ref))
                    } label: {
                        if m.ref == current {
                            Label(label(m), systemImage: "checkmark")
                        } else {
                            Text(verbatim: label(m))
                        }
                    }
                    .disabled(m.isOffline && m.ref != current)
                }
            } label: {
                Label(shown.map { label($0) } ?? "", systemImage: "desktopcomputer")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("The machine the agent runs on")
        }
        .font(.caption)
        .padding(.horizontal, 20).padding(.vertical, 6)
    }

    private func label(_ m: CatalogueEntry) -> String {
        let name = m.peer ?? String(localized: "This machine")
        return m.isOffline ? name + " (" + String(localized: "offline") + ")" : name
    }
}
