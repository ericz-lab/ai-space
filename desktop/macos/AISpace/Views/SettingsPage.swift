import SwiftUI

/// The Settings page's sections (src/web/SettingsNav.tsx): listed on the left, the chosen one's
/// rows on the right. The last one shown is remembered on this Mac.
enum SettingsSection: String, CaseIterable, Identifiable {
    case general, appearance, models, automation, feedback, usage, status, packages, account

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .general: return "General"
        case .appearance: return "Appearance"
        case .models: return "Models"
        case .automation: return "Automation"
        case .feedback: return "Feedback"
        case .usage: return "Usage"
        case .status: return "Status"
        case .packages: return "Packages"
        case .account: return "Account"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .appearance: return "circle.lefthalf.filled"
        case .models: return "cylinder.split.1x2"
        case .automation: return "clock"
        case .feedback: return "exclamationmark.bubble"
        case .usage: return "chart.bar"
        case .status: return "waveform.path.ecg"
        case .packages: return "shippingbox"
        case .account: return "person.crop.circle"
        }
    }
}

/// The launcher's last page, sectioned as the web panel's Settings: General (the saved Spaces,
/// this Mac's install, widgets, language, the Space's pages), Appearance, Models, Automation, Feedback,
/// Usage, Status (the Space, its peers, services and backups), Packages and Account (the session,
/// the app). A section's row that leads to a page of the Space opens it inside the pane, as the
/// web panel does; Inbox, Chat and Terminal open over the launcher.
struct SettingsPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var settings: SettingsLoader
    let icons: IconStore
    @ObservedObject var prefs: Preferences
    @AppStorage("settingsSection") private var picked = SettingsSection.general.rawValue
    /// The page of the Space shown inside the pane in place of the section's rows.
    @State private var detail: HubPage?

    private var section: SettingsSection { SettingsSection(rawValue: picked) ?? .general }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            nav
            Group {
                if let detail { detailPane(detail) } else { sectionPane }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
        .task(id: loader.status) { await settings.refresh() }
        .onChange(of: picked) { _, _ in detail = nil }
    }

    private var sectionPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(section.title).font(.title.weight(.semibold)).foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, 20).padding(.top, 22)
            Form { content }
                .formStyle(.grouped)
                .scrollContentBackground(.hidden)
                .font(.system(size: 15))
                .controlSize(.large)
                .id(section)
        }
        .frame(maxWidth: 680, alignment: .leading)
    }

    /// A page of the Space inside the pane (src/web/App.tsx, 1361ec1): Back returns to its section,
    /// Reload reads it again, and the page's own rows lead further in within the pane.
    private func detailPane(_ page: HubPage) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button { detail = nil } label: {
                    Label { Text(section.title) } icon: { Image(systemName: "chevron.left") }
                        .font(.callout)
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .background(Theme.text.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.text)
                .help("Back to \(Text(section.title))")
                Spacer()
                Button { NotificationCenter.default.post(name: .reloadHubPage, object: nil) } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Reload")
                .accessibilityLabel(Text("Reload"))
            }
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 6)
            NavigationStack {
                HubPageContent(model: model, connection: connection, page: page, loader: loader, icons: icons)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .scrollContentBackground(.hidden)
            }
            .environment(\.hubEmbedded, true)
            .id(page)
        }
    }

    private var nav: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(SettingsSection.allCases) { s in
                let on = s == section
                Button { picked = s.rawValue } label: {
                    Label { Text(s.title) } icon: { Image(systemName: s.symbol).frame(width: 18) }
                        .font(.system(size: 15, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? AnyShapeStyle(Theme.text) : AnyShapeStyle(.secondary))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(on ? Theme.text.opacity(0.08) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(.horizontal, 12).padding(.top, 22)
        .frame(width: 190, alignment: .leading)
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .general:
            spaces
            if model.local.available { LocalSettingsSection(model: model, local: model.local) }
            general
            more
        case .appearance:
            appearance
        case .models:
            models
            pages("Apps", [("App models", "cpu", .appModels)])
            MachineClisSection(api: loader.api)
        case .automation:
            TasksOverview(api: loader.api) { detail = .tasks }
            EventsOverview(api: loader.api) { detail = .events }
        case .feedback:
            FeedbackSections(api: loader.api)
        case .usage:
            ModelUsageOverview(api: loader.api) { detail = .modelUsage }
            AppUsageOverview(api: loader.api, catalogue: loader.catalogue) { detail = .appUsage }
        case .status:
            space
        case .packages:
            pages(nil, [("Apps and connections", "shippingbox", .packages)])
        case .account:
            account
        }
    }

    private var account: some View {
        Group {
            Section {
                Button("Sign Out…", role: .destructive) { model.confirmingSignOut = true }
                    .confirmationDialog(Text("Sign out of \(connection.name)?"), isPresented: $model.confirmingSignOut) {
                        Button("Sign Out", role: .destructive) { model.signOut(connection) }
                    } message: {
                        Text("This clears the Space's cookies and saved pages from this Mac.")
                    }
            } header: {
                Text("Session")
            } footer: {
                Text("The sign-in belongs to whatever stands in front of your Space (for example Cloudflare Access). The app stores no password or token; the session lives in this Space's own web data, apart from your browser.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Version") { Text(verbatim: Bundle.main.shortVersion) }
                SettingsLink { Text("Notifications, Menu Bar and Quick Chat…") }
            } header: {
                Text("About")
            }
        }
    }

    /// Rows that open a page of the Space over the launcher.
    private func pages(_ header: LocalizedStringKey?, _ rows: [(title: LocalizedStringKey, symbol: String, page: HubPage)]) -> some View {
        Section {
            ForEach(rows, id: \.page) { row in
                Button { detail = row.page } label: {
                    HStack {
                        Label(row.title, systemImage: row.symbol).foregroundStyle(Theme.text)
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            if let header { Text(header) }
        } footer: {
            Text("Read from the Space each time a page opens.").font(.callout).foregroundStyle(.secondary)
        }
    }

    // MARK: Spaces

    private var spaces: some View {
        Section {
            ForEach(model.store.connections) { c in
                Button { model.select(c.id) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: c.name).foregroundStyle(Theme.text)
                            Text(verbatim: c.url.absoluteString).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        if c.id == connection.id { Image(systemName: "checkmark").foregroundStyle(Theme.accent).accessibilityLabel(Text("Selected")) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            SettingsLink { Label("Add or Edit Spaces…", systemImage: "plus") }
        } header: {
            Text("Spaces")
        } footer: {
            Text("Removing a Space forgets its address, sign-in and screens on this Mac. Nothing changes on the server.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    // MARK: This Mac's display

    private var general: some View {
        Section {
            Toggle("Widgets", isOn: $prefs.showsWidgets)
            LabeledContent("Language") {
                Button(Locale.current.localizedString(forLanguageCode: Lang.current) ?? Lang.current) {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension") { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(.link)
            }
        } header: {
            Text("This Mac")
        } footer: {
            Text("These belong to this Mac, as the same choices on the panel belong to each browser. The language follows the app's language in System Settings.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    private var appearance: some View {
        Section {
            Picker("Mode", selection: $prefs.appearance) {
                Text("System").tag(Appearance.system)
                Text("Light").tag(Appearance.light)
                Text("Dark").tag(Appearance.dark)
            }
            Picker("Theme", selection: $prefs.themeID) {
                ForEach(ThemePreset.all) { Text(verbatim: $0.name).tag($0.id) }
            }
        } header: {
            Text("Display")
        } footer: {
            Text("These belong to this Mac, as the same choices on the panel belong to each browser.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    // MARK: The Space

    /// The Space's default model: the one setting here that changes the Space itself.
    @ViewBuilder private var models: some View {
        if let m = settings.settings?.models {
            Section {
                Picker("Default model", selection: Binding(get: { m.defaultModel ?? "" }, set: { value in
                    guard m.canPick(value) else { return }
                    Task { await settings.setDefaultModel(value.isEmpty ? nil : value) }
                })) {
                    Text("Environment defaults").tag("")
                    ForEach(m.options) { o in Text(verbatim: o.shownLabel).tag(o.value).disabled(!o.isAvailable) }
                    if let current = m.defaultModel, !m.options.contains(where: { $0.value == current }) {
                        Text(verbatim: ModelChoiceText.saved(current)).tag(current)
                    }
                }
                .disabled(settings.isSaving || loader.status != .ok)
                if let reason = settings.saveError {
                    Label { Text("The change was not saved: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                        .font(.footnote)
                }
            } header: {
                Text("Models")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Shared by app requests and new Space Assistant chats. Changing it here changes the Space, for every device.")
                    if let apps = m.appDefault, let base = m.baseDefault {
                        Text("Apps: \(apps) · Space Assistant: \(base)")
                    }
                }
                .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    /// The pages General leads to; the others sit under their own sections.
    private static let spacePages: Set<HubPage> = [.inbox, .chat(agent: nil), .terminal]

    /// The Space's own pages, drawn by the app from the Space's routes.
    private var more: some View {
        Section {
            ForEach(HubPage.rows.filter { Self.spacePages.contains($0.page) }, id: \.page) { row in
                Button { model.destination = .hub(row.page) } label: {
                    HStack {
                        Label(row.title, systemImage: row.symbol).foregroundStyle(Theme.text)
                        Spacer()
                        if row.page == .inbox, let n = model.lives[connection.id]?.summary.unread, n > 0 {
                            Text(verbatim: "\(n)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Button { model.openWebPanel() } label: {
                HStack {
                    Label("Web Panel", systemImage: "safari").foregroundStyle(Theme.text)
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } header: {
            Text("Space")
        } footer: {
            Text("Read from the Space each time a page opens.").font(.callout).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var space: some View {
        let peers = loader.catalogue?.peers ?? []
        Section {
            LabeledContent("Status") { Text(statusText) }
            if let s = settings.settings {
                LabeledContent("Services") { Text(verbatim: "\(s.services.filter { $0.state == .running }.count) / \(s.services.count)") }
                if !peers.isEmpty {
                    LabeledContent("Peers") { Text(verbatim: "\(peers.filter { !$0.isOffline }.count) / \(peers.count)") }
                }
                if !s.backups.isEmpty {
                    LabeledContent("Backups") { Text(verbatim: "\(s.backups.filter { $0.state == .ok }.count) / \(s.backups.filter { $0.state != .retired }.count)") }
                }
            } else if settings.isLoading {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Loading…").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(verbatim: connection.name)
        } footer: {
            Text(verbatim: connection.url.absoluteString).font(.callout).foregroundStyle(.secondary)
        }

        if !peers.isEmpty {
            Section {
                ForEach(peers) { peer in
                    row(dot: peer.isOffline ? Color.secondary : Theme.success, title: peer.name, detail: peerDetail(peer),
                        value: peer.isOffline ? String(localized: "offline") : String(localized: "online"))
                }
            } header: {
                Text("Peers")
            }
        }

        if let s = settings.settings {
            if !s.services.isEmpty {
                Section {
                    ForEach(s.services) { service in
                        HStack(spacing: 12) {
                            EntryIcon(icon: service.icon, fallback: "app", icons: icons, size: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: service.displayTitle).foregroundStyle(Theme.text)
                                Text(verbatim: [service.peer, service.port.map { ":\($0)" }].compactMap { $0 }.joined(separator: " "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            stateLabel(service.state)
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    Text("Services")
                }
            }
            if !s.backups.isEmpty {
                Section {
                    ForEach(s.backups) { backup in
                        row(dot: backupColor(backup.state), title: backup.app, detail: backupDetail(backup), value: backupText(backup.state))
                    }
                } header: {
                    Text("Backups")
                } footer: {
                    if let target = s.backupTarget { Text(verbatim: target).font(.callout).foregroundStyle(.secondary) }
                }
            }
        }
    }

    private func row(dot: Color, title: String, detail: String?, value: String) -> some View {
        HStack(spacing: 10) {
            Circle().fill(dot).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title).foregroundStyle(Theme.text)
                if let detail, !detail.isEmpty {
                    Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Text(verbatim: value).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func stateLabel(_ state: SpaceService.State) -> some View {
        let (color, text): (Color, String) = {
            switch state {
            case .running: return (Theme.success, String(localized: "running"))
            case .down: return (Theme.danger, String(localized: "not answering"))
            case .paused: return (Color.secondary, String(localized: "paused"))
            case .unknown: return (Color.secondary, String(localized: "unknown"))
            }
        }()
        return HStack(spacing: 6) {
            Circle().fill(color).frame(width: 9, height: 9)
            Text(verbatim: text).foregroundStyle(.secondary)
        }
    }

    private func peerDetail(_ peer: PeerStatus) -> String {
        var parts: [String] = []
        if let apps = peer.apps { parts.append(String(localized: "\(apps) apps")) }
        if let agents = peer.agents { parts.append(String(localized: "\(agents) agents")) }
        if let widgets = peer.widgets { parts.append(String(localized: "\(widgets) widgets")) }
        if peer.isOffline, let date = peer.asOf.flatMap(Times.parse) { parts.append(Times.ago(date)) }
        return parts.joined(separator: " · ")
    }

    private func backupColor(_ state: SpaceBackup.State) -> Color {
        switch state {
        case .ok: return Theme.success
        case .stale: return Theme.warning
        case .failed: return Theme.danger
        case .retired, .none: return .secondary
        }
    }

    private func backupText(_ state: SpaceBackup.State) -> String {
        switch state {
        case .ok: return String(localized: "ok")
        case .stale: return String(localized: "out of date")
        case .failed: return String(localized: "failed")
        case .retired: return String(localized: "retired")
        case .none: return String(localized: "none yet")
        }
    }

    private func backupDetail(_ backup: SpaceBackup) -> String {
        var parts: [String] = []
        if let count = backup.count { parts.append(String(localized: "\(count) snapshots")) }
        if let date = backup.lastOk { parts.append(Times.ago(date)) }
        if let bytes = backup.lastOkBytes { parts.append(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)) }
        if backup.state == .failed, let error = backup.lastError { parts.append(error) }
        return parts.joined(separator: " · ")
    }

    private var statusText: String {
        switch loader.status {
        case .ok: return String(localized: "Connected")
        case .loading: return String(localized: "Connecting…")
        case .signInNeeded: return String(localized: "Signed out")
        case .unreachable: return String(localized: "Cannot reach this Space")
        case .incompatible: return String(localized: "Not an ai-space panel")
        }
    }
}

/// Settings → Models (src/web/MachineClis.tsx): which agent CLIs each machine has, with its
/// version, whether it is signed in and which runtime uses it. A CLI found on the Space's own
/// machine that no runtime uses can be added to runtimes.yaml; a peer's row is only shown.
struct MachineClisSection: View {
    @StateObject private var store: MachineClisStore

    init(api: SpaceAPI) {
        _store = StateObject(wrappedValue: MachineClisStore(api: api))
    }

    var body: some View {
        Section {
            if let error = store.error {
                Label { Text("Unavailable: \(error)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
            } else if !store.loaded {
                ProgressView().controlSize(.small)
            }
            ForEach(store.machines) { m in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(verbatim: m.machine.isEmpty ? String(localized: "This machine") : m.machine).fontWeight(.semibold)
                        if let note = m.note { Text(verbatim: note).font(.caption).foregroundStyle(.secondary) }
                    }
                    ForEach(m.entries) { c in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: c.cli).font(.body.monospaced()).frame(minWidth: 56, alignment: .leading)
                            Text(verbatim: Self.status(c)).font(.callout).foregroundStyle(c.state == .signedIn ? Theme.success : Color.secondary)
                                .help([c.path, c.detail].compactMap { $0 }.joined(separator: "\n"))
                            Spacer(minLength: 8)
                            if m.canAdd(c, pending: store.pending), let kind = c.kind {
                                Button("Add to runtimes.yaml") { Task { await store.add(kind) } }
                                    .controlSize(.small).disabled(store.isSaving)
                            } else if c.installed == true {
                                Text(verbatim: c.configured == true ? String(localized: "Runtime: \((c.runtimes ?? []).joined(separator: ", "))") : String(localized: "Not a runtime there"))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .opacity(m.isOff ? 0.6 : 1)
                    }
                }
                .padding(.vertical, 2)
            }
            HStack {
                if let at = MachineInventory.lastChecked(store.machines) {
                    Text("Checked \(HubFormat.relative(at))").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button { Task { await store.recheck() } } label: { Text(store.isSaving ? "Checking…" : "Check again") }
                    .disabled(store.isSaving)
            }
            if let added = store.added {
                Text("Added as runtime \(added). Restart ai-space to offer it.").font(.callout).foregroundStyle(.secondary)
            }
            if let reason = store.saveError {
                Label { Text(verbatim: reason) } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                    .font(.callout)
            }
        } header: {
            Text("AI CLIs by machine")
        } footer: {
            Text("The agent CLIs each machine has. A CLI that is missing is left out of every model choice; one that is not signed in is shown greyed until it is.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .task { await store.refresh() }
    }

    /// Its version and sign-in, or why there is none.
    static func status(_ c: CliInfo) -> String {
        switch c.state {
        case .unknown: return String(localized: "Not checked yet")
        case .missing: return String(localized: "Not installed")
        case .signedIn: return [c.version, String(localized: "Signed in")].compactMap { $0 }.joined(separator: " · ")
        case .signedOut: return [c.version, String(localized: "Not signed in")].compactMap { $0 }.joined(separator: " · ")
        case .installed: return c.version ?? "✓"
        }
    }
}

/// Settings → Feedback (src/web/FeedbackSettings.tsx, docs/feedback.md): the button app pages show,
/// what happens to what is sent with it, where the Fix Engineer runs and on which model, which apps
/// show the button (each peer's too, which the Space sends these settings on to), and the feedback
/// sent lately with a way to start the waiting ones. A choice shows at once and saves behind it.
struct FeedbackSections: View {
    @StateObject private var store: FeedbackStore

    init(api: SpaceAPI) {
        _store = StateObject(wrappedValue: FeedbackStore(api: api))
    }

    var body: some View {
        Group {
            if let view = store.view {
                settings(view)
                apps(view)
                ForEach(view.peers) { peer(view, $0) }
                recent(view)
            } else {
                Section {
                    if let error = store.error {
                        Label { Text("Unavailable: \(error)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
            }
        }
        .task { await store.refresh() }
        // While something is being fixed, the list follows it.
        .task(id: store.isActive) {
            while store.isActive, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if !Task.isCancelled { await store.refresh() }
            }
        }
    }

    private func bind<T>(_ value: T, _ change: @escaping (T) -> FeedbackChange?) -> Binding<T> {
        Binding(get: { value }, set: { new in
            guard let c = change(new) else { return }
            Task { await store.change(c) }
        })
    }

    private func settings(_ v: FeedbackView) -> some View {
        let s = v.settings
        return Section {
            Toggle("Feedback button on app pages", isOn: bind(s.enabled) { .enabled($0) })
            Picker("What happens to feedback", selection: bind(s.mode) { .mode($0) }) {
                Text("Fix it right away").tag("auto")
                Text("Record it, fix later together").tag("later")
            }
            Picker("Fix on", selection: bind(s.machine) { .machine($0) }) {
                ForEach(v.machines) { m in
                    Text(verbatim: m.value.isEmpty ? String(localized: "\(m.label) (this machine)") : m.label).tag(m.value)
                }
            }
            Picker("Fix Engineer model", selection: bind(s.model) { value in
                value.isEmpty || v.models.first(where: { $0.value == value })?.isAvailable == true ? FeedbackChange.model(value) : nil
            }) {
                Text("Default chat model").tag("")
                if !s.model.isEmpty, !v.models.contains(where: { $0.value == s.model }) {
                    Text(verbatim: ModelChoiceText.saved(s.model)).tag(s.model)
                }
                ForEach(v.models) { o in Text(verbatim: o.shownLabel).tag(o.value).disabled(!o.isAvailable) }
            }
            Picker("Effort", selection: bind(s.effort) { .effort($0) }) {
                Text("High").tag("high")
                Text("Extra high").tag("xhigh")
                Text("Max").tag("max")
            }
            Toggle("Attach recent script errors", isOn: bind(s.errors) { .errors($0) })
            LabeledContent("Shortcut") { Text(verbatim: v.shortcut).font(.body.monospaced()) }
            if let reason = store.saveError {
                Label { Text("The change was not saved: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                    .font(.callout)
            }
        } header: {
            Text("Feedback")
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text("A small button in the corner of each app page (Alt+Shift+F): people describe a problem, pick the element, add a picture, and it becomes an ai-todo task. Off until you turn it on.")
                Text("The button sends what the person types, the page address, client, screen size, theme, language and picked elements; passwords, tokens and form values are left out. The Fix Engineer changes only that app's source and treats page content as data, not instructions. Turn this on only when app pages need sign-in.")
            }
            .font(.callout).foregroundStyle(.secondary)
        }
    }

    private func appRow(_ a: FeedbackApp, _ s: FeedbackSettings) -> some View {
        Picker(selection: bind(s.apps[a.app] ?? "default") { .app(a.app, $0) }) {
            Text("Default (\(s.appsDefault ? String(localized: "On") : String(localized: "Off")))").tag("default")
            Text("On").tag("on")
            Text("Off").tag("off")
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: a.displayTitle())
                Text(a.enabled == true ? "Button shown" : "Button hidden").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func apps(_ v: FeedbackView) -> some View {
        Section {
            Toggle("Show on apps by default", isOn: bind(v.settings.appsDefault) { .appsDefault($0) })
            ForEach(v.apps) { appRow($0, v.settings) }
        } header: {
            Text("Apps")
        } footer: {
            Text("An app shows the button when the main switch is on and the app is on — by its own setting, or by the default.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    /// A peer's apps follow these settings: the Space sends them there (docs/feedback.md#apps-on-a-peer).
    private func peer(_ v: FeedbackView, _ p: FeedbackPeer) -> some View {
        Section {
            if p.ok != true {
                Text("Can't reach \(p.name): \(p.error ?? "")").foregroundStyle(Theme.danger)
            } else {
                if p.appList.isEmpty { Text("No apps with a page on \(p.name).").foregroundStyle(.secondary) }
                ForEach(p.appList) { appRow($0, v.settings) }
                if p.synced != true {
                    Text("Not sent to \(p.name) yet: \(p.error ?? ""). It is tried again the next time this page opens.").foregroundStyle(Theme.danger)
                }
            }
        } header: {
            Text("Apps on \(p.name)")
        } footer: {
            if p.ok == true, !p.appList.isEmpty {
                Text("These apps run on \(p.name). Their pages ask \(p.name), so the choices above and these switches are sent to \(p.name) each time this page opens or changes. Fix on: the app's own machine, unless \(p.name) also knows the one chosen above.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    private func recent(_ v: FeedbackView) -> some View {
        Section {
            if store.items.isEmpty { Text("Nothing sent yet.").foregroundStyle(.secondary) }
            ForEach(store.items, id: \.key) { i in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        (Text(verbatim: v.title(i.app, peer: i.peerName)).bold() + Text(verbatim: " " + i.text)).lineLimit(4)
                        HStack(spacing: 6) {
                            Text(verbatim: Self.meta(i)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                .help(i.note ?? "")
                            if let url = i.todoUrl.flatMap(URL.init(string:)), let n = i.todoId {
                                Link(destination: url) { Text("task #\(n)") }.font(.caption)
                            }
                        }
                    }
                    Spacer(minLength: 4)
                    if i.canFix {
                        Button { Task { await store.fix(peer: i.peerName, ids: [i.id]) } } label: { Text(i.status == "later" ? "Fix now" : "Fix again") }
                            .controlSize(.small).disabled(store.fixing)
                    }
                }
                .padding(.vertical, 2)
            }
            HStack {
                if v.waiting > 0 { Text("\(v.waiting) waiting").font(.callout).foregroundStyle(.secondary) }
                Spacer()
                if v.waiting > 0 {
                    Button { Task { await store.fix() } } label: { Text("Fix \(v.waiting) waiting now") }.disabled(store.fixing)
                }
                ForEach(v.peers.filter { $0.ok == true && $0.waiting > 0 }) { p in
                    Button { Task { await store.fix(peer: p.name) } } label: { Text("Fix \(p.waiting) waiting on \(p.name)") }.disabled(store.fixing)
                }
                Button { Task { await store.refresh() } } label: { Text("Refresh") }
            }
            if let notice = store.notice { Text(verbatim: notice).font(.callout).foregroundStyle(.secondary) }
        } header: {
            Text("Recent feedback")
        }
    }

    /// Where the row stands: the peer, the status, the task, the machine, when, and why when it says.
    static func meta(_ i: FeedbackItem) -> String {
        var parts: [String] = []
        if let peer = i.peerName { parts.append(peer) }
        parts.append(FeedbackItem.statusText(i.status))
        if let n = i.todoId, i.todoUrl == nil { parts.append(String(localized: "task #\(n)")) }
        if let m = i.runMachine, !m.isEmpty { parts.append(m) }
        if let at = i.createdAt { parts.append(HubFormat.relative(Date(timeIntervalSince1970: at / 1000))) }
        if let note = i.shownNote, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}
