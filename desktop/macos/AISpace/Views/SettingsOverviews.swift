import SwiftUI

/// Settings' Usage and Automation sections open on a short overview of each page, read from the
/// Space when the section shows; More opens the whole page inside the pane.

/// The last row of an overview: the whole page, one level in.
private struct MoreRow: View {
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack {
                Text("More").foregroundStyle(Theme.accent)
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A loading, failed or empty overview, in one line.
private struct OverviewNote: View {
    @ObservedObject var store: HubStore
    let empty: Bool
    let emptyText: LocalizedStringKey

    var body: some View {
        if let error = store.error {
            Text(verbatim: error).foregroundStyle(.secondary).lineLimit(2)
        } else if !store.loaded {
            ProgressView().controlSize(.small)
        } else if empty {
            Text(emptyText).foregroundStyle(.secondary)
        }
    }
}

struct ModelUsageOverview: View {
    @StateObject private var store: ModelUsageStore
    let open: () -> Void

    init(api: SpaceAPI, open: @escaping () -> Void) {
        _store = StateObject(wrappedValue: ModelUsageStore(api: api))
        self.open = open
    }

    var body: some View {
        Section {
            if let t = store.usage?.totals, (t.calls ?? 0) > 0 {
                StatCards(stats: [
                    (HubFormat.count(t.calls), String(localized: "calls")),
                    (HubFormat.tokens(t.tokens), String(localized: "tokens")),
                    (HubFormat.cost(t.costUsd), String(localized: "cost")),
                    (HubFormat.duration(ms: t.durationMs), String(localized: "time")),
                ])
                ForEach(Array((store.usage?.byModel?.elements ?? []).prefix(3).enumerated()), id: \.offset) { _, r in
                    LabeledContent {
                        Text(verbatim: [HubFormat.count(r.totals.calls) + " " + String(localized: "calls"), HubFormat.tokens(r.totals.tokens)].joined(separator: " · "))
                    } label: {
                        Text(verbatim: r.modelOn ?? "—").lineLimit(1)
                    }
                }
            }
            OverviewNote(store: store, empty: (store.usage?.totals.calls ?? 0) == 0, emptyText: "No calls in the last 24 hours.")
            MoreRow(open: open)
        } header: {
            Text("Model usage · last 24 hours")
        }
        .task { await store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .reloadHubPage)) { _ in Task { await store.refresh() } }
    }
}

struct AppUsageOverview: View {
    @StateObject private var store: AppUsageStore
    let catalogue: Catalogue?
    let open: () -> Void

    init(api: SpaceAPI, catalogue: Catalogue?, open: @escaping () -> Void) {
        let store = AppUsageStore(api: api)
        store.window = "7d"
        _store = StateObject(wrappedValue: store)
        self.catalogue = catalogue
        self.open = open
    }

    var body: some View {
        Section {
            if store.loaded {
                StatCards(stats: [
                    (store.opens.formatted(), String(localized: "opens")),
                    (store.activeMs > 0 ? HubFormat.duration(ms: store.activeMs) : "—", String(localized: "time in use")),
                ])
                ForEach(Array(store.rows.prefix(3).enumerated()), id: \.offset) { _, row in
                    LabeledContent {
                        Text(verbatim: [String(localized: "\(row.opens) opens"), row.activeMs.map { HubFormat.duration(ms: $0) }].compactMap { $0 }.joined(separator: " · "))
                    } label: {
                        Text(verbatim: name(row)).lineLimit(1)
                    }
                }
            }
            OverviewNote(store: store, empty: store.rows.isEmpty, emptyText: "Nothing was opened in the last 7 days.")
            MoreRow(open: open)
        } header: {
            Text("App usage · last 7 days")
        }
        .task { await store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .reloadHubPage)) { _ in Task { await store.refresh() } }
    }

    private func name(_ row: AppUsageRow) -> String {
        catalogue?.apps.first { $0.ref == row.key }?.displayTitle()
            ?? catalogue?.agents.first { $0.ref == row.key }?.displayTitle()
            ?? row.key.capitalized
    }
}

struct TasksOverview: View {
    @StateObject private var store: TasksStore
    let open: () -> Void

    init(api: SpaceAPI, open: @escaping () -> Void) {
        _store = StateObject(wrappedValue: TasksStore(api: api))
        self.open = open
    }

    var body: some View {
        Section {
            if store.loaded, !store.tasks.isEmpty {
                let on = store.tasks.filter { $0.enabled != false && $0.orphaned != true }
                let failing = store.tasks.filter { if case .error = $0.status { return true } else { return false } }
                StatCards(stats: [
                    ("\(store.tasks.count)", String(localized: "tasks")),
                    ("\(on.count)", String(localized: "on")),
                    ("\(failing.count)", String(localized: "failing")),
                ])
                ForEach(upcoming(on)) { task in
                    LabeledContent {
                        if let next = task.state?.nextRunAt.flatMap(ISO8601.parse) {
                            Text(verbatim: HubFormat.relative(next))
                        }
                    } label: {
                        Text(verbatim: "\(store.title(task.app)) · \(task.name)").lineLimit(1)
                    }
                }
            }
            OverviewNote(store: store, empty: store.tasks.isEmpty, emptyText: "No scheduled tasks.")
            MoreRow(open: open)
        } header: {
            Text("Scheduled tasks")
        }
        .task { await store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .reloadHubPage)) { _ in Task { await store.refresh() } }
    }

    /// The next three runs, soonest first.
    private func upcoming(_ tasks: [SpaceTask]) -> [SpaceTask] {
        tasks.compactMap { t in t.state?.nextRunAt.flatMap(ISO8601.parse).map { (t, $0) } }
            .sorted { $0.1 < $1.1 }
            .prefix(3)
            .map(\.0)
    }
}

struct EventsOverview: View {
    @StateObject private var store: EventsStore
    let open: () -> Void

    init(api: SpaceAPI, open: @escaping () -> Void) {
        _store = StateObject(wrappedValue: EventsStore(api: api))
        self.open = open
    }

    var body: some View {
        Section {
            ForEach(store.events.prefix(4)) { event in
                LabeledContent {
                    if let at = ISO8601.parse(event.at) { Text(verbatim: HubFormat.relative(at)) }
                } label: {
                    Text(verbatim: [event.app, event.name].compactMap { $0 }.joined(separator: " · ")).lineLimit(1)
                }
            }
            OverviewNote(store: store, empty: store.events.isEmpty, emptyText: "No recent events.")
            MoreRow(open: open)
        } header: {
            Text("Events and calls")
        }
        .task { await store.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .reloadHubPage)) { _ in Task { await store.refresh() } }
    }
}
