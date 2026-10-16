import SwiftUI

/// The launcher, in the two parts the panel has (docs/panel.md#screens). Without a screen it is
/// the Home page: the library of every app, agent and widget of the Space, with one search.
/// With one it is that screen, a page of its own between Home and Settings. Panel 1 has
/// the command box at its top: a swipe moves between the pages and a long press on the screen brings up its actions.
/// The screens are this phone's (ScreenStore): copied from the panel once, then changed here
/// without touching the Space.
struct HomeView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var store: ScreenStore
    /// The screen to show, by id; nil for the library.
    var screenID: String?
    @FocusState private var searchFocused: Bool
    @State private var commandText = ""
    @State private var searchSubmit = 0
    @State private var searchVoiceBusy = false

    private var screens: [PanelScreen] { store.screens(connection.id) }

    private let columns = [GridItem(.adaptive(minimum: 76, maximum: 110), spacing: 12, alignment: .top)]

    var body: some View {
        Group {
            if let screenID {
                page(longPress: { model.showingScreenMenu = true }) {
                    if screenID == screens.first?.id {
                        OmniboxField(query: $commandText, api: loader.api, voiceBusy: $searchVoiceBusy, focused: $searchFocused, submit: { searchSubmit += 1 })
                            .anchorPreference(key: OmniboxFieldBounds.self, value: .bounds) { $0 }
                    }
                    if let catalogue = loader.catalogue, let screen = screens.first(where: { $0.id == screenID }) {
                        self.screen(screen, catalogue)
                    }
                }
            } else {
                page(spacing: 12) {
                    if let catalogue = loader.catalogue { library(catalogue) }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    SearchField(model: model, focused: $searchFocused)
                        .padding(.vertical, 12)
                }
            }
        }
        .onReceive(model.pager.$id.removeDuplicates().dropFirst()) { _ in searchFocused = false }
        .onChange(of: model.page?.id) { _, _ in searchFocused = false }
        .onChange(of: model.hubPage) { _, _ in searchFocused = false }
        .onChange(of: model.showingWebPanel) { _, _ in searchFocused = false }
        .onChange(of: connection.id) { _, _ in commandText = "" }
        .onDisappear { searchFocused = false }
    }

    // MARK: Pages

    private func page<Content: View>(spacing: CGFloat = 22, longPress: (() -> Void)? = nil, @ViewBuilder _ content: () -> Content) -> some View {
        let content = content()
        return GeometryReader { geo in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: spacing) {
                    StatusCard(model: model, connection: connection, loader: loader)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
                // Universal search results float under the field over everything else on the page,
                // so they neither push the tiles down nor sit beneath them.
                .overlayPreferenceValue(OmniboxFieldBounds.self) { field in
                    GeometryReader { proxy in
                        if let field {
                            let bounds = proxy[field]
                            omniboxResults
                                .frame(width: bounds.width)
                                .offset(x: bounds.minX, y: bounds.maxY + 8)
                        }
                    }
                }
                .frame(minHeight: geo.size.height, alignment: .top)
                .background {
                    // The empty part of a screen takes the long press; a tile or a card keeps its own.
                    // The tap before it is what lets the scroll view keep scrolling under the gesture.
                    if let longPress {
                        Color.clear.contentShape(Rectangle())
                            .onTapGesture { searchFocused = false }
                            .onLongPressGesture(minimumDuration: 0.45, perform: longPress)
                    } else {
                        Color.clear.contentShape(Rectangle()).onTapGesture { searchFocused = false }
                    }
                }
            }
            .scrollClipDisabled()
            .scrollDismissesKeyboard(.immediately)
            .contentShape(Rectangle())
            .refreshable { await loader.refresh() }
        }
    }

    private var omniboxResults: some View {
        let showing = !commandText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return OmniboxView(model: model, query: $commandText, connection: connection, loader: loader, store: model.omnibox(for: connection), submit: searchSubmit)
            .id(connection.id)
            .disabled(searchVoiceBusy)
            .foregroundStyle(Theme.text)
            .padding(showing ? 8 : 0)
            .background {
                // The frame is see-through; each result carries its own solid surface, so the
                // tiles show around the results without washing out their text.
                if showing {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Theme.hairline))
                        .shadow(color: .black.opacity(0.18), radius: 16, y: 8)
                }
            }
            // The field carries 8 pt of its own on each side; line the results up with its capsule.
            .padding(.horizontal, 8)
    }

    /// One screen: its tiles in one grid, its widget cards below, in the screen's order. A key
    /// whose entry is gone is skipped and kept, so it comes back with the entry.
    @ViewBuilder private func screen(_ screen: PanelScreen, _ catalogue: Catalogue) -> some View {
        let tiles = screen.items.compactMap { catalogue.entry($0) }.filter { $0.kind != .widget }
        // Settings can leave the widget cards off the screens; they stay pinned and stay in the library.
        let widgets = model.showsWidgets ? screen.items.compactMap { key in catalogue.widgets.first { "widget:\($0.id)" == key } } : []
        if !tiles.isEmpty { grid(tiles, catalogue, on: screen.id) }
        ForEach(widgets) { widgetCard($0, on: screen.id) }
        if tiles.isEmpty && widgets.isEmpty {
            ContentUnavailableView {
                Label("Nothing on this screen yet", systemImage: "square.grid.2x2")
            } description: {
                Text("Touch and hold an app, agent or widget on the Home tab and choose Add to Panel. Touch and hold here for the screen's own actions.")
            } actions: {
                Button("Open Home") { withAnimation { model.tab = .home } }.buttonStyle(.borderedProminent)
            }
            .padding(.top, 40)
        }
    }

    /// Everything the Space has, pinned or not. The titles, grids and cards are the page's own
    /// rows, not stacks of their own, so a widget card is made when it is scrolled to: all of
    /// them made at once is what the page then carries on every frame of a scroll.
    @ViewBuilder private func library(_ catalogue: Catalogue) -> some View {
        let query = model.query
        let apps = CatalogueSearch.filter(catalogue.apps, query: query)
        let agents = CatalogueSearch.filter(catalogue.agents, query: query)
        let widgets = catalogue.widgets.filter { CatalogueSearch.matches(Catalogue.entry($0), query: query) }

        if !apps.isEmpty {
            heading("Apps", first: true)
            grid(apps, catalogue, on: nil)
        }
        if !agents.isEmpty {
            heading("Agents", first: apps.isEmpty)
            grid(agents, catalogue, on: nil)
        }
        if !widgets.isEmpty {
            heading("Widgets", first: apps.isEmpty && agents.isEmpty)
            ForEach(widgets) { widgetCard($0, on: nil) }
        }
        if apps.isEmpty && agents.isEmpty && widgets.isEmpty {
            if query.isEmpty {
                ContentUnavailableView("Nothing here yet", systemImage: "square.grid.2x2",
                                       description: Text("This Space has no apps with a page. Add one on the panel."))
            } else {
                ContentUnavailableView.search(text: query)
            }
        }
    }

    /// A section's title; after another section it stands further from it than from its own rows.
    private func heading(_ title: LocalizedStringKey, first: Bool) -> some View {
        Text(title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, first ? 0 : 10)
    }

    private func grid(_ entries: [CatalogueEntry], _ catalogue: Catalogue, on screen: String?) -> some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
            ForEach(entries) { entry in
                EntryTile(entry: current(entry), icons: icons, peer: catalogue.peer(entry.peer)) { model.open(entry) }
                    .contextMenu { menu(entry, on: screen) }
            }
        }
    }

    /// A health dot is a claim about now: while the catalogue on show is not this moment's
    /// answer (the Space is unreachable or wants a sign-in), running and not answering are unknown.
    private func current(_ entry: CatalogueEntry) -> CatalogueEntry {
        guard loader.status != .ok, entry.reach == .up || entry.reach == .down else { return entry }
        var copy = entry
        copy.reach = .unknown
        return copy
    }

    private func widgetCard(_ widget: CatalogWidget, on screen: String?) -> some View {
        let entry = Catalogue.entry(widget)
        return WidgetCard(widget: widget, icons: icons, open: { url in open(url, widget: entry) })
            .contextMenu { menu(entry, on: screen) }
    }

    private func open(_ link: String?, widget entry: CatalogueEntry) {
        guard let link, let url = URL(string: link, relativeTo: connection.url)?.absoluteURL,
              ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        else { return model.open(entry) }
        model.open(url, title: entry.displayTitle(), key: entry.key, in: connection)
    }

    // MARK: Menus

    /// What a long press offers: the screens the entry is on, and the ways out to the browser.
    @ViewBuilder private func menu(_ entry: CatalogueEntry, on screen: String?) -> some View {
        let screens = self.screens
        Group {
            if let screen {
                Button(role: .destructive) { model.togglePin(entry.key, screen: screen, in: connection) } label: {
                    Label("Remove from This Screen", systemImage: "minus.circle")
                }
            }
            if screens.count <= 1 {
                if screen == nil {
                    let on = Screens.isPinned(screens, Screens.home, entry.key)
                    Button { model.togglePin(entry.key, screen: Screens.home, in: connection) } label: {
                        Label(on ? "Remove from Panel" : "Add to Panel", systemImage: on ? "minus.rectangle" : "plus.rectangle.on.rectangle")
                    }
                }
            } else {
                Menu {
                    ForEach(Array(screens.enumerated()), id: \.element.id) { index, s in
                        Button { model.togglePin(entry.key, screen: s.id, in: connection) } label: {
                            if s.items.contains(entry.key) { Label(Screens.title(at: index), systemImage: "checkmark") } else { Text(verbatim: Screens.title(at: index)) }
                        }
                    }
                } label: {
                    Label("Add to Panel", systemImage: "plus.rectangle.on.rectangle")
                }
            }
        }
        if let url = entry.pageURL(space: connection.url) {
            Button { model.openInBrowser(url) } label: { Label("Open in Safari", systemImage: "safari") }
            Button { UIPasteboard.general.url = url } label: { Label("Copy Link", systemImage: "doc.on.doc") }
        }
    }

}

/// The library's search: one field over apps, agents and widgets.
struct SearchField: View {
    @ObservedObject var model: AppModel
    var focused: FocusState<Bool>.Binding

    private var idle: Bool { model.query.isEmpty && !focused.wrappedValue }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .opacity(idle ? 0 : 1)
            TextField(text: $model.query, prompt: idle ? Text("") : Text("Apps / Agents / Widgets")) { Text("Apps / Agents / Widgets") }
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .focused(focused)
                .onSubmit { focused.wrappedValue = false }
            if !model.query.isEmpty {
                Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Clear"))
            }
        }
        .font(.system(size: 19))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 18).frame(height: 48)
        .overlay {
            if idle {
                Label("Apps / Agents / Widgets", systemImage: "magnifyingglass")
                    .font(.system(size: 19)).foregroundStyle(Theme.text)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Capsule())
        .onTapGesture { focused.wrappedValue = true }
        .modifier(LauncherCapsuleGlass())
        .padding(.horizontal, 24)
    }
}

/// Where the universal search field sits on its page, for the results drawn over the page.
private struct OmniboxFieldBounds: PreferenceKey {
    static var defaultValue: Anchor<CGRect>?
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

/// The first Panel's command field: actions, agents and voice input.
struct OmniboxField: View {
    @Binding var query: String
    let api: SpaceAPI
    @StateObject private var voice = OmniboxVoice()
    @Environment(\.scenePhase) private var scenePhase
    @Binding var voiceBusy: Bool
    var focused: FocusState<Bool>.Binding
    let submit: () -> Void

    private var idle: Bool { query.isEmpty && !focused.wrappedValue }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .opacity(idle ? 0 : 1)
            TextField(text: $query, prompt: idle ? Text("") : Text("Universal Search")) { Text("Search, run an action or ask an agent") }
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .focused(focused)
                .onSubmit { if !voice.busy { submit() } }
                .disabled(voice.busy)
            Group {
                Button { voice.toggle(api: api, prefix: query) { text in
                    query = text
                    focused.wrappedValue = true
                } } label: {
                    if voice.transcribing { ProgressView().controlSize(.small) }
                    else { Image(systemName: voice.recording || voice.starting ? "stop.circle.fill" : "mic.fill") }
                }.disabled(voice.transcribing)
                    .accessibilityLabel(Text(voice.recording || voice.starting ? "Stop Recording" : "Voice Input"))
            }
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Clear"))
                    .disabled(voice.busy)
            }
        }
        .font(.system(size: 19))
        .foregroundStyle(Theme.text)
        .padding(.horizontal, 18).frame(height: 48)
        .overlay {
            if idle {
                Label("Universal Search", systemImage: "magnifyingglass")
                    .font(.system(size: 19)).foregroundStyle(Theme.text)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Capsule())
        .onTapGesture { focused.wrappedValue = true }
        .modifier(LauncherCapsuleGlass())
        // The scrolling panel already supplies 16 pt; match Home's total 24 pt margin.
        .padding(.horizontal, 8)
        .onChange(of: api.base) { _, _ in voice.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase == .background { voice.cancel() } }
        .onChange(of: voice.busy) { _, busy in voiceBusy = busy }
        .onDisappear { voice.cancel(); voiceBusy = false }
        .alert("Voice Input", isPresented: Binding(get: { voice.error != nil }, set: { if !$0 { voice.error = nil } })) {
            Button("OK") { voice.error = nil }
        } message: { Text(verbatim: voice.error ?? "") }
    }
}

/// One screen's entries as a list to drag into order and delete from, as iOS rearranges lists.
/// Tiles and widgets are two groups, as the screen draws them apart.
struct ScreenEditor: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var store: ScreenStore
    let screen: String

    var body: some View {
        let catalogue = loader.catalogue
        let screens = store.screens(connection.id)
        let items = screens.first { $0.id == screen }?.items ?? []
        let entries = items.compactMap { catalogue?.entry($0) }
        let tiles = entries.filter { $0.kind != .widget }
        let widgets = entries.filter { $0.kind == .widget }
        NavigationStack {
            List {
                if !tiles.isEmpty { group("Apps and Agents", tiles) }
                if !widgets.isEmpty { group("Widgets", widgets) }
                if entries.isEmpty {
                    Text("Nothing on this screen yet").foregroundStyle(.secondary)
                }
                Section {} footer: {
                    Text("Screens on this iPhone are its own. Changes here are not sent to the panel.")
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle(Text(verbatim: Screens.title(at: screens.firstIndex { $0.id == screen } ?? 0)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { model.editingScreen = nil } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func group(_ title: LocalizedStringKey, _ entries: [CatalogueEntry]) -> some View {
        let keys = entries.map(\.key)
        return Section {
            ForEach(entries) { entry in
                HStack(spacing: 12) {
                    EntryIcon(icon: entry.icon, fallback: entry.kind == .agent ? "person.fill" : "app", icons: icons, size: 32, isRound: entry.kind == .agent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: entry.displayTitle())
                        if let peer = entry.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            .onMove { source, destination in
                var order = keys
                order.move(fromOffsets: source, toOffset: destination)
                store.edit(connection.id) { Screens.reorder($0, screen, group: keys, to: order) }
            }
            .onDelete { offsets in
                let gone = offsets.map { keys[$0] }
                store.edit(connection.id) { screens in gone.reduce(screens) { Screens.unpin($0, screen, $1) } }
            }
        } header: {
            Text(title)
        }
    }
}

/// Where the catalogue stands when it is not simply current.
struct StatusCard: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader

    var body: some View {
        switch loader.status {
        case .ok:
            EmptyView()
        case .loading:
            if loader.catalogue == nil {
                VStack(spacing: 14) {
                    ConnectingMark()
                    Text("Connecting…").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 40)
                .accessibilityElement(children: .combine)
            }
        case .signInNeeded:
            card(icon: "person.badge.key", tint: Theme.accent, title: Text("Sign in to \(connection.url.host ?? connection.name)"),
                 detail: Text("Your Space is behind a sign-in. It opens on the Panel tab and is kept for this Space only.")) {
                Button("Sign In") { model.signIn() }.buttonStyle(.borderedProminent)
            }
        case .unreachable(let reason):
            card(icon: "wifi.exclamationmark", tint: Theme.warning, title: Text("Cannot reach this Space"), detail: Text(verbatim: reason)) {
                Button("Retry") { Task { await loader.refresh() } }.buttonStyle(.bordered)
            }
        case .incompatible(let reason):
            card(icon: "exclamationmark.triangle", tint: Theme.danger, title: Text("This address is not an ai-space panel"), detail: Text(verbatim: reason)) {
                Button("Retry") { Task { await loader.refresh() } }.buttonStyle(.bordered)
            }
        }
    }

    private func card<Action: View>(icon: String, tint: Color, title: Text, detail: Text, @ViewBuilder action: () -> Action) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label { title.font(.headline) } icon: { Image(systemName: icon).foregroundStyle(tint) }
            detail.font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if loader.isLastKnown, let at = loader.catalogue?.fetchedAt {
                Text("Below is what this Space had \(at.formatted(.relative(presentation: .named))). It may have changed.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            action()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glass()
    }
}

/// How the API's instants read on the phone (docs/time.md).
enum Times {
    /// "2h ago"; an instant within the last minute, or one a skewed clock puts ahead, is "now".
    static func ago(_ date: Date, now: Date = Date()) -> String {
        if date > now.addingTimeInterval(-60) { return String(localized: "now") }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
    }

    static func parse(_ text: String) -> Date? { ISO8601.parse(text) }
}
