import AppKit
import WebKit

/// One web view and its state: a connection's panel, or one app's page in its own window.
/// A session lives until its connection is removed or changed, so switching keeps each page,
/// its drafts and its streams in place. Nothing here is exposed to page scripts: there is no
/// message handler and no bridge.
@MainActor
final class PanelSession: NSObject, ObservableObject {
    let connection: Connection
    /// The page this session shows; its origin is the one that stays in the window.
    let home: URL
    /// Panel sessions confirm the page is ai-space; an app's page is whatever the app serves.
    let verifiesSpace: Bool
    let webView: WKWebView
    /// Where a link leaving the window goes: an app's window, or the default browser.
    var openLink: (URL) -> Void = { NSWorkspace.shared.open($0) }
    var onStateChange: ((SpaceState) -> Void)?
    /// The view currently hosting the web view (see PanelWebView).
    weak var container: NSView?
    @Published private(set) var state: SpaceState = .connecting {
        didSet {
            #if DEBUG
            if state != oldValue { NSLog("ai-space: %@ %@", home.absoluteString, String(describing: state)) }
            #endif
            if state != oldValue { onStateChange?(state) }
        }
    }
    @Published private(set) var isLoading = false
    private var downloads: [ObjectIdentifier: URL] = [:]

    init(connection: Connection, dataStore: WKWebsiteDataStore, home: URL? = nil) {
        self.connection = connection
        self.home = home ?? connection.url
        verifiesSpace = home == nil
        let config = WKWebViewConfiguration()
        // Each connection signs in separately and apart from Safari; its app windows share the sign-in.
        config.websiteDataStore = dataStore
        config.applicationNameForUserAgent = "AISpaceDesktop/\(Bundle.main.shortVersion)"
        config.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = true
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func load() {
        state = .connecting
        webView.load(URLRequest(url: home))
    }

    /// Reloads the current page; after a failure, starts again from the connection's URL.
    func reload() {
        if webView.url == nil || state.isFailure { load() } else { webView.reload() }
    }

    /// The page to open in the browser: the current panel page, or the connection's URL.
    var browserURL: URL {
        if let url = webView.url, ConnectionRules.sameOrigin(url, home) { return url }
        return home
    }

    /// Re-checks a failed connection, for example after the Mac wakes.
    func recoverIfFailed() {
        if state.isFailure { load() }
    }

    private var showsConnectionPage: Bool {
        webView.url.map { ConnectionRules.sameOrigin($0, home) } ?? false
    }

    private func check() {
        guard verifiesSpace else {
            state = showsConnectionPage ? .ready : .authenticationRequired
            return
        }
        guard showsConnectionPage else {
            state = .authenticationRequired
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
}

extension PanelSession: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
                 decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel, preferences) }
        let request = NavigationRequest(
            url: url,
            isMainFrame: action.targetFrame?.isMainFrame ?? true,
            isLinkActivation: action.navigationType == .linkActivated,
            opensNewWindow: action.targetFrame == nil,
            shouldDownload: action.shouldPerformDownload,
            fromConnectionPage: showsConnectionPage)
        switch NavigationPolicy.decide(request, connection: home) {
        case .allow: decisionHandler(.allow, preferences)
        case .download: decisionHandler(.download, preferences)
        case .cancel: decisionHandler(.cancel, preferences)
        case .openExternally:
            openLink(url)
            decisionHandler(.cancel, preferences)
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
        // The page restores background runs from the server; reloading never resends a prompt.
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

extension PanelSession: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let url = Downloads.destination(for: suggestedFilename)
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        Downloads.announce(downloads.removeValue(forKey: ObjectIdentifier(download)))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        NSLog("ai-space: download failed: \(error.localizedDescription)")
    }
}

extension PanelSession: WKUIDelegate {
    /// target=_blank and window.open reach here only if the policy allowed them, which it does not
    /// for web URLs; never create a second web view that could outlive this session's checks.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            openLink(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        if let window = webView.window {
            panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
        } else {
            completionHandler(panel.runModal() == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = dialog(message, frame)
        alert.addButton(withTitle: String(localized: "OK"))
        present(alert, in: webView) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = dialog(message, frame)
        alert.addButton(withTitle: String(localized: "OK"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = dialog(prompt, frame)
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: String(localized: "OK"))
        alert.addButton(withTitle: String(localized: "Cancel"))
        present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    /// Titled with the frame's origin so a dialog from an embedded page is not mistaken for the panel's.
    private func dialog(_ message: String, _ frame: WKFrameInfo) -> NSAlert {
        let alert = NSAlert()
        let origin = frame.securityOrigin
        alert.messageText = origin.port == 0 ? "\(origin.protocol)://\(origin.host)" : "\(origin.protocol)://\(origin.host):\(origin.port)"
        alert.informativeText = message
        return alert
    }

    private func present(_ alert: NSAlert, in webView: WKWebView, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window = webView.window {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }
}

/// Downloads land in ~/Downloads under a name that does not replace an existing file.
enum Downloads {
    static func destination(for suggested: String) -> URL {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = (suggested as NSString).lastPathComponent.isEmpty ? "download" : (suggested as NSString).lastPathComponent
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var url = folder.appendingPathComponent(name)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return url
    }

    /// Bounces the Downloads stack in the Dock, as Safari does.
    static func announce(_ file: URL?) {
        guard let file else { return }
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: file.path)
    }
}

extension Bundle {
    var shortVersion: String { object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
}
