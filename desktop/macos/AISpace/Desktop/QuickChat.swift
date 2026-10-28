import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// A floating panel over whatever app is in front, opened by the global shortcut or a section of
/// the floating ball: type or paste text and pictures, read the reply, press Esc or click
/// elsewhere. The conversation is the same one the main window shows. Drawn to Design Studio's
/// spec (design 12): 380 pt wide, rounded glass, only the header and the field while the
/// conversation is empty (96 pt), growing upward with the replies to at most 420 pt.
@MainActor
final class QuickChat: NSObject, NSWindowDelegate {
    static let width: CGFloat = 380
    static let maxHeight: CGFloat = 420

    private let model: AppModel
    private lazy var panel: QuickChatPanel = makePanel()
    /// The screen rect the panel was opened beside (the floating ball), or nil for the shortcut.
    private var anchor: NSRect?

    init(model: AppModel) {
        self.model = model
    }

    var isVisible: Bool { panel.isVisible }

    func toggle() {
        if panel.isVisible && panel.isKeyWindow { hide() } else { show() }
    }

    /// Opens the panel, optionally on an agent, with text to send and beside `near` (the floating
    /// ball's frame); it never sends by itself.
    func show(agent: String? = nil, text: String? = nil, near: NSRect? = nil) {
        if let agent { model.quickChatSelect(agentID: agent) }
        if let text, let chat = model.quickChatController {
            chat.draft = chat.draft.isEmpty ? text : chat.draft + "\n\n" + text
        }
        if !panel.isVisible || near != nil {
            anchor = near
            position(height: panel.frame.height)
        }
        NSApp.activate()
        panel.makeKeyAndOrderFront(nil)
    }

    func hide() {
        panel.orderOut(nil)
    }

    /// Places the panel: beside the ball, its bottom a little under the ball's middle so it grows
    /// upward past it, on the side with room; for the shortcut, in the upper middle of the screen.
    private func position(height: CGFloat) {
        let screen = anchor.flatMap { a in NSScreen.screens.first { $0.frame.intersects(a) } } ?? NSScreen.main ?? NSScreen.screens.first
        guard let visible = screen?.visibleFrame else { panel.center(); return }
        var origin: NSPoint
        if let a = anchor {
            let gap: CGFloat = 12
            let left = a.minX - gap - Self.width
            origin = NSPoint(x: left >= visible.minX ? left : a.maxX + gap, y: a.midY - 48)
        } else {
            origin = NSPoint(x: visible.midX - Self.width / 2, y: visible.maxY - visible.height * 0.12 - Self.maxHeight)
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - Self.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - height - 8)
        panel.setFrame(NSRect(origin: origin, size: NSSize(width: Self.width, height: height)), display: true)
    }

    /// The content asks for a height: the bottom edge stays where it is and the panel grows up,
    /// kept under the top of the screen.
    private func fit(_ height: CGFloat) {
        let h = min(max(height.rounded(.up), 60), Self.maxHeight)
        guard abs(panel.frame.height - h) > 0.5 else { return }
        var frame = panel.frame
        frame.size = NSSize(width: Self.width, height: h)
        if let visible = (panel.screen ?? NSScreen.main)?.visibleFrame, frame.maxY > visible.maxY - 8 {
            frame.origin.y = visible.maxY - 8 - h
        }
        panel.setFrame(frame, display: true)
        panel.invalidateShadow()
    }

    private func makePanel() -> QuickChatPanel {
        let panel = QuickChatPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.width, height: 96),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.animationBehavior = .none
        panel.delegate = self
        panel.onEscape = { [weak self] in self?.hide() }
        let view = QuickChatView(model: model, close: { [weak self] in self?.hide() },
                                 fit: { [weak self] height in self?.fit(height) })
        panel.contentView = NSHostingView(rootView: view)
        return panel
    }

    /// A click anywhere else closes the panel, as a popover does. Its own file picker, a sheet or
    /// a modal dialog of the app take the focus without closing it.
    func windowDidResignKey(_ notification: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isVisible, !self.panel.isKeyWindow,
                  self.panel.attachedSheet == nil, NSApp.modalWindow == nil,
                  !(NSApp.keyWindow is NSSavePanel) else { return }
            self.hide()
        }
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

/// The panel: a 40 pt header (the agent, what it is doing, close), the conversation once there is
/// one, and the field. It reports the height it needs, so the window can grow up to it.
struct QuickChatView: View {
    @ObservedObject var model: AppModel
    let close: () -> Void
    let fit: (CGFloat) -> Void
    @StateObject private var state = QuickChatState()
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                AgentPicker(model: model, state: state)
                if let chat = model.quickChatController { WorkingMark(chat: chat) }
                Spacer(minLength: 8)
                // Kept for their keys (⌘N, ⌘O); the spec's header shows only the close button.
                if let chat = model.quickChatController { NewConversationButton(chat: chat).frame(width: 0, height: 0).opacity(0) }
                Button("") { model.openQuickChatInMainWindow(); close() }
                    .keyboardShortcut("o", modifiers: .command)
                    .disabled(model.quickChatController == nil)
                    .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
                CloseButton(action: close)
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            if let chat = model.quickChatController {
                FloatingChatBody(chat: chat, icons: model.quickChatResolvedRef.flatMap { model.icons($0.connection) })
                    .id(chat.agent.id)
            } else {
                NoAgent(model: model).frame(height: 120)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: QuickChat.width)
        .background(GeometryReader { geo in Color.clear.preference(key: QuickChatHeight.self, value: geo.size.height) })
        .onPreferenceChange(QuickChatHeight.self) { fit($0) }
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(scheme == .dark ? Color(red: 36 / 255, green: 36 / 255, blue: 40 / 255).opacity(0.8) : Color.white.opacity(0.8)))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(scheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08), lineWidth: 1))
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .frame(maxHeight: .infinity, alignment: .bottom)
    }
}

private struct QuickChatHeight: PreferenceKey {
    static let defaultValue: CGFloat = 96
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct ThreadHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The 20 pt round close button of the spec.
private struct CloseButton: View {
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 8, weight: .bold))
                .foregroundStyle(scheme == .dark ? Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.6) : Color(red: 60 / 255, green: 60 / 255, blue: 67 / 255).opacity(0.6))
                .frame(width: 20, height: 20)
                .background(Color(red: 120 / 255, green: 120 / 255, blue: 128 / 255).opacity(scheme == .dark ? 0.32 : 0.14), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Close (Esc)")
        .accessibilityLabel(Text("Close"))
    }
}

/// Holds what the body measures; the Command Line Tools build has no `@State` storage.
@MainActor
private final class FloatingChatState: ObservableObject {
    @Published var focused = true
    @Published var thread: CGFloat = 0
}

/// The conversation and the field of the panel: messages 13/18 pt with 8 pt between them in a
/// thread that scrolls past 324 pt, pictures waiting to go as 44 pt thumbnails, the field 36 pt
/// high at least with "↩ Send" inside it.
private struct FloatingChatBody: View {
    @ObservedObject var chat: ChatController
    let icons: IconStore?
    @ObservedObject private var preferences = Preferences.shared
    @StateObject private var state = FloatingChatState()
    @Environment(\.colorScheme) private var scheme

    private var placeholder: String {
        chat.busy ? String(localized: "Add to the reply in progress…") : String(localized: "Hand it to \(chat.agent.displayTitle)…")
    }

    var body: some View {
        VStack(spacing: 0) {
            if !chat.messages.isEmpty || chat.error != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(chat.messages) { message in
                                MessageRow(message: message,
                                           retry: message.id == chat.messages.last?.id && chat.retryableMessage != nil ? { chat.retry() } : nil,
                                           grant: message.id == chat.messages.last?.id && !chat.busy ? { chat.grantAndRetry() } : nil,
                                           grantPermission: preferences.chatPermission.granting(message.denied),
                                           answer: message.live ? { id, allow, answers in await chat.answer(id, allow: allow, answers: answers) } : nil)
                            }
                            if let error = chat.error {
                                Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Theme.danger)
                            }
                            Color.clear.frame(height: 1).id("end")
                        }
                        .font(.system(size: 13))
                        .padding(12)
                        .background(GeometryReader { geo in Color.clear.preference(key: ThreadHeight.self, value: geo.size.height) })
                    }
                    .frame(height: min(state.thread, 324))
                    .onPreferenceChange(ThreadHeight.self) { state.thread = $0 }
                    .onChange(of: chat.messages) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                if !chat.images.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(chat.images) { image in thumbnail(image) }
                    }
                    .padding(.top, 6)
                }
                if let error = chat.imageError { Text(error).font(.caption).foregroundStyle(Theme.danger) }
                field
            }
            .padding(.horizontal, 12)
            .padding(.top, chat.messages.isEmpty ? 0 : 10)
            .padding(.bottom, 10)
        }
        .onDrop(of: [UTType.image.identifier, UTType.fileURL.identifier], isTargeted: nil) { providers in
            for provider in providers.prefix(4) {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                        guard let data, let url = URL(dataRepresentation: data, relativeTo: nil), let bytes = try? PictureImport.read(url) else { return }
                        Task { @MainActor in chat.attach(bytes, name: url.lastPathComponent) }
                    }
                } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                    _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                        guard let data else { return }
                        Task { @MainActor in chat.attach(data, name: "Image") }
                    }
                }
            }
            return true
        }
    }

    private func thumbnail(_ image: ChatImage) -> some View {
        Group {
            if let picture = NSImage(data: image.bytes) {
                Image(nsImage: picture).resizable().scaledToFill()
            } else {
                Color.secondary.opacity(0.2)
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .topTrailing) {
            Button { chat.images.removeAll { $0.id == image.id } } label: {
                Image(systemName: "xmark").font(.system(size: 7, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 16, height: 16)
                    .background(Color.black.opacity(0.6), in: Circle())
            }
            .buttonStyle(.plain).offset(x: 5, y: -5)
            .help("Remove image").accessibilityLabel(Text("Remove image"))
        }
        .help(image.name)
    }

    private var field: some View {
        let empty = (chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.images.isEmpty) || chat.pendingImageImports > 0
        return HStack(alignment: .bottom, spacing: 6) {
            ChatTextInput(text: $chat.draft, focused: $state.focused, placeholder: placeholder,
                          onImage: { chat.attach($0, name: "Image") },
                          onImageFile: { url in
                              if let bytes = try? PictureImport.read(url) { chat.attach(bytes, name: url.lastPathComponent) }
                              else { chat.imageError = String(localized: "Could not read this image.") }
                          },
                          onSend: { chat.send() })
                .overlay(alignment: .topLeading) {
                    if chat.draft.isEmpty {
                        Text(placeholder).font(.system(size: 13)).foregroundStyle(.tertiary).allowsHitTesting(false)
                    }
                }
            if chat.busy {
                Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 16)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger)
                    .help("Stop").accessibilityLabel(Text("Stop"))
            } else {
                Text("↩ Send").font(.system(size: 11)).foregroundStyle(empty ? .tertiary : .secondary)
                    .padding(.bottom, 1)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(minHeight: 36)
        .background(scheme == .dark ? Color.white.opacity(0.06) : Color.white.opacity(0.7),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(state.focused ? Color(nsColor: .systemBlue).opacity(0.6) : (scheme == .dark ? Color.white.opacity(0.12) : Color.black.opacity(0.08)), lineWidth: 1))
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
                        EntryIcon(icon: agent.avatar, fallback: "person.fill", icons: icons, size: 22, isRound: true)
                    }
                    Text(verbatim: agent.displayTitle).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    if let peer = agent.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                } else {
                    Text("Choose an Agent").font(.system(size: 13, weight: .semibold))
                }
                Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4).padding(.vertical, 3)
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
