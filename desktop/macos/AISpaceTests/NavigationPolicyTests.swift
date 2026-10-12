import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct NavigationPolicyTests {
    let panel = URL(string: "https://space.example.com/")!

    func decide(_ url: String, mainFrame: Bool = true, link: Bool = false, newWindow: Bool = false,
                download: Bool = false, fromPanel: Bool = true) -> NavigationDecision {
        NavigationPolicy.decide(NavigationRequest(
            url: URL(string: url)!, isMainFrame: mainFrame, isLinkActivation: link,
            opensNewWindow: newWindow, shouldDownload: download, fromConnectionPage: fromPanel), connection: panel)
    }

    @Test func panelPagesStayInTheWindow() {
        #expect(decide("https://space.example.com/?lang=zh") == .allow)
        #expect(decide("https://space.example.com/settings", link: true) == .allow)
        #expect(decide("about:blank") == .allow)
    }

    @Test func linksAndNewWindowsGoToTheBrowser() {
        #expect(decide("https://todo.space.example.com/", link: true) == .openExternally)
        #expect(decide("https://github.com/ericz-lab/ai-space", newWindow: true) == .openExternally)
        #expect(decide("https://space.example.com/apps/x", newWindow: true) == .openExternally)
        #expect(decide("mailto:op@example.com", link: true) == .openExternally)
    }

    @Test func signInRedirectsStayInTheWindow() {
        // The access layer redirects the main frame to its login origin, then back.
        #expect(decide("https://team.cloudflareaccess.com/cdn-cgi/access/login") == .allow)
        // Clicks on the login page (an identity provider button) belong to the sign-in flow.
        #expect(decide("https://accounts.example.org/o/oauth2", link: true, fromPanel: false) == .allow)
    }

    @Test func framesLoadButNeverEscalate() {
        #expect(decide("https://widget.example.net/card", mainFrame: false) == .allow)
        #expect(decide("javascript:alert(1)", mainFrame: false) == .cancel)
        #expect(decide("x-other-app://open") == .cancel)
    }

    @Test func downloads() {
        #expect(decide("blob:https://space.example.com/1234", download: true) == .download)
        #expect(decide("https://space.example.com/api/backups/1", download: true) == .download)
        #expect(decide("https://files.example.net/a.zip", download: true) == .openExternally)
        #expect(decide("file:///etc/hosts", download: true) == .cancel)
    }
}
