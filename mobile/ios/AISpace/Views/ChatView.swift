import SwiftUI

/// The agents of the Space, each leading to its conversation.
struct AgentsPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        let agents = loader.catalogue?.agents ?? []
        List {
            if agents.isEmpty { Text("This Space has no agents.").foregroundStyle(.secondary) }
            ForEach(agents) { agent in
                if let base = ChatRoute.base(ref: agent.ref, peer: agent.peer) {
                    NavigationLink { ChatPage(agent: agent, store: model.chat(for: connection, base: base), icons: icons) } label: {
                        HStack(spacing: 12) {
                            EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 40, isRound: true)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: agent.displayTitle()).foregroundStyle(Theme.text)
                                if let detail = agent.displayDetail() { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    .disabled(agent.reach == .peerOffline)
                }
            }
        }
        .navigationTitle(Text("Chat"))
        .refreshable { await loader.refresh() }
    }
}

/// One agent's conversation: the messages, the reply as it streams in, and the field to write in.
/// The model and the permission mode are the agent's defaults; the web panel's chat can pick them.
struct ChatPage: View {
    let agent: CatalogueEntry
    @ObservedObject var store: ChatStore
    let icons: IconStore

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if store.bubbles.isEmpty { intro }
                        ForEach(store.bubbles) { bubble in
                            ChatBubble(bubble: bubble, answer: bubble.live ? { id, allow in await store.answer(id, allow: allow) } : nil)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.bubbles.last?.text) { _, _ in proxy.scrollTo("end") }
                .onChange(of: store.bubbles.count) { _, _ in proxy.scrollTo("end") }
            }
            if let error = store.error {
                Text("Unavailable: \(error)").font(.footnote).foregroundStyle(Theme.danger).padding(.horizontal, 14).padding(.bottom, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(text: $store.draft, prompt: Text("Message"), axis: .vertical) { Text("Message") }
                    .lineLimit(1...6)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Theme.solid, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.hairline))
                if store.isRunning {
                    Button { store.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 32)) }
                        .foregroundStyle(Theme.danger).accessibilityLabel(Text("Stop"))
                }
                // A message written during a turn joins it; Send stays beside Stop while the field
                // has something to add.
                if !store.isRunning || !store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button { store.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                        .disabled(!store.canSend).accessibilityLabel(Text("Send"))
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.bar)
        }
        .background(Theme.ground.ignoresSafeArea())
        .navigationTitle(Text(verbatim: agent.displayTitle()))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { store.newChat() } label: { Label("New Chat", systemImage: "square.and.pencil") }
                    if !store.sessions.isEmpty {
                        Section {
                            ForEach(store.sessions.prefix(20)) { session in
                                Button { Task { await store.open(session) } } label: {
                                    Text(verbatim: session.title.flatMap { $0.isEmpty ? nil : String($0.prefix(60)) } ?? session.sid)
                                }
                            }
                        } header: {
                            Text("Earlier chats")
                        }
                    }
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                }
                .disabled(store.isRunning)
                .accessibilityLabel(Text("Chats"))
            }
        }
        .task { await store.loadSessions() }
        .task(id: store.isRunning) { if !store.isRunning { await store.loadSessions() } }
    }

    private var intro: some View {
        VStack(spacing: 10) {
            EntryIcon(icon: agent.icon, fallback: "person.fill", icons: icons, size: 64, isRound: true)
            Text(verbatim: agent.displayTitle()).font(.headline).foregroundStyle(Theme.text)
            if let detail = agent.displayDetail() {
                Text(verbatim: detail).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity).padding(.top, 40).padding(.horizontal, 20)
    }
}

struct ChatBubble: View {
    let bubble: ChatStore.Bubble
    /// Answers an approval of the running turn; nil once the turn is over.
    let answer: ((String, Bool) async -> String?)?

    private var approvals: [ChatStep] { bubble.isUser ? [] : bubble.steps.filter { $0.kind == .approval } }
    private var steers: [ChatStep] { bubble.isUser ? [] : bubble.steps.filter { $0.kind == .steer } }

    var body: some View {
        HStack {
            if bubble.isUser { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 6) {
                if !bubble.tools.isEmpty {
                    Text(verbatim: bubble.tools.suffix(6).joined(separator: " · ")).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
                if !bubble.text.isEmpty {
                    Self.rendered(bubble.text).foregroundStyle(bubble.isUser ? Color.white : Theme.text).textSelection(.enabled)
                }
                ForEach(approvals) { step in
                    ChatApprovalCard(step: step, answer: bubble.live ? answer : nil)
                }
                ForEach(steers) { step in
                    ChatSteerLine(text: step.text)
                }
                ForEach(Array(bubble.pending.enumerated()), id: \.offset) { item in
                    ChatSteerLine(text: item.element, pending: true)
                }
                if bubble.live, approvals.contains(where: { $0.state == .waiting }) {
                    Text("Waiting for your approval…").font(.caption).foregroundStyle(.secondary)
                }
                if let activity = bubble.activity {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(verbatim: Self.text(activity)).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(bubble.isUser ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Theme.solid), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(bubble.isUser ? Color.clear : Theme.hairline))
            if !bubble.isUser { Spacer(minLength: 24) }
        }
    }

    /// Inline Markdown (bold, code, links) with the line breaks kept; blocks stay as written.
    static func rendered(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let rich = try? AttributedString(markdown: text, options: options) { return Text(rich) }
        return Text(verbatim: text)
    }

    static func text(_ activity: ChatActivity) -> String {
        switch activity {
        case .starting: return String(localized: "Starting…")
        case .reconnecting: return String(localized: "Reconnecting…")
        case .thinking(let model): return model.isEmpty ? String(localized: "Thinking…") : String(localized: "Thinking (\(model))…")
        case .running(let tool): return String(localized: "Running \(tool)…")
        }
    }
}

/// An action the agent waits on (docs/runtimes.md#live-chat): what it wants to do, why, and the
/// person's answer while the turn runs. Nothing is allowed without a tap here.
private struct ChatApprovalCard: View {
    let step: ChatStep
    let answer: ((String, Bool) async -> String?)?
    @State private var sending = false
    @State private var error = ""

    private var waiting: Bool { step.state == .waiting && answer != nil }

    private var status: String {
        switch step.state {
        case .waiting: return String(localized: "Waiting for you")
        case .allowed: return String(localized: "Allowed")
        case .denied: return String(localized: "Denied")
        case .cancelled: return String(localized: "Not answered")
        default: return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle.fill").foregroundStyle(Theme.accent)
                Text(verbatim: step.title).font(.footnote.weight(.semibold))
                Spacer(minLength: 6)
                Text(status).font(.caption2).foregroundStyle(.secondary)
            }
            if !step.text.isEmpty {
                Text(verbatim: step.text).font(.caption.monospaced()).lineLimit(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !step.output.isEmpty {
                Text(verbatim: step.output).font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if waiting {
                HStack(spacing: 8) {
                    Button("Allow") { reply(allow: true) }
                        .buttonStyle(.borderedProminent)
                    Button("Deny") { reply(allow: false) }
                        .buttonStyle(.bordered)
                }
                .controlSize(.small)
                .disabled(sending)
            }
            if !error.isEmpty {
                Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.ground, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline))
    }

    private func reply(allow: Bool) {
        guard let answer else { return }
        sending = true
        error = ""
        Task { @MainActor in
            let requestID = String(step.id.dropFirst("approval:".count))
            if let failed = await answer(requestID, allow) { error = failed }
            sending = false
        }
    }
}

/// A message the person added while the turn ran, waiting for the agent to read it or already read.
private struct ChatSteerLine: View {
    let text: String
    var pending = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("You").font(.footnote.weight(.semibold))
            if !text.isEmpty { Text(verbatim: text).font(.footnote) }
            if pending {
                Text("the agent reads it after its current step").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
