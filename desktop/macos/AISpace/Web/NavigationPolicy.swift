import Foundation

enum NavigationDecision: Equatable {
    case allow
    case openExternally
    case download
    case cancel
}

/// One navigation as the policy sees it, free of WebKit types so it can be tested.
struct NavigationRequest {
    var url: URL
    var isMainFrame: Bool
    /// The user clicked a link (WKNavigationType.linkActivated).
    var isLinkActivation: Bool
    /// target=_blank or window.open: WebKit asks for a new web view.
    var opensNewWindow: Bool
    /// The link carries a `download` attribute.
    var shouldDownload: Bool
    /// The main frame currently shows the connection's own origin.
    var fromConnectionPage: Bool
}

/// The panel stays in the window; everything else goes to the default browser.
/// A redirect or script navigation away from the panel's origin stays in the window so an access
/// layer's sign-in can complete, but a link the user clicks on the panel leaves for the browser.
enum NavigationPolicy {
    static func decide(_ r: NavigationRequest, connection: URL) -> NavigationDecision {
        let scheme = r.url.scheme?.lowercased() ?? ""
        let web = scheme == "http" || scheme == "https"
        let sameOrigin = web && ConnectionRules.sameOrigin(r.url, connection)

        if r.shouldDownload {
            if sameOrigin || scheme == "blob" || scheme == "data" { return .download }
            return web ? .openExternally : .cancel
        }
        if r.opensNewWindow {
            return web ? .openExternally : .cancel
        }
        switch scheme {
        case "about", "blob", "data":
            return .allow
        case "http", "https":
            break
        default:
            // mailto:, tel:, other apps' schemes: only on a click, and never inside the panel.
            return r.isLinkActivation ? .openExternally : .cancel
        }
        if !r.isMainFrame || sameOrigin { return .allow }
        if r.isLinkActivation && r.fromConnectionPage { return .openExternally }
        return .allow
    }
}

/// What a page asks to capture, free of WebKit types (WKMediaCaptureType).
enum MediaCaptureKind: Equatable {
    case microphone
    case camera
    case cameraAndMicrophone
}

enum MediaCaptureDecision: Equatable {
    case grant
    case deny
}

/// Microphone for the pages this app opened, so their voice input works (getUserMedia); macOS
/// still asks the operator once for the app itself. The page and the frame asking must both be
/// of the session's own origin or the connection's: an embedded or redirected-to site gets
/// nothing. The camera is never granted: the app declares no camera use (Info.plist).
enum MediaCapturePolicy {
    static func decide(_ kind: MediaCaptureKind, page: URL?, frame: URL?, home: URL, connection: URL) -> MediaCaptureDecision {
        guard kind == .microphone, let page, let frame else { return .deny }
        func own(_ url: URL) -> Bool {
            let scheme = url.scheme?.lowercased() ?? ""
            guard scheme == "http" || scheme == "https" else { return false }
            return ConnectionRules.sameOrigin(url, home) || ConnectionRules.sameOrigin(url, connection)
        }
        return own(page) && own(frame) ? .grant : .deny
    }

    /// A WebKit security origin's parts as a URL; port 0 means the scheme's default.
    static func url(scheme: String, host: String, port: Int) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        if port != 0 { parts.port = port }
        parts.path = "/"
        return parts.url
    }
}
