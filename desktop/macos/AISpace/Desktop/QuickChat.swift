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

struct QuickChatView: View {
    @ObservedObject var model: AppModel
    let close: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                AgentPicker(model: model)
                Spacer()
                if let chat = model.quickChatController {
                    Button { chat.newConversation() } label: { Image(systemName: "square.and.pencil") }
                        .buttonStyle(.borderless).help("New Conversation").disabled(chat.busy)
                }
                Button { model.openQuickChatInMainWindow(); close() } label: { Image(systemName: "macwindow") }
                    .buttonStyle(.borderless).help("Open in Main Window").disabled(model.quickChatController == nil)
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            if let chat = model.quickChatController {
                ChatView(chat: chat, live: model.quickChatLive, compact: true)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "bubble.left.and.text.bubble.right").font(.system(size: 30)).foregroundStyle(.secondary)
                    Text(model.store.connections.isEmpty ? "Add a connection first." : "No agents yet. Sign in on the panel or check the connection.")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(.regularMaterial)
    }
}

/// Every agent of every connection, grouped by connection when there is more than one.
struct AgentPicker: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Menu {
            ForEach(model.store.connections) { c in
                if let live = model.lives[c.id] {
                    Section(model.store.connections.count > 1 ? c.name : "") {
                        ForEach(live.agents) { a in
                            Button(a.peer.map { "\(a.displayTitle) · \($0)" } ?? a.displayTitle) {
                                model.quickChatSelect(agentID: AgentRef(connection: c.id, agent: a.id).key)
                            }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                if let ref = model.quickChatResolvedRef, let live = model.lives[ref.connection], let agent = live.agent(ref.agent) {
                    Avatar(live: live, path: agent.avatar, fallback: "person.crop.circle").frame(width: 22, height: 22)
                    Text(agent.displayTitle).font(.headline)
                } else {
                    Text("Choose an Agent").font(.headline)
                }
            }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}
