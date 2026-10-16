import SwiftUI

/// The launcher, laid out as the iPhone client's: pages side by side, moved through with a
/// sideways swipe on the trackpad, the dots in the toolbar or ⌥⌘← and ⌥⌘→. Home is the library
/// of every app, agent and widget of the Space with one search; each screen of the panel is a
/// page of its own; Settings is last. The screens are this Mac's (ScreenStore): copied from the
/// panel once, then changed here without touching the Space.
struct LauncherView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var screens: ScreenStore

    var body: some View {
        let all = screens.screens(connection.id)
        GeometryReader { viewport in
            PagerScroll(position: model.pager, width: viewport.size.width) {
                // Not lazy: a lazy row makes the page being swiped to in the middle of the swipe.
                HStack(spacing: 0) {
                    LauncherPage(model: model, connection: connection, loader: loader, icons: icons, store: screens, prefs: model.prefs)
                        .frame(width: viewport.size.width, height: viewport.size.height)
                        .id(Pager.home)
                    ForEach(all) { screen in
                        LauncherPage(model: model, connection: connection, loader: loader, icons: icons, store: screens, prefs: model.prefs, screenID: screen.id)
                            .frame(width: viewport.size.width, height: viewport.size.height)
                            .id(screen.id)
                    }
                    SettingsPage(model: model, connection: connection, loader: loader, settings: model.settings(for: connection), icons: icons, prefs: model.prefs)
                        .frame(width: viewport.size.width, height: viewport.size.height)
                        .id(Pager.settings)
                }
                .scrollTargetLayout()
            }
        }
        .background { SpaceBackdrop(space: connection.url, dataStore: model.dataStore(connection.id)) }
        .task(id: connection.id) { await loader.refresh() }
        .confirmationDialog(Text("Delete this screen?"), isPresented: $model.confirmingDeleteScreen) {
            Button("Delete Screen", role: .destructive) { withAnimation { model.removeScreen(model.actionScreen, in: connection) } }
        } message: {
            Text("Its apps, agents and widgets stay in the library.")
        }
        .confirmationDialog(Text("Replace this Mac's screens?"), isPresented: $model.confirmingResetScreens) {
            Button("Replace", role: .destructive) { model.resetScreens(in: connection) }
        } message: {
            Text("The screens on this Mac become a copy of the panel's as it is now. The panel does not change.")
        }
        .sheet(isPresented: Binding(get: { model.editingScreen != nil }, set: { if !$0 { model.editingScreen = nil } })) {
            if let id = model.editingScreen {
                ScreenEditor(model: model, connection: connection, loader: loader, icons: icons, store: screens, screen: id)
            }
        }
    }
}

/// Whether the pager has been moved to the page on show since it was made.
@MainActor
private final class PagerSettle: ObservableObject {
    var settled = false
}

/// The paging scroll view, the one view that follows the page on show. A swipe changes the
/// position here only; the pages, made by LauncherView, are not evaluated again for it.
private struct PagerScroll<Pages: View>: View {
    @ObservedObject var position: PagerPosition
    let width: CGFloat
    @ViewBuilder let pages: Pages
    @StateObject private var settle = PagerSettle()

    var body: some View {
        ScrollViewReader { pager in
            ScrollView(.horizontal) { pages }
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.never)
                .scrollPosition(id: Binding<String?>(get: { position.id }, set: { id in
                    // A new pager lies on its leftmost page and says so before it has been moved
                    // to the page on show; that report is not a swipe.
                    guard settle.settled else { return }
                    if let id, id != position.id { position.id = id }
                }))
                .onAppear {
                    pager.scrollTo(position.id, anchor: .leading)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settle.settled = true }
                }
                // A resized window keeps the page it shows.
                .onChange(of: width) { _, _ in pager.scrollTo(position.id, anchor: .leading) }
        }
    }
}

/// One page of the launcher: the library (no screen) or one screen.
struct LauncherPage: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var store: ScreenStore
    @ObservedObject var prefs: Preferences
    /// The screen to show, by id; nil for the library.
    var screenID: String?

    private var screens: [PanelScreen] { store.screens(connection.id) }

    private let columns = [GridItem(.adaptive(minimum: 96, maximum: 124), spacing: 18, alignment: .top)]
    private let cards = [GridItem(.adaptive(minimum: 300, maximum: 520), spacing: 16, alignment: .top)]

    var body: some View {
        if let screenID, screenID == Screens.home {
            // The first screen, where the window opens, carries the command box too; while it
            // holds a query the page shows what matches instead of the screen.
            page(spacing: model.query.isEmpty ? 22 : 14, menu: model.query.isEmpty) {
                if let catalogue = loader.catalogue {
                    if !model.query.isEmpty {
                        library(catalogue)
                    } else if let screen = screens.first(where: { $0.id == screenID }) {
                        self.screen(screen, catalogue)
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { omnibox(on: Screens.home) }
        } else if let screenID {
            page(menu: true) {
                if let catalogue = loader.catalogue, let screen = screens.first(where: { $0.id == screenID }) {
                    self.screen(screen, catalogue)
                }
            }
        } else {
            page(spacing: 14, menu: false) { if let catalogue = loader.catalogue { library(catalogue) } }
                .safeAreaInset(edge: .top, spacing: 0) { omnibox(on: Pager.home) }
        }
    }

    // MARK: Pages

    private func page<Content: View>(spacing: CGFloat = 22, menu: Bool, @ViewBuilder _ content: () -> Content) -> some View {
        let content = content()
        return GeometryReader { geo in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: spacing) {
                    StatusCard(model: model, connection: connection, loader: loader)
                    content
                }
                .frame(maxWidth: 1120, alignment: .leading)
                .padding(.horizontal, 32)
                .padding(.top, 16)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .top)
                .background {
                    // The empty part of a screen takes the right click; a tile or a card keeps its own.
                    if menu {
                        Color.clear.contentShape(Rectangle()).contextMenu { ScreenActions(model: model, connection: connection, loader: loader, store: store) }
                    }
                }
            }
            .scrollIndicators(.automatic)
        }
    }

    /// One screen: its tiles in one grid, its widget cards below, in the screen's order. A key
    /// whose entry is gone is skipped and kept, so it comes back with the entry.
    @ViewBuilder private func screen(_ screen: PanelScreen, _ catalogue: Catalogue) -> some View {
        let tiles = screen.items.compactMap { catalogue.entry($0) }.filter { $0.kind != .widget }
        // Settings can leave the widget cards off the screens; they stay pinned and stay in the library.
        let widgets = prefs.showsWidgets ? screen.items.compactMap { key in catalogue.widgets.first { "widget:\($0.id)" == key } } : []
        if !tiles.isEmpty { grid(tiles, on: screen.id) }
        if !widgets.isEmpty { widgetGrid(widgets, on: screen.id) }
        if tiles.isEmpty && widgets.isEmpty {
            ContentUnavailableView {
                Label("Nothing on this screen yet", systemImage: "square.grid.2x2")
            } description: {
                Text("Right-click an app, agent or widget on Home and choose Add to Panel. Right-click here for the screen's own actions.")
            } actions: {
                Button("Open Home") { withAnimation { model.showPage(Pager.home) } }.buttonStyle(.borderedProminent)
            }
            .padding(.top, 40)
        }
    }

    private func omnibox(on page: String) -> some View {
        OmniboxField(model: model, page: page, best: bestMatch, api: model.lives[connection.id]?.api)
            .padding(.top, 14).padding(.bottom, 6)
    }

    /// What Return in the Home box opens when it does not ask: the best name over the whole library.
    private var bestMatch: CatalogueEntry? {
        guard let catalogue = loader.catalogue, !model.query.isEmpty else { return nil }
        return OmniboxRules.rank(model.query, catalogue.apps + catalogue.agents + catalogue.widgets.map(Catalogue.entry)).first
    }

    /// Everything the Space has, pinned or not; while the box holds a query, what matches it, best names first.
    @ViewBuilder private func library(_ catalogue: Catalogue) -> some View {
        let query = model.query.trimmingCharacters(in: .whitespacesAndNewlines)
        let apps = query.isEmpty ? catalogue.apps : OmniboxRules.rank(query, catalogue.apps)
        let agents = query.isEmpty ? catalogue.agents : OmniboxRules.rank(query, catalogue.agents)
        let widgets = query.isEmpty ? catalogue.widgets : OmniboxRules.rank(query, catalogue.widgets.map(Catalogue.entry))
            .compactMap { e in catalogue.widgets.first { Catalogue.entry($0).key == e.key } }

        if !apps.isEmpty {
            heading("Apps", first: true)
            grid(apps, on: nil)
        }
        if !agents.isEmpty {
            heading("Agents", first: apps.isEmpty)
            grid(agents, on: nil)
        }
        if !widgets.isEmpty {
            heading("Widgets", first: apps.isEmpty && agents.isEmpty)
            widgetGrid(widgets, on: nil)
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

    private func heading(_ title: LocalizedStringKey, first: Bool) -> some View {
        Text(title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, first ? 0 : 12)
    }

    private func grid(_ entries: [CatalogueEntry], on screen: String?) -> some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 20) {
            ForEach(entries) { entry in
                EntryTile(entry: current(entry), icons: icons) { model.open(entry) }
                    .contextMenu { EntryMenu(model: model, connection: connection, store: store, entry: entry, screen: screen) }
            }
        }
    }

    private func widgetGrid(_ widgets: [CatalogWidget], on screen: String?) -> some View {
        LazyVGrid(columns: cards, alignment: .leading, spacing: 16) {
            ForEach(widgets) { widget in
                let entry = Catalogue.entry(widget)
                WidgetCard(widget: widget, icons: icons, open: { url in open(url, widget: entry) })
                    .contextMenu { EntryMenu(model: model, connection: connection, store: store, entry: entry, screen: screen) }
            }
        }
    }

    /// A health dot is a claim about now: while the catalogue on show is not this moment's
    /// answer, running and not answering are unknown.
    private func current(_ entry: CatalogueEntry) -> CatalogueEntry {
        guard loader.status != .ok, entry.reach == .up || entry.reach == .down else { return entry }
        var copy = entry
        copy.reach = .unknown
        return copy
    }

    private func open(_ link: String?, widget entry: CatalogueEntry) {
        guard let link, let url = URL(string: link, relativeTo: connection.url)?.absoluteURL,
              ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        else { return model.open(entry) }
        model.openLink(url, from: connection)
    }
}

/// What a right click on an entry offers: the screens it is on, and the ways out to the browser.
struct EntryMenu: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var store: ScreenStore
    let entry: CatalogueEntry
    /// The screen the entry was clicked on; nil in the library.
    let screen: String?

    var body: some View {
        let screens = store.screens(connection.id)
        Button("Open") { model.open(entry) }
        Divider()
        if let screen {
            Button("Remove from This Screen") { model.togglePin(entry.key, screen: screen, in: connection) }
        }
        if screens.count <= 1 {
            if screen == nil {
                let on = Screens.isPinned(screens, Screens.home, entry.key)
                Button(on ? "Remove from Panel" : "Add to Panel") { model.togglePin(entry.key, screen: Screens.home, in: connection) }
            }
        } else {
            Menu("Add to Panel") {
                ForEach(Array(screens.enumerated()), id: \.element.id) { index, s in
                    Toggle(isOn: Binding(get: { s.items.contains(entry.key) }, set: { _ in model.togglePin(entry.key, screen: s.id, in: connection) })) {
                        Text(verbatim: Screens.title(at: index))
                    }
                }
            }
        }
        if let url = entry.pageURL(space: connection.url) {
            Divider()
            Button("Open in Browser") { NSWorkspace.shared.open(url) }
            Button("Copy Link") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url.absoluteString, forType: .string)
            }
        }
    }
}

/// The actions on the screens: from a right click on a screen, or the toolbar's menu.
struct ScreenActions: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    @ObservedObject var store: ScreenStore

    var body: some View {
        let all = store.screens(connection.id)
        Button("New Screen") { withAnimation { model.addScreen(in: connection) } }
            .disabled(all.count >= Screens.limit)
        Button("Edit This Screen…") { model.editingScreen = model.actionScreen }
        Button("Copy the Panel's Layout…") { model.confirmingResetScreens = true }
            .disabled(loader.catalogue == nil)
        if model.actionScreen != Screens.home {
            Divider()
            Button("Delete Screen…", role: .destructive) { model.confirmingDeleteScreen = true }
        }
    }
}

/// The command box on the first screen and on Home (docs/panel.md#omnibox): what is typed filters the library below, best
/// names first, and Return either opens the best match (when its name holds the whole query) or
/// hands the text to Space Assistant as a new conversation; ⌘Return always asks, Shift-Return
/// breaks the line. The microphone fills the field from speech. ⌘F comes here.
struct OmniboxField: View {
    @ObservedObject var model: AppModel
    /// The pager page this field is on: ⌘F focuses the one on show.
    let page: String
    let best: CatalogueEntry?
    let api: SpaceAPI?
    @FocusState private var focused: Bool
    @StateObject private var voice = VoiceInput()

    private var text: String { model.query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var opens: Bool { OmniboxRules.opensByDefault(text, best) }

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "sparkle").foregroundStyle(Theme.accent)
                TextField(voice.state == .recording ? "Listening… click the microphone to stop" : "Search apps, or tell Space Assistant what to do",
                          text: $model.query, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .focused($focused)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        submit(ask: press.modifiers.contains(.command))
                        return .handled
                    }
                    .onExitCommand { model.query = ""; focused = false }
                if !model.query.isEmpty {
                    Button { model.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("Clear"))
                }
                VoiceButton(voice: voice, api: api, size: 22) { heard in
                    model.query = appendingTranscript(heard, to: model.query)
                    focused = true
                }
            }
            .font(.system(size: 16))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 18).padding(.vertical, 10)
            .frame(minHeight: 44)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(focused ? Theme.accent.opacity(0.6) : Theme.hairline))
            .contentShape(Rectangle())
            .onTapGesture { focused = true }

            if let error = voice.error {
                Text(verbatim: error).font(.caption).foregroundStyle(Theme.danger)
            } else if !text.isEmpty {
                HStack(spacing: 8) {
                    if let best {
                        choice(isDefault: opens, key: "↵") { model.open(best); model.query = "" } label: {
                            Text("Open \(best.displayTitle())")
                        }
                    }
                    choice(isDefault: !opens, key: opens ? "⌘↵" : "↵") { model.ask(text) } label: {
                        Text("Ask Space Assistant")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6)
            }
        }
        .frame(maxWidth: 640)
        .padding(.horizontal, 32)
        .onReceive(model.focusSearch) { if model.pagerID == page { focused = true } }
    }

    private func submit(ask: Bool) {
        guard !text.isEmpty else { return }
        if !ask, opens, let best {
            model.open(best)
            model.query = ""
        } else {
            model.ask(text)
        }
    }

    /// One of the two things Return can do; the one it does now is filled.
    private func choice(isDefault: Bool, key: String, action: @escaping () -> Void, @ViewBuilder label: () -> Text) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                label().lineLimit(1)
                Text(verbatim: key).foregroundStyle(isDefault ? AnyShapeStyle(Color.white.opacity(0.8)) : AnyShapeStyle(.tertiary))
            }
            .font(.callout)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .foregroundStyle(isDefault ? AnyShapeStyle(Color.white) : AnyShapeStyle(Theme.text))
            .background(isDefault ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.thinMaterial), in: Capsule())
            .overlay(Capsule().strokeBorder(isDefault ? Color.clear : Theme.hairline))
        }
        .buttonStyle(.plain)
    }
}

/// One screen's entries as a list to drag into order and delete from. Tiles and widgets are two
/// groups, as the screen draws them apart.
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
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: Screens.title(at: screens.firstIndex { $0.id == screen } ?? 0))
                .font(.headline).padding([.horizontal, .top], 20).padding(.bottom, 8)
            List {
                if !tiles.isEmpty { group("Apps and Agents", tiles) }
                if !widgets.isEmpty { group("Widgets", widgets) }
                if entries.isEmpty {
                    Text("Nothing on this screen yet").foregroundStyle(.secondary)
                }
            }
            .listStyle(.inset)
            Text("Drag to reorder. Screens on this Mac are its own. Changes here are not sent to the panel.")
                .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.top, 8)
            HStack {
                Spacer()
                Button("Done") { model.editingScreen = nil }.keyboardShortcut(.defaultAction)
            }
            .padding(20)
        }
        .frame(width: 440, height: 480)
    }

    private func group(_ title: LocalizedStringKey, _ entries: [CatalogueEntry]) -> some View {
        let keys = entries.map(\.key)
        return Section {
            ForEach(entries) { entry in
                HStack(spacing: 12) {
                    EntryIcon(icon: entry.icon, fallback: entry.kind == .agent ? "person.fill" : "app", icons: icons, size: 28, isRound: entry.kind == .agent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: entry.displayTitle())
                        if let peer = entry.peer { Text(verbatim: peer).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button { store.edit(connection.id) { Screens.unpin($0, screen, entry.key) } } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(Theme.danger)
                    }
                    .buttonStyle(.plain)
                    .help("Remove from This Screen")
                }
                .padding(.vertical, 2)
            }
            .onMove { source, destination in
                var order = keys
                order.move(fromOffsets: source, toOffset: destination)
                store.edit(connection.id) { Screens.reorder($0, screen, group: keys, to: order) }
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
                    Text("Connecting…").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 60)
                .accessibilityElement(children: .combine)
            }
        case .signInNeeded:
            card(icon: "person.badge.key", tint: Theme.accent, title: Text("Sign in to \(connection.url.host ?? connection.name)"),
                 detail: Text("Your Space is behind a sign-in. It opens in the web panel and is kept for this Space only.")) {
                Button("Sign In") { model.signIn() }.buttonStyle(.borderedProminent)
            }
        case .unreachable(let reason):
            card(icon: "wifi.exclamationmark", tint: Theme.warning, title: Text("Cannot reach this Space"), detail: Text(verbatim: reason)) {
                HStack {
                    Button("Retry") { Task { await loader.refresh() } }.buttonStyle(.bordered)
                    if connection.isLocal {
                        Text("Start ai-space on this Mac with `space start`, then retry.").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        case .incompatible(let reason):
            card(icon: "exclamationmark.triangle", tint: Theme.danger, title: Text("This address is not an ai-space panel"), detail: Text(verbatim: reason)) {
                HStack {
                    Button("Retry") { Task { await loader.refresh() } }.buttonStyle(.bordered)
                    SettingsLink { Text("Edit Connections…") }
                }
            }
        }
    }

    private func card<Action: View>(icon: String, tint: Color, title: Text, detail: Text, @ViewBuilder action: () -> Action) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label { title.font(.headline) } icon: { Image(systemName: icon).foregroundStyle(tint) }
            detail.font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if loader.isLastKnown, let at = loader.catalogue?.fetchedAt {
                Text("Below is what this Space had \(at.formatted(.relative(presentation: .named))). It may have changed.")
                    .font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            action()
        }
        .padding(16)
        .frame(maxWidth: 640, alignment: .leading)
        .glass()
    }
}

/// The launcher's pages as the toolbar shows them: Home, a dot per screen, Settings.
struct PageIndicator: View {
    @ObservedObject var position: PagerPosition
    let screens: [PanelScreen]
    let show: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
            button(Pager.home, label: Text("Home")) {
                Image(systemName: "square.grid.2x2").font(.system(size: 11, weight: .semibold))
            }
            ForEach(Array(screens.enumerated()), id: \.element.id) { index, screen in
                button(screen.id, label: Text(verbatim: Screens.title(at: index))) {
                    Circle().frame(width: 7, height: 7)
                }
            }
            button(Pager.settings, label: Text("Settings")) {
                Image(systemName: "gearshape").font(.system(size: 11, weight: .semibold))
            }
        }
        .padding(.horizontal, 6)
    }

    private func button<Mark: View>(_ id: String, label: Text, @ViewBuilder mark: () -> Mark) -> some View {
        let on = position.id == id
        return Button { show(id) } label: {
            mark()
                .foregroundStyle(on ? AnyShapeStyle(Theme.text) : AnyShapeStyle(.tertiary))
                .frame(width: 20, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
