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
                Picker("Permission", selection: $preferences.chatPermission) {
                    ForEach(ChatPermission.allCases) { permission in Text(permission.label).tag(permission) }
                }
                .fixedSize()
                .help("The choice is remembered and applies to new messages. All permissions allows commands and file changes without further approval.")
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

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button { chooseImages() } label: { Image(systemName: "photo.badge.plus").font(.system(size: 20)) }
                .buttonStyle(.borderless).help("Add images").accessibilityLabel(Text("Add images"))
                .disabled(chat.images.count >= 4)
            ChatTextInput(text: $chat.draft, focused: Binding(get: { focused }, set: { focused = $0 }),
                          placeholder: String(localized: "Message \(chat.agent.displayTitle)"),
                          onImage: { appendImage($0, name: "Image") },
                          onImageFile: { importImage(url: $0) }, onSend: { chat.send() })
                .overlay(alignment: .topLeading) {
                    if chat.draft.isEmpty {
                        Text("Message \(chat.agent.displayTitle)").foregroundStyle(.tertiary)
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
            if chat.busy {
                Button { chat.stop() } label: { Image(systemName: "stop.circle.fill").font(.system(size: 26)) }
                    .buttonStyle(.borderless).foregroundStyle(Theme.danger)
                    .help("Stop").accessibilityLabel(Text("Stop"))
            } else {
                let empty = (chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && chat.images.isEmpty) || chat.pendingImageImports > 0
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
        VStack(alignment: .leading, spacing: 12) {
            if message.steps.isEmpty {
                if !message.text.isEmpty { textBubble(message.text) }
            } else {
                ForEach(message.steps) { step in
                    if step.kind == .text {
                        textBubble(step.text)
                    } else {
                        ChatWorkStep(step: step)
                    }
                }
                if !message.live && message.text.hasSuffix(String(localized: "(stopped)")) {
                    Text("(stopped)").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let activity = message.activity {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(Self.label(activity)).font(.callout).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12).padding(.vertical, 6)
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

/// Each operation keeps its own result instead of disappearing into a tool-name summary.
private struct ChatWorkStep: View {
    let step: ChatStep
    @State private var expanded = false

    private var color: Color {
        switch step.state {
        case .running: return Theme.accent
        case .succeeded: return Theme.success
        case .failed: return Theme.danger
        case .incomplete: return .secondary
        }
    }

    private var status: String {
        switch step.state {
        case .running: return String(localized: "Running")
        case .succeeded: return String(localized: "Completed")
        case .failed: return String(localized: "Failed")
        case .incomplete: return String(localized: "No result received")
        }
    }

    private var symbol: String {
        switch step.title.lowercased() {
        case "bash", "exec_command", "command_execution": return "terminal"
        case "read", "read_file": return "doc.text.magnifyingglass"
        case "edit", "write", "apply_patch": return "square.and.pencil"
        case "websearch", "web_search", "webfetch": return "globe"
        default: return "wrench.and.screwdriver"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: symbol).foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                Text(verbatim: step.title).font(.callout.weight(.semibold))
                Spacer()
                if step.state == .running { ProgressView().controlSize(.small) }
                else { Image(systemName: step.state == .succeeded ? "checkmark.circle.fill" : step.state == .failed ? "exclamationmark.circle.fill" : "minus.circle").foregroundStyle(color) }
                Text(status).font(.caption).foregroundStyle(color)
            }
            if !step.text.isEmpty {
                Text(verbatim: step.text).font(.caption.monospaced()).textSelection(.enabled)
                    .lineLimit(expanded ? nil : 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !step.output.isEmpty || step.text.count > 180 {
                DisclosureGroup("Details", isExpanded: $expanded) {
                    if !step.output.isEmpty {
                        Text(verbatim: step.output).font(.caption.monospaced()).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                    }
                    if step.output.count >= 12000 {
                        Text("Output limited to 12,000 characters.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.solid.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
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
