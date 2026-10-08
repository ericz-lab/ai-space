import SwiftUI

/// A native conversation with one agent: messages, the activity of the running turn, and the
/// composer. Return sends, Shift-Return starts a new line, Stop ends the turn on the server.
struct ChatView: View {
    @ObservedObject var chat: ChatController
    let live: SpaceLive?
    let compact: Bool
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if chat.messages.isEmpty {
                            EmptyChat(agent: chat.agent, live: live)
                        }
                        ForEach(chat.messages) { MessageRow(message: $0) }
                        if let error = chat.error {
                            Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(compact ? 14 : 20)
                    .frame(maxWidth: compact ? .infinity : 820, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: chat.messages) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message \(chat.agent.displayTitle)", text: $chat.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...8)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        chat.send()
                        return .handled
                    }
                if chat.busy {
                    Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("Stop")
                } else {
                    Button { chat.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                        .buttonStyle(.borderless).help("Send")
                        .disabled(chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(12)
        }
        .toolbar {
            if !compact {
                ToolbarItem {
                    Button { chat.newConversation() } label: { Label("New Conversation", systemImage: "square.and.pencil") }
                        .disabled(chat.busy)
                }
            }
        }
        .onAppear { focused = true }
    }
}

private struct EmptyChat: View {
    let agent: AgentInfo
    let live: SpaceLive?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                if let live { Avatar(live: live, path: agent.avatar, fallback: "person.crop.circle").frame(width: 32, height: 32) }
                Text(agent.displayTitle).font(.title3.bold())
            }
            if let d = agent.description { Text(Lang.pick(d, agent.i18n, \.description)).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 8)
    }
}

private struct MessageRow: View {
    let message: ChatMessage

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 60)
                Text(message.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
            }
        case .agent:
            VStack(alignment: .leading, spacing: 6) {
                if !message.tools.isEmpty {
                    Text(message.tools.joined(separator: " · "))
                        .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
                if !message.text.isEmpty {
                    Text(Self.markdown(message.text)).textSelection(.enabled)
                }
                if let activity = message.activity {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(Self.label(activity)).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
