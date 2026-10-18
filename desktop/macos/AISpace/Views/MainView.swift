import SwiftUI

/// The main window, laid out as the iPhone client: the launcher (Home, the screens, Settings)
/// fills it, and an app, a page of the Space or the web panel comes up over it, with a way back
/// in the toolbar. The launcher stays alive underneath, on the page it was on.
struct MainView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: ConnectionStore
    @ObservedObject var prefs = Preferences.shared

    var body: some View {
        Group {
            if let connection = model.selected {
                SpaceWindow(model: model, connection: connection, loader: model.loader(for: connection),
                            icons: model.icons(for: connection), screens: model.screens)
                    .id(connection.id)
            } else {
                FirstLaunchView(model: model)
            }
        }
        // A theme changes tokens every view reads; the views are made again in it.
        .id(prefs.themeID)
        .sheet(isPresented: Binding(get: { model.local.needsModelChoice && model.store.managedConnection != nil }, set: { model.local.needsModelChoice = $0 })) {
            if let c = model.store.managedConnection {
                LocalModelChoice(model: model, settings: model.settings(for: c))
            }
        }
        .tint(Theme.accent)
        .frame(minWidth: 820, minHeight: 540)
    }
}

/// One Space in the window: the launcher and whatever is over it.
struct SpaceWindow: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader
    let icons: IconStore
    @ObservedObject var screens: ScreenStore

    var body: some View {
        let onLauncher = model.destination == .launcher
        ZStack {
            LauncherView(model: model, connection: connection, loader: loader, icons: icons, screens: screens)
                .opacity(onLauncher ? 1 : 0)
                .allowsHitTesting(onLauncher)
                .accessibilityHidden(!onLauncher)
            switch model.destination {
            case .launcher:
                EmptyView()
            case .hub(let page):
                HubContainer(model: model, connection: connection, page: page, loader: loader, icons: icons)
            case .app(let id):
                if let tab = model.tab(id, connection: connection.id) {
                    AppTabView(model: model, connection: connection, tab: tab, session: tab.session)
                        .id(tab.session.home)
                } else {
                    ContentUnavailableView("This app is not open", systemImage: "app.dashed")
                }
            case .panel:
                PanelPage(model: model, session: model.session(for: connection))
            }
        }
        .toolbar {
            if onLauncher {
                ToolbarItem(placement: .navigation) { ConnectionSwitcher(model: model, connection: connection, loader: loader) }
                ToolbarItem(placement: .principal) {
                    PageIndicator(position: model.pager, screens: screens.screens(connection.id)) { id in
                        withAnimation(.easeInOut(duration: 0.3)) { model.showPage(id) }
                    }
                }
                if #available(macOS 26.0, *) {
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                }
                ToolbarItem(placement: .primaryAction) { OpenTabsBar(model: model, connection: connection) }
                if #available(macOS 26.0, *) {
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        ScreenActions(model: model, connection: connection, loader: loader, store: screens)
                        Divider()
                        Button("Reload") { model.refreshCatalogue() }
                        Button("Web Panel") { model.openWebPanel() }
                    } label: {
                        Label("More", systemImage: "ellipsis.circle")
                    }
                    .help("Screens and More")
                }
            }
        }
        .navigationTitle(Text(verbatim: connection.name))
    }
}

/// The Space switcher and its state, at the leading edge of the launcher's toolbar.
struct ConnectionSwitcher: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader

    var body: some View {
        Menu {
            ForEach(model.store.connections) { c in
                Button { model.select(c.id) } label: {
                    if c.id == connection.id { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
            Divider()
            SettingsLink { Text("Edit Connections…") }
        } label: {
            HStack(spacing: 7) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                Text(verbatim: connection.name).font(.headline)
            }
        }
        .help(statusText)
    }

    private var statusColor: Color {
        switch loader.status {
        case .ok: return Theme.success
        case .signInNeeded: return Theme.warning
        case .unreachable, .incompatible: return Theme.danger
        case .loading: return .gray
        }
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

/// Up to five open apps, with the remaining pages in the overflow menu.
struct OpenTabsBar: View {
    @ObservedObject var model: AppModel
    let connection: Connection

    var body: some View {
        let tabs = model.tabs[connection.id] ?? []
        let selected = selectedApp
        let visible = OpenTabLayout.visible(tabs.map(\.id), selected: selected)
        let overflow = tabs.filter { !visible.contains($0.id) }
        HStack(spacing: 4) {
            ForEach(tabs.filter { visible.contains($0.id) }) { tab in
                Button { model.destination = .app(tab.id) } label: {
                    EntryIcon(icon: tab.app.icon, fallback: "app", icons: model.icons(for: connection), size: 22)
                        .padding(4)
                        .background(selected == tab.id ? Color.primary.opacity(0.10) : .clear,
                                    in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8)
                            .stroke(selected == tab.id ? Color.primary.opacity(0.22) : .clear, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .help(tab.app.displayTitle)
                .accessibilityLabel(Text(verbatim: tab.app.displayTitle))
                .accessibilityAddTraits(selected == tab.id ? .isSelected : [])
                .contextMenu {
                    Button("Close") { model.closeTab(tab.id, connection: connection.id) }
                    Button("Close All") { tabs.forEach { model.closeTab($0.id, connection: connection.id) } }
                }
            }
            if !overflow.isEmpty {
                Menu {
                    ForEach(overflow) { tab in
                        Button(tab.app.displayTitle) { model.destination = .app(tab.id) }
                    }
                    Divider()
                    Button("Close All") { tabs.forEach { model.closeTab($0.id, connection: connection.id) } }
                } label: {
                    Label("Open Tabs", systemImage: "chevron.down")
                }
                .menuIndicator(.hidden)
                .help("Open Tabs")
            }
        }
    }

    private var selectedApp: String? {
        if case .app(let id) = model.destination { return id }
        return nil
    }
}

/// An app open as a tab: its page, with the way back to the Space and the page's controls above it.
struct AppTabView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    let tab: AppTab
    @ObservedObject var session: PanelSession

    var body: some View {
        AppPageView(session: session)
            .navigationTitle(Text(verbatim: session.pageTitle.isEmpty ? tab.app.displayTitle : session.pageTitle))
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button { model.returnToSpace() } label: { Label("Back to Space", systemImage: "square.grid.2x2") }
                        .help("Back to Space (⇧⌘H)")
                }
                ToolbarItemGroup(placement: .navigation) {
                    Button { session.webView.goBack() } label: { Label("Back", systemImage: "chevron.left") }
                        .disabled(!session.canGoBack).help("Back")
                    Button { session.webView.goForward() } label: { Label("Forward", systemImage: "chevron.right") }
                        .disabled(!session.canGoForward).help("Forward")
                    Button { session.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .help("Reload")
                }
                if #available(macOS 26.0, *) {
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                }
                ToolbarItem(placement: .primaryAction) { OpenTabsBar(model: model, connection: connection) }
                if #available(macOS 26.0, *) {
                    ToolbarSpacer(.fixed, placement: .primaryAction)
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if let url = session.currentURL ?? session.webView.url {
                        Button { NSWorkspace.shared.open(url) } label: { Label("Open in Browser", systemImage: "safari") }
                            .help("Open in Browser")
                    }
                    Button { model.moveToWindow(tab.app.id, connection: connection.id) } label: {
                        Label("Open in New Window", systemImage: "macwindow.badge.plus")
                    }
                    .help("Open in New Window (⌥⌘T)")
                    Button { model.closeTab(tab.app.id, connection: connection.id) } label: { Label("Close", systemImage: "xmark") }
                        .help("Close")
                }
            }
    }

}

/// The Space's web panel over the launcher, for what the app does not draw (and the sign-in).
struct PanelPage: View {
    @ObservedObject var model: AppModel
    @ObservedObject var session: PanelSession

    var body: some View {
        SessionView(session: session)
            .navigationTitle(Text("Web Panel"))
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button { model.returnToSpace() } label: { Label("Back to Space", systemImage: "square.grid.2x2") }
                        .help("Back to Space (⇧⌘H)")
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { session.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .help("Reload")
                    Button { NSWorkspace.shared.open(session.browserURL) } label: { Label("Open in Browser", systemImage: "safari") }
                        .help("Open in Browser")
                }
            }
    }
}

/// One connection's page with its connection state over it.
struct SessionView: View {
    @ObservedObject var session: PanelSession

    var body: some View {
        ZStack(alignment: .top) {
            PanelWebView(session: session)
            switch session.state {
            case .connecting where !session.hasContent:
                Connecting().background(Theme.ground)
            case .authenticationRequired:
                SignInBanner(session: session)
            case .unreachable(let detail):
                FailureView(session: session, title: "Cannot reach this Space", detail: detail)
            case .incompatible(let detail):
                FailureView(session: session, title: "This address is not an ai-space panel", detail: detail)
            default:
                EmptyView()
            }
        }
    }
}

/// Shown above the access layer's sign-in page, which stays usable underneath.
struct SignInBanner: View {
    let session: PanelSession

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "person.badge.key")
            Text("Sign in to continue. If sign-in does not work here, use the browser.")
            Spacer()
            Button("Open in Browser") { NSWorkspace.shared.open(session.browserURL) }
            Button("Retry") { session.load() }
        }
        .font(.callout)
        .padding(10)
        .background(.bar)
    }
}

struct FailureView: View {
    let session: PanelSession
    let title: LocalizedStringKey
    let detail: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 36)).foregroundStyle(.secondary)
            Text(title).font(.title2)
            Text(session.home.absoluteString).font(.callout.monospaced()).textSelection(.enabled)
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if session.connection.isLocal && session.verifiesSpace {
                Text("Start ai-space on this Mac with `space start`, then retry. The app never starts a second Space on its own.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            HStack {
                Button("Retry") { session.load() }.keyboardShortcut(.defaultAction)
                if session.verifiesSpace { SettingsLink { Text("Edit Connections…") } }
                if !session.connection.isLocal {
                    Button("Open in Browser") { NSWorkspace.shared.open(session.home) }
                }
            }
        }
        .frame(maxWidth: 460)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

struct FirstLaunchView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if model.local.available {
            LocalSetupView(model: model, local: model.local)
        } else {
            connect
        }
    }

    private var connect: some View {
        VStack(spacing: 20) {
            Logo(size: 96)
            Text("Connect to a Space").font(.largeTitle)
            Text("Open an ai-space that is already running, on this Mac or on a server. Nothing is installed or started.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center)
            ConnectionForm(initial: nil) { name, url in model.add(name: name, url: url) }
                .frame(width: 440)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
