import SwiftUI

/// The main window: a sidebar of the selected Space (panel, inbox, agents, apps) and the chosen
/// item beside it. Agents and the inbox are native; an app opens as a tab here and can be moved
/// into its own window.
struct MainView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: ConnectionStore

    var body: some View {
        Group {
            if let connection = model.selected {
                NavigationSplitView {
                    Sidebar(model: model, connection: connection)
                        .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
                } detail: {
                    Detail(model: model, connection: connection)
                }
            } else {
                FirstLaunchView(model: model)
            }
        }
        .frame(minWidth: 820, minHeight: 520)
    }
}

struct Detail: View {
    @ObservedObject var model: AppModel
    let connection: Connection

    var body: some View {
        switch model.destination {
        case .panel:
            SessionView(session: model.session(for: connection))
                .id(connection.id)
                .ignoresSafeArea(.container, edges: .top)
        case .inbox:
            if let live = model.lives[connection.id] { InboxView(model: model, live: live) }
        case .agent(let id):
            let ref = AgentRef(connection: connection.id, agent: id)
            if let live = model.lives[connection.id], let chat = model.chat(ref) {
                ChatView(chat: chat, live: live, compact: false)
                    .id(ref)
                    .navigationTitle(chat.agent.displayTitle)
            } else {
                ContentUnavailableView("Agent not available", systemImage: "person.crop.circle.badge.questionmark",
                                       description: Text("Sign in on the panel or check the connection."))
            }
        case .app(let id):
            if let tab = model.tab(id, connection: connection.id) {
                AppPageView(session: tab.session)
                    .id(tab.session.home)
                    .navigationTitle(tab.app.displayTitle)
                    .toolbar {
                        ToolbarItem {
                            Button { model.moveToWindow(id, connection: connection.id) } label: {
                                Label("Open in New Window", systemImage: "macwindow.badge.plus")
                            }
                            .help("Open in New Window (⌥⌘T)")
                        }
                        ToolbarItem {
                            Button { model.closeTab(id, connection: connection.id) } label: { Label("Close", systemImage: "xmark") }
                                .help("Close")
                        }
                    }
            } else {
                ContentUnavailableView("This app is not open", systemImage: "app.dashed")
            }
        }
    }
}

struct Sidebar: View {
    @ObservedObject var model: AppModel
    let connection: Connection

    var body: some View {
        let live = model.lives[connection.id]
        List(selection: Binding(get: { model.destination }, set: { choose($0) })) {
            Section {
                Label("Home", systemImage: "square.grid.2x2").tag(Destination.panel)
                HStack {
                    Label("Inbox", systemImage: "tray")
                    Spacer()
                    if let n = live?.summary.unread, n > 0 { Text("\(n)").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                }
                .tag(Destination.inbox)
            }
            if let live {
                if !live.agents.isEmpty {
                    Section("Agents") {
                        ForEach(live.agents) { agent in
                            HStack(spacing: 8) {
                                Avatar(live: live, path: agent.avatar, fallback: "person.crop.circle").frame(width: 20, height: 20)
                                Text(agent.displayTitle).lineLimit(1)
                                Spacer()
                                if live.running.contains(where: { $0.agent == "\(agent.app)/\(agent.name)" }) {
                                    ProgressView().controlSize(.mini).help("Working")
                                }
                                if let peer = agent.peer { Text(peer).font(.caption2).foregroundStyle(.tertiary) }
                            }
                            .tag(Destination.agent(agent.id))
                        }
                    }
                }
                if !live.apps.isEmpty {
                    Section("Apps") {
                        ForEach(live.apps) { app in
                            AppRow(model: model, live: live, app: app, connection: connection)
                                .tag(Destination.app(app.id))
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top) { ConnectionHeader(model: model, connection: connection, live: live) }
    }

    /// Choosing an app opens it as a tab; an app already in its own window comes forward instead.
    private func choose(_ d: Destination?) {
        guard let d else { return }
        if case .app(let id) = d {
            guard let app = model.lives[connection.id]?.apps.first(where: { $0.id == id }) else { return }
            model.openApp(app, connection: connection)
        } else {
            model.destination = d
        }
    }
}

/// An app in the sidebar: open as a tab (with a close button), in its own window, or closed.
private struct AppRow: View {
    @ObservedObject var model: AppModel
    let live: SpaceLive
    let app: AppInfo
    let connection: Connection

    var body: some View {
        let open = model.tab(app.id, connection: connection.id) != nil
        let windowed = model.appWindows.isOpen(app.id, connection: connection.id)
        HStack(spacing: 8) {
            Avatar(live: live, path: app.icon, fallback: "app").frame(width: 20, height: 20)
            Text(app.displayTitle).lineLimit(1)
            Spacer()
            if let peer = app.peer { Text(peer).font(.caption2).foregroundStyle(.tertiary) }
            if windowed {
                Image(systemName: "macwindow").font(.caption).foregroundStyle(.secondary).help("In its own window")
            } else if open {
                Button { model.closeTab(app.id, connection: connection.id) } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).help("Close")
            }
        }
        .contextMenu {
            if windowed {
                Button("Show Window") { model.openApp(app, connection: connection) }
            } else {
                Button("Open") { model.openApp(app, connection: connection) }
                Button("Open in New Window") {
                    if !open { model.openApp(app, connection: connection) }
                    model.moveToWindow(app.id, connection: connection.id)
                }
                if open { Button("Close") { model.closeTab(app.id, connection: connection.id) } }
            }
        }
    }
}

/// The connection switcher and its state, at the top of the sidebar.
struct ConnectionHeader: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let live: SpaceLive?

    var body: some View {
        Menu {
            ForEach(model.store.connections) { c in
                Button { model.select(c.id) } label: {
                    if c.id == connection.id { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
            Divider()
            SettingsLink { Text("Edit Connections…") }
        } label: {
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 1) {
                    Text(connection.name).font(.headline).lineLimit(1)
                    Text(statusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    private var statusColor: Color {
        switch live?.status {
        case .ok: return .green
        case .signInNeeded: return .orange
        case .offline: return .red
        default: return .gray
        }
    }

    private var statusText: LocalizedStringKey {
        switch live?.status {
        case .ok:
            let n = live?.running.count ?? 0
            return n > 0 ? "\(n) agents working" : "Connected"
        case .signInNeeded: return "Sign in on Home"
        case .offline: return "Offline"
        default: return "Connecting…"
        }
    }
}

/// An icon or avatar from the Space: an image path, an emoji, or a symbol while it loads.
struct Avatar: View {
    @ObservedObject var live: SpaceLive
    let path: String?
    let fallback: String

    var body: some View {
        if let image = live.image(path) {
            Image(nsImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 5))
        } else if let path, !path.isEmpty, !path.hasPrefix("/"), !path.hasPrefix("http") {
            Text(path).font(.system(size: 14)).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Image(systemName: fallback).resizable().scaledToFit().foregroundStyle(.secondary)
        }
    }
}

/// One connection's page with its connection state over it.
struct SessionView: View {
    @ObservedObject var session: PanelSession

    var body: some View {
        ZStack(alignment: .top) {
            PanelWebView(session: session)
            switch session.state {
            case .connecting where session.webView.url == nil:
                ProgressView("Connecting…").padding(40)
            case .authenticationRequired:
                SignInBanner(session: session)
            case .unreachable(let detail):
                FailureView(session: session, title: "Cannot reach this Space", detail: detail)
            case .incompatible(let detail):
                FailureView(session: session, title: "This address is not an ai-space panel", detail: detail)
            default:
                EmptyView()
            }
        }
    }
}

/// Shown above the access layer's sign-in page, which stays usable underneath.
struct SignInBanner: View {
    let session: PanelSession

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.badge.key")
            Text("Sign in to continue. If sign-in does not work here, use the browser.")
            Spacer()
            Button("Open in Browser") { NSWorkspace.shared.open(session.browserURL) }
            Button("Retry") { session.load() }
        }
        .font(.callout)
        .padding(10)
        .background(.bar)
    }
}

struct FailureView: View {
    let session: PanelSession
    let title: LocalizedStringKey
    let detail: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 36)).foregroundStyle(.secondary)
            Text(title).font(.title2)
            Text(session.home.absoluteString).font(.callout.monospaced()).textSelection(.enabled)
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if session.connection.isLocal && session.verifiesSpace {
                Text("Start ai-space on this Mac with `space start`, then retry. The app never starts a second Space on its own.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            HStack {
                Button("Retry") { session.load() }.keyboardShortcut(.defaultAction)
                if session.verifiesSpace { SettingsLink { Text("Edit Connections…") } }
                if !session.connection.isLocal {
                    Button("Open in Browser") { NSWorkspace.shared.open(session.home) }
                }
            }
        }
        .frame(maxWidth: 460)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

struct FirstLaunchView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 96, height: 96)
            Text("Connect to a Space").font(.largeTitle)
            Text("Open an ai-space that is already running, on this Mac or on a server. Nothing is installed or started.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            ConnectionForm(initial: nil) { name, url in model.add(name: name, url: url) }
                .frame(width: 440)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
