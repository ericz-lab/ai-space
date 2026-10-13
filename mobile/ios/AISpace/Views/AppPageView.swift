import SwiftUI

/// One app's page, edge to edge: nothing of the app's is drawn around it but a small handle
/// that opens the page's controls and can be dragged out of the page's way. The page keeps the
/// Space's sign-in.
struct AppPageView: View {
    @ObservedObject var model: AppModel
    let page: OpenPage
    @ObservedObject var session: WebSession
    @ObservedObject var screens: ScreenStore
    @ObservedObject var handle: PageHandle

    var body: some View {
        VStack(spacing: 0) {
            // Off the Space, on an access layer's sign-in, the page says whose it is.
            if !session.showsSpacePage, let host = session.currentURL?.host {
                SignInBar(host: host)
            }
            ZStack {
                Theme.ground
                WebContainer(session: session)
                    .opacity(session.state.isFailure ? 0 : 1)
                WebFailure(session: session)
            }
        }
        .overlay(alignment: .top) {
            ProgressView(value: session.progress).progressViewStyle(.linear).tint(Theme.accent)
                .opacity(session.isLoading ? 1 : 0).frame(height: 2)
        }
        .overlay {
            GeometryReader { geo in
                controls
                    .position(handle.point(in: geo.size))
                    .simultaneousGesture(
                        DragGesture(minimumDistance: 10)
                            .onChanged { handle.drag = $0.translation }
                            .onEnded { handle.drop($0.translation, in: geo.size) }
                    )
            }
        }
        .background(Theme.ground.ignoresSafeArea())
        // The web view moves its own content clear of the keyboard, as Safari does.
        .ignoresSafeArea(.keyboard, edges: .bottom)
        .modifier(DownloadOutcome(session: session))
    }

    private var controls: some View {
        Menu {
            Section {
                Button { model.page = nil } label: { Label("Close", systemImage: "xmark") }
            } header: {
                Text(verbatim: [page.title, session.currentURL?.host ?? session.home.host].compactMap { $0 }.joined(separator: " · "))
            }
            Section {
                Button { session.webView.goBack() } label: { Label("Back", systemImage: "chevron.backward") }
                    .disabled(!session.canGoBack)
                Button { session.webView.goForward() } label: { Label("Forward", systemImage: "chevron.forward") }
                    .disabled(!session.canGoForward)
                if session.isLoading {
                    Button { session.stop() } label: { Label("Stop", systemImage: "xmark.circle") }
                } else {
                    Button { session.reload() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                }
            }
            Section {
                ShareLink(item: session.shareURL) { Label("Share", systemImage: "square.and.arrow.up") }
                Button { model.openInBrowser(session.shareURL) } label: { Label("Open in Safari", systemImage: "safari") }
                if let key = page.key, let connection = model.store.connection(page.connection) {
                    let on = screens.isPinned(key, page.connection)
                    Button { model.togglePin(key, screen: Screens.home, in: connection) } label: {
                        if on { Label("Remove from Panel", systemImage: "checkmark.rectangle.stack.fill") } else { Label("Add to Panel", systemImage: "plus.rectangle.on.rectangle") }
                    }
                }
            }
        } label: {
            // Dark with a light rim whatever the theme: the page under it can be any colour.
            Image(systemName: "ellipsis").font(.body.weight(.semibold)).foregroundStyle(Color.white)
                .frame(width: PageHandle.size, height: PageHandle.size)
                .background(Color.black.opacity(0.55), in: Circle())
                .overlay(Circle().strokeBorder(Color.white.opacity(0.35)))
                .contentShape(Circle())
        }
        .accessibilityLabel(Text("Page controls"))
    }
}

/// Where the page's handle rests: against one side, at a height the user chose by dragging it.
final class PageHandle: ObservableObject {
    static let size: CGFloat = 40
    static let margin: CGFloat = 8

    @Published var drag = CGSize.zero
    @Published private(set) var isLeading = false
    @Published private(set) var height: CGFloat = 0.62

    private func rest(in size: CGSize) -> CGPoint {
        let inset = Self.size / 2 + Self.margin
        return CGPoint(x: isLeading ? inset : size.width - inset, y: min(max(size.height * height, inset), max(inset, size.height - inset)))
    }

    func point(in size: CGSize) -> CGPoint {
        let rest = rest(in: size), inset = Self.size / 2 + Self.margin
        return CGPoint(x: min(max(rest.x + drag.width, inset), max(inset, size.width - inset)),
                       y: min(max(rest.y + drag.height, inset), max(inset, size.height - inset)))
    }

    func drop(_ translation: CGSize, in size: CGSize) {
        drag = translation
        let at = point(in: size)
        drag = .zero
        guard size.width > 0, size.height > 0 else { return }
        isLeading = at.x < size.width / 2
        height = at.y / size.height
    }
}
