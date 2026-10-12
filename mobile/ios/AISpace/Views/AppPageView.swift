import SwiftUI

/// One app's page with what a phone needs around it: whose page it is, back, forward, reload,
/// share and a way out to Safari. The page keeps the Space's sign-in.
struct AppPageView: View {
    @ObservedObject var model: AppModel
    let page: OpenPage
    @ObservedObject var session: WebSession
    @ObservedObject var favorites: FavoritesStore

    var body: some View {
        VStack(spacing: 0) {
            header
            ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent)
                .opacity(session.isLoading ? 1 : 0).frame(height: 2)
            ZStack {
                Theme.ground
                WebContainer(session: session)
                    .opacity(session.state.isFailure ? 0 : 1)
                WebFailure(session: session)
            }
            toolbar
        }
        .background(Theme.ground.ignoresSafeArea())
        // The web view moves its own content clear of the keyboard, as Safari does.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .modifier(DownloadOutcome(session: session))
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { model.page = nil } label: {
                Image(systemName: "xmark").font(.body.weight(.semibold)).frame(width: 36, height: 36)
            }
            .accessibilityLabel(Text("Close"))
            VStack(spacing: 1) {
                Text(verbatim: page.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                HStack(spacing: 4) {
                    if !session.showsSpacePage {
                        Image(systemName: "person.badge.key.fill").font(.system(size: 9))
                    } else if (session.currentURL ?? session.home).scheme?.lowercased() == "https" {
                        Image(systemName: "lock.fill").font(.system(size: 9))
                    }
                    Text(verbatim: session.currentURL?.host ?? session.home.host ?? "").lineLimit(1)
                }
                .font(.caption2).foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(session.showsSpacePage ? Text(verbatim: session.currentURL?.host ?? "") : Text("Signing in at \(session.currentURL?.host ?? "")"))
            }
            .frame(maxWidth: .infinity)
            if let key = page.key {
                let on = favorites.isFavorite(key, page.connection)
                Button { favorites.toggle(key, page.connection) } label: {
                    Image(systemName: on ? "star.fill" : "star").frame(width: 36, height: 36)
                        .foregroundStyle(on ? Theme.warning : Theme.accent)
                }
                .accessibilityLabel(on ? Text("Remove from Favorites") : Text("Add to Favorites"))
            } else {
                Color.clear.frame(width: 36, height: 36)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(.bar)
    }

    private var toolbar: some View {
        HStack {
            tool("chevron.backward", "Back", enabled: session.canGoBack) { session.webView.goBack() }
            Spacer()
            tool("chevron.forward", "Forward", enabled: session.canGoForward) { session.webView.goForward() }
            Spacer()
            if session.isLoading {
                tool("xmark", "Stop") { session.stop() }
            } else {
                tool("arrow.clockwise", "Reload") { session.reload() }
            }
            Spacer()
            ShareLink(item: session.shareURL) {
                Image(systemName: "square.and.arrow.up").font(.body.weight(.medium)).frame(width: 44, height: 44)
            }
            .accessibilityLabel(Text("Share"))
            Spacer()
            tool("safari", "Open in Safari") { model.openInBrowser(session.shareURL) }
        }
        .padding(.horizontal, 16).padding(.top, 2)
        .background(.bar)
    }

    private func tool(_ symbol: String, _ label: LocalizedStringKey, enabled: Bool = true, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.body.weight(.medium)).frame(width: 44, height: 44)
        }
        .disabled(!enabled)
        .accessibilityLabel(Text(label))
    }
}
