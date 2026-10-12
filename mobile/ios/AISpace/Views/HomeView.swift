import SwiftUI

/// The launcher: favourites, then every app, agent and widget of the Space, with one search
/// across the three kinds and an honest word on what cannot be reached.
struct HomeView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var icons: IconStore
    @ObservedObject var favorites: FavoritesStore

    private let columns = [GridItem(.adaptive(minimum: 76, maximum: 110), spacing: 12, alignment: .top)]

    var body: some View {
        NavigationStack {
            ZStack {
                Backdrop()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        StatusCard(model: model, connection: connection, loader: loader)
                        if let catalogue = loader.catalogue {
                            content(catalogue)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
                .refreshable { await loader.refresh() }
            }
            .navigationTitle(connection.name)
            .searchable(text: $model.query, prompt: Text("Search apps, agents and widgets"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { spaceMenu }
            }
        }
    }

    @ViewBuilder private func content(_ catalogue: Catalogue) -> some View {
        let query = model.query
        let apps = CatalogueSearch.filter(catalogue.apps, query: query)
        let agents = CatalogueSearch.filter(catalogue.agents, query: query)
        let widgets = catalogue.widgets.filter { CatalogueSearch.matches(Catalogue.entry($0), query: query) }
        let favoriteKeys = favorites.keys(connection.id)
        let pinned = favoriteKeys.compactMap { catalogue.entry($0) }.filter { $0.kind != .widget }
        let pinnedWidgets = widgets.filter { favoriteKeys.contains("widget:\($0.id)") }

        if !catalogue.peers.isEmpty && query.isEmpty {
            PeerStrip(peers: catalogue.peers)
        }
        // A search lists each match once, under its kind.
        if query.isEmpty && (!pinned.isEmpty || !pinnedWidgets.isEmpty) {
            section("Favorites") {
                if !pinned.isEmpty { grid(pinned, catalogue) }
                ForEach(pinnedWidgets) { widgetCard($0, catalogue) }
            }
        }
        if !apps.isEmpty { section("Apps") { grid(apps, catalogue) } }
        if !agents.isEmpty { section("Agents") { grid(agents, catalogue) } }
        let rest = query.isEmpty ? widgets.filter { !favoriteKeys.contains("widget:\($0.id)") } : widgets
        if !rest.isEmpty {
            section("Widgets") { ForEach(rest) { widgetCard($0, catalogue) } }
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

    private func grid(_ entries: [CatalogueEntry], _ catalogue: Catalogue) -> some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 16) {
            ForEach(entries) { entry in
                EntryTile(entry: current(entry), icons: icons, peer: catalogue.peer(entry.peer)) { model.open(entry) }
                    .contextMenu { menu(entry) }
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

    private func widgetCard(_ widget: CatalogWidget, _ catalogue: Catalogue) -> some View {
        let entry = Catalogue.entry(widget)
        return WidgetCard(widget: widget, icons: icons, isFavorite: favorites.isFavorite(entry.key, connection.id),
                          open: { url in open(url, widget: entry) })
            .contextMenu { menu(entry) }
    }

    private func open(_ link: String?, widget entry: CatalogueEntry) {
        guard let link, let url = URL(string: link, relativeTo: connection.url)?.absoluteURL,
              ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        else { return model.open(entry) }
        model.open(url, title: entry.displayTitle(), key: entry.key, in: connection)
    }

    @ViewBuilder private func menu(_ entry: CatalogueEntry) -> some View {
        let isFavorite = favorites.isFavorite(entry.key, connection.id)
        Button {
            favorites.toggle(entry.key, connection.id)
        } label: {
            Label(isFavorite ? "Remove from Favorites" : "Add to Favorites", systemImage: isFavorite ? "star.slash" : "star")
        }
        if let url = entry.pageURL(space: connection.url) {
            Button { model.openInBrowser(url) } label: { Label("Open in Safari", systemImage: "safari") }
            Button { UIPasteboard.general.url = url } label: { Label("Copy Link", systemImage: "doc.on.doc") }
        }
    }

    private var spaceMenu: some View {
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

/// The API's instants: ISO 8601 in UTC, with or without fractional seconds (docs/time.md).
enum Times {
    /// "2h ago"; an instant within the last minute, or one a skewed clock puts ahead, is "now".
    static func ago(_ date: Date, now: Date = Date()) -> String {
        if date > now.addingTimeInterval(-60) { return String(localized: "now") }
        return date.formatted(.relative(presentation: .numeric, unitsStyle: .narrow))
    }

    static func parse(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
