import AppKit
import SwiftUI

/// A floating panel over whatever app is in front, opened by the global shortcut: pick an agent,
/// type, read the reply, press Esc. The conversation is the same one the main window shows.
@MainActor
final class QuickChat: NSObject, NSWindowDelegate {
    private let model: AppModel
    private lazy var panel: QuickChatPanel = makePanel()

    init(model: AppModel) {
        self.model = model
    }

    var isVisible: Bool { panel.isVisible }

    func toggle() {
        if panel.isVisible && panel.isKeyWindow { hide() } else { show() }
    }

    /// Opens the panel, optionally on an agent and with text to send; it never sends by itself.
    func show(agent: String? = nil, text: String? = nil) {
        if let agent { model.quickChatSelect(agentID: agent) }
        if let text, let chat = model.quickChatController {
            chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n\n" + text
        }
        if !panel.isVisible { position() }
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() {
        panel.orderOut(nil)
    }

    private func position() {
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let frame = screen?.visibleFrame else { panel.center(); return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - size.height - frame.height * 0.12))
    }

    private func makePanel() -> QuickChatPanel {
        let panel = QuickChatPanel(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 460),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.minSize = NSSize(width: 460, height: 320)
        // Esc and the header's close button close it; the traffic lights would sit on the header.
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.delegate = self
        panel.onEscape = { [weak self] in self?.hide() }
        panel.contentView = NSHostingView(rootView: QuickChatView(model: model, close: { [weak self] in self?.hide() }))
        panel.setFrameAutosaveName("QuickChat")
        return panel
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()
        return false
    }
}

final class QuickChatPanel: NSPanel {
    var onEscape: () -> Void = {}
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onEscape()
    }
}

/// Whether the agent list is open over the header (view state lives in an object: the Command
/// Line Tools build has no `@State` storage for these views).
@MainActor
final class QuickChatState: ObservableObject {
    @Published var picking = false
}

/// The panel: one header line (the agent, what it is doing, and the panel's actions), then the
/// conversation. Nothing above the thread is taller than the header, so a short panel still shows
/// most of the reply.
struct QuickChatView: View {
    @ObservedObject var model: AppModel
    let close: () -> Void
    @StateObject private var state = QuickChatState()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                AgentPicker(model: model, state: state)
                if let chat = model.quickChatController { WorkingMark(chat: chat) }
                Spacer(minLength: 8)
                if let chat = model.quickChatController { NewConversationButton(chat: chat) }
                HeaderButton(symbol: "macwindow", help: "Open in Main Window (⌘O)") { model.openQuickChatInMainWindow(); close() }
                    .keyboardShortcut("o", modifiers: .command)
                    .disabled(model.quickChatController == nil)
                HeaderButton(symbol: "xmark", help: "Close (Esc)", action: close)
            }
            .padding(.leading, 10).padding(.trailing, 8)
            .frame(height: 44)
            Divider()
            if let chat = model.quickChatController {
                ChatView(chat: chat, icons: nil, compact: true)
                    .id(chat.agent.id)
            } else {
                NoAgent(model: model)
            }
        }
        .background(.regularMaterial)
    }
}

/// A borderless symbol button of the header, with a hover fill so it reads as a control.
private struct HeaderButton: View {
    let symbol: String
    let help: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 13, weight: .medium))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(HeaderButtonStyle())
        .help(help)
        .accessibilityLabel(Text(help))
    }
}

struct HeaderButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HeaderButtonBody(configuration: configuration)
    }

    private struct HeaderButtonBody: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isEnabled) private var enabled
        @StateObject private var hover = Hover()

        var body: some View {
            configuration.label
                .foregroundStyle(.secondary)
                .background(Color.primary.opacity(configuration.isPressed ? 0.12 : hover.on && enabled ? 0.07 : 0),
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .opacity(enabled ? 1 : 0.45)
                .onHover { hover.on = $0 }
        }
    }
}

@MainActor
final class Hover: ObservableObject {
    @Published var on = false
}

private struct NewConversationButton: View {
    @ObservedObject var chat: ChatController

    var body: some View {
        HeaderButton(symbol: "square.and.pencil", help: "New Conversation (⌘N)") { chat.newConversation() }
            .keyboardShortcut("n", modifiers: .command)
            .disabled(chat.busy || chat.messages.isEmpty)
    }
}

/// A small spinner beside the agent while its turn runs, so the header says it is working.
private struct WorkingMark: View {
    @ObservedObject var chat: ChatController

    var body: some View {
        if chat.busy {
            ProgressView().controlSize(.small).help("Working")
        }
    }
}

/// What the panel shows with no agent to talk to: the mark while the Spaces answer, else why.
private struct NoAgent: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let connecting = model.store.connections.contains { model.lives[$0.id]?.status == .unknown }
        if connecting {
            Connecting()
        } else {
            VStack(spacing: 12) {
                Image(systemName: "bubble.left.and.text.bubble.right").font(.system(size: 28)).foregroundStyle(.secondary)
                Text(model.store.connections.isEmpty ? "Add a connection first." : "No agents yet. Sign in on the panel or check the connection.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("Open ai-space") { model.showMainWindow() }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// The agent being talked to, as a button that lists every agent of every connection (grouped by
/// connection when there is more than one). A list of its own and not a menu: a menu draws an
/// avatar at the size it was stored at (128 points) and drops the name beside it.
struct AgentPicker: View {
    @ObservedObject var model: AppModel
    @ObservedObject var state: QuickChatState

    var body: some View {
        Button { state.picking.toggle() } label: {
            HStack(spacing: 8) {
                if let ref = model.quickChatResolvedRef, let agent = model.lives[ref.connection]?.agent(ref.agent) {
                    if let icons = model.icons(ref.connection) {
                        EntryIcon(icon: agent.avatar, fallback: "person.fill", icons: icons, size: 24, isRound: true)
                    }
                    Text(verbatim: agent.displayTitle).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                    if let peer = agent.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                } else {
                    Text("Choose an Agent").font(.headline)
                }
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 6).padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(HeaderButtonStyle())
        .keyboardShortcut("j", modifiers: .command)
        .help("Choose an Agent (⌘J)")
        .popover(isPresented: $state.picking, arrowEdge: .bottom) {
            AgentList(model: model) { key in
                model.quickChatSelect(agentID: key)
                state.picking = false
            }
        }
    }
}

/// Every agent the panel can talk to, with its avatar, what it does, and whether it is working.
private struct AgentList: View {
    @ObservedObject var model: AppModel
    let pick: (String) -> Void

    var body: some View {
        let current = model.quickChatResolvedRef
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(model.store.connections) { c in
                    if let live = model.lives[c.id], !live.agents.isEmpty {
                        if model.store.connections.count > 1 {
                            Text(verbatim: c.name).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                .padding(.horizontal, 8).padding(.top, 6)
                        }
                        ForEach(live.agents) { a in
                            let ref = AgentRef(connection: c.id, agent: a.id)
                            AgentRow(agent: a, icons: model.icons(c.id), current: ref == current,
                                     working: live.running.contains { $0.agent == "\(a.app)/\(a.name)" && a.peer == nil }) {
                                pick(ref.key)
                            }
                        }
                    }
                }
            }
            .padding(6)
        }
        .frame(width: 320)
        .frame(maxHeight: 380)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct AgentRow: View {
    let agent: AgentInfo
    let icons: IconStore?
    let current: Bool
    let working: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let icons { EntryIcon(icon: agent.avatar, fallback: "person.fill", icons: icons, size: 30, isRound: true) }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text(verbatim: agent.displayTitle).font(.callout.weight(current ? .semibold : .regular)).foregroundStyle(Theme.text)
                        if let peer = agent.peer { Text(verbatim: "· \(peer)").font(.caption).foregroundStyle(.secondary) }
                    }
                    if let d = agent.description {
                        Text(Lang.pick(d, agent.i18n, \.description)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if working { ProgressView().controlSize(.mini).help("Working") }
                if current { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Theme.accent) }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(selected: current))
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

private struct RowButtonStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, selected: selected)
    }

    private struct RowBody: View {
        let configuration: ButtonStyle.Configuration
        let selected: Bool
        @StateObject private var hover = Hover()

        var body: some View {
            configuration.label
                .background(Color.primary.opacity(configuration.isPressed ? 0.1 : hover.on ? 0.06 : 0),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .background(selected ? Theme.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .onHover { hover.on = $0 }
        }
    }
}
