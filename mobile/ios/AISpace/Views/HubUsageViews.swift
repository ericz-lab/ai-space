import SwiftUI

/// What the model service recorded (src/web/Usage.tsx), read-only. Token figures are what the
/// runtime reported; a call with none shows a dash, nothing is estimated.
struct ModelUsagePage: View {
    @StateObject private var store: ModelUsageStore

    init(api: SpaceAPI) {
        _store = StateObject(wrappedValue: ModelUsageStore(api: api))
    }

    var body: some View {
        List {
            Group {
                Section {
                    Picker("Window", selection: $store.window) {
                        ForEach(ModelUsageStore.windows, id: \.self) { Text(verbatim: $0).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    HubNotice(store: store)
                    if let t = store.usage?.totals {
                        StatCards(stats: [
                            (HubFormat.count(t.calls) + ((t.errors ?? 0) > 0 ? " · \(Int(t.errors ?? 0))⚠︎" : ""), String(localized: "calls")),
                            (HubFormat.tokens(t.tokens), String(localized: "tokens")),
                            (HubFormat.cost(t.costUsd), String(localized: "cost")),
                            (HubFormat.duration(ms: t.durationMs), String(localized: "time")),
                        ])
                        if (t.calls ?? 0) == 0 { Text("No calls in this window.").foregroundStyle(.secondary) }
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let space = store.usage?.space, !space.isEmpty {
                        // The ledger is the open Space's own; apps running on a peer are in the peer's.
                        Text("Space \(space)")
                    }
                    if let backend = store.usage?.backend { Text("Backend: \(backend)") }
                    ForEach(store.usage?.peersOff ?? [], id: \.name) { p in
                        if let at = p.asOf.flatMap(ISO8601.parse) {
                            Text("\(p.name) did not answer (\(p.error ?? "")); its figures are from \(at.formatted(date: .abbreviated, time: .shortened))")
                        } else {
                            Text("\(p.name) is not included: \(p.error ?? "")")
                        }
                    }
                        Text("Costs include GPT estimates at standard API rates, not subscription charges. Unknown costs are excluded from totals.")
                    }
                }
    
                if let rows = store.usage?.byTag?.elements, !rows.isEmpty {
                    Section {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                            usageRow(title: [r.app.map(store.title), r.tag].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "), detail: r.modelOn, r.totals)
                        }
                    } header: {
                        Text("By app and tag")
                    }
                }
                if let rows = store.usage?.byModel?.elements, !rows.isEmpty {
                    Section {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, r in usageRow(title: r.modelOn ?? "", detail: nil, r.totals) }
                    } header: {
                        Text("By model")
                    }
                }
                history
                if !store.calls.isEmpty {
                    Section {
                        ForEach(store.calls, id: \.key) { call in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Dot(color: call.status == "ok" ? Theme.success : Theme.danger)
                                    // `machine:model` stays on one line, cut at the end.
                                Text(verbatim: call.modelOn ?? "").foregroundStyle(Theme.text).lineLimit(1).truncationMode(.tail)
                                    Spacer(minLength: 8)
                                    if let date = call.startedAt.flatMap(ISO8601.parse) {
                                        Text(verbatim: HubFormat.relative(date)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Text(verbatim: [[store.title(call.app), call.tag].compactMap { $0 }.joined(separator: " · "),
                                                call.usage.map { HubFormat.tokens($0.total) }, call.costUsd.map { HubFormat.cost($0) },
                                                call.durationMs.map { HubFormat.duration(ms: $0) }].compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                if let error = call.error, !error.isEmpty { Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger).lineLimit(4) }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    } header: {
                        Text("Recent calls")
                    }
                }
            }
            .hubRows()
        }
        .navigationTitle(Text("Model usage"))
        .refreshable { await store.refresh() }
        .task(id: store.window) { await store.refresh() }
    }

    private func usageRow(title: String, detail: String?, _ t: ModelTotals) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title).foregroundStyle(Theme.text).lineLimit(2)
                Text(verbatim: [detail, String(localized: "\(Int(t.calls ?? 0)) calls"), (t.errors ?? 0) > 0 ? String(localized: "\(Int(t.errors ?? 0)) errors") : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle((t.errors ?? 0) > 0 ? Theme.danger : Color.secondary).lineLimit(1)
                Text(verbatim: String(localized: "in \(HubFormat.tokens(t.inputTokens)) · cached \(HubFormat.tokens(t.cacheReadTokens)) · out \(HubFormat.tokens(t.outputTokens))"))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(verbatim: HubFormat.tokens(t.tokens)).font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(Theme.text)
                Text(verbatim: HubFormat.cost(t.costUsd)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Everything recorded so far, and the last twelve weeks' tokens as bars.
    @ViewBuilder private var history: some View {
        if let usage = store.usage, let h = usage.history, let t = h.totals, (t.calls ?? 0) > 0 {
            let days = usage.daysRecorded()
            let weeks = usage.weekly(\.tokens)
            Section {
                StatCards(stats: [
                    ("\(days)", String(localized: "days recorded")),
                    (HubFormat.count(t.calls), String(localized: "calls")),
                    (HubFormat.tokens(t.tokens), String(localized: "tokens")),
                    (HubFormat.cost(t.costUsd), String(localized: "\(HubFormat.cost(days > 0 ? (t.costUsd ?? 0) / Double(days) : 0)) a day")),
                ])
                if !weeks.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        MiniBars(values: weeks.map(\.value)).frame(height: 56)
                        HStack {
                            Text(verbatim: weeks.first.map { $0.week.formatted(.dateTime.month(.abbreviated).day()) } ?? "")
                            Spacer()
                            Text("Tokens by week")
                            Spacer()
                            Text(verbatim: weeks.last.map { $0.week.formatted(.dateTime.month(.abbreviated).day()) } ?? "")
                        }
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("History")
            }
        }
    }
}

/// How often each app, agent and panel window was opened and for how long (src/web/Activity.tsx).
struct AppUsagePage: View {
    @StateObject private var store: AppUsageStore
    let catalogue: Catalogue?

    init(api: SpaceAPI, catalogue: Catalogue?) {
        _store = StateObject(wrappedValue: AppUsageStore(api: api))
        self.catalogue = catalogue
    }

    var body: some View {
        List {
            Group {
                Section {
                    Picker("Window", selection: $store.window) {
                        ForEach(AppUsageStore.windows, id: \.self) { w in
                            if w == "all" { Text("All time").tag(w) } else { Text(verbatim: w).tag(w) }
                        }
                    }
                    .pickerStyle(.segmented)
                    Picker("Kind", selection: $store.kind) {
                        Text("All").tag("all")
                        Text("Apps").tag("app")
                        Text("Agents").tag("agent")
                        Text("Panel").tag("builtin")
                    }
                    .pickerStyle(.segmented)
                    HubNotice(store: store)
                    if store.loaded {
                        StatCards(stats: [
                            (store.opens.formatted(), String(localized: "opens")),
                            (store.activeMs > 0 ? HubFormat.duration(ms: store.activeMs) : "—", String(localized: "time in use")),
                            (store.rows.first.map(name) ?? "—", String(localized: "most used")),
                        ])
                        if store.rows.isEmpty { Text("Nothing was opened in this window.").foregroundStyle(.secondary) }
                    }
                } footer: {
                    Text("How often each app, agent and panel window was opened, and for how long. An app's time comes from its heartbeat script; one without it shows a dash. An agent's opens are chat turns.")
                }
                Section {
                    if let error = store.devicesError {
                        Text("Device usage is unavailable on this Space.").foregroundStyle(.secondary)
                        Text(verbatim: error).font(.caption).foregroundStyle(.secondary)
                    } else if !store.devicesLoaded {
                        ProgressView()
                    } else if store.devices.isEmpty {
                        Text("No device activity in this period. Updated clients report while in the foreground.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.devices) { device in
                            DisclosureGroup {
                                if let apps = device.apps {
                                    if apps.isEmpty { Text("No app activity recorded for this device.").foregroundStyle(.secondary) }
                                    ForEach(apps) { app in
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(verbatim: catalogue?.apps.first { $0.ref == app.key }?.displayTitle() ?? app.key)
                                            HStack {
                                                Text("Opens: \(app.opens)")
                                                Spacer()
                                                if let ms = app.activeMs {
                                                    Text(verbatim: HubFormat.duration(ms: ms))
                                                } else { Text("Time not measured") }
                                            }.font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                } else {
                                    Text("This Space does not provide app activity by device yet.").foregroundStyle(.secondary)
                                }
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(verbatim: "\(device.clientName) · \(device.shortID)")
                                        Spacer(minLength: 8)
                                        Text(verbatim: HubFormat.duration(ms: device.activeMs)).monospacedDigit()
                                    }
                                    Text("Foreground visits: \(device.sessions)").font(.caption).foregroundStyle(.secondary)
                                    if let date = ISO8601.parse(device.lastAt) {
                                        Text("Last used: \(date.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Text(verbatim: device.deviceId).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Device usage")
                } footer: {
                    Text("Foreground time in the Space client. Overlapping windows count once per device. App filters do not affect device usage.")
                }
                if !store.rows.isEmpty {
                    Section {
                        ForEach(store.rows) { row in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: name(row)).foregroundStyle(Theme.text).lineLimit(1)
                                    Text(verbatim: detail(row)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                                Spacer(minLength: 8)
                                MiniBars(values: (store.month[row.id] ?? row).spark()).frame(width: 90, height: 22)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
            .hubRows()
        }
        .navigationTitle(Text("App usage"))
        .refreshable { await store.refresh() }
        .task(id: store.window + store.kind) { await store.refresh() }
    }

    /// The entry's title from the catalogue; the panel's own windows by their names.
    private func name(_ row: AppUsageRow) -> String {
        switch row.kind {
        case "app": return catalogue?.apps.first { $0.ref == row.key }?.displayTitle() ?? row.key
        case "agent": return catalogue?.agents.first { $0.ref == row.key }?.displayTitle() ?? row.key
        default:
            switch row.key {
            case "inbox": return String(localized: "Inbox")
            case "terminal": return String(localized: "Terminal")
            case "settings": return String(localized: "Settings")
            case "chat": return String(localized: "Chat")
            default: return row.key
            }
        }
    }

    private func detail(_ row: AppUsageRow) -> String {
        var parts = [String(localized: "\(row.opens) opens")]
        if let ms = row.activeMs { parts.append(HubFormat.duration(ms: ms)) }
        if let avg = row.averageMs { parts.append(String(localized: "avg \(HubFormat.duration(ms: avg))")) }
        if let last = row.lastAt.flatMap(ISO8601.parse) { parts.append(HubFormat.relative(last)) }
        return parts.joined(separator: " · ")
    }
}

/// Which model each app's calls run on when they name none (src/web/AppModels.tsx). A choice
/// here is the panel's override: it saves at once and changes the Space.
struct AppModelsPage: View {
    @StateObject private var store: AppModelsStore
    let icons: IconStore

    init(api: SpaceAPI, icons: IconStore) {
        _store = StateObject(wrappedValue: AppModelsStore(api: api))
        self.icons = icons
    }

    var body: some View {
        List {
            Group {
                Section {
                    HubNotice(store: store)
                } footer: {
                    Text("The model an app's calls run on when they name none. A choice here overrides what the app declares, for every device; “No override” returns to it.")
                }
                appSections(store.sorted, options: store.options, peer: nil)
                // On a hub, each peer's apps under its name, offered the peer's own choices (src/web/AppModels.tsx).
                ForEach(store.peers) { p in
                    Section {
                        if p.isLoading {
                            ProgressView()
                        } else if p.old {
                            Text("\(p.peer) runs an older core; update it to list its apps here.").font(.footnote).foregroundStyle(.secondary)
                        } else if let error = p.error {
                            Text("\(p.peer) is not answering: \(error)").font(.footnote).foregroundStyle(Theme.danger)
                        } else if p.apps?.isEmpty == true {
                            Text("No apps installed.").font(.footnote).foregroundStyle(.secondary)
                        }
                    } header: {
                        Text("On \(p.peer)")
                    }
                    appSections(store.sorted(p.apps ?? [], peer: p.peer), options: p.options ?? [], peer: p.peer)
                }
            }
            .hubRows()
        }
        .hubPage("App models", store)
    }

    /// One section per app: the app-wide row and one per tag, each a model menu saved at once.
    private func appSections(_ apps: [AppModelRows], options: [ModelChoice], peer: String?) -> some View {
        ForEach(apps) { app in
            Section {
                ForEach(app.rows) { row in
                    ModelMenu(options: options, current: row.override, none: String(localized: "No override"), disabled: store.isSaving,
                              pick: { value in Task { await store.setModel(app: app.app, peer: peer, tag: row.tag, value) } }) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: row.tag ?? String(localized: "All calls")).foregroundStyle(Theme.text)
                            Text(verbatim: [row.model, source(row.source)].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            } header: {
                HStack(spacing: 8) {
                    EntryIcon(icon: store.icon(app.app, peer: peer), fallback: "shippingbox", icons: icons, size: 20)
                    Text(verbatim: store.title(app.app, peer: peer))
                    if let peer {
                        Spacer(minLength: 4)
                        Text(verbatim: peer).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// The layer that chose the model a row runs on.
    private func source(_ source: String?) -> String? {
        switch source {
        case "override-tag": return String(localized: "set here for this tag")
        case "override-app": return String(localized: "set here for the app")
        case "manifest-tag": return String(localized: "declared for this tag")
        case "manifest-default": return String(localized: "declared by the app")
        case "default": return String(localized: "the Space's default")
        default: return source
        }
    }
}
