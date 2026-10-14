import SwiftUI
import WebKit

/// What is behind the pages of a Space: the theme's glows, or for a theme with drawn artwork
/// (Orbit, Northern Lights, Paper Cut, Prism) that artwork as the Space serves it
/// (`/backdrops/<name>.html`, src/web/theme.ts), over the theme's ground until it has drawn.
/// The iPhone draws it once to a picture for scrolling's sake; a Mac window is resized, so here the
/// page itself sits behind, as it does behind the panel in a browser. It takes no clicks.
struct SpaceBackdrop: View {
    let space: URL
    let dataStore: WKWebsiteDataStore
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let name = Theme.current.backdrop {
            ZStack {
                Theme.ground
                BackdropPage(space: space, name: name, dark: scheme == .dark, dataStore: dataStore)
                    .id("\(name)|\(scheme == .dark)")
            }
            .ignoresSafeArea()
            .accessibilityHidden(true)
        } else {
            Backdrop()
        }
    }
}

private struct BackdropPage: NSViewRepresentable {
    let space: URL
    let name: String
    let dark: Bool
    let dataStore: WKWebsiteDataStore

    func makeCoordinator() -> BackdropPolicy { BackdropPolicy(space: space) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        // The artwork picks its version from `data-theme`; the app's choice wins over the system's.
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.theme='\(dark ? "dark" : "light")'", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = InertWebView(frame: .zero, configuration: config)
        view.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        view.setValue(false, forKey: "drawsBackground")
        view.navigationDelegate = context.coordinator
        if let url = URL(string: "/backdrops/\(SpacePath.escape(name)).html?v=2", relativeTo: space)?.absoluteURL {
            view.load(URLRequest(url: url))
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    static func dismantleNSView(_ view: WKWebView, coordinator: BackdropPolicy) {
        view.stopLoading()
        view.navigationDelegate = nil
    }
}

/// Only the artwork itself loads: a redirect to a sign-in page, or anything off the Space, is not it.
final class BackdropPolicy: NSObject, WKNavigationDelegate {
    let space: URL

    init(space: URL) {
        self.space = space
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" { return decisionHandler(.allow) }
        decisionHandler(ConnectionRules.sameOrigin(url, space) && url.path.hasPrefix("/backdrops/") ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let status = (response.response as? HTTPURLResponse)?.statusCode ?? 200
        decisionHandler(response.isForMainFrame && status != 200 ? .cancel : .allow)
    }
}

/// A web view that is only looked at: clicks and scrolls go to what is in front of it.
private final class InertWebView: WKWebView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func scrollWheel(with event: NSEvent) { nextResponder?.scrollWheel(with: event) }
}
