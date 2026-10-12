import SwiftUI

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            if let connection = model.selected {
                MainTabs(model: model, connection: connection)
                    .id(connection.id)
            } else {
                NavigationStack {
                    ConnectView(model: model, isFirst: true)
                }
            }
        }
        .sheet(isPresented: $model.showingAdd) {
            NavigationStack {
                ConnectView(model: model, isFirst: false)
            }
        }
    }
}

struct MainTabs: View {
    @ObservedObject var model: AppModel
    let connection: Connection

    var body: some View {
        TabView(selection: $model.tab) {
            HomeView(model: model, connection: connection, loader: model.loader(for: connection),
                     icons: model.icons(for: connection), favorites: model.favorites)
                .tabItem { Label("Home", systemImage: "square.grid.2x2") }
                .tag(MainTab.home)
            PanelView(model: model, connection: connection, session: model.panel(for: connection))
                .tabItem { Label("Panel", systemImage: "bubble.left.and.text.bubble.right") }
                .tag(MainTab.panel)
            SettingsView(model: model, connection: connection, loader: model.loader(for: connection))
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(MainTab.settings)
        }
        .fullScreenCover(item: $model.page) { page in
            AppPageView(model: model, page: page, session: page.session, favorites: model.favorites)
        }
    }
}
