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
                        ForEach(store.bubbles) { ChatBubble(bubble: $0) }
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
                } else {
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
