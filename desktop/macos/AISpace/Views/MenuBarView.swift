import SwiftUI

/// The menu bar window: for each connection, who is working, what is unread, and the apps.
struct MenuBarView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: ConnectionStore
    @ObservedObject var prefs = Preferences.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if store.connections.isEmpty {
                Text("No connection yet.").foregroundStyle(.secondary)
            }
            ForEach(store.connections) { c in
                if let live = model.lives[c.id] { ConnectionSummary(model: model, connection: c, live: live) }
            }
            Divider()
            HStack {
                Button {
                    model.quickChat?()
                } label: {
                    Label("Quick Chat", systemImage: "bubble.left.and.text.bubble.right")
                }
                if prefs.quickChat != .off { Text(prefs.quickChat.label).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Open ai-space") { model.showMainWindow() }
            }
            HStack {
                SettingsLink { Text("Settings…") }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .font(.callout)
        }
        .buttonStyle(.borderless)
        .padding(14)
        .frame(width: 340)
    }
}

private struct ConnectionSummary: View {
    let model: AppModel
    let connection: Connection
    @ObservedObject var live: SpaceLive

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(connection.name).font(.headline)
                Spacer()
                switch live.status {
                case .ok:
                    if !live.running.isEmpty {
                        Label("\(live.running.count) working", systemImage: "gearshape.2").font(.caption).foregroundStyle(.secondary)
                    }
                case .signInNeeded:
                    Button("Sign In") { model.showMainWindow(connection: connection.id, .panel) }.font(.caption)
                case .offline:
                    Text("Offline").font(.caption).foregroundStyle(.red)
                case .unknown:
                    ProgressView().controlSize(.mini)
                }
            }
            ForEach(live.running.prefix(3)) { run in
                Button {
                    model.showMainWindow(connection: connection.id, .agent(agentID(run)))
                } label: {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(run.message).lineLimit(1).foregroundStyle(.secondary)
                    }
                }
            }
            let unread = live.inbox.filter(\.unread)
            if !unread.isEmpty {
                ForEach(unread.prefix(4)) { item in
                    Button { model.openInboxItem(connection: connection.id, url: item.url); Task { await live.mark([item.thread], read: true) } } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title?.isEmpty == false ? item.title! : item.app).font(.callout).lineLimit(1)
                            Text(item.text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                Button("Inbox (\(live.summary.unread) unread)") { model.showMainWindow(connection: connection.id, .inbox) }
                    .font(.caption)
            }
            if !live.apps.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(44), spacing: 8), count: 6), spacing: 8) {
                    ForEach(live.apps.prefix(12)) { app in
                        Button { model.openApp(app, connection: connection) } label: {
                            Avatar(live: live, path: app.icon, fallback: "app").frame(width: 30, height: 30)
                        }
                        .help(app.displayTitle)
                    }
                }
            }
        }
    }

    /// Runs name their agent `<app>/<name>`, which is the local agent's id as `/api/agents` lists it.
    private func agentID(_ run: ChatRun) -> String {
        live.agents.first { "\($0.app)/\($0.name)" == run.agent && $0.peer == nil }?.id ?? run.agent
    }
}

struct MenuBarLabel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let unread = model.lives.values.reduce(0) { $0 + $1.summary.unread }
        let working = model.lives.values.contains { !$0.running.isEmpty }
        HStack(spacing: 3) {
            Image(systemName: working ? "square.grid.2x2.fill" : "square.grid.2x2")
            if unread > 0 { Text("\(unread)") }
        }
    }
}
