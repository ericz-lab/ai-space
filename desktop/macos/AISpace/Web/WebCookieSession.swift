import WebKit

/// One saved Space's WebKit store, and its cookies for the native calls. A persistent store read
/// before WebKit has opened its profile can answer with no cookies at all, although valid ones are
/// on disk: the native calls would then see a sign-in page where there is none. So the first read
/// waits for a blank local page to load in the store, as the iPhone client does. This contacts
/// nothing and extends no cookie.
@MainActor
final class WebCookieSession: NSObject, WKNavigationDelegate, WKHTTPCookieStoreObserver {
    var onCookies: (([HTTPCookie]) -> Void)?
    private var cookieGeneration = 0

    func invalidateSharedCookies() { cookieGeneration += 1 }

    func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        cookieGeneration += 1
        Task { _ = await cookies() }
    }
    let dataStore: WKWebsiteDataStore
    private let bootstrap: WKWebView
    private var ready = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(identifier: UUID) {
        dataStore = WKWebsiteDataStore(forIdentifier: identifier)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        bootstrap = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        bootstrap.navigationDelegate = self
        dataStore.httpCookieStore.add(self)
    }

    func cookies() async -> [HTTPCookie] {
        let generation = cookieGeneration
        if !ready {
            await withCheckedContinuation { continuation in
                waiting.append(continuation)
                if waiting.count == 1 { bootstrap.loadHTMLString("<!doctype html><title></title>", baseURL: nil) }
            }
        }
        let cookies = await dataStore.httpCookieStore.allCookies()
        if generation == cookieGeneration { onCookies?(cookies) }
        return cookies
    }

    private func finish() {
        ready = true
        let callers = waiting
        waiting.removeAll()
        callers.forEach { $0.resume() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish()
        ready = false
    }
}
