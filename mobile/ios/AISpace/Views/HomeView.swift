import SwiftUI

/// The launcher, in the two parts the panel has (docs/panel.md#screens). Without a screen it is
/// the Home page: the library of every app, agent and widget of the Space, with one search.
/// With one it is that screen, a page of its own between Home and Settings, with nothing above
/// it: a swipe moves between the pages and a long press on the screen brings up its actions.
/// The screens are this phone's (ScreenStore): copied from the panel once, then changed here
/// without touching the Space.
struct HomeView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var icons: IconStore
    @ObservedObject var store: ScreenStore
    /// The screen to show, by id; nil for the library.
    var screenID: String?

    private var screens: [PanelScreen] { store.screens(connection.id) }

    private let columns = [GridItem(.adaptive(minimum: 76, maximum: 110), spacing: 12, alignment: .top)]

    var body: some View {
        if let screenID {
            ZStack {
                page(longPress: { model.showingScreenMenu = true }) {
                    if let catalogue = loader.catalogue, let screen = screens.first(where: { $0.id == screenID }) {
                        self.screen(screen, catalogue)
                    }
                }
            }
        } else {
            ZStack {
                page { if let catalogue = loader.catalogue { library(catalogue) } }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 8) {
                    PageHeader(model: model, connection: connection, title: Text(verbatim: connection.name))
                    SearchField(model: model)
                }
                .padding(.bottom, 8)
                .background(.bar)
            }
        }
    }

    // MARK: Pages

    private func page<Content: View>(longPress: (() -> Void)? = nil, @ViewBuilder _ content: () -> Content) -> some View {
        let content = content()
        return GeometryReader { geo in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    StatusCard(model: model, connection: connection, loader: loader)
                    content
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 24)
                .frame(minHeight: geo.size.height, alignment: .top)
                .background {
                    // The empty part of a screen takes the long press; a tile or a card keeps its own.
                    // The tap before it is what lets the scroll view keep scrolling under the gesture.
                    if let longPress {
                        Color.clear.contentShape(Rectangle()).onTapGesture {}.onLongPressGesture(minimumDuration: 0.45, perform: longPress)
                    }
                }
            }
            .refreshable { await loader.refresh() }
        }
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

    /// Everything the Space has, pinned or not.
    @ViewBuilder private func library(_ catalogue: Catalogue) -> some View {
        let query = model.query
        let apps = CatalogueSearch.filter(catalogue.apps, query: query)
        let agents = CatalogueSearch.filter(catalogue.agents, query: query)
        let widgets = catalogue.widgets.filter { CatalogueSearch.matches(Catalogue.entry($0), query: query) }

        if !catalogue.peers.isEmpty && query.isEmpty {
            PeerStrip(peers: catalogue.peers)
        }
        if !apps.isEmpty { section("Apps") { grid(apps, catalogue, on: nil) } }
        if !agents.isEmpty { section("Agents") { grid(agents, catalogue, on: nil) } }
        if !widgets.isEmpty {
            section("Widgets") { ForEach(widgets) { widgetCard($0, on: nil) } }
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

    private func section<Content: View>(_ title: LocalizedStringKey, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                .accessibilityAddTraits(.isHeader)
            content()
        }
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

/// The top of a page: its title and the menu of Spaces. The pages sit side by side in a pager,
/// so each draws its own top instead of living in a navigation bar.
struct PageHeader: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let title: Text

    var body: some View {
        ZStack {
            title.font(.headline).foregroundStyle(Theme.text).lineLimit(1).padding(.horizontal, 60)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Spacer()
                SpaceMenu(model: model, connection: connection)
                    .font(.body.weight(.medium)).frame(width: 40, height: 40)
            }
        }
        .padding(.horizontal, 12).frame(height: 44)
    }
}

/// The library's search: one field over apps, agents and widgets.
struct SearchField: View {
    @ObservedObject var model: AppModel

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(text: $model.query, prompt: Text("Search apps, agents and widgets")) { Text("Search") }
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
            if !model.query.isEmpty {
                Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Clear"))
            }
        }
        .padding(.horizontal, 12).frame(height: 38)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.hairline))
        .padding(.horizontal, 16)
    }
}

/// The saved Spaces, to move between them, and a way to add one.
struct SpaceMenu: View {
    @ObservedObject var model: AppModel
    let connection: Connection

    var body: some View {
        Menu {
            ForEach(model.store.connections) { c in
                Button { model.select(c.id) } label: {
                    if c.id == connection.id { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
            Divider()
            Button { model.showingAdd = true } label: { Label("Add a Space", systemImage: "plus") }
        } label: {
            Image(systemName: "rectangle.stack").accessibilityLabel(Text("Switch Space"))
        }
    }
}

/// One screen's entries as a list to drag into order and delete from, as iOS rearranges lists.
/// Tiles and widgets are two groups, as the screen draws them apart.
struct ScreenEditor: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var icons: IconStore
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
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Connecting…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 40)
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

/// The Space's peers: other machines whose apps this panel also shows. A peer that does not
/// answer is named as such; its tiles below are its last snapshot.
struct PeerStrip: View {
    let peers: [PeerStatus]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(peers) { peer in
                    HStack(spacing: 6) {
                        Circle().fill(peer.isOffline ? Color.secondary : Theme.success).frame(width: 8, height: 8)
                        Text(verbatim: peer.name).font(.footnote.weight(.medium))
                        if peer.isOffline {
                            Text(Self.offlineText(peer)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .glass(radius: 100)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(peer.isOffline ? Text("\(peer.name), offline") : Text("\(peer.name), online"))
                }
            }
            .padding(.vertical, 2)
        }
        .scrollClipDisabled()
    }

    static func offlineText(_ peer: PeerStatus) -> String {
        guard let asOf = peer.asOf, let date = Times.parse(asOf) else { return String(localized: "offline") }
        return String(localized: "offline, last seen \(date.formatted(.relative(presentation: .named)))")
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
