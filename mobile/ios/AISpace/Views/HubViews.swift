import SwiftUI

/// A page of the Space drawn by the app from the Space's own routes, over the tabs: what the
/// web panel keeps under Settings, the inbox and the chat.
enum HubPage: Identifiable, Hashable {
    case inbox, tasks, modelUsage, appUsage, appModels, events, packages, terminal
    /// The agents to talk to, or one agent's conversation by its catalogue key.
    case chat(agent: String?)

    var id: String {
        switch self {
        case .inbox: return "inbox"
        case .tasks: return "tasks"
        case .modelUsage: return "modelUsage"
        case .appUsage: return "appUsage"
        case .appModels: return "appModels"
        case .events: return "events"
        case .packages: return "packages"
        case .terminal: return "terminal"
        case .chat(let agent): return "chat:\(agent ?? "")"
        }
    }
}

/// The page with its own navigation: it sits in a cover, outside the pager, so a navigation
/// stack is safe here and its rows can lead further in.
struct HubCover: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let page: HubPage
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        NavigationStack {
            HubPageContent(model: model, connection: connection, page: page, loader: loader, icons: icons)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { model.hubPage = nil } label: { Image(systemName: "xmark") }
                            .accessibilityLabel(Text("Close"))
                    }
                }
        }
        .tint(Theme.accent)
    }
}

/// One page of the Space, in a cover (HubCover) or pushed from a section of Settings.
struct HubPageContent: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let page: HubPage
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore

    var body: some View {
        let api = loader.api
        switch page {
        case .inbox: InboxPage(model: model, api: api)
        case .tasks: TasksPage(api: api, icons: icons)
        case .modelUsage: ModelUsagePage(api: api)
        case .appUsage: AppUsagePage(api: api, catalogue: loader.catalogue)
        case .appModels: AppModelsPage(api: api, icons: icons)
        case .events: EventsPage(api: api)
        case .packages: PackagesPage(model: model, connection: connection, api: api)
        case .terminal: TerminalPage(store: model.terminal(for: connection))
        case .chat(let key):
            if let agent = loader.catalogue?.agents.first(where: { $0.key == key }), let base = ChatRoute.base(ref: agent.ref, peer: agent.peer) {
                ChatPage(agent: agent, store: model.chat(for: connection, base: base), icons: icons, backdrop: model.backdrops(for: connection))
            } else {
                AgentsPage(model: model, connection: connection, loader: loader, icons: icons)
            }
        }
    }
}

// MARK: Shared pieces

/// What a page says before its rows: that it is reading, or why it could not.
struct HubNotice: View {
    @ObservedObject var store: HubStore

    var body: some View {
        if let error = store.error {
            Label { Text("Unavailable: \(error)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                .font(.footnote)
        } else if !store.loaded {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading…").foregroundStyle(.secondary)
            }
        }
        if let reason = store.saveError {
            Label { Text("The change was not saved: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                .font(.footnote)
        }
    }
}

struct Dot: View {
    let color: Color
    var size: CGFloat = 9

    var body: some View {
        Circle().fill(color).frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// A row of figures, each over its name, as the panel's usage cards.
struct StatCards: View {
    let stats: [(value: String, label: String)]

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(Array(stats.enumerated()), id: \.offset) { _, s in
                VStack(spacing: 3) {
                    Text(verbatim: s.value).font(.system(.headline, design: .rounded)).monospacedDigit()
                        .foregroundStyle(Theme.text).lineLimit(1).minimumScaleFactor(0.6)
                    Text(verbatim: s.label).font(.caption2).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, 4)
    }
}

/// Small bars, tallest at full height; a day without a value is a tick on the floor.
struct MiniBars: View {
    let values: [Double]
    var color: Color = Theme.accent

    var body: some View {
        GeometryReader { geo in
            let top = max(values.max() ?? 0, 1)
            let step = geo.size.width / CGFloat(max(values.count, 1))
            HStack(alignment: .bottom, spacing: step * 0.25) {
                ForEach(Array(values.enumerated()), id: \.offset) { _, v in
                    Rectangle().fill(v > 0 ? color : Theme.hairline)
                        .frame(width: step * 0.75, height: v > 0 ? max(CGFloat(v / top) * geo.size.height, 1.5) : 1)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .bottomLeading)
        }
        .accessibilityHidden(true)
    }
}

/// A small label beside a name: where a row comes from, or what it is.
struct Badge: View {
    let text: String

    var body: some View {
        Text(verbatim: text).font(.caption2.weight(.medium)).foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Theme.hairline, in: Capsule())
    }
}

/// A model menu: "none" first, then the choices, and the current value when the Space no longer offers it.
struct ModelMenu<Label: View>: View {
    let options: [ModelChoice]
    let current: String?
    let none: String
    let disabled: Bool
    let pick: (String?) -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        Picker(selection: Binding(get: { current ?? "" }, set: { pick($0.isEmpty ? nil : $0) })) {
            Text(verbatim: none).tag("")
            if let current, !current.isEmpty, !options.contains(where: { $0.value == current }) {
                Text(verbatim: current).tag(current)
            }
            ForEach(options) { Text(verbatim: $0.label).tag($0.value) }
        } label: {
            label()
        }
        .disabled(disabled)
    }
}

extension View {
    /// A page's list: read when it comes up, again when pulled down.
    func hubPage(_ title: LocalizedStringKey, _ store: HubStore) -> some View {
        navigationTitle(Text(title))
            .refreshable { await store.refresh() }
            .task { await store.refresh() }
    }
}

// MARK: Tasks

extension SpaceTask.Status {
    var color: Color {
        switch self {
        case .ok: return Theme.success
        case .error: return Theme.danger
        case .running: return Theme.accent
        case .skipped: return Theme.warning
        case .orphaned, .off, .neverRan: return .secondary
        }
    }

    var text: String {
        switch self {
        case .orphaned: return String(localized: "orphaned")
        case .off: return String(localized: "off")
        case .running: return String(localized: "running")
        case .ok: return String(localized: "ok")
        case .error(let n): return n > 1 ? String(localized: "failed \(n) times in a row") : String(localized: "failed")
        case .skipped: return String(localized: "skipped")
        case .neverRan: return String(localized: "never ran")
        }
    }
}

extension TaskSchedule {
    /// As the panel writes it (api.ts `scheduleText`).
    var text: String {
        switch kind {
        case "every": return String(localized: "every \(HubFormat.duration(ms: everyMs))")
        case "cron": return tz.map { "\(expr ?? "") (\($0))" } ?? (expr ?? "")
        case "at": return String(localized: "once at \(at.flatMap(ISO8601.parse)?.formatted(date: .abbreviated, time: .shortened) ?? at ?? "")")
        default: return String(localized: "manual")
        }
    }
}

struct TasksPage: View {
    @StateObject private var store: TasksStore
    let icons: IconStore

    init(api: SpaceAPI, icons: IconStore) {
        _store = StateObject(wrappedValue: TasksStore(api: api))
        self.icons = icons
    }

    var body: some View {
        List {
            Section {
                HubNotice(store: store)
                if store.loaded {
                    let active = store.tasks.filter(\.isActive).count
                    let failing = store.tasks.filter(\.isFailing).count
                    StatCards(stats: [
                        ("\(active)", String(localized: "active")),
                        ("\(store.tasks.count)", String(localized: "tasks")),
                        ("\(failing)", String(localized: "failing")),
                    ])
                    if store.tasks.isEmpty { Text("No tasks yet.").foregroundStyle(.secondary) }
                }
            }
            ForEach(store.groups, id: \.app) { group in
                Section {
                    ForEach(group.tasks) { task in
                        NavigationLink { TaskDetail(store: store, id: task.id) } label: { TaskRow(task: task) }
                    }
                } header: {
                    HStack(spacing: 8) {
                        EntryIcon(icon: store.labels[group.app]?.icon, fallback: "shippingbox", icons: icons, size: 20)
                        Text(verbatim: store.title(group.app))
                    }
                }
            }
        }
        .hubPage("Scheduled tasks", store)
    }
}

struct TaskRow: View {
    let task: SpaceTask

    var body: some View {
        let status = task.status
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Dot(color: status.color)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: task.name).foregroundStyle(task.isActive ? Theme.text : Color.secondary).lineLimit(1)
                    if task.source == "api" { Badge(text: "api") }
                    if task.overrides?.isEmpty == false { Badge(text: String(localized: "override")) }
                }
                Text(verbatim: line(status)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// A run that is due within half a minute, or overdue, is due now.
    static func next(_ date: Date) -> String {
        date.timeIntervalSinceNow < 30 ? String(localized: "due now") : String(localized: "next \(HubFormat.relative(date))")
    }

    private func line(_ status: SpaceTask.Status) -> String {
        var parts = (task.triggers ?? []).map { String(localized: "on \($0.event)") }
        if task.schedule.kind != "manual" || parts.isEmpty { parts.append(task.schedule.text) }
        parts.append(status.text)
        if let last = task.state?.lastRunAt.flatMap(ISO8601.parse) { parts.append(HubFormat.relative(last)) }
        if task.isActive, let next = task.state?.nextRunAt.flatMap(ISO8601.parse) { parts.append(TaskRow.next(next)) }
        return parts.joined(separator: " · ")
    }
}

/// One task: what it is, the model it runs on, and its last runs.
struct TaskDetail: View {
    @ObservedObject var store: TasksStore
    let id: String

    var body: some View {
        List {
            if let task = store.task(id) {
                Section {
                    if let d = task.description, !d.isEmpty { Text(verbatim: d).font(.subheadline).foregroundStyle(.secondary) }
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            Dot(color: task.status.color)
                            Text(verbatim: task.status.text)
                        }
                    }
                    LabeledContent("Schedule") { Text(verbatim: task.schedule.text) }
                    ForEach(task.triggers ?? [], id: \.self) { trigger in
                        LabeledContent("Trigger") { Text(verbatim: trigger.event) }
                    }
                    if let kind = task.target?.kind { LabeledContent("Kind") { Text(verbatim: kind) } }
                    if let last = task.state?.lastRunAt.flatMap(ISO8601.parse) {
                        LabeledContent("Last run") { Text(verbatim: [HubFormat.relative(last), task.state?.lastDurationMs.map { HubFormat.duration(ms: $0) }].compactMap { $0 }.joined(separator: " · ")) }
                    }
                    if task.isActive, let next = task.state?.nextRunAt.flatMap(ISO8601.parse) {
                        LabeledContent("Next run") { Text(verbatim: next.timeIntervalSinceNow < 30 ? String(localized: "due now") : HubFormat.relative(next)) }
                    }
                    if let pending = task.state?.pending { LabeledContent("Events waiting") { Text(verbatim: "\(pending.events)") } }
                    if let error = task.state?.lastError, task.state?.lastStatus == "error" {
                        Text(verbatim: error).font(.footnote).foregroundStyle(Theme.danger)
                    }
                }
                Section {
                    if task.modelSelectable == true {
                        ModelMenu(options: task.eligible(store.options), current: task.overrides?.model,
                                  none: String(localized: "Default (\(task.base?.model ?? String(localized: "the Space's")))"),
                                  disabled: store.isSaving || task.orphaned == true,
                                  pick: { value in Task { await store.setModel(id, value) } }) { Text("Model") }
                        if let reason = store.saveError {
                            Text("The change was not saved: \(reason)").font(.footnote).foregroundStyle(Theme.danger)
                        }
                    } else {
                        Text("This task does not support model selection.").font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Model")
                } footer: {
                    if task.modelSelectable == true { Text("Used from the task's next run. Changing it here changes the Space, for every device.") }
                }
                Section {
                    if let runs = store.runs[id] {
                        if runs.isEmpty { Text("No runs yet.").foregroundStyle(.secondary) }
                        ForEach(runs) { RunRow(run: $0) }
                    } else if let error = store.runErrors[id] {
                        Text("Unavailable: \(error)").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ProgressView()
                    }
                } header: {
                    Text("Runs")
                }
            }
        }
        .navigationTitle(Text(verbatim: store.task(id)?.name ?? ""))
        .refreshable {
            await store.refresh()
            await store.loadRuns(id)
        }
        .task { await store.loadRuns(id) }
    }
}

struct RunRow: View {
    let run: TaskRun

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Dot(color: run.status == "ok" ? Theme.success : (run.status == "error" ? Theme.danger : Theme.warning))
                Text(verbatim: run.status == "ok" ? String(localized: "ok") : (run.status == "error" ? String(localized: "failed") : String(localized: "skipped")))
                    .foregroundStyle(Theme.text)
                if run.trigger == "manual" { Badge(text: String(localized: "manual")) }
                if let n = run.eventIds?.count, n > 0 { Badge(text: String(localized: "\(n) events")) }
                Spacer(minLength: 8)
                Text(verbatim: [HubFormat.relative(run.started), run.durationMs.map { HubFormat.duration(ms: $0) }].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = run.error, !error.isEmpty { Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger) }
            if let output = run.output, !output.isEmpty {
                Text(verbatim: output).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(12).textSelection(.enabled)
            }
        }
    }
}
