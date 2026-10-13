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
/// the panel, Settings. The bar at the bottom names the three parts and jumps between them;
/// while there are several screens, dots above it say which one is on show.
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
        ScrollView(.horizontal) {
            LazyHStack(spacing: 0) {
                HomeView(model: model, connection: connection, loader: loader, icons: icons, store: screens)
                    .containerRelativeFrame([.horizontal, .vertical])
                    .id(Pager.home)
                ForEach(all) { screen in
                    HomeView(model: model, connection: connection, loader: loader, icons: icons, store: screens, screenID: screen.id)
                        .containerRelativeFrame([.horizontal, .vertical])
                        .id(screen.id)
                }
                SettingsView(model: model, connection: connection, loader: loader, settings: model.settings(for: connection), icons: icons)
                    .containerRelativeFrame([.horizontal, .vertical])
                    .id(Pager.settings)
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollIndicators(.hidden)
        .scrollPosition(id: Binding<String?>(get: { model.pagerID }, set: { if let id = $0, id != model.pagerID { model.pagerID = id } }))
        // Room for the bar, as a tab bar leaves it.
        .safeAreaPadding(.bottom, TabBar.height + 8)
        // One backdrop behind every page: the pages slide over it, as the panel's screens do.
        .background { SpaceBackdrop(store: model.backdrops(for: connection)) }
        .overlay(alignment: .bottom) { TabBar(model: model, screens: all) }
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
        .fullScreenCover(item: $model.page) { page in
            AppPageView(model: model, page: page, session: page.session, screens: model.screens, handle: model.pageHandle)
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

/// The bar under the pages: Home, Panel, Settings, as the panel's dock floats over its screens.
struct TabBar: View {
    static let height: CGFloat = 58

    @ObservedObject var model: AppModel
    let screens: [PanelScreen]

    var body: some View {
        VStack(spacing: 8) {
            if model.tab == .panel && screens.count > 1 {
                HStack(spacing: 7) {
                    ForEach(screens) { screen in
                        Circle().fill(screen.id == model.pagerID ? Theme.text : Theme.text.opacity(0.3)).frame(width: 6, height: 6)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(.ultraThinMaterial, in: Capsule())
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: Screens.title(at: screens.firstIndex { $0.id == model.pagerID } ?? 0)))
            }
            HStack(spacing: 4) {
                item(.home, "Home", "square.grid.2x2.fill")
                item(.panel, "Panel", "rectangle.on.rectangle")
                item(.settings, "Settings", "gearshape.fill")
            }
            .padding(5)
            .frame(height: Self.height)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Theme.hairline))
            .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        }
        .padding(.bottom, 6)
    }

    private func item(_ tab: MainTab, _ title: LocalizedStringKey, _ symbol: String) -> some View {
        let on = model.tab == tab
        return Button { withAnimation { model.tab = tab } } label: {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(.system(size: 18, weight: .semibold))
                Text(title).font(.caption2.weight(.semibold))
            }
            .foregroundStyle(on ? Theme.accent : Theme.text)
            .frame(width: 86, height: Self.height - 10)
            .background(on ? AnyShapeStyle(Theme.accent.opacity(0.16)) : AnyShapeStyle(.clear), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
