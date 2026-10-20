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
                            ChatBubble(bubble: bubble, answer: bubble.live ? { id, allow, answers in await store.answer(id, allow: allow, answers: answers) } : nil)
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 14).padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: store.bubbles.last?.text) { _, _ in proxy.scrollTo("end") }
                .onChange(of: store.bubbles.last?.steps.count) { _, _ in proxy.scrollTo("end") }
                .onChange(of: store.bubbles.count) { _, _ in proxy.scrollTo("end") }
            }
            if let error = store.error {
                Text("Unavailable: \(error)").font(.footnote).foregroundStyle(Theme.danger).padding(.horizontal, 14).padding(.bottom, 6)
            }
            composer
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

    private var composer: some View {
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
            if !store.isRunning || store.canSend {
                Button { store.send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)) }
                    .disabled(!store.canSend).accessibilityLabel(Text("Send"))
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
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

/// One message. The person's are in the accent; the agent's reply has no bubble, as on the panel:
/// its text and its tool calls in the order they happened, approvals and questions as cards.
struct ChatBubble: View {
    let bubble: ChatStore.Bubble
    /// Answers an approval or the questions of the running turn; nil once the turn is over.
    let answer: ((String, Bool, [String: [String]]?) async -> String?)?

    var body: some View {
        if bubble.isUser { user } else { reply }
    }

    private var user: some View {
        HStack {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 6) {
                if !bubble.text.isEmpty {
                    Self.rendered(bubble.text).foregroundStyle(Color.white).textSelection(.enabled)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Theme.accent, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private var waitingFor: String? {
        guard bubble.live else { return nil }
        let waiting = bubble.steps.filter { $0.kind == .approval && $0.state == .waiting }
        if waiting.isEmpty { return nil }
        return waiting.contains { bubble.asks[$0.id] != nil } ? String(localized: "Waiting for your answer…") : String(localized: "Waiting for your approval…")
    }

    private var reply: some View {
        VStack(alignment: .leading, spacing: 10) {
            if bubble.steps.isEmpty {
                if !bubble.text.isEmpty { ChatMarkdownText(text: bubble.text) }
            } else {
                ForEach(ChatRows.groups(bubble.steps)) { group in
                    switch group {
                    case .tools(let steps):
                        VStack(alignment: .leading, spacing: 2) { ForEach(steps) { ChatToolRow(step: $0) } }
                    case .step(let step):
                        switch step.kind {
                        case .text:
                            ChatMarkdownText(text: step.text)
                        case .approval:
                            if let ask = bubble.asks[step.id] {
                                ChatQuestionCard(step: step, ask: ask, answer: bubble.live ? answer : nil)
                            } else {
                                ChatApprovalCard(step: step, answer: bubble.live ? answer : nil)
                            }
                        case .steer, .tool:
                            ChatSteerLine(text: step.text)
                        }
                    }
                }
                if let note = bubble.note {
                    Text(verbatim: note).font(.footnote).foregroundStyle(note.hasPrefix("⚠️") ? Theme.danger : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            ForEach(Array(bubble.pending.enumerated()), id: \.offset) { item in
                ChatSteerLine(text: item.element, pending: true)
            }
            if let waitingFor {
                Text(verbatim: waitingFor).font(.caption).foregroundStyle(.secondary)
            }
            if let activity = bubble.activity {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(verbatim: Self.text(activity)).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 2)
        .padding(.trailing, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Inline Markdown (bold, code, links) with the line breaks kept, for the person's own words.
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

/// One tool call as a quiet single line (src/web/ChatToolRow.tsx): its glyph, title and first
/// line, muted on success, red on failure; a tap opens the call's full input and output.
private struct ChatToolRow: View {
    let step: ChatStep
    @State private var open = false

    private var kind: ChatRows.Tool { ChatRows.tool(step.title) }
    private var expandable: Bool { ChatRows.expandable(step) }
    private var failed: Bool { step.state == .failed }

    private var title: String {
        switch kind {
        case .bash: return String(localized: "Bash")
        case .read: return String(localized: "Read")
        case .write: return String(localized: "Write")
        case .edit: return String(localized: "Edit")
        case .search: return String(localized: "Search")
        case .web: return String(localized: "Web")
        case .code: return String(localized: "Code")
        case .task: return String(localized: "Agent")
        case .plan: return String(localized: "Plan")
        case .other: return ChatRows.plainName(step.title)
        }
    }

    private var symbol: String {
        switch kind {
        case .bash: return "terminal"
        case .read: return "doc.text"
        case .write, .edit: return "square.and.pencil"
        case .search: return "magnifyingglass"
        case .web: return "globe"
        case .code: return "number"
        case .task: return "sparkle"
        case .plan: return "list.bullet"
        case .other: return "gearshape"
        }
    }

    /// Only what needs a look is said: a failure, a call without a result, one still running.
    private var cue: String? {
        switch step.state {
        case .running: return String(localized: "Running")
        case .failed: return String(localized: "Failed")
        case .incomplete: return String(localized: "No result received")
        default: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { if expandable { open.toggle() } } label: { row }
                .buttonStyle(.plain)
                .disabled(!expandable)
                .accessibilityLabel(Text(verbatim: [title, ChatRows.summary(step.text), cue ?? ""].filter { !$0.isEmpty }.joined(separator: ", ")))
                .accessibilityHint(expandable ? Text(open ? "Hides the input and output" : "Shows the input and output") : Text(verbatim: ""))
            if open { details }
        }
    }

    private var row: some View {
        HStack(spacing: 6) {
            Image(systemName: open ? "chevron.up" : symbol).font(.caption).frame(width: 16)
            Text(verbatim: title).font(.footnote.weight(.medium)).layoutPriority(1)
            let summary = ChatRows.summary(step.text)
            if !summary.isEmpty {
                Text(verbatim: "·").font(.footnote)
                Text(verbatim: summary).font(.caption.monospaced()).lineLimit(1).truncationMode(.tail)
                    .foregroundStyle(failed ? Theme.danger : .secondary)
            }
            Spacer(minLength: 4)
            if step.state == .running { ProgressView().controlSize(.mini) }
            if let cue { Text(verbatim: cue).font(.caption2).foregroundStyle(failed ? Theme.danger : .secondary).layoutPriority(1) }
        }
        .foregroundStyle(open ? Theme.text : .secondary)
        .padding(.vertical, 3).padding(.horizontal, 4)
        .contentShape(Rectangle())
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !step.text.isEmpty { io(String(localized: "IN"), step.text, failed: false) }
            if !step.text.isEmpty && !step.output.isEmpty { Divider().overlay(Theme.hairline) }
            if !step.output.isEmpty {
                io(String(localized: "OUT"), step.output, failed: failed)
                if step.output.count >= 12000 {
                    Text("Output limited to 12,000 characters.").font(.caption2).foregroundStyle(.secondary)
                        .padding(.horizontal, 10).padding(.bottom, 8)
                }
            }
        }
        .background(Theme.solid, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
        .padding(.leading, 22)
    }

    private func io(_ label: String, _ text: String, failed: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(verbatim: label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).frame(minWidth: 26, alignment: .leading)
            ScrollView(.vertical) {
                Text(verbatim: text).font(.caption.monospaced()).foregroundStyle(failed ? Theme.danger : Theme.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 180)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
    }
}

/// An action the agent waits on (docs/runtimes.md#live-chat): what it wants to do, why, and the
/// person's answer while the turn runs. Nothing is allowed without a tap here.
private struct ChatApprovalCard: View {
    let step: ChatStep
    let answer: ((String, Bool, [String: [String]]?) async -> String?)?
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
                Image(systemName: "exclamationmark.shield").foregroundStyle(Theme.accent)
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
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.solid, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.hairline))
    }

    private func reply(allow: Bool) {
        guard let answer else { return }
        sending = true
        error = ""
        Task { @MainActor in
            let requestID = String(step.id.dropFirst("approval:".count))
            if let failed = await answer(requestID, allow, nil) { error = failed }
            sending = false
        }
    }
}

/// A question the agent asks while its turn runs (src/web/Chat.tsx `QuestionStep`): pick an
/// option or type an answer. One question with one choice goes back on the tap; otherwise the
/// answers go back with Send. Skip answers nothing and the agent goes on without it.
private struct ChatQuestionCard: View {
    let step: ChatStep
    let ask: ChatStore.Ask
    let answer: ((String, Bool, [String: [String]]?) async -> String?)?
    @State private var picked: [String: [String]] = [:]
    @State private var typed: [String: String] = [:]
    @State private var sending = false
    @State private var error = ""

    private var questions: [ChatRows.Question] { ask.questions }
    private var waiting: Bool { step.state == .waiting && answer != nil }

    private var status: String {
        switch step.state {
        case .waiting: return String(localized: "Waiting for you")
        case .allowed: return String(localized: "Answered")
        case .denied: return String(localized: "Skipped")
        case .cancelled: return String(localized: "Not answered")
        default: return ""
        }
    }

    private func answerOf(_ q: ChatRows.Question) -> [String] {
        ChatRows.answer(to: q, picked: picked[q.id] ?? [], typed: typed[q.id] ?? "")
    }

    private var all: [String: [String]] {
        Dictionary(uniqueKeysWithValues: questions.map { ($0.id, answerOf($0)) })
    }

    private var ready: Bool { questions.allSatisfy { !answerOf($0).isEmpty } }

    /// Send is needed when a tap alone cannot finish the answer.
    private var needsSend: Bool {
        questions.count > 1 || questions.contains { $0.multiple } || questions.contains { !(typed[$0.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.circle").foregroundStyle(Theme.accent)
                Text("Question").font(.footnote.weight(.semibold))
                Spacer(minLength: 6)
                Text(status).font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(questions) { q in item(q) }
            if waiting {
                HStack(spacing: 8) {
                    if needsSend {
                        Button("Send") { reply(all) }
                            .buttonStyle(.borderedProminent).disabled(!ready)
                    }
                    Button("Skip") { reply(nil) }
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
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.solid, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.hairline))
    }

    @ViewBuilder private func item(_ q: ChatRows.Question) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header = q.header, !header.isEmpty {
                Text(verbatim: header).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(verbatim: q.question).font(.subheadline).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            if waiting {
                ForEach(q.options, id: \.label) { option in
                    let on = (picked[q.id] ?? []).contains(option.label) && (q.multiple || (typed[q.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty)
                    Button { choose(q, option.label) } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: q.multiple ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                                .foregroundStyle(on ? Theme.accent : .secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: option.label).font(.footnote.weight(.semibold)).foregroundStyle(Theme.text)
                                if let d = option.description, !d.isEmpty {
                                    Text(verbatim: d).font(.caption).foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .background(on ? Theme.accent.opacity(0.1) : Theme.ground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(on ? Theme.accent.opacity(0.5) : Theme.hairline))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(sending)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
                TextField(text: Binding(get: { typed[q.id] ?? "" }, set: { typed[q.id] = $0 }),
                          prompt: Text(q.options.isEmpty ? "Your answer" : "Or type your own answer")) { Text("Your answer") }
                    .font(.footnote)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(Theme.ground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
                    .disabled(sending)
                    .submitLabel(.send)
                    .onSubmit { if ready { reply(all) } }
            } else if let shown = ask.answers?[q.id], !shown.isEmpty {
                Text(verbatim: "→ " + shown.joined(separator: ", ")).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private func choose(_ q: ChatRows.Question, _ label: String) {
        let current = picked[q.id] ?? []
        picked[q.id] = q.multiple ? (current.contains(label) ? current.filter { $0 != label } : current + [label]) : [label]
        if !q.multiple { typed[q.id] = "" }
        if questions.count == 1 && !q.multiple { reply(all) }
    }

    private func reply(_ answers: [String: [String]]?) {
        guard let answer else { return }
        sending = true
        error = ""
        Task { @MainActor in
            let requestID = String(step.id.dropFirst("approval:".count))
            if let failed = await answer(requestID, answers != nil, answers) { error = failed }
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
            Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.secondary)
            Text("You").font(.footnote.weight(.semibold))
            if !text.isEmpty { Text(verbatim: text).font(.footnote) }
            if pending {
                Text("the agent reads it after its current step").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
