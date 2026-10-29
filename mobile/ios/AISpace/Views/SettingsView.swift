import SwiftUI

/// A section of Settings, as the panel's section nav and the Mac's have them.
enum SettingsSection: String, CaseIterable, Identifiable, Hashable {
    case general, appearance, models, automation, usage, status, packages, account

    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .general: return "General"
        case .appearance: return "Appearance"
        case .models: return "Models"
        case .automation: return "Automation"
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
        case .usage: return "chart.bar"
        case .status: return "waveform.path.ecg"
        case .packages: return "shippingbox"
        case .account: return "person.crop.circle"
        }
    }
}

/// Settings as the panel's (src/web/App.tsx, SettingsNav.tsx) and the Mac's, opened from its tile
/// over the pages: the sections in their order, General, Appearance, Models, Automation, Usage,
/// Status, Packages and Account, each an icon and a title in one glass card, drawn as the panel
/// draws its cards over the Space's backdrop. A section opens as a page of its own with its rows
/// in such cards, and a row there that leads to a page of the Space opens it further in, as the
/// panel shows those pages inside Settings.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var settings: SettingsLoader
    let icons: IconStore

    var body: some View {
        let backdrop = model.backdrops(for: connection)
        NavigationStack(path: $model.settingsPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    SettingsHeading("Settings")
                    SettingsCard {
                        ForEach(Array(SettingsSection.allCases.enumerated()), id: \.element) { index, section in
                            if index > 0 { CardDivider() }
                            NavigationLink(value: section) {
                                HStack(spacing: 12) {
                                    Image(systemName: section.symbol).foregroundStyle(.secondary).frame(width: 22)
                                    Text(section.title)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                                }
                            }
                            .buttonStyle(SettingsRowStyle())
                        }
                    }
                    Text("Version \(Bundle.main.shortVersion)").font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.top, 12)
                }
                .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 40)
            }
            .background { SpaceBackdrop(store: backdrop) }
            .settingsChrome(Text("Settings"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { model.showingSettings = false } label: { Image(systemName: "xmark") }
                        .accessibilityLabel(Text("Close"))
                }
            }
            .navigationDestination(for: SettingsSection.self) { section in
                SettingsSectionPage(model: model, connection: connection, loader: loader, settings: settings, icons: icons, section: section)
                    .background { SpaceBackdrop(store: backdrop) }
            }
            .navigationDestination(for: HubPage.self) { page in
                HubPageContent(model: model, connection: connection, page: page, loader: loader, icons: icons)
                    .scrollContentBackground(.hidden)
                    .background { SpaceBackdrop(store: backdrop) }
                    .navigationBarTitleDisplayMode(.inline)
            }
        }
        .tint(Theme.accent)
        #if DEBUG
        .onAppear { DebugLaunch.settingsPath(&model.settingsPath) }
        #endif
        .sheet(isPresented: Binding(get: { model.sharedCapture != nil }, set: { if !$0 { model.sharedCapture = nil } })) {
            if let sharedCapture = model.sharedCapture { SharedCaptureView(model: sharedCapture) { model.sharedCapture = nil } }
        }
        // A Space is added from here while Settings is up; RootView's sheet serves the pages.
        .sheet(isPresented: Binding(get: { model.showingAdd && model.showingSettings }, set: { model.showingAdd = $0 })) {
            NavigationStack { ConnectView(model: model, isFirst: false) }
        }
        .task(id: loader.status) { await settings.refresh() }
    }
}

/// One section of Settings on a page of its own: its rows in glass cards, as the panel shows
/// the chosen section. What belongs to this phone joins the section it fits: the pages the panel
/// has as tiles go under General, the saved Spaces and the sign-in under Account.
struct SettingsSectionPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var settings: SettingsLoader
    let icons: IconStore
    let section: SettingsSection
    /// The status rows, shown first as on the panel, where the section has a page of its own.
    @State private var statusOpen = true

    var body: some View {
        Group {
            if section == .account {
                account
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        SettingsHeading(section.title)
                        switch section {
                        case .general: general
                        case .appearance: appearance
                        case .models: models
                        case .automation: automation
                        case .usage: usage
                        case .status: status
                        case .packages: packages
                        case .account: EmptyView()
                        }
                    }
                    .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 40)
                }
            }
        }
        .settingsChrome(Text(section.title))
        .refreshable {
            await loader.refresh()
            await settings.refresh()
        }
    }

    // MARK: General

    /// The panel's General holds the browser's preferences; here they are this phone's.
    private var general: some View {
        SectionCards {
            SettingsCard {
                Toggle("Widgets", isOn: $model.showsWidgets).settingsRow()
                CardDivider()
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                } label: {
                    HStack {
                        Text("Language")
                        Spacer()
                        Text(verbatim: Locale.current.localizedString(forLanguageCode: Lang.current) ?? Lang.current).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(SettingsRowStyle())
                #if !targetEnvironment(macCatalyst)
                CardDivider()
                Button {
                    Task {
                        await model.prepareSharing()
                        model.sharedCapture = SharedCaptureModel()
                    }
                } label: { link("Pending Shares", "square.and.arrow.down") }
                .buttonStyle(SettingsRowStyle())
                #endif
            }
            SettingsCard {
                pageRow("Inbox", "tray", .inbox)
                CardDivider()
                pageRow("Chat", "bubble.left.and.text.bubble.right", .chat(agent: nil))
                CardDivider()
                pageRow("Terminal", "terminal", .terminal)
            }
            SettingsNote("These belong to this iPhone, as the same choices on the panel belong to each browser. The language follows the app's language in iOS Settings.")
        }
    }

    // MARK: Appearance

    private var appearance: some View {
        SectionCards {
            SettingsCard {
                LabeledContent("Appearance") {
                    Picker("Appearance", selection: $model.appearance) {
                        Text("System").tag(Appearance.system)
                        Text("Light").tag(Appearance.light)
                        Text("Dark").tag(Appearance.dark)
                    }
                    .labelsHidden()
                }
                .settingsRow(vertical: 6)
                CardDivider()
                LabeledContent("Theme") {
                    Picker("Theme", selection: $model.themeID) {
                        ForEach(ThemePreset.all) { Text(verbatim: $0.name).tag($0.id) }
                    }
                    .labelsHidden()
                }
                .settingsRow(vertical: 6)
            }
        }
    }

    // MARK: Models

    /// The default model, the one setting here that changes the Space itself, then the app models
    /// in a card of their own, as on the panel.
    private var models: some View {
        SectionCards {
            if let m = settings.settings?.models {
                SettingsCard {
                    LabeledContent("Default model") {
                        Picker("Default model", selection: Binding(get: { m.defaultModel ?? "" }, set: { value in
                            Task { await settings.setDefaultModel(value.isEmpty ? nil : value) }
                        })) {
                            Text("Environment defaults").tag("")
                            ForEach(m.options) { Text(verbatim: $0.label).tag($0.value) }
                            if let current = m.defaultModel, !m.options.contains(where: { $0.value == current }) {
                                Text(verbatim: current).tag(current)
                            }
                        }
                        .labelsHidden()
                    }
                    .settingsRow(vertical: 6)
                    .disabled(settings.isSaving || loader.status != .ok)
                    if let reason = settings.saveError {
                        CardDivider()
                        Label { Text("The change was not saved: \(reason)") } icon: { Image(systemName: "exclamationmark.triangle").foregroundStyle(Theme.warning) }
                            .font(.footnote)
                            .settingsRow()
                    }
                }
            }
            SettingsCard {
                pageRow("App models", "cpu", .appModels)
            }
            if let m = settings.settings?.models {
                VStack(alignment: .leading, spacing: 4) {
                    SettingsNote("Shared by app requests and new Space Assistant chats. Changing it here changes the Space, for every device.")
                    if let apps = m.appDefault, let base = m.baseDefault {
                        SettingsNote("Apps: \(apps) · Space Assistant: \(base)")
                    }
                }
            }
        }
    }

    // MARK: Automation, Usage, Packages

    private var automation: some View {
        SectionCards {
            SettingsCard {
                pageRow("Scheduled tasks", "calendar.badge.clock", .tasks)
                CardDivider()
                pageRow("Events and calls", "bolt.horizontal", .events)
            }
        }
    }

    private var usage: some View {
        SectionCards {
            SettingsCard {
                pageRow("Model usage", "chart.bar", .modelUsage)
                CardDivider()
                pageRow("App usage", "chart.line.uptrend.xyaxis", .appUsage)
            }
        }
    }

    private var packages: some View {
        SectionCards {
            SettingsCard {
                pageRow("Apps and connections", "shippingbox", .packages)
            }
        }
    }

    private func pageRow(_ title: LocalizedStringKey, _ symbol: String, _ page: HubPage) -> some View {
        NavigationLink(value: page) { link(title, symbol) }
            .buttonStyle(SettingsRowStyle())
    }

    private func link(_ title: LocalizedStringKey, _ symbol: String) -> some View {
        HStack {
            Label(title, systemImage: symbol)
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
    }

    // MARK: Status

    /// The panel's Status: the peers, services and backups folded into one summary line with a
    /// tally of what is wrong (a service or peer down, a backup gone stale), their rows under it.
    @ViewBuilder private var status: some View {
        let peers = loader.catalogue?.peers ?? []
        SectionCards {
            SettingsCard {
                Button { withAnimation(.easeOut(duration: 0.15)) { statusOpen.toggle() } } label: {
                    HStack(spacing: 8) {
                        Text(verbatim: summary(peers: peers)).lineLimit(2)
                        Spacer(minLength: 8)
                        if let s = settings.settings, loader.status == .ok {
                            let problems = s.services.filter { $0.state == .down }.count + peers.filter(\.isOffline).count
                                + s.backups.filter { $0.state == .stale }.count
                            HStack(spacing: 6) {
                                Dot(color: problems == 0 ? Theme.success : Theme.danger, size: 8)
                                Text(problems == 0 ? String(localized: "all ok") : String(localized: "\(problems) issues"))
                                    .font(.subheadline).foregroundStyle(.secondary)
                            }
                        } else if settings.isLoading {
                            ProgressView().controlSize(.small)
                        }
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(statusOpen ? 90 : 0))
                    }
                }
                .buttonStyle(SettingsRowStyle())
                .accessibilityValue(Text(statusOpen ? "Shown" : "Hidden"))
                if statusOpen { statusRows(peers: peers) }
            }
        }
    }

    @ViewBuilder private func statusRows(peers: [PeerStatus]) -> some View {
        if !peers.isEmpty {
            CardHead("Peers")
            ForEach(peers) { peer in
                row(dot: peer.isOffline ? Color.secondary : Theme.success, title: peer.name, detail: peerDetail(peer),
                    value: peer.isOffline ? String(localized: "offline") : String(localized: "online"))
                    .settingsRow(vertical: 8)
            }
        }
        if let s = settings.settings {
            CardHead("Services")
            if s.services.isEmpty {
                SettingsNote("No services").padding(.horizontal, 12).padding(.bottom, 10)
            }
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
                .settingsRow(vertical: 8)
            }
            if !s.backups.isEmpty {
                CardHead("Backups")
                ForEach(s.backups) { backup in
                    row(dot: backupColor(backup.state), title: backup.app, detail: backupDetail(backup), value: backupText(backup.state))
                        .settingsRow(vertical: 8)
                }
                if let target = s.backupTarget {
                    Text(verbatim: target).font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 14).padding(.bottom, 12)
                }
            }
        }
    }

    /// What the summary line says: the counts once read, else where the connection stands.
    private func summary(peers: [PeerStatus]) -> String {
        guard loader.status == .ok else { return statusText }
        guard let s = settings.settings else { return String(localized: "Loading…") }
        var parts = [String(localized: "\(s.services.count) services")]
        if !s.backups.isEmpty { parts.append(String(localized: "\(s.backups.count) backups")) }
        if !peers.isEmpty { parts.append(String(localized: "\(peers.count) peers")) }
        return parts.joined(separator: " · ")
    }

    // MARK: Account

    /// The Spaces saved on this phone and the sign-in of the one on show: on the panel, Account
    /// is the sign-in of the Space it is served from. Drawn as a List, not cards: a saved Space is
    /// removed by swiping it left, and only a List row swipes as the system's do before iOS 27
    /// (swipeActionsContainer). Its rows sit on the cards' glass, padded as the cards' rows.
    private var account: some View {
        List {
            Section {
                SettingsHeading(section.title)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
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
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) { model.remove(c.id) } label: { Label("Remove", systemImage: "trash") }
                    }
                    .contextMenu {
                        Button(role: .destructive) { model.remove(c.id) } label: { Label("Remove", systemImage: "trash") }
                    }
                    .accountRow()
                }
                Button { model.showingAdd = true } label: {
                    // Not a Label: a List sets a Label's icon in a wide column of its own.
                    HStack(spacing: 10) {
                        Image(systemName: "plus")
                        Text("Add a Space")
                    }
                    .foregroundStyle(Theme.accent)
                }
                .accountRow()
            } footer: {
                SettingsNote("Swipe a Space to the left to remove it. Removing a Space here forgets its address, sign-in and screens on this iPhone. Nothing changes on the server.")
                    .accountFooter()
            }
            Section {
                Button(role: .destructive) { model.confirmingSignOut = true } label: { Text("Sign Out").foregroundStyle(Theme.danger) }
                    .confirmationDialog(Text("Sign out of \(connection.name)?"), isPresented: $model.confirmingSignOut, titleVisibility: .visible) {
                        Button("Sign Out", role: .destructive) { model.signOut(connection) }
                    } message: {
                        Text("This clears the Space's cookies and saved pages from this iPhone.")
                    }
                    .accountRow()
            } footer: {
                SettingsNote("The sign-in belongs to whatever stands in front of your Space (for example Cloudflare Access). The app stores no password or token; the session lives in this Space's own web data, apart from Safari.")
                    .accountFooter()
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(12)
        .contentMargins(.horizontal, 16, for: .scrollContent)
        .contentMargins(.top, 4, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .environment(\.defaultMinListHeaderHeight, 0)
        .environment(\.defaultMinListRowHeight, 0)
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

// MARK: The panel's surfaces

/// A section's cards and notes; the page's heading names it.
private struct SectionCards<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
    }
}

/// A page's title, set as the library's section titles (Apps, Agents, Widgets on Home).
private struct SettingsHeading: View {
    let title: LocalizedStringKey

    init(_ title: LocalizedStringKey) { self.title = title }

    var body: some View {
        Text(title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Rows on the glass of the panel's widget cards: no border, the theme's radius, the soft shadow.
private struct SettingsCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .font(.subheadline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .glass(bordered: false)
    }
}

/// The faint line between two rows of a card, in from its edges as the rows' text.
private struct CardDivider: View {
    var body: some View { Theme.hairline.frame(height: 1).padding(.horizontal, 14).accessibilityHidden(true) }
}

/// A heading inside a card over a group of its rows, set as a widget card's title.
private struct CardHead: View {
    let title: LocalizedStringKey

    init(_ title: LocalizedStringKey) { self.title = title }

    var body: some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A line of explanation under a card.
private struct SettingsNote: View {
    let text: LocalizedStringKey

    init(_ text: LocalizedStringKey) { self.text = text }

    var body: some View {
        Text(text).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 4)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A row that is a button: the card's padding, and a faint fill while pressed.
private struct SettingsRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(Theme.text)
            .settingsRow()
            .contentShape(Rectangle())
            .background(configuration.isPressed ? Theme.text.opacity(0.06) : .clear)
    }
}

private extension View {
    /// A row of Account's List drawn as a card's row: the card's font and padding over its glass.
    func accountRow() -> some View {
        font(.subheadline)
            .frame(minHeight: 20)
            .listRowInsets(EdgeInsets(top: 12, leading: 14, bottom: 12, trailing: 14))
            .listRowBackground(Rectangle().fill(.regularMaterial))
            .listRowSeparatorTint(Theme.hairline)
    }

    /// A note under a section of Account's List, placed as a note under a card.
    func accountFooter() -> some View {
        listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
    }

    /// A card's row: 14 points in from its edges as a widget card's, at least 44 tall.
    func settingsRow(vertical: CGFloat = 12) -> some View {
        padding(.horizontal, 14).padding(.vertical, vertical)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    /// The navigation bar of a page of Settings: the page names itself in its heading, so the bar
    /// carries only Back (labelled with the title) and Close, over the backdrop.
    func settingsChrome(_ title: Text) -> some View {
        navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) } }
    }
}
