import SwiftUI

/// The launcher's last page, as the iPhone client's Settings: the saved Spaces, this Mac's
/// display, the Space's own settings as its panel shows them (status, the default model, its
/// pages, peers, services, backups), then the session and the app.
struct SettingsPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var settings: SettingsLoader
    let icons: IconStore
    @ObservedObject var prefs: Preferences

    var body: some View {
        Form {
            spaces
            display
            space
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
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                LabeledContent("Version") { Text(verbatim: Bundle.main.shortVersion) }
                SettingsLink { Text("Notifications, Menu Bar and Quick Chat…") }
            } header: {
                Text("About")
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .frame(maxWidth: 680)
        .frame(maxWidth: .infinity)
        .task(id: loader.status) { await settings.refresh() }
    }

    // MARK: Spaces

    private var spaces: some View {
        Section {
            ForEach(model.store.connections) { c in
                Button { model.select(c.id) } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: c.name).foregroundStyle(Theme.text)
                            Text(verbatim: c.url.absoluteString).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
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
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    // MARK: This Mac's display

    private var display: some View {
        Section {
            Picker("Appearance", selection: $prefs.appearance) {
                Text("System").tag(Appearance.system)
                Text("Light").tag(Appearance.light)
                Text("Dark").tag(Appearance.dark)
            }
            Picker("Theme", selection: $prefs.themeID) {
                ForEach(ThemePreset.all) { Text(verbatim: $0.name).tag($0.id) }
            }
            Toggle("Widgets", isOn: $prefs.showsWidgets)
            LabeledContent("Language") {
                Button(Locale.current.localizedString(forLanguageCode: Lang.current) ?? Lang.current) {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.Localization-Settings.extension") { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(.link)
            }
        } header: {
            Text("Display")
        } footer: {
            Text("These belong to this Mac, as the same choices on the panel belong to each browser. The language follows the app's language in System Settings.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    // MARK: The Space

    /// The Space's default model: the one setting here that changes the Space itself.
    @ViewBuilder private var models: some View {
        if let m = settings.settings?.models {
            Section {
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
            } header: {
                Text("Models")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Shared by app requests and new Space Assistant chats. Changing it here changes the Space, for every device.")
                    if let apps = m.appDefault, let base = m.baseDefault {
                        Text("Apps: \(apps) · Space Assistant: \(base)")
                    }
                }
                .font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    /// The Space's own pages, drawn by the app from the Space's routes.
    private var more: some View {
        Section {
            ForEach(HubPage.rows, id: \.page) { row in
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
            Text("Read from the Space each time a page opens.").font(.footnote).foregroundStyle(.secondary)
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
            Text(verbatim: connection.url.absoluteString).font(.footnote).foregroundStyle(.secondary)
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
                    if let target = s.backupTarget { Text(verbatim: target).font(.footnote).foregroundStyle(.secondary) }
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
