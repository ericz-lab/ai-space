import SwiftUI

/// A native conversation with one agent: messages, the activity of the running turn, and the
/// composer. Return sends, Shift-Return starts a new line, Stop ends the turn on the server.
/// Drawn as the iPhone's chat page: the agent's replies on the solid surface, the person's in the
/// accent, the field rounded at the bottom; a failed turn shows its reason in the thread with a
/// retry, and the field keeps whatever is being written.
struct ChatView: View {
    @ObservedObject var chat: ChatController
    let icons: IconStore?
    let compact: Bool
    @FocusState private var focused: Bool
    @StateObject private var voice = VoiceInput()
    @ObservedObject private var preferences = Preferences.shared

    /// About 72 characters of body text (docs/design-guidelines.md, chat panel).
    private static let column: CGFloat = 680

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if chat.messages.isEmpty {
                            ChatIntro(agent: chat.agent, icons: compact ? nil : icons, keys: compact)
                        }
                        ForEach(chat.messages) { message in
                            MessageRow(message: message,
                                       retry: message.id == chat.messages.last?.id && chat.retryableMessage != nil ? { chat.retry() } : nil,
                                       grant: message.id == chat.messages.last?.id && !chat.busy ? { chat.grantAndRetry() } : nil,
                                       grantPermission: preferences.chatPermission.granting(message.denied))
                        }
                        if let error = chat.error {
                            // An earlier chat that would not open; a failed turn shows in its own reply.
                            Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Theme.danger)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, compact ? 14 : 20)
                    .padding(.vertical, 12)
                    .frame(maxWidth: Self.column, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: chat.messages) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            HStack {
                Picker("Write access (next message)", selection: $preferences.chatPermission) {
                    ForEach(ChatPermission.allCases) { permission in Text(permission.label).tag(permission) }
                }
                .fixedSize()
                .help("The choice is remembered and applies to new messages. All permissions allows commands and file changes without further approval.")
                Spacer(minLength: 0)
            }
            .font(.caption)
            .padding(.horizontal, compact ? 14 : 20).padding(.vertical, 6)
            .frame(maxWidth: Self.column + 32)
            composer
        }
        .toolbar {
            if !compact {
                ToolbarItem {
                    Menu {
                        if chat.sessions.isEmpty { Text("No earlier chats") }
                        ForEach(chat.sessions.prefix(20)) { session in
                            Button { Task { await chat.open(session) } } label: {
                                Text(verbatim: session.title.flatMap { $0.isEmpty ? nil : String($0.prefix(60)) } ?? session.sid)
                            }
                        }
                    } label: {
                        Label("Earlier chats", systemImage: "clock.arrow.circlepath")
                    }
                    .disabled(chat.busy)
                    .help("Earlier chats")
                }
                ToolbarItem {
                    Button { chat.newConversation() } label: { Label("New Conversation", systemImage: "square.and.pencil") }
                        .disabled(chat.busy)
                        .help("New Conversation")
                }
            }
        }
        .onAppear { focused = true }
        .task { if !compact { await chat.loadSessions() } }
        .task(id: chat.busy) { if !compact, !chat.busy { await chat.loadSessions() } }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message \(chat.agent.displayTitle)", text: $chat.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...8)
                .focused($focused)
                .focusEffectDisabled()
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    chat.send()
                    return .handled
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                // Circular corners: a continuous curve wider than half a one-line field draws spurs.
                .background(Theme.solid, in: RoundedRectangle(cornerRadius: 14, style: .circular))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .circular).strokeBorder(focused ? Theme.accent.opacity(0.6) : Theme.hairline))
            VoiceButton(voice: voice, api: chat.api) { text in
                chat.draft = appendingTranscript(text, to: chat.draft)
                focused = true
            }
            if chat.busy {
                Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.borderless).foregroundStyle(Theme.danger)
                    .help("Stop").accessibilityLabel(Text("Stop"))
            } else {
                let empty = chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button { chat.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.borderless).foregroundStyle(empty ? Color.secondary : Theme.accent)
                    .help("Send").accessibilityLabel(Text("Send"))
                    .disabled(empty)
            }
        }
        .padding(.horizontal, compact ? 12 : 16).padding(.vertical, 10)
        .overlay(alignment: .topLeading) {
            if let error = voice.error {
                Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger)
                    .padding(.horizontal, compact ? 14 : 18).offset(y: -18)
            }
        }
        .frame(maxWidth: Self.column + 32)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}

/// The agent before the first message: a small avatar beside its name and what it does, not a
/// banner, so the thread starts high. Quick Chat names the agent in its own header and passes no
/// icons, which leaves only the description.
private struct ChatIntro: View {
    let agent: AgentInfo
    let icons: IconStore?
    /// Quick Chat lists its keys, since it is reached from the keyboard and left with Esc.
    var keys = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if let icons { EntryIcon(icon: agent.avatar, fallback: "person.fill", icons: icons, size: 36, isRound: true) }
            VStack(alignment: .leading, spacing: 3) {
                if icons != nil { Text(agent.displayTitle).font(.headline).foregroundStyle(Theme.text) }
                if let d = agent.description {
                    Text(Lang.pick(d, agent.i18n, \.description)).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if keys {
                    Text("Return sends · Shift-Return starts a new line · ⌘J picks another agent · Esc closes")
                        .font(.caption).foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MessageRow: View {
    let message: ChatMessage
    /// Present on the last reply when it failed and its message can go again.
    let retry: (() -> Void)?
    let grant: (() -> Void)?
    let grantPermission: ChatPermission

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 60)
                Text(message.text)
                    .textSelection(.enabled)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        case .agent:
            VStack(alignment: .leading, spacing: 8) {
                if !message.tools.isEmpty || !message.text.isEmpty || message.activity != nil {
                    reply
                }
                if !message.denied.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("\(message.denied.joined(separator: ", ")) was refused for lack of permission", systemImage: "lock.fill")
                            .font(.callout).foregroundStyle(Theme.danger)
                        if let grant, !message.live {
                            Text("Next messages: \(grantPermission.label)").font(.caption).foregroundStyle(.secondary)
                            Button("Grant and retry", action: grant).controlSize(.small)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.solid, in: RoundedRectangle(cornerRadius: 10))
                }
                if let failure = message.failure {
                    FailureCard(failure: failure, retry: retry)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var reply: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                if !message.tools.isEmpty {
                    Text(message.tools.suffix(6).joined(separator: " · "))
                        .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
                if !message.text.isEmpty {
                    Text(Self.markdown(message.text)).textSelection(.enabled).foregroundStyle(Theme.text)
                }
                if let activity = message.activity {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(Self.label(activity)).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Theme.solid, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.hairline))
            Spacer(minLength: 24)
        }
    }

    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    static func label(_ a: ChatActivity) -> String {
        switch a {
        case .starting: return String(localized: "Starting…")
        case .reconnecting: return String(localized: "Reconnecting…")
        case .thinking(let model): return model.isEmpty ? String(localized: "Thinking…") : String(localized: "Thinking with \(model)…")
        case .running(let tool): return String(localized: "Running \(tool)…")
        }
    }
}

/// A turn that did not come back: what happened in words, the Space's own text under it, and
/// Try Again when sending the message once more may work.
struct FailureCard: View {
    let failure: ChatFailure
    let retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.danger)
            VStack(alignment: .leading, spacing: 4) {
                Text(Self.title(failure.kind)).font(.callout.weight(.semibold)).foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if !failure.detail.isEmpty, failure.detail != Self.title(failure.kind) {
                    Text(verbatim: failure.detail).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .textSelection(.enabled).lineLimit(6)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let retry, failure.retryable {
                    Button(action: retry) { Label("Try Again", systemImage: "arrow.clockwise") }
                        .controlSize(.small)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.danger.opacity(0.3)))
        .accessibilityElement(children: .contain)
    }

    static func title(_ kind: ChatFailure.Kind) -> String {
        switch kind {
        case .busy: return String(localized: "The model service is busy or over its limit. Wait a moment and try again.")
        case .signedOut: return String(localized: "The agent's runtime is not signed in on the Space.")
        case .timedOut: return String(localized: "The reply took too long and was stopped.")
        case .exited(let code): return String(localized: "The agent's runtime stopped without a reply (exit code \(Int(code))).")
        case .unavailable: return String(localized: "The agent's runtime could not start on the Space.")
        case .connection: return String(localized: "The reply could not be reached.")
        case .other: return String(localized: "The agent could not reply.")
        }
    }
}
