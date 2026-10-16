import SwiftUI

/// Native command results. Catalogue matching is immediate; structured commands use the shared resolver.
struct OmniboxView: View {
    @ObservedObject var model: AppModel
    @Binding var query: String
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var store: OmniboxStore
    let submit: Int
    @State private var selection: ShortcutIntent?
    @State private var showingHistory = false
    @State private var chatError: String?
    @State private var pendingLink: String?

    private var resolution: ShortcutResolution? { store.resolvedText == query ? store.resolution : nil }
    private var entries: [CatalogueEntry] {
        guard let c = loader.catalogue else { return [] }
        return Array(OmniboxRules.rank(query, (c.entries + builtinEntries)).prefix(6))
    }
    private var builtinPages: [(String, String, String, HubPage)] {
        [("inbox", "Inbox", "收件箱", .inbox), ("tasks", "Tasks", "任务", .tasks),
         ("model-usage", "Model Usage", "模型用量", .modelUsage), ("app-usage", "App Usage", "应用使用情况", .appUsage),
         ("app-models", "App Models", "应用模型", .appModels), ("events", "Events", "事件", .events),
         ("packages", "Packages", "应用包", .packages), ("terminal", "Terminal", "终端", .terminal)]
    }
    private var builtinEntries: [CatalogueEntry] {
        builtinPages.map { id, title, zh, _ in
            CatalogueEntry(kind: .app, ref: "builtin/" + id, title: title, i18n: ["zh": LocalizedText(title: zh)], reach: .link)
        }
    }
    private func openEntry(_ entry: CatalogueEntry) {
        if let builtin = builtinPages.first(where: { "builtin/" + $0.0 == entry.ref }) { model.hubPage = builtin.3 }
        else { model.open(entry) }
        query = ""
    }
    private var strong: [ShortcutIntent] { resolution?.intents.filter { $0.kind != "action" || $0.strong == true } ?? [] }
    private var loose: [ShortcutIntent] { Array((resolution?.intents.filter { $0.kind == "action" && $0.strong != true } ?? []).prefix(3)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button { showingHistory = true } label: { Label("Recent Actions", systemImage: "clock.arrow.circlepath") }
            } else {
                if resolution?.ambiguous == true { Text("Choose an action").font(.subheadline).foregroundStyle(.secondary) }
                // The server returns mutually exclusive agent/action candidates.
                ForEach(resolution?.agentIntents ?? []) { intent in
                    Button { ask(intent) } label: {
                        row(intent.title, detail: intent.reason, icon: "sparkles")
                    }.disabled(!intent.available)
                }
                ForEach(strong) { intent in actionRow(intent) }
                if resolution?.agentIntents.isEmpty != false {
                    ForEach(entries) { entry in
                        Button { openEntry(entry) } label: {
                            row(entry.displayTitle(), detail: entry.peer, icon: entry.kind == .agent ? "person.crop.circle" : "square.grid.2x2")
                        }
                    }
                }
                ForEach(loose) { intent in actionRow(intent) }
                if store.resolving { ProgressView().controlSize(.small).accessibilityLabel(Text("Searching…")) }
                Button { ask(nil) } label: { Label("Ask Space Assistant", systemImage: "sparkles").frame(maxWidth: .infinity, alignment: .leading) }
                    .padding(12).glass()
                if let error = store.error { Text(verbatim: error).foregroundStyle(Theme.danger).font(.footnote) }
                if let chatError { Text(verbatim: chatError).foregroundStyle(Theme.danger).font(.footnote) }
            }
        }
        .buttonStyle(.plain)
        .task(id: query) { await store.resolve(query) }
        .onChange(of: submit) { _, _ in activateDefault() }
        .sheet(item: $selection, onDismiss: openPendingLink) { intent in
            if let action = intent.action {
                ShortcutActionSheet(api: store.api, action: action, args: intent.args ?? [:], open: open)
            }
        }
        .sheet(isPresented: $showingHistory, onDismiss: openPendingLink) { ShortcutHistory(store: store, open: open) }
    }

    private func row(_ title: String, detail: String?, icon: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: title)
                if let detail, !detail.isEmpty { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).glass()
    }
    @ViewBuilder private func actionRow(_ intent: ShortcutIntent) -> some View {
        Button {
            if intent.kind == "calc" { if let value = store.preview?.text { UIPasteboard.general.string = value } }
            else { selection = intent }
        } label: {
            if (intent.kind == "calc" || intent.kind == "convert"), let preview = store.preview {
                ShortcutResultView(result: preview, open: open).padding(12).glass()
            } else {
                row(intent.action?.displayTitle ?? intent.expression ?? "", detail: intent.action?.reason ?? intent.action?.peer,
                    icon: intent.kind == "calc" ? "equal" : intent.action?.effect == "write" ? "plus.circle" : "bolt.circle")
            }
        }.disabled(intent.action?.available == false)
    }
    private func activateDefault() {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard resolution != nil else {
            if !store.resolving, OmniboxRules.opensByDefault(query, entries.first), let entry = entries.first { openEntry(entry) }
            return
        }
        guard resolution?.ambiguous != true else { return }
        if let agent = resolution?.agentIntents.first { if agent.available { ask(agent) }; return }
        if let intent = strong.first {
            if intent.action?.available == false { return }
            if intent.kind == "calc" { UIPasteboard.general.string = store.preview?.text }
            else { selection = intent }
        } else if OmniboxRules.opensByDefault(query, entries.first), let entry = entries.first { openEntry(entry) }
        else { ask(nil) }
    }
    private func ask(_ intent: ShortcutAgentIntent?) {
        let agent = intent?.agent ?? "space/assistant"
        guard let base = ChatRoute.base(ref: agent, peer: nil) else { return }
        let chat = model.chat(for: connection, base: base)
        guard !chat.isRunning else { chatError = String(localized: "This agent is still replying. Open its chat to continue."); return }
        chat.newChat()
        chat.draft = query
        chat.send(intentID: intent?.id, timezone: TimeZone.current.identifier)
        model.hubPage = .chat(agent: "agent:\(agent)")
        query = ""
    }
    private func openPendingLink() {
        guard let link = pendingLink else { return }
        pendingLink = nil
        open(link)
    }
    private func open(_ link: String) {
        if selection != nil || showingHistory {
            pendingLink = link
            selection = nil; showingHistory = false
            return
        }
        guard let url = URL(string: link, relativeTo: connection.url)?.absoluteURL, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        model.open(url, title: String(localized: "Result"), key: "shortcut:\(url.absoluteString)", in: connection)
    }
}

struct ShortcutActionSheet: View {
    @StateObject private var execution: ShortcutExecution
    @Environment(\.dismiss) private var dismiss
    let open: (String) -> Void
    init(api: SpaceAPI, action: ShortcutAction, args: [String: JSONValue], open: @escaping (String) -> Void) {
        _execution = StateObject(wrappedValue: ShortcutExecution(api: api, action: action, args: args))
        self.open = open
    }
    var body: some View {
        NavigationStack {
            Form {
                if let action = execution.action {
                    if !action.available { Text(verbatim: action.reason ?? "").foregroundStyle(.secondary) }
                    Section {
                        ForEach(action.inputs) { input in field(input, action: action) }
                    } footer: {
                        if action.inputs.contains(where: { ["date", "time", "period"].contains($0.type) }) { Text(verbatim: execution.timezone) }
                    }.disabled(execution.busy || execution.hasSubmitted)
                    if execution.run == nil {
                        Button(LocalizedStringKey(execution.hasSubmitted ? "Retry" : action.effect == "write" ? "Create" : action.effect == "run" ? "Run" : "Show Result")) { execution.submit() }
                            .disabled(!execution.canSubmit)
                    }
                    ShortcutExecutionView(execution: execution, open: open)
                }
            }
            .navigationTitle(execution.action?.displayTitle ?? "")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                if execution.action?.effect == "read", execution.canSubmit { execution.submit() }
            }
        }
    }
    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { execution.values[name] ?? "" }, set: { execution.values[name] = $0 })
    }
    @ViewBuilder private func field(_ input: ShortcutAction.Input, action: ShortcutAction) -> some View {
        let label = action.label(input)
        if input.type == "choice" || input.type == "task" {
            Picker(selection: binding(input.name)) {
                Text("Choose…").tag("")
                ForEach(input.options ?? [], id: \.value) { option in
                    Text(verbatim: action.translation?.options?[option.value] ?? option.label).tag(option.value)
                }
            } label: { Text(verbatim: label) }
        } else if input.type == "date" || input.type == "time" {
            VStack(alignment: .leading) {
                TextField(label, text: binding(input.name)).autocorrectionDisabled().textInputAutocapitalization(.never)
                DatePicker(selection: calendarBinding(input), displayedComponents: input.type == "date" ? [.date] : [.hourAndMinute]) {
                    Text(LocalizedStringKey(input.type == "date" ? "Choose Date" : "Choose Time"))
                }.environment(\.timeZone, TimeZone(identifier: execution.timezone) ?? .current)
            }
        } else {
            TextField(label, text: binding(input.name), axis: input.type == "text" ? .vertical : .horizontal)
                .keyboardType(input.type == "number" ? .numbersAndPunctuation : .default)
                .autocorrectionDisabled(input.type != "text")
            if input.type == "period" { Text("Use today, this-week, or YYYY-MM-DD..YYYY-MM-DD").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func calendarBinding(_ input: ShortcutAction.Input) -> Binding<Date> {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: execution.timezone)
        formatter.dateFormat = input.type == "date" ? "yyyy-MM-dd" : "HH:mm"
        return Binding(get: {
            let value = execution.values[input.name] ?? ""
            if input.type == "date", ["today", "tomorrow", "yesterday"].contains(value) {
                var calendar = Calendar(identifier: .gregorian); calendar.timeZone = formatter.timeZone
                return calendar.date(byAdding: .day, value: value == "tomorrow" ? 1 : value == "yesterday" ? -1 : 0, to: Date()) ?? Date()
            }
            return formatter.date(from: value) ?? Date()
        }, set: { execution.values[input.name] = formatter.string(from: $0) })
    }
}

struct ShortcutExecutionView: View {
    @ObservedObject var execution: ShortcutExecution
    let open: (String) -> Void
    var body: some View {
        if execution.busy || execution.run?.status == "running" { ProgressView() }
        if let run = execution.run {
            Text(LocalizedStringKey(run.status == "ok" ? "Completed" : run.status == "running" ? "Running…" : run.status == "unknown" ? "Outcome unknown; check the app before trying again." : "Failed"))
            if let result = run.result { ShortcutResultView(result: result, open: open) }
            if let error = run.error { Text(verbatim: error).foregroundStyle(Theme.danger) }
            if execution.canRetry { Button("Retry") { execution.retry() } }
        }
        if let error = execution.error { Text(verbatim: error).foregroundStyle(Theme.danger) }
    }
}

struct ShortcutResultView: View {
    let result: ShortcutResult
    let open: (String) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if result.kind == "value" {
                Text(verbatim: result.text ?? result.value?.compact ?? "").font(.title3).textSelection(.enabled)
            }
            ForEach(Array((result.items ?? []).enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 3) {
                    if let url = item.url { Button { open(url) } label: { Text(verbatim: item.title) } }
                    else { Text(verbatim: item.title) }
                    if let detail = item.detail { Text(verbatim: detail).font(.subheadline) }
                    let metadata = [item.source, item.date, item.time, item.timezone, item.at.flatMap { Times.parse($0)?.formatted() }].compactMap { $0 }.joined(separator: " · ")
                    if !metadata.isEmpty { Text(verbatim: metadata).font(.caption).foregroundStyle(.secondary) }
                }
            }
            if let task = result.task { Text(verbatim: task).font(.headline) }
            if let output = result.output { Text(verbatim: output).font(.caption.monospaced()).textSelection(.enabled) }
            if let error = result.error { Text(verbatim: error).foregroundStyle(Theme.danger) }
            if let detail = result.detail { Text(verbatim: detail).font(.subheadline) }
            if let source = result.source { Text(verbatim: source).font(.caption).foregroundStyle(.secondary) }
            if let at = result.asOf.flatMap(Times.parse) { Text(at, style: .relative).font(.caption).foregroundStyle(.secondary) }
            if result.stale == true { Text("Cached result").font(.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ShortcutHistory: View {
    @ObservedObject var store: OmniboxStore
    @Environment(\.dismiss) private var dismiss
    let open: (String) -> Void
    var body: some View {
        NavigationStack {
            List {
                if let error = store.error { Text(verbatim: error).foregroundStyle(Theme.danger) }
                ForEach(store.runs) { run in
                    Section {
                        Text(LocalizedStringKey(run.status == "ok" ? "Completed" : run.status == "running" ? "Running…" : run.status == "unknown" ? "Outcome unknown; check the app before trying again." : "Failed"))
                        if let result = run.result { ShortcutResultView(result: result, open: open) }
                        if let error = run.error { Text(verbatim: error).foregroundStyle(Theme.danger) }
                    } header: { Text(verbatim: run.title) }
                }
            }
            .navigationTitle("Recent Actions")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await store.refreshRuns() }
            .task {
                repeat {
                    await store.refreshRuns()
                    guard store.runs.contains(where: { $0.status == "running" }) else { return }
                    do { try await Task.sleep(nanoseconds: 1_500_000_000) } catch { return }
                } while !Task.isCancelled
            }
        }
    }
}
