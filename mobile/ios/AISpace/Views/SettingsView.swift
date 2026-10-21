import SwiftUI

/// The Space's own settings as its panel shows them (peers, services, backups), read from the
/// Space, then what belongs to this phone: the saved Spaces, the session and the app.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var settings: SettingsLoader
    let icons: IconStore

    var body: some View {
        List {
            Section {
                ForEach(model.store.connections) { c in
                    Button { model.select(c.id) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: c.name).foregroundStyle(Theme.text)
                                Text(verbatim: c.url.absoluteString).font(.footnote).foregroundStyle(Color.secondary).lineLimit(1)
                            }
                            Spacer()
                            if c.id == connection.id { Image(systemName: "checkmark").foregroundStyle(Theme.accent).accessibilityLabel(Text("Selected")) }
                        }
                    }
                    .swipeActions {
                        Button(role: .destructive) { model.remove(c.id) } label: { Label("Remove", systemImage: "trash") }
                    }
                }
                Button { model.showingAdd = true } label: { Label("Add a Space", systemImage: "plus") }
            } header: {
                Text("Spaces")
            } footer: {
                Text("Removing a Space here forgets its address, sign-in and screens on this iPhone. Nothing changes on the server.")
            }

            #if !targetEnvironment(macCatalyst)
            Section {
                Button {
                    Task {
                        await model.prepareSharing()
                        model.sharedCapture = SharedCaptureModel()
                    }
                } label: { Label("Pending Shares", systemImage: "square.and.arrow.down") }
            }

            #endif

            display
            space

            Section {
                Button(role: .destructive) { model.confirmingSignOut = true } label: { Text("Sign Out") }
                    .confirmationDialog(Text("Sign out of \(connection.name)?"), isPresented: $model.confirmingSignOut, titleVisibility: .visible) {
                        Button("Sign Out", role: .destructive) { model.signOut(connection) }
                    } message: {
                        Text("This clears the Space's cookies and saved pages from this iPhone.")
                    }
            } header: {
                Text("Session")
            } footer: {
                Text("The sign-in belongs to whatever stands in front of your Space (for example Cloudflare Access). The app stores no password or token; the session lives in this Space's own web data, apart from Safari.")
            }

            Section {
                LabeledContent("Version") { Text(verbatim: Bundle.main.shortVersion) }
            } header: {
                Text("About")
            }
        }
        .sheet(isPresented: Binding(get: { model.sharedCapture != nil }, set: { if !$0 { model.sharedCapture = nil } })) {
            if let sharedCapture = model.sharedCapture { SharedCaptureView(model: sharedCapture) { model.sharedCapture = nil } }
        }
        .scrollContentBackground(.hidden)
        .scrollClipDisabled()
        .refreshable {
            await loader.refresh()
            await settings.refresh()
        }
        .task(id: loader.status) { await settings.refresh() }
    }

    // MARK: This iPhone's display

    private var display: some View {
        Section {
            Picker("Appearance", selection: $model.appearance) {
                Text("System").tag(Appearance.system)
                Text("Light").tag(Appearance.light)
                Text("Dark").tag(Appearance.dark)
            }
            Picker("Theme", selection: $model.themeID) {
                ForEach(ThemePreset.all) { Text(verbatim: $0.name).tag($0.id) }
            }
            Toggle("Widgets", isOn: $model.showsWidgets)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                LabeledContent("Language") { Text(verbatim: Locale.current.localizedString(forLanguageCode: Lang.current) ?? Lang.current) }
            }
            .foregroundStyle(Theme.text)
        } header: {
            Text("Display")
        } footer: {
            Text("These belong to this iPhone, as the same choices on the panel belong to each browser. The language follows the app's language in iOS Settings.")
        }
    }

    /// The Space's sections as the panel's settings has them (General, Models, Automation, Usage,
    /// Status, Packages), one card each in the phone's single column: Models holds the default
    /// model, the one setting here that changes the Space itself, and the app models.
    @ViewBuilder private var models: some View {
        Section {
            if let m = settings.settings?.models {
                Picker("Default model", selection: Binding(get: { m.defaultModel ?? "" }, set: { value in
                    Task { await settings.setDefaultModel(value.isEmpty ? nil : value) }
                })) {
                    Text("Environment defaults").tag("")
                    ForEach(m.options) { Text(verbatim: $0.label).tag($0.value) }
                    if let current = m.defaultModel, !m.options.contains(where: { $0.value == current }) {
                        Text(verbatim: current).tag(current)
                    }
                }
                .disabled(settings.isSaving || loader.status != .ok)
                if let reason = settings.saveError {
                    Label { Text("The change was not saved: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                        .font(.footnote)
                }
            }
            pageRow("App models", "cpu", .appModels)
        } header: {
            Text("Models")
        } footer: {
            if let m = settings.settings?.models {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Shared by app requests and new Space Assistant chats. Changing it here changes the Space, for every device.")
                    if let apps = m.appDefault, let base = m.baseDefault {
                        Text("Apps: \(apps) · Space Assistant: \(base)")
                    }
                }
            }
        }
    }

    /// The Space's own pages, drawn by the app from the Space's routes, in the panel's sections.
    @ViewBuilder private var more: some View {
        Section {
            pageRow("Scheduled tasks", "calendar.badge.clock", .tasks)
            pageRow("Events and calls", "bolt.horizontal", .events)
        } header: {
            Text("Automation")
        }
        Section {
            pageRow("Model usage", "chart.bar", .modelUsage)
            pageRow("App usage", "chart.line.uptrend.xyaxis", .appUsage)
        } header: {
            Text("Usage")
        }
        Section {
            pageRow("Inbox", "tray", .inbox)
            pageRow("Chat", "bubble.left.and.text.bubble.right", .chat(agent: nil))
            pageRow("Apps and connections", "shippingbox", .packages)
            pageRow("Terminal", "terminal", .terminal)
        } header: {
            Text("Space")
        } footer: {
            Text("Read from the Space each time a page opens.")
        }
    }

    private func pageRow(_ title: LocalizedStringKey, _ symbol: String, _ page: HubPage) -> some View {
        Button { model.hubPage = page } label: {
            HStack {
                Label(title, systemImage: symbol).foregroundStyle(Theme.text)
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: The Space

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
                    ProgressView()
                    Text("Loading…").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text(verbatim: connection.name)
        } footer: {
            Text(verbatim: connection.url.absoluteString)
        }

        models
        more

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
                            EntryIcon(icon: service.icon, fallback: "app", icons: icons, size: 30)
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
                    if let target = s.backupTarget { Text(verbatim: target) }
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
            Text(verbatim: value).font(.subheadline).foregroundStyle(.secondary)
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
            Text(verbatim: text).font(.subheadline).foregroundStyle(.secondary)
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
