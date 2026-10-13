import UIKit
import WebKit

/// The drawn artwork some of the panel's themes have behind the page (`/backdrops/<name>.html`,
/// src/web/theme.ts), fetched from the Space with its session and drawn once to a bitmap by an
/// offscreen web view: the artwork is static, and a picture scrolls better under the pages than
/// a live document. Kept in memory per name, light or dark, and size.
@MainActor
final class BackdropStore: NSObject, ObservableObject, WKNavigationDelegate {
    private struct Job {
        var key: String
        var name: String
        var dark: Bool
        var size: CGSize
    }

    private let space: URL
    private let dataStore: WKWebsiteDataStore
    private var images: [String: UIImage] = [:]
    private var failed: Set<String> = []
    private var waiting: Job?
    private var current: Job?
    private var webView: WKWebView?

    init(space: URL, dataStore: WKWebsiteDataStore) {
        self.space = space
        self.dataStore = dataStore
    }

    /// The artwork at this size, or while it is being drawn the same artwork at another size; nil until there is any.
    func image(_ name: String, dark: Bool, size: CGSize) -> UIImage? {
        guard size.width > 50, size.height > 50 else { return nil }
        let prefix = "\(name)|\(dark)|"
        let key = prefix + "\(Int(size.width))x\(Int(size.height))"
        if let hit = images[key] { return hit }
        if current?.key != key, waiting?.key != key, !failed.contains(key) {
            // Only the latest size asked for matters; not started from inside a view update.
            waiting = Job(key: key, name: name, dark: dark, size: size)
            DispatchQueue.main.async { [weak self] in self?.next() }
        }
        return images.first { $0.key.hasPrefix(prefix) }?.value
    }

    /// A failed drawing is tried again after a sign-in (the session may have been the reason).
    func retryFailed() {
        guard !failed.isEmpty else { return }
        failed.removeAll()
        objectWillChange.send()
    }

    private func next() {
        guard current == nil, let job = waiting,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first,
              let url = URL(string: "/backdrops/\(SpacePath.escape(job.name)).html?v=2", relativeTo: space)?.absoluteURL
        else { return }
        waiting = nil
        current = job
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        // The artwork picks its version from `data-theme`; the app's choice wins over the system's.
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.theme='\(job.dark ? "dark" : "light")'", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        let view = WKWebView(frame: CGRect(origin: .zero, size: job.size), configuration: config)
        view.overrideUserInterfaceStyle = job.dark ? .dark : .light
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isUserInteractionEnabled = false
        view.navigationDelegate = self
        // A web view outside a window may never paint; it sits behind the app's content, unseen.
        // WKWebView snapshots include the view's alpha. Hide it behind the content,
        // not by fading it, or the cached bitmap becomes almost transparent too.
        view.alpha = 1
        window.insertSubview(view, at: 0)
        webView = view
        view.load(URLRequest(url: url))
    }

    private func finish(_ image: UIImage?) {
        if let job = current {
            if let image { images[job.key] = image } else { failed.insert(job.key) }
        }
        webView?.navigationDelegate = nil
        webView?.removeFromSuperview()
        webView = nil
        current = nil
        objectWillChange.send()
        next()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The artwork's filters and gradients need a moment after the load to be painted.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, webView === self.webView, let job = self.current else { return }
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(origin: .zero, size: job.size)
            webView.takeSnapshot(with: config) { image, _ in
                MainActor.assumeIsolated { if webView === self.webView { self.finish(image) } }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { finish(nil) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === self.webView { finish(nil) }
    }

    /// Only the artwork itself loads: a redirect to a sign-in page, or anything off the Space, is not it.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "data" || scheme == "blob" { return decisionHandler(.allow) }
        decisionHandler(ConnectionRules.sameOrigin(url, space) && url.path.hasPrefix("/backdrops/") ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let status = (response.response as? HTTPURLResponse)?.statusCode ?? 200
        decisionHandler(response.isForMainFrame && status != 200 ? .cancel : .allow)
    }
}
