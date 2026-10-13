import Combine
import UIKit
import WebKit

/// One web view and its state: a Space's panel, or one app's page. Its cookies live in the
/// Space's own WebKit store, apart from Safari and from every other saved Space, and the native
/// catalogue calls read the same store, so one sign-in serves both. Nothing here is exposed to
/// page scripts: there is no message handler and no bridge.
@MainActor
final class WebSession: NSObject, ObservableObject {
    /// The Space this page belongs to.
    let space: URL
    /// The page this session opens.
    let home: URL
    /// The panel's session confirms the page is ai-space; an app's page is whatever the app serves.
    let verifiesSpace: Bool
    let webView: WKWebView
    /// The Space's hostnames as of now; read on every navigation, so a refreshed catalogue applies at once.
    var hosts: () -> SpaceHosts
    /// Where a link leaving the view goes; the default is the system browser.
    var openExternally: (URL) -> Void = { UIApplication.shared.open($0) }
    var onStateChange: ((SpaceState) -> Void)?

    @Published private(set) var state: SpaceState = .connecting {
        didSet {
            guard state != oldValue else { return }
            #if DEBUG
            NSLog("ai-space: %@ %@ at %@", home.absoluteString, String(describing: state), webView.url?.absoluteString ?? "-")
            #endif
            onStateChange?(state)
        }
    }
    /// WebKit derives this from the page's HTML/body backgrounds and updates it when CSS
    /// changes. Observe it without overriding it, so the website remains in charge.
    @Published private(set) var pageBackground: UIColor = .systemBackground
    @Published private(set) var controlsHidden = false
    private var controlGesture = BrowserControlGesture()

    func showControls() {
        controlsHidden = false
        controlGesture = BrowserControlGesture()
    }

    @objc private func trackReadingGesture(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: webView)
        switch gesture.state {
        case .began:
            controlGesture = BrowserControlGesture()
        case .changed:
            if let hidden = controlGesture.update(x: translation.x, y: translation.y) {
                controlsHidden = hidden
            }
        default: break
        }
    }

    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var currentURL: URL?
    @Published private(set) var pageTitle = ""
    /// A finished download, waiting for the share sheet.
    @Published var downloaded: URL?
    /// Why a download did not finish, waiting to be said.
    @Published var downloadFailure: String?

    private var downloads: [ObjectIdentifier: URL] = [:]
    private var watchers: Set<AnyCancellable> = []
    private var started = false

    init(space: URL, home: URL? = nil, dataStore: WKWebsiteDataStore, hosts: @escaping () -> SpaceHosts) {
        self.space = space
        self.home = home ?? space
        self.hosts = hosts
        verifiesSpace = home == nil
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore
        config.applicationNameForUserAgent = "AISpaceMobile/\(Bundle.main.shortVersion)"
        config.allowsInlineMediaPlayback = true
        if home == nil {
            // The panel page has its own ways between its screens (src/web/ScreenNav.tsx). The app
            // has its own screens and tab bar, so they are left out. A newer Space leaves them out
            // itself, by the user agent; this covers one that does not yet.
            let css = ".dock,.edge,.screens-hint{display:none!important}"
            let script = "const s=document.createElement('style');s.textContent='\(css)';document.documentElement.appendChild(s);"
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Observe vertical drags in the page, including nested scrolling regions, without
        // cancelling WebKit's gestures, link taps, selection, or horizontal back swipes.
        let readingGesture = UIPanGestureRecognizer(target: self, action: #selector(trackReadingGesture(_:)))
        readingGesture.maximumNumberOfTouches = 1
        readingGesture.cancelsTouchesInView = false
        readingGesture.delegate = self
        webView.addGestureRecognizer(readingGesture)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.scrollView.keyboardDismissMode = .interactive
        // Leave app views opaque with WebKit's automatic background. A custom UIView
        // background overrides the page-derived color, even when observing WebKit's value.
        webView.isOpaque = home != nil
        if home == nil { webView.backgroundColor = .clear }
        webView.publisher(for: \.underPageBackgroundColor).sink { [weak self] color in
            self?.pageBackground = color ?? .systemBackground
        }.store(in: &watchers)
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.publisher(for: \.canGoBack).sink { [weak self] v in self?.canGoBack = v }.store(in: &watchers)
        webView.publisher(for: \.canGoForward).sink { [weak self] v in self?.canGoForward = v }.store(in: &watchers)
        webView.publisher(for: \.url).sink { [weak self] v in self?.currentURL = v }.store(in: &watchers)
        webView.publisher(for: \.title).sink { [weak self] v in self?.pageTitle = v ?? "" }.store(in: &watchers)
        webView.publisher(for: \.estimatedProgress).sink { [weak self] v in self?.progress = v }.store(in: &watchers)
    }

    /// Loads the page the first time it is shown.
    func start() {
        guard !started else { return }
        started = true
        load()
    }

    func load() {
        started = true
        state = .connecting
        webView.load(URLRequest(url: home))
    }

    /// Reloads the current page; after a failure, starts again from the session's own page.
    func reload() {
        if webView.url == nil || state.isFailure { load() } else { webView.reload() }
    }

    func stop() {
        webView.stopLoading()
        isLoading = false
    }

    func recoverIfFailed() {
        if started && state.isFailure { load() }
    }

    /// The address to hand to Safari or the share sheet: the page on show while it is a Space
    /// page, else the session's own page (never a half-finished sign-in URL).
    var shareURL: URL {
        if let url = webView.url, hosts().contains(url) { return url }
        return home
    }

    /// True while the view shows a page of the Space; false on an access layer's sign-in pages.
    var showsSpacePage: Bool {
        webView.url.map { hosts().contains($0) } ?? false
    }

    private func check() {
        guard showsSpacePage else {
            state = .authenticationRequired
            return
        }
        guard verifiesSpace, let url = webView.url, ConnectionRules.sameOrigin(url, space) else {
            state = .ready
            return
        }
        webView.callAsyncJavaScript(SpaceCheck.script, arguments: ["path": SpaceCheck.path], in: nil, in: .defaultClient) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value): self.state = SpaceCheck.classify(scriptResult: value)
            case .failure(let error): self.state = .incompatible(error.localizedDescription)
            }
        }
    }

    private func fail(_ error: Error) {
        isLoading = false
        if let s = SpaceCheck.classify(error: error) { state = s }
    }

    private func presenter() -> UIViewController? {
        var top = webView.window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

extension WebSession: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel, preferences) }
        let list = hosts()
        let request = NavigationRequest(
            url: url,
            isMainFrame: action.targetFrame?.isMainFrame ?? true,
            isLinkActivation: action.navigationType == .linkActivated,
            opensNewWindow: action.targetFrame == nil,
            shouldDownload: action.shouldPerformDownload,
            fromConnectionPage: showsSpacePage)
        switch MobileNavigation.decide(request, hosts: list, space: space) {
        case .allow: decisionHandler(.allow, preferences)
        case .download: decisionHandler(.download, preferences)
        case .cancel: decisionHandler(.cancel, preferences)
        case .openExternally:
            decisionHandler(.cancel, preferences)
            route(url, hosts: list)
        }
    }

    private func route(_ url: URL, hosts list: SpaceHosts) {
        switch MobileNavigation.external(url, hosts: list) {
        case .sameView: webView.load(URLRequest(url: url))
        case .browser: openExternally(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        isLoading = true
        showControls()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        check()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // iOS ends the page's process under memory pressure; the page restores itself from the server.
        state = .connecting
        if webView.url == nil { load() } else { webView.reload() }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
}

extension WebSession: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        // A fresh directory per download keeps the server's file name without replacing anything.
        let dir = AppPaths.downloads.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = (suggestedFilename as NSString).lastPathComponent
        let url = dir.appendingPathComponent(name.isEmpty ? "download" : name)
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        isLoading = false
        downloaded = downloads.removeValue(forKey: ObjectIdentifier(download))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        isLoading = false
        downloads.removeValue(forKey: ObjectIdentifier(download))
        downloadFailure = error.localizedDescription
        NSLog("ai-space: download failed: \(error.localizedDescription)")
    }
}

extension WebSession: WKUIDelegate {
    /// target=_blank and window.open never get a second web view: a Space page loads in this
    /// one, another site goes to Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            route(url, hosts: hosts())
        }
        return nil
    }

    /// Camera and microphone for the Space's own pages only; iOS still asks the operator.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(Self.url(of: origin).map(hosts().contains) == true ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = dialog(message, frame)
        alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default) { _ in completionHandler() })
        present(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = dialog(message, frame)
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default) { _ in completionHandler(true) })
        present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = dialog(prompt, frame)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: String(localized: "Cancel"), style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text ?? "")
        })
        present(alert) { completionHandler(nil) }
    }

    /// Titled with the frame's origin so a dialog from an embedded page is not mistaken for the app's.
    private func dialog(_ message: String, _ frame: WKFrameInfo) -> UIAlertController {
        UIAlertController(title: Self.url(of: frame.securityOrigin)?.absoluteString, message: message, preferredStyle: .alert)
    }

    /// WebKit must always get its answer, also when nothing can present the dialog.
    private func present(_ alert: UIAlertController, otherwise: () -> Void) {
        if let presenter = presenter() { presenter.present(alert, animated: true) } else { otherwise() }
    }

    private static func url(of origin: WKSecurityOrigin) -> URL? {
        URL(string: origin.port == 0 ? "\(origin.protocol)://\(origin.host)" : "\(origin.protocol)://\(origin.host):\(origin.port)")
    }
}

extension Bundle {
    var shortVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
}

/// Initializes a saved WebKit profile before native requests read its cookies. On a cold
/// launch, querying the cookie store before a web view has loaded can return an empty jar
/// even though valid persistent cookies are on disk. The local blank page makes no request
/// to the Space or its identity provider and concurrent callers share the same preparation.
@MainActor
final class WebCookieSession: NSObject, WKNavigationDelegate {
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
    }

    func cookies() async -> [HTTPCookie] {
        if !ready {
            await withCheckedContinuation { continuation in
                waiting.append(continuation)
                if waiting.count == 1 { bootstrap.loadHTMLString("<!doctype html><title></title>", baseURL: nil) }
            }
        }
        return await dataStore.httpCookieStore.allCookies()
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

/// Direction reversal must travel far enough to avoid flickering on small finger movements.
struct BrowserControlGesture {
    private var previousY: CGFloat = 0
    private var distance: CGFloat = 0

    mutating func update(x: CGFloat, y: CGFloat) -> Bool? {
        let delta = y - previousY
        previousY = y
        guard abs(y) > abs(x) else { distance = 0; return nil }
        if delta * distance < 0 { distance = 0 }
        distance += delta
        guard abs(distance) >= 24 else { return nil }
        let hidden = distance < 0
        distance = 0
        return hidden
    }
}

extension WebSession: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
}
