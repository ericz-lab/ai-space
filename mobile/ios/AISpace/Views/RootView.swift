import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            if let connection = model.selected {
                MainTabs(model: model, connection: connection, screens: model.screens)
                    .id(connection.id)
            } else {
                NavigationStack {
                    ConnectView(model: model, isFirst: true)
                }
            }
        }
        // A theme changes tokens every view reads; the views are made again in it.
        .id(model.themeID)
        .tint(Theme.accent)
        .preferredColorScheme(model.appearance == .system ? nil : (model.appearance == .dark ? .dark : .light))
        .sheet(isPresented: $model.showingAdd) {
            NavigationStack {
                ConnectView(model: model, isFirst: false)
            }
        }
    }
}

/// The pages side by side, swiped through as on an iPhone's home screen: Home, each screen of
/// the panel, Settings. Swipe horizontally to move between them; no dock covers the content.
struct MainTabs: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var screens: ScreenStore

    var body: some View {
        let loader = model.loader(for: connection)
        let icons = model.icons(for: connection)
        let all = screens.screens(connection.id)
        // A paging scroll view, not a page-style TabView: that one loses its place when a screen
        // is added or removed, and a navigation bar inside it does not survive.
        // Measure the safe viewport outside the scroll view. A horizontal scroll view resolves
        // safe areas into content margins; nested pages keep that layout size while their
        // scrolling content can pass behind the frosted status area.
        GeometryReader { viewport in
            PagerScroll(position: model.pager) {
                // Not lazy: a lazy row makes the page being swiped to, with all its tiles and
                // cards, in the middle of the swipe. Each page is lazy down its own length.
                HStack(spacing: 0) {
                    HomeView(model: model, connection: connection, loader: loader, icons: icons, store: screens)
                        .frame(width: viewport.size.width, height: viewport.size.height)
                        .id(Pager.home)
                    ForEach(all) { screen in
                        HomeView(model: model, connection: connection, loader: loader, icons: icons, store: screens, screenID: screen.id)
                            .frame(width: viewport.size.width, height: viewport.size.height)
                            .id(screen.id)
                    }
                    SettingsView(model: model, connection: connection, loader: loader, settings: model.settings(for: connection), icons: icons)
                        .frame(width: viewport.size.width, height: viewport.size.height)
                        .id(Pager.settings)
                }
                .scrollTargetLayout()
            }
        }
        // Keep one status effect outside the pager so adjacent pages never overlap their glass.
        .modifier(LauncherHeaderBlur())
        // One continuous backdrop for Home, Panel and Settings, including the status bar.
        .background { SpaceBackdrop(store: model.backdrops(for: connection)) }
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .confirmationDialog(Text(verbatim: Screens.title(at: all.firstIndex { $0.id == model.homePage } ?? 0)), isPresented: $model.showingScreenMenu, titleVisibility: .visible) {
            Button("New Screen") { withAnimation { model.addScreen(in: connection) } }
                .disabled(all.count >= Screens.limit)
            Button("Edit This Screen") { model.editingScreen = model.homePage }
            Button("Copy the Panel's Layout") { model.confirmingResetScreens = true }
                .disabled(loader.catalogue == nil)
            if model.homePage != Screens.home {
                Button("Delete Screen", role: .destructive) { model.confirmingDeleteScreen = true }
            }
        }
        .confirmationDialog(Text("Delete this screen?"), isPresented: $model.confirmingDeleteScreen, titleVisibility: .visible) {
            Button("Delete Screen", role: .destructive) { withAnimation { model.removeScreen(model.homePage, in: connection) } }
        } message: {
            Text("Its apps, agents and widgets stay in the library.")
        }
        .confirmationDialog(Text("Replace this iPhone's screens?"), isPresented: $model.confirmingResetScreens, titleVisibility: .visible) {
            Button("Replace", role: .destructive) { model.resetScreens(in: connection) }
        } message: {
            Text("The screens on this iPhone become a copy of the panel's as it is now. The panel does not change.")
        }
        .sheet(isPresented: Binding(get: { model.editingScreen != nil }, set: { if !$0 { model.editingScreen = nil } })) {
            if let id = model.editingScreen {
                ScreenEditor(model: model, connection: connection, loader: loader, icons: icons, store: screens, screen: id)
            }
        }
        .fullScreenCover(isPresented: Binding(get: { model.page != nil }, set: { if !$0 { model.page = nil } })) {
            AppBrowserView(model: model)
        }
        // A second cover needs a view of its own to hang from.
        .background {
            Color.clear.fullScreenCover(isPresented: $model.showingWebPanel) {
                WebPanelView(model: model, connection: connection, session: model.panel(for: connection))
            }
        }
        .background {
            Color.clear.fullScreenCover(item: $model.hubPage) { page in
                HubCover(model: model, connection: connection, page: page, loader: loader, icons: icons)
                    .preferredColorScheme(model.appearance == .system ? nil : (model.appearance == .dark ? .dark : .light))
            }
        }
    }
}

/// The paging scroll view, the one view that follows the page on show. A swipe changes the
/// position here only; the pages, made by MainTabs, are not evaluated again for it.
private struct PagerScroll<Pages: View>: View {
    @ObservedObject var position: PagerPosition
    @ViewBuilder let pages: Pages
    /// Whether the pager has been moved to the page on show since it was made.
    @State private var settled = false

    var body: some View {
        ScrollViewReader { pager in
            ScrollView(.horizontal) { pages }
                .scrollClipDisabled()
                .scrollTargetBehavior(.paging)
                .scrollIndicators(.hidden)
                .scrollPosition(id: Binding<String?>(get: { position.id }, set: { id in
                    // A new pager lies on its leftmost page and says so before it has been moved
                    // to the page on show; that report is not a swipe.
                    guard settled else { settled = id == position.id; return }
                    if let id, id != position.id { position.id = id }
                }))
                .onAppear {
                    pager.scrollTo(position.id, anchor: .leading)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled = true }
                }
        }
    }
}
