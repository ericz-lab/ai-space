import SwiftUI

/// The Space's terminal: a shell on the Space's machine or on a peer, one tab per session, drawn
/// by the phone over the routes the panel's page uses (docs/terminal.md). The Space decides what
/// runs; the phone sends keystrokes and the window size.
struct TerminalPage: View {
    @ObservedObject var store: TerminalStore

    var body: some View {
        Group {
            if let tab = store.currentTab {
                VStack(spacing: 0) {
                    TerminalTabStrip(store: store)
                    TerminalSurface(tab: tab)
                        // A view per tab: each keeps its own emulator and scrollback.
                        .id(tab.id)
                        .background(Color(TerminalPalette.ground).ignoresSafeArea(edges: .bottom))
                        .onAppear { tab.focus() }
                }
            } else {
                TerminalStart(store: store)
            }
        }
        .navigationTitle(Text("Terminal"))
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if !store.tabs.isEmpty {
                    Button { store.showingRecent = true } label: { Image(systemName: "clock.arrow.circlepath") }
                        .accessibilityLabel(Text("Recent sessions"))
                }
                Menu {
                    ForEach(store.machines) { machine in
                        Button { store.open(on: machine) } label: { Text(verbatim: TerminalStart.label(machine)) }
                            .disabled(!machine.canOpen)
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(Text("New session"))
                .disabled(!store.machines.contains(where: \.canOpen))
            }
        }
        .task { await store.refresh() }
        .sheet(isPresented: $store.showingRecent) {
            NavigationStack {
                List { TerminalRecentRows(store: store) }
                    .navigationTitle(Text("Recent sessions"))
                    .navigationBarTitleDisplayMode(.inline)
                    .refreshable { await store.refresh() }
            }
            .presentationDetents([.medium, .large])
        }
        .alert(Text("Terminal passphrase"), isPresented: Binding(get: { store.asking != nil }, set: { if !$0 { store.asking = nil } }), presenting: store.asking) { ask in
            SecureField("Passphrase", text: $store.passphraseDraft)
            Button("Open") { store.submit(for: ask.machine) }
            Button("Cancel", role: .cancel) { store.passphraseDraft = "" }
        } message: { ask in
            if let message = ask.message {
                Text(verbatim: "\(ask.machine.name): \(message)")
            } else {
                Text("\(ask.machine.name) asks for its passphrase before a shell opens. It is kept in memory only.")
            }
        }
    }
}

/// The page before a session is open: where a shell can start, and what ran before.
private struct TerminalStart: View {
    @ObservedObject var store: TerminalStore

    var body: some View {
        List {
            Section {
                HubNotice(store: store)
                ForEach(store.machines) { machine in
                    Button { store.open(on: machine) } label: {
                        HStack(spacing: 12) {
                            Dot(color: machine.canOpen ? Theme.success : .secondary)
                            Text(verbatim: machine.name).foregroundStyle(Theme.text)
                            Spacer()
                            Text(verbatim: Self.state(machine)).font(.subheadline).foregroundStyle(Color.secondary)
                        }
                    }
                    .disabled(!machine.canOpen)
                }
            } header: {
                Text("Open a shell on")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    if store.loaded, !store.machines.contains(where: \.canOpen) {
                        Text("No machine of this Space offers a terminal. It is off until SPACE_TERMINAL_ENABLED=1 is set in a machine's workspace .env.")
                    }
                    Text("The shell runs on that machine as the Space's own user. A session ends when its connection does, and the phone drops it in the background: run tmux inside for work that must outlive it. The Space records when a session ran, never what was typed or shown.")
                }
            }
            TerminalRecentRows(store: store)
        }
        .refreshable { await store.refresh() }
    }

    static func state(_ machine: TerminalMachine) -> String {
        if machine.isDown { return String(localized: "offline") }
        return machine.enabled ? String(localized: "on") : String(localized: "off")
    }

    static func label(_ machine: TerminalMachine) -> String {
        machine.canOpen ? machine.name : "\(machine.name) (\(state(machine)))"
    }
}

/// The Space's audit rows for its own machine: when a session ran and how it ended.
private struct TerminalRecentRows: View {
    @ObservedObject var store: TerminalStore

    var body: some View {
        if let recent = store.status?.recent, !recent.isEmpty {
            Section {
                ForEach(recent) { row in
                    HStack(spacing: 12) {
                        Dot(color: row.isOpen ? Theme.success : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: HubFormat.relative(row.started)).foregroundStyle(Theme.text)
                            Text(verbatim: Self.detail(row)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Recent sessions")
            }
        }
    }

    static func detail(_ row: TerminalRecent) -> String {
        guard let seconds = row.duration else { return String(localized: "open") }
        var parts = [HubFormat.duration(ms: seconds * 1000)]
        switch row.reason {
        case "exit": parts.append(row.exitCode.map { String(localized: "exit \($0)") } ?? String(localized: "ended by a signal"))
        case "closed": parts.append(String(localized: "client left"))
        case "idle": parts.append(String(localized: "idle"))
        case "killed": parts.append(String(localized: "ended by the operator"))
        case "lost": parts.append(String(localized: "ai-space restarted"))
        case let other?: parts.append(other)
        case nil: break
        }
        return parts.joined(separator: " · ")
    }
}

/// One chip per session: a dot for its state, its name, and a way to end it.
private struct TerminalTabStrip: View {
    @ObservedObject var store: TerminalStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(store.tabs) { tab in
                    TerminalTabChip(tab: tab, session: tab.session, selected: tab.id == store.current,
                                    select: { store.current = tab.id }, close: { store.close(tab) })
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
        }
        .background(.bar)
    }
}

private struct TerminalTabChip: View {
    let tab: TerminalTab
    @ObservedObject var session: TerminalSession
    let selected: Bool
    let select: () -> Void
    let close: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: select) {
                HStack(spacing: 6) {
                    Dot(color: colour, size: 7)
                    Text(verbatim: tab.title).font(.footnote.weight(selected ? .semibold : .regular)).foregroundStyle(Theme.text).lineLimit(1)
                }
            }
            .accessibilityValue(Text(verbatim: state))
            Button(action: close) {
                Image(systemName: "xmark").font(.caption2.weight(.semibold)).foregroundStyle(.secondary).frame(width: 22, height: 22)
            }
            .accessibilityLabel(Text("End session"))
        }
        .buttonStyle(.plain)
        .padding(.leading, 10).padding(.trailing, 4).padding(.vertical, 3)
        .background(selected ? Theme.solid : Theme.hairline, in: Capsule())
    }

    private var colour: Color {
        switch session.state {
        case .connecting: return Theme.warning
        case .open: return Theme.success
        case .closed: return .secondary
        }
    }

    private var state: String {
        switch session.state {
        case .connecting: return String(localized: "connecting")
        case .open: return String(localized: "open")
        case .closed: return String(localized: "closed")
        }
    }
}
