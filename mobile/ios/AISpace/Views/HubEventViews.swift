import SwiftUI

/// The bus, read-only (src/web/Events.tsx): what apps provide, publish and consume, and the
/// recent events with where each delivery stands.
struct EventsPage: View {
    @StateObject private var store: EventsStore

    init(api: SpaceAPI) {
        _store = StateObject(wrappedValue: EventsStore(api: api))
    }

    var body: some View {
        List {
            Section {
                HubNotice(store: store)
                if store.loaded {
                    StatCards(stats: [
                        ("\(store.events.count)", String(localized: "recent events")),
                        ("\(store.capabilities.filter { !($0.provides ?? []).isEmpty }.count)", String(localized: "apps providing")),
                        ("\(store.capabilities.filter { !($0.publishes ?? []).isEmpty }.count)", String(localized: "apps publishing")),
                    ])
                    NavigationLink { CapabilitiesPage(store: store) } label: { Label("Capabilities and events", systemImage: "list.bullet.rectangle") }
                }
            }
            Section {
                if store.loaded && store.events.isEmpty { Text("No events yet.").foregroundStyle(.secondary) }
                ForEach(store.events) { event in
                    NavigationLink { EventDetail(store: store, event: event) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(verbatim: event.name).foregroundStyle(Theme.text).lineLimit(1)
                                if let peer = event.peer { Badge(text: peer) }
                                Spacer(minLength: 8)
                                if let date = ISO8601.parse(event.at) { Text(verbatim: HubFormat.relative(date)).font(.caption).foregroundStyle(.secondary) }
                            }
                            if !event.preview.isEmpty { Text(verbatim: event.preview).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            } header: {
                Text("Recent events")
            }
        }
        .hubPage("Events and calls", store)
    }
}

struct EventDetail: View {
    @ObservedObject var store: EventsStore
    let event: SpaceEvent

    var body: some View {
        List {
            Section {
                if let app = event.app { LabeledContent("App") { Text(verbatim: app) } }
                if let date = ISO8601.parse(event.at) { LabeledContent("Time") { Text(verbatim: date.formatted(date: .abbreviated, time: .standard)) } }
                ForEach((event.data ?? [:]).sorted { $0.key < $1.key }, id: \.key) { key, value in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: key).font(.caption).foregroundStyle(.secondary)
                        Text(verbatim: value.compact).font(.callout.monospaced()).foregroundStyle(Theme.text).textSelection(.enabled)
                    }
                }
            }
            Section {
                if let rows = store.deliveries[event.id] {
                    if rows.isEmpty { Text("Nobody consumes this event.").foregroundStyle(.secondary) }
                    ForEach(rows) { d in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Dot(color: color(d.status))
                                Text(verbatim: d.app).foregroundStyle(Theme.text)
                                if let kind = d.kind { Badge(text: kind) }
                                Spacer(minLength: 8)
                                Text(verbatim: status(d.status)).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Text(verbatim: [d.path, d.attempts.map { String(localized: "\($0) attempts") }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            if let error = d.lastError, !error.isEmpty { Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger) }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else if let error = store.deliveryErrors[event.id] {
                    Text("Unavailable: \(error)").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            } header: {
                Text("Deliveries")
            }
        }
        .navigationTitle(Text(verbatim: event.name))
        .task { await store.loadDeliveries(event.id) }
        .refreshable { await store.loadDeliveries(event.id) }
    }

    private func color(_ status: String) -> Color {
        switch status {
        case "ok": return Theme.success
        case "dead": return Theme.danger
        case "sent": return Theme.accent
        case "pending": return Theme.warning
        default: return .secondary
        }
    }

    private func status(_ status: String) -> String {
        switch status {
        case "ok": return String(localized: "ok")
        case "dead": return String(localized: "gave up")
        case "sent": return String(localized: "sent")
        case "pending": return String(localized: "pending")
        case "skipped": return String(localized: "skipped")
        default: return status
        }
    }
}

/// Which apps provide capabilities, publish events and consume them, with call counts.
struct CapabilitiesPage: View {
    @ObservedObject var store: EventsStore

    var body: some View {
        List {
            if store.capabilities.isEmpty { Text("No app declares a capability or an event.").foregroundStyle(.secondary) }
            ForEach(store.capabilities) { app in
                Section {
                    ForEach(app.provides ?? [], id: \.self) { c in
                        let stat = app.stats?.first { $0.capability == c.name }
                        line(String(localized: "provides"), c.name, [c.description, stat.map { String(localized: "\($0.calls ?? 0) calls, \($0.failures ?? 0) failed") }].compactMap { $0 }.joined(separator: " · "))
                    }
                    ForEach(app.publishes ?? [], id: \.self) { p in line(String(localized: "publishes"), p.name, p.description ?? "") }
                    ForEach(app.consumes ?? [], id: \.self) { c in
                        line(String(localized: "consumes"), c.event,
                             c.kind == "task" ? String(localized: "runs task \(c.task ?? "")") : (c.kind == "http" ? "\(c.method ?? "") \(c.path ?? "")" : String(localized: "over a stream")))
                    }
                } header: {
                    Text(verbatim: app.peer.map { "\(app.app) · \($0)" } ?? app.app)
                }
            }
        }
        .navigationTitle(Text("Capabilities and events"))
    }

    private func line(_ kind: String, _ name: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Badge(text: kind)
                Text(verbatim: name).foregroundStyle(Theme.text).lineLimit(1)
            }
            if !detail.isEmpty { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(4) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The packages of this Space and of the Spaces it is connected to, and the connections
/// (src/web/Packages.tsx). Sharing can be switched here; installing a package, removing one and
/// making a connection stay in the web panel.
struct PackagesPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @StateObject private var store: PackagesStore

    init(model: AppModel, connection: Connection, api: SpaceAPI) {
        self.model = model
        self.connection = connection
        _store = StateObject(wrappedValue: PackagesStore(api: api))
    }

    var body: some View {
        let local = store.catalogue?.apps?.elements ?? []
        List {
            Section {
                HubNotice(store: store)
                if store.loaded {
                    if local.isEmpty { Text("No package is installed on this Space.").foregroundStyle(.secondary) }
                    ForEach(local) { app in packageRow(app, opens: false) }
                }
            } header: {
                Text("Installed here")
            } footer: {
                if let id = store.catalogue?.spaceId { Text("This Space: \(id)") }
            }
            ForEach(store.catalogue?.remotes?.elements ?? []) { remote in
                Section {
                    if (remote.apps?.elements ?? []).isEmpty { Text("Nothing is shared over this connection.").foregroundStyle(.secondary) }
                    ForEach(remote.apps?.elements ?? []) { app in packageRow(app, opens: remote.available != false) }
                } header: {
                    Text("Shared by \(short(remote.spaceId ?? remote.connectionId))")
                } footer: {
                    if remote.available == false { Text("That Space is not answering.") }
                }
            }
            ForEach(store.links) { link in
                Section {
                    LabeledContent("Status") {
                        HStack(spacing: 6) {
                            Dot(color: link.connected == true ? Theme.success : Color.secondary)
                            Text(verbatim: link.connected == true ? String(localized: "connected") : String(localized: "not connected"))
                        }
                    }
                    if let direction = link.direction {
                        LabeledContent("Direction") { Text(verbatim: direction == "outgoing" ? String(localized: "this Space connects out") : String(localized: "that Space connects in")) }
                    }
                    if let url = link.url { LabeledContent("Address") { Text(verbatim: url).lineLimit(1) } }
                    Toggle("Connection on", isOn: Binding(get: { link.enabled != false }, set: { on in Task { await store.setEnabled(link, on) } }))
                        .disabled(store.isSaving)
                    ForEach(local) { app in
                        Toggle(isOn: Binding(get: { (link.apps ?? []).contains(app.app) }, set: { on in Task { await store.setShared(link, app: app.app, on) } })) {
                            Text("Share \(app.title ?? app.app)")
                        }
                        .disabled(store.isSaving)
                    }
                } header: {
                    Text("Connection to \(short(link.remoteSpaceId ?? link.id))")
                } footer: {
                    Text("Select which local apps this connection may access. Nothing is shared by default. Turning sharing off closes active remote requests.")
                }
            }
            Section {
                Button { model.webPanelFromHub() } label: { Label("Install, remove or connect in the web panel", systemImage: "safari") }
            } footer: {
                Text("Installing a package file, rolling one back, removing one and making a new connection are done in the Space's web panel, under Settings.")
            }
        }
        .hubPage("Apps and connections", store)
    }

    @ViewBuilder private func packageRow(_ app: PackageApp, opens: Bool) -> some View {
        let label = HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: app.title ?? app.app).foregroundStyle(Theme.text)
                Text(verbatim: [app.version, app.state].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 8)
            if opens, app.page != false, app.url != nil { Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary) }
        }
        if opens, app.page != false, let url = app.url.flatMap({ URL(string: $0, relativeTo: connection.url)?.absoluteURL }) {
            Button { model.openFromHub(url, title: app.title ?? app.app, in: connection) } label: { label }
        } else {
            label
        }
    }

    /// A Space's id is a UUID; its first group is enough to tell two apart.
    private func short(_ id: String) -> String { String(id.prefix(8)) }
}

/// Every app's notifications in one list (src/web/Inbox.tsx). Opening a row marks it read;
/// "done" closes a thread until a newer notification arrives in it.
struct InboxPage: View {
    @ObservedObject var model: AppModel
    @StateObject private var store: InboxStore

    init(model: AppModel, api: SpaceAPI) {
        self.model = model
        _store = StateObject(wrappedValue: InboxStore(api: api))
    }

    var body: some View {
        List {
            Section {
                Picker("Filter", selection: $store.filter) {
                    Text("All").tag(InboxFilter.all)
                    Text("Unread").tag(InboxFilter.unread)
                    Text("To handle").tag(InboxFilter.handle)
                    Text("Done").tag(InboxFilter.done)
                }
                .pickerStyle(.segmented)
                HubNotice(store: store)
                if store.loaded && store.items.isEmpty {
                    Text(verbatim: store.filter == .all ? String(localized: "Nothing has arrived yet.") : String(localized: "Nothing matches this filter.")).foregroundStyle(.secondary)
                }
            } footer: {
                if let s = store.summary { Text("\(s.unread) unread · \(s.open) open") }
            }
            Section {
                ForEach(store.items) { item in
                    NavigationLink { InboxDetail(model: model, store: store, item: item) } label: { row(item) }
                        .swipeActions(edge: .trailing) {
                            Button { Task { await store.mark(item.thread, done: item.done != true) } } label: {
                                Label(item.done == true ? String(localized: "Reopen") : String(localized: "Done"), systemImage: item.done == true ? "arrow.uturn.backward" : "checkmark")
                            }
                            .tint(Theme.success)
                        }
                }
            }
        }
        .navigationTitle(Text("Inbox"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Read All") { Task { await store.readAll() } }.disabled((store.summary?.unread ?? 0) == 0 || store.isSaving)
            }
        }
        .refreshable { await store.refresh() }
        .task(id: store.filter) { await store.refresh() }
    }

    private func row(_ item: InboxThread) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Dot(color: InboxDetail.color(item.level))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: item.heading).font(item.unread == true ? .body.weight(.semibold) : .body)
                        .foregroundStyle(item.done == true ? Color.secondary : Theme.text).lineLimit(2)
                    if let n = item.count, n > 1 { Badge(text: "×\(n)") }
                }
                HStack(spacing: 6) {
                    Badge(text: item.app)
                    if item.action == true && item.done != true { Text("needs action").font(.caption).foregroundStyle(Theme.warning) }
                    if item.done == true { Text("done").font(.caption).foregroundStyle(.secondary) }
                    Spacer(minLength: 4)
                    if let date = item.lastAt.flatMap(ISO8601.parse) { Text(verbatim: HubFormat.relative(date)).font(.caption).foregroundStyle(.secondary) }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct InboxDetail: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: InboxStore
    /// As it was in the list: a filter may drop the thread from it once it is read.
    let item: InboxThread

    var body: some View {
        let now = store.item(item.thread) ?? item
        List {
            Section {
                if let title = now.title, !title.isEmpty { Text(verbatim: title).font(.headline).foregroundStyle(Theme.text) }
                Text(verbatim: now.text).foregroundStyle(Theme.text).textSelection(.enabled)
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: [now.app, now.lastAt.flatMap(ISO8601.parse)?.formatted(date: .abbreviated, time: .shortened)].compactMap { $0 }.joined(separator: " · "))
                    if let n = now.count, n > 1, let first = now.firstAt.flatMap(ISO8601.parse) {
                        Text("\(n) times since \(first.formatted(date: .abbreviated, time: .shortened))")
                    }
                }
            }
            Section {
                if let url = now.url.flatMap({ URL(string: $0, relativeTo: store.api.base)?.absoluteURL }), let connection = model.selected {
                    Button { model.openFromHub(url, title: now.heading, in: connection) } label: { Label("Open Link", systemImage: "arrow.up.right") }
                }
                Button { Task { await store.mark(now.thread, done: now.done != true) } } label: {
                    Label(now.done == true ? String(localized: "Reopen") : String(localized: "Mark Done"), systemImage: now.done == true ? "arrow.uturn.backward" : "checkmark")
                }
                if now.done != true {
                    Button { Task { await store.mark(now.thread, read: false) } } label: { Label("Mark Unread", systemImage: "circle.fill") }
                }
                if let reason = store.saveError { Text("The change was not saved: \(reason)").font(.footnote).foregroundStyle(Theme.danger) }
            }
        }
        .navigationTitle(Text(verbatim: now.app))
        .task { if item.unread == true { await store.mark(item.thread, read: true) } }
    }

    static func color(_ level: String?) -> Color {
        switch level {
        case "alert": return Theme.danger
        case "warn": return Theme.warning
        case "success": return Theme.success
        default: return Color.secondary.opacity(0.5)
        }
    }
}
