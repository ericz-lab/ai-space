import UIKit
import WebKit

/// Icons and avatars of one Space, fetched through its API with its session and kept in memory;
/// an icon a manifest places on another site is fetched plainly, without the session.
/// An emoji needs no loading (see `Icon.emoji`); SVG files, which UIKit cannot decode, are drawn
/// once by an offscreen web view with scripts off.
@MainActor
final class IconStore: ObservableObject {
    private let api: SpaceAPI
    private var images: [String: UIImage] = [:]
    private var pending: Set<String> = []
    private var failed: Set<String> = []

    /// For icons on other sites: no cookie goes out and none is kept.
    private static let external: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()
    /// Twice what the Space accepts for an icon of its own (MAX_ICON_BYTES); a larger answer is not an icon.
    private static let externalLimit = 1 << 20

    init(api: SpaceAPI) {
        self.api = api
    }

    func image(_ icon: String?) -> UIImage? {
        guard let icon, Icon.isPath(icon) else { return nil }
        if let hit = images[icon] { return hit }
        guard !pending.contains(icon), !failed.contains(icon) else { return nil }
        pending.insert(icon)
        Task {
            let image = await load(icon)
            pending.remove(icon)
            if let image { images[icon] = image } else { failed.insert(icon) }
            objectWillChange.send()
        }
        return nil
    }

    /// A failed icon is tried again after a refresh (the session may have been the reason).
    func retryFailed() {
        failed.removeAll()
    }

    private func load(_ icon: String) async -> UIImage? {
        guard let data = await data(icon), !data.isEmpty else { return nil }
        if Icon.isSVG(data) { return await SVGRasterizer.shared.image(svg: data) }
        return UIImage(data: data)
    }
}

extension IconStore {
    private func data(_ icon: String) async -> Data? {
        switch IconSource(icon, space: api.base) {
        case .space(let path):
            return try? await api.data(path)
        case .external(let url):
            guard let (data, response) = try? await Self.external.data(from: url),
                  let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  data.count <= Self.externalLimit
            else { return nil }
            return data
        case nil:
            return nil
        }
    }
}

enum Icon {
    /// A path on the Space or an http(s) URL; anything else is an emoji to draw as text.
    static func isPath(_ s: String) -> Bool {
        s.hasPrefix("/") || s.lowercased().hasPrefix("http://") || s.lowercased().hasPrefix("https://")
    }

    static func emoji(_ s: String?) -> String? {
        guard let s, !s.isEmpty, !isPath(s), s.count <= 4 else { return nil }
        return s
    }

    static func isSVG(_ data: Data) -> Bool {
        guard let head = String(data: data.prefix(512), encoding: .utf8)?.lowercased() else { return false }
        return head.contains("<svg") || head.contains("<?xml")
    }
}

/// Draws an SVG to a bitmap with a web view that runs no script and loads nothing but the image
/// itself, one at a time.
@MainActor
final class SVGRasterizer: NSObject, WKNavigationDelegate {
    static let shared = SVGRasterizer()
    private static let side: CGFloat = 96

    private lazy var webView: WKWebView = {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: Self.side, height: Self.side), configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        // The view sits in the app's window, whose safe area would push the image down and out of the snapshot.
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isUserInteractionEnabled = false
        view.navigationDelegate = self
        return view
    }()
    private var queue: [(Data, CheckedContinuation<UIImage?, Never>)] = []
    private var current: CheckedContinuation<UIImage?, Never>?

    func image(svg: Data) async -> UIImage? {
        await withCheckedContinuation { continuation in
            queue.append((svg, continuation))
            next()
        }
    }

    private func next() {
        guard current == nil, !queue.isEmpty else { return }
        let (svg, continuation) = queue.removeFirst()
        current = continuation
        attach()
        let html = """
        <!doctype html><meta name="viewport" content="width=\(Int(Self.side)),initial-scale=1">
        <style>html,body{margin:0;background:transparent;overflow:hidden}img{display:block;width:\(Int(Self.side))px;height:\(Int(Self.side))px;object-fit:contain}</style>
        <img src="data:image/svg+xml;base64,\(svg.base64EncodedString())">
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    /// A web view outside a window may never paint; it sits behind the app's content, unseen.
    private func attach() {
        guard webView.window == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first
        else { return }
        webView.alpha = 0.01
        window.insertSubview(webView, at: 0)
    }

    private func finish(_ image: UIImage?) {
        current?.resume(returning: image)
        current = nil
        next()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // One turn of the run loop lets the image decode before the snapshot.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self else { return }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: Self.side, height: Self.side)
            self.webView.takeSnapshot(with: config) { image, _ in
                MainActor.assumeIsolated { self.finish(image) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(nil)
    }

    /// The page is the image and nothing else: no link, redirect or subresource leaves it.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = action.request.url?.scheme?.lowercased() ?? ""
        decisionHandler(scheme == "about" || scheme == "data" ? .allow : .cancel)
    }
}
