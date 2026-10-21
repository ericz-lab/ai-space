import SwiftUI
import UniformTypeIdentifiers

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
                                       grantPermission: preferences.chatPermission.granting(message.denied),
                                       answer: message.live ? { id, allow, answers in await chat.answer(id, allow: allow, answers: answers) } : nil)
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
                Picker("Permission", selection: $preferences.chatPermission) {
                    ForEach(ChatPermission.allCases) { permission in Text(permission.label).tag(permission) }
                }
                .fixedSize()
                .help("The choice is remembered and applies to new messages. Ask before changes lets the agent ask you before an edit or a command; All permissions allows commands and file changes without asking.")
                Spacer(minLength: 0)
            }
            .font(.caption)
            .padding(.horizontal, compact ? 14 : 20).padding(.vertical, 6)
            .frame(maxWidth: Self.column + 32)
            if !chat.images.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(chat.images) { image in
                            ChatImagePreview(image: image)
                                .overlay(alignment: .topTrailing) {
                                    Button { chat.images.removeAll { $0.id == image.id } } label: { Image(systemName: "xmark.circle.fill") }
                                        .buttonStyle(.plain).help("Remove image")
                                }
                        }
                    }.padding(8)
                }.frame(maxWidth: Self.column + 32)
            }
            if let error = chat.imageError { Text(error).font(.caption).foregroundStyle(Theme.danger) }
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
                    .disabled(chat.busy || chat.pendingImageImports > 0)
                    .help("Earlier chats")
                }
                ToolbarItem {
                    Button { chat.newConversation() } label: { Label("New Conversation", systemImage: "square.and.pencil") }
                        .disabled(chat.busy || chat.pendingImageImports > 0)
                        .help("New Conversation")
                }
            }
        }
        .onDrop(of: [UTType.image.identifier, UTType.fileURL.identifier], isTargeted: nil) { providers in
            importImages(providers)
            return true
        }
        .onAppear { focused = true }
        .task { if !compact { await chat.loadSessions() } }
        .task(id: chat.busy) { if !compact, !chat.busy { await chat.loadSessions() } }
    }

    private func chooseImages() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.begin { result in
            if result == .OK { for url in panel.urls { importImage(url: url) } }
        }
    }

    private func importImage(url: URL) {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        do { appendImage(try PictureImport.read(url), name: url.lastPathComponent) }
        catch { chat.imageError = String(localized: "Could not read this image.") }
    }

    private func appendImage(_ data: Data, name: String) {
        guard data.count <= 40 * 1024 * 1024, let source = NSBitmapImageRep(data: data), source.pixelsWide > 0, source.pixelsHigh > 0,
              source.pixelsWide <= 16000, source.pixelsHigh <= 16000 else {
            chat.imageError = String(localized: "Could not read this image.")
            return
        }
        let prefix = [UInt8](data.prefix(12))
        let mediaType: String?
        if prefix.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) { mediaType = "image/png" }
        else if prefix.starts(with: [255, 216, 255]) { mediaType = "image/jpeg" }
        else if prefix.starts(with: Array("GIF8".utf8)) { mediaType = "image/gif" }
        else if prefix.starts(with: Array("RIFF".utf8)) && Array(prefix.suffix(4)) == Array("WEBP".utf8) { mediaType = "image/webp" }
        else { mediaType = nil }
        guard let bytes = mediaType == nil ? source.representation(using: .png, properties: [:]) : data else { return }
        let image = ChatImage(name: String(name.prefix(80)) + (mediaType == nil ? ".png" : ""), mediaType: mediaType ?? "image/png", bytes: bytes)
        guard ChatImage.validate(chat.images + [image]) else {
            chat.imageError = String(localized: "Add up to 4 images, 5 MB each and 10 MB in total.")
            return
        }
        chat.images.append(image)
        chat.imageError = nil
    }

    private func importImages(_ providers: [NSItemProvider]) {
        guard providers.count + chat.images.count + chat.pendingImageImports <= 4 else {
            chat.imageError = String(localized: "Add up to 4 images, 5 MB each and 10 MB in total.")
            return
        }
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                chat.pendingImageImports += 1
                _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                    Task { @MainActor in
                        defer { chat.pendingImageImports -= 1 }
                        guard let data, let url = URL(dataRepresentation: data, relativeTo: nil) else { chat.imageError = String(localized: "Could not read this image."); return }
                        importImage(url: url)
                    }
                }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                chat.pendingImageImports += 1
                _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                    Task { @MainActor in
                        defer { chat.pendingImageImports -= 1 }
                        guard let data else { chat.imageError = String(localized: "Could not read this image."); return }
                        appendImage(data, name: "Image")
                    }
                }
            }
        }
    }

    /// What the field says it takes: a message, or during a turn a message for that turn.
    private var placeholder: String {
        chat.busy
            ? String(localized: "Add to the reply in progress…")
            : String(localized: "Message \(chat.agent.displayTitle)")
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button { chooseImages() } label: { Image(systemName: "photo.badge.plus").font(.system(size: 20)) }
                .buttonStyle(.borderless).help("Add images").accessibilityLabel(Text("Add images"))
                .disabled(chat.images.count >= 4)
            ChatTextInput(text: $chat.draft, focused: Binding(get: { focused }, set: { focused = $0 }),
                          placeholder: placeholder,
                          onImage: { appendImage($0, name: "Image") },
                          onImageFile: { importImage(url: $0) }, onSend: { chat.send() })
                .overlay(alignment: .topLeading) {
                    if chat.draft.isEmpty {
                        Text(placeholder).foregroundStyle(.tertiary)
                            .allowsHitTesting(false)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                // Circular corners: a continuous curve wider than half a one-line field draws spurs.
                .background(Theme.solid, in: RoundedRectangle(cornerRadius: 14, style: .circular))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .circular).strokeBorder(focused ? Theme.accent.opacity(0.6) : Theme.hairline))
            VoiceButton(voice: voice, api: chat.api) { text in
                chat.draft = appendingTranscript(text, to: chat.draft)
                focused = true
            }
            // A message written during a turn joins it; Stop stays beside Send so the turn can
            // still be ended while the field is in use.
            let empty = (chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.images.isEmpty) || chat.pendingImageImports > 0
            if chat.busy {
                Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.borderless).foregroundStyle(Theme.danger)
                    .help("Stop").accessibilityLabel(Text("Stop"))
            }
            if !chat.busy || !empty {
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
    /// Answers an approval or a question of the running turn; nil once the turn is over.
    let answer: ChatAnswer?

    var body: some View {
        switch message.role {
        case .user:
            HStack {
                Spacer(minLength: 60)
                VStack(alignment: .trailing, spacing: 8) {
                    if !message.images.isEmpty {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 88))], alignment: .trailing) { ForEach(message.images) { ChatImagePreview(image: $0) } }.frame(maxWidth: 360)
                    }
                    if !message.text.isEmpty { Text(message.text) }
                }
                    .textSelection(.enabled)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        case .agent:
            VStack(alignment: .leading, spacing: 8) {
                if !message.tools.isEmpty || !message.text.isEmpty || message.activity != nil || !message.steps.isEmpty || !message.pending.isEmpty {
                    reply
                }
                // With live chat a refusal is an approval card; the old banner is only for runtimes
                // that cannot ask (and for a turn that was refused before the card could appear).
                if !message.denied.isEmpty && !message.steps.contains(where: { $0.kind == .approval }) {
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
        VStack(alignment: .leading, spacing: 12) {
            if message.steps.isEmpty {
                if !message.text.isEmpty { textBubble(message.text) }
            } else {
                ForEach(ChatStepGroup.groups(message.steps)) { group in
                    switch group {
                    case .tools(let tools):
                        // Consecutive calls stack as one tight list between paragraphs; a past
                        // session's run of two or more folds to one line, a live turn keeps them in view.
                        if tools.count > 1 && message.historic {
                            ChatToolFold(steps: tools)
                        } else {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(tools) { ChatWorkStep(step: $0) }
                            }
                        }
                    case .single(let step):
                        switch step.kind {
                        case .text:
                            textBubble(step.text)
                        case .approval where !step.questions.isEmpty:
                            QuestionCard(step: step, answer: answer)
                        case .approval:
                            ApprovalCard(step: step, answer: answer)
                        case .steer:
                            SteerRow(text: step.text)
                        case .tool:
                            ChatWorkStep(step: step)
                        }
                    }
                }
                if !message.live && message.text.hasSuffix(String(localized: "(stopped)")) {
                    Text("(stopped)").font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(Array(message.pending.enumerated()), id: \.offset) { item in
                SteerRow(text: item.element, pending: true)
            }
            if let activity = message.activity {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(Self.label(activity)).font(.callout).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
            }
            if message.live, let waiting = message.steps.first(where: { $0.kind == .approval && $0.state == .waiting }) {
                Text(waiting.questions.isEmpty ? "Waiting for your approval…" : "Waiting for your answer…")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .padding(.trailing, 24)
    }

    private func textBubble(_ text: String) -> some View {
        ChatMarkdownView(text: text)
            .padding(.horizontal, 4).padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
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

/// Answers one approval of the running turn: the request id, allow or deny, and a question's
/// answers. Returns nil when the answer reached the Space, else what to show in the card.
typealias ChatAnswer = (String, Bool, [String: [String]]?) async -> String?

/// An action the agent waits on (docs/runtimes.md#live-chat): what it wants to do, why, and the
/// person's answer while the turn runs. Nothing is allowed without an explicit choice here.
private struct ApprovalCard: View {
    let step: ChatStep
    /// Nil when the turn is over; the card then only shows how the question ended.
    let answer: ChatAnswer?
    @State private var sending = false
    @State private var error = ""

    private var waiting: Bool { step.state == .waiting && answer != nil }

    private var color: Color {
        switch step.state {
        case .waiting: return Theme.accent
        case .allowed: return Theme.success
        case .denied: return Theme.danger
        default: return .secondary
        }
    }

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
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.circle.fill").foregroundStyle(color)
                Text(verbatim: step.title).font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Text(status).font(.caption).foregroundStyle(color)
            }
            if !step.text.isEmpty {
                Text(verbatim: step.text).font(.caption.monospaced()).textSelection(.enabled)
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
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(color.opacity(0.3)))
        .accessibilityElement(children: .contain)
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

/// A message the person added while the turn ran: what they wrote, and while the agent has not
/// read it yet, that it will after the current step.
private struct SteerRow: View {
    let text: String
    var pending = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary)
            Text("You").font(.callout.weight(.semibold))
            if !text.isEmpty {
                Text(verbatim: text).font(.callout).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if pending {
                Text("the agent reads it after its current step").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.solid.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// A question the agent asks while its turn runs (src/web/Chat.tsx `QuestionStep`): pick an option
/// or type an answer. One question with one choice goes back on the click; otherwise the answers go
/// back with Send. Skip answers nothing and the agent goes on without it.
private struct QuestionCard: View {
    let step: ChatStep
    let answer: ChatAnswer?
    @State private var picked: [String: [String]] = [:]
    @State private var typed: [String: String] = [:]
    @State private var sending = false
    @State private var error = ""

    private var waiting: Bool { step.state == .waiting && answer != nil }
    private var questions: [ChatQuestion] { step.questions }

    private var status: String {
        switch step.state {
        case .waiting: return String(localized: "Waiting for you")
        case .allowed: return String(localized: "Answered")
        case .denied: return String(localized: "Skipped")
        case .cancelled: return String(localized: "Not answered")
        default: return ""
        }
    }

    private func answers(_ p: [String: [String]], _ t: [String: String]) -> [String: [String]] {
        Dictionary(uniqueKeysWithValues: questions.map { ($0.id, $0.answer(picked: p[$0.id] ?? [], typed: t[$0.id] ?? "")) })
    }

    private var ready: Bool { answers(picked, typed).values.allSatisfy { !$0.isEmpty } }

    /// Send shows when the answer is not given by one click: several questions, a multiple choice,
    /// or an answer being typed.
    private var needsSend: Bool {
        questions.count > 1 || questions.contains(where: \.multiSelect)
            || questions.contains { !(typed[$0.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "questionmark.circle").foregroundStyle(Theme.accent)
                Text("Question").font(.callout.weight(.semibold))
                Spacer(minLength: 8)
                Text(status).font(.caption).foregroundStyle(step.state == .waiting ? Theme.accent : .secondary)
            }
            ForEach(questions) { q in
                VStack(alignment: .leading, spacing: 6) {
                    if !q.header.isEmpty {
                        Text(verbatim: q.header).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Text(verbatim: q.question).font(.callout).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    if waiting {
                        ForEach(q.options, id: \.label) { option in
                            optionButton(q, option)
                        }
                        TextField(q.options.isEmpty ? "Your answer" : "Or type your own answer", text: Binding(
                            get: { typed[q.id] ?? "" },
                            set: { typed[q.id] = $0 }))
                            .textFieldStyle(.roundedBorder)
                            .disabled(sending)
                            .onSubmit { if ready { reply(answers(picked, typed)) } }
                            .accessibilityLabel(Text("Your answer"))
                    } else if let shown = step.answers[q.id], !shown.isEmpty {
                        Text(verbatim: "→ " + shown.joined(separator: ", "))
                            .font(.callout.weight(.semibold)).foregroundStyle(Theme.accent)
                    }
                }
            }
            if waiting {
                HStack(spacing: 8) {
                    if needsSend {
                        Button("Send") { reply(answers(picked, typed)) }
                            .buttonStyle(.borderedProminent)
                            .disabled(!ready)
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
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.accent.opacity(step.state == .waiting ? 0.08 : 0.04), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.accent.opacity(step.state == .waiting ? 0.35 : 0.15)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Question"))
    }

    private func optionButton(_ q: ChatQuestion, _ option: ChatQuestion.Option) -> some View {
        let typing = !q.multiSelect && !(typed[q.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        let on = (picked[q.id] ?? []).contains(option.label) && !typing
        return Button { choose(q, option.label) } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: option.label).font(.callout.weight(.semibold))
                if !option.description.isEmpty {
                    Text(verbatim: option.description).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .background(on ? Theme.accent.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? Theme.accent : Color.secondary.opacity(0.3)))
        }
        .buttonStyle(.plain)
        .disabled(sending)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func choose(_ q: ChatQuestion, _ label: String) {
        let current = picked[q.id] ?? []
        var next = picked
        next[q.id] = q.multiSelect ? (current.contains(label) ? current.filter { $0 != label } : current + [label]) : [label]
        var nextTyped = typed
        if !q.multiSelect { nextTyped[q.id] = "" }
        picked = next
        typed = nextTyped
        if questions.count == 1 && !q.multiSelect { reply(answers(next, nextTyped)) }
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

/// A run of tool calls from a past session folded to one line (src/web/ChatToolRow.tsx
/// `ToolGroup`): what kind of work ran and how many calls, the calls one click away. A transcript
/// opens on its answers rather than on its commands.
private struct ChatToolFold: View {
    let steps: [ChatStep]
    @State private var open = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { open.toggle() } label: { head }
                .buttonStyle(.plain)
                .onHover { hovering = $0 }
                .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            if open {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(steps) { ChatWorkStep(step: $0) }
                }
                .padding(.leading, 22).padding(.top, 2).padding(.bottom, 4)
            }
        }
    }

    private var head: some View {
        let lit = hovering || open
        return HStack(spacing: 0) {
            Image(systemName: "chevron.down")
                .rotationEffect(.degrees(open ? 0 : -90))
                .font(.system(size: 11))
                .frame(width: 16, height: 16)
                .padding(.trailing, 6)
            Text(ChatToolKind.allCommands(steps) ? "Ran commands" : "Called tools").font(.system(size: 12.5, weight: .medium))
            Text(verbatim: "\(steps.count)").font(.system(size: 11)).monospacedDigit().opacity(0.7).padding(.leading, 6)
            Spacer(minLength: 0)
        }
        .foregroundStyle(lit ? AnyShapeStyle(Theme.text) : AnyShapeStyle(.secondary))
        .frame(height: 26)
        .padding(.leading, 2).padding(.trailing, 6)
        .contentShape(Rectangle())
        .background(lit ? Theme.text.opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
    }
}

/// One tool call as a quiet single line (src/web/ChatToolRow.tsx `WorkStep`): glyph, title, the
/// call's first line. A running call shimmers; once it ends its dot says so, red for a failure and
/// green for a success. A click opens the full input and output.
private struct ChatWorkStep: View {
    let step: ChatStep
    @State private var expanded = false
    @State private var hovering = false

    private var kind: ChatToolKind { ChatToolKind(tool: step.title) }
    private var summary: String { ChatToolKind.summary(step.text) }
    private var expandable: Bool {
        !step.output.isEmpty || step.text.trimmingCharacters(in: .whitespacesAndNewlines) != summary
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

    /// Only what needs attention is named: a failure, a missing result, a call still running.
    private var cue: String {
        switch step.state {
        case .running: return String(localized: "Running")
        case .failed: return String(localized: "Failed")
        case .incomplete: return String(localized: "No result received")
        default: return ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { if expandable { expanded.toggle() } } label: { row }
                .buttonStyle(.plain)
                .disabled(!expandable)
                .onHover { hovering = $0 }
                .help(step.text.isEmpty ? step.title : step.text)
                .accessibilityLabel(Text(verbatim: step.title))
                .accessibilityValue(Text(verbatim: summary))
            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    if !step.text.isEmpty { io("IN", step.text, failed: false) }
                    if !step.text.isEmpty && !step.output.isEmpty { Divider() }
                    if !step.output.isEmpty { io("OUT", step.output, failed: step.state == .failed) }
                }
                .background(Theme.solid.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.hairline))
                .padding(.leading, 24).padding(.top, 4).padding(.bottom, 6)
            }
        }
    }

    /// The dot beside the call says how it ended: red for a failure, green for a success.
    @ViewBuilder private var dot: some View {
        switch step.state {
        case .failed: Circle().fill(Theme.danger)
        case .succeeded: Circle().fill(Theme.success)
        default: Circle().opacity(0.6)
        }
    }

    /// A failure's summary and cue turn red; otherwise they keep the row's color.
    private var failed: AnyShapeStyle { step.state == .failed ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.foreground) }

    private var row: some View {
        let lit = expandable && (hovering || expanded)
        return HStack(spacing: 0) {
            ZStack {
                Image(systemName: symbol).opacity(lit ? 0 : 1)
                Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)).opacity(lit ? 1 : 0)
            }
            .font(.system(size: 11))
            .frame(width: 16, height: 16)
            .padding(.trailing, 6)
            HStack(spacing: 0) {
                Text(verbatim: ChatToolKind.title(step.title)).font(.system(size: 12.5, weight: .medium)).layoutPriority(1)
                if !summary.isEmpty {
                    dot.frame(width: 3, height: 3).padding(.horizontal, 8)
                    Text(verbatim: summary).font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(failed)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            .modifier(ToolShimmer(active: step.state == .running))
            Spacer(minLength: 0)
            if !cue.isEmpty {
                Text(cue).font(.system(size: 11)).padding(.leading, 8)
                    .foregroundStyle(failed)
                    .opacity(step.state == .incomplete ? 0.8 : 1)
                    .modifier(ToolShimmer(active: step.state == .running))
            }
        }
        .foregroundStyle(lit ? AnyShapeStyle(Theme.text) : AnyShapeStyle(.secondary))
        .frame(height: 26)
        .padding(.leading, 2).padding(.trailing, 6)
        .contentShape(Rectangle())
        .background(lit ? Theme.text.opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
    }

    private func io(_ label: LocalizedStringKey, _ text: String, failed: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.system(size: 10.5, weight: .semibold)).tracking(0.4).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .foregroundStyle(failed ? Theme.danger : Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if text.count >= 12000 {
                        Text("Output limited to 12,000 characters.").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxHeight: 180)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}

/// A running call's text: a light sweep across it, the way the web panel marks work in progress.
/// Still under Reduce Motion.
private struct ToolShimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if !active {
            content
        } else if reduceMotion {
            content.foregroundStyle(Theme.text)
        } else {
            TimelineView(.animation) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                content.overlay {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, Theme.text.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geo.size.width * 0.4)
                            .offset(x: -geo.size.width * 0.4 + phase * geo.size.width * 1.4)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
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

private struct ChatImagePreview: View {
    let image: ChatImage
    var body: some View {
        if let picture = NSImage(data: image.bytes) {
            Image(nsImage: picture).resizable().scaledToFit()
                .frame(width: 88, height: 88)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                .help(image.name).accessibilityLabel(Text(image.name))
        }
    }
}
