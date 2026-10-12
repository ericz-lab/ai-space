import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct SpaceHostsTests {
    let space = URL(string: "https://space.example.com/")!
    func u(_ s: String) -> URL { URL(string: s)! }

    @Test func thePanelAndTheServiceAppsBelong() {
        var catalogue = Fixture.catalogue
        catalogue.domain = nil
        let hosts = SpaceHosts(space: space, catalogue: catalogue)
        #expect(hosts.contains(u("https://space.example.com/api/apps")))
        #expect(hosts.contains(u("https://todo.example.com/items/3")))
        #expect(hosts.contains(u("https://voice.example.com/")))
        // A link app points at another site: that is Safari's, not the Space's.
        #expect(!hosts.contains(u("https://bun.sh/docs/installation")))
        #expect(!hosts.contains(u("https://example.org/")))
        #expect(!hosts.contains(u("https://bun.sh.evil.example.org/")))
    }

    @Test func theDomainCoversItsHttpsHostsOnly() {
        let hosts = SpaceHosts(space: space, pages: [], domain: "example.com")
        #expect(hosts.contains(u("https://new-app.example.com/")))
        #expect(hosts.contains(u("https://example.com/")))
        #expect(!hosts.contains(u("http://new-app.example.com/")))
        #expect(!hosts.contains(u("https://new-app.example.com:8443/")))
        #expect(!hosts.contains(u("https://example.com.evil.org/")))
        #expect(!hosts.contains(u("https://notexample.com/")))
    }

    @Test func aDomainTheSpaceIsNotUnderIsIgnored() {
        #expect(!SpaceHosts(space: u("https://space.other.net/"), domain: "example.com").contains(u("https://a.example.com/")))
        #expect(!SpaceHosts(space: u("http://127.0.0.1:8700/"), domain: "example.com").contains(u("https://a.example.com/")))
    }

    @Test func originsCompareSchemeHostAndPort() {
        let hosts = SpaceHosts(space: u("http://127.0.0.1:8700/"), pages: [u("http://127.0.0.1:8801/")])
        #expect(hosts.contains(u("http://127.0.0.1:8700/x")))
        #expect(hosts.contains(u("http://127.0.0.1:8801/")))
        #expect(!hosts.contains(u("http://127.0.0.1:9999/")))
        #expect(!hosts.contains(u("https://127.0.0.1:8700/")))
        #expect(!hosts.contains(u("mailto:someone@example.com")))
        #expect(SpaceHosts(space: space).contains(u("https://SPACE.example.com:443/")))
    }
}

struct MobileNavigationTests {
    let space = URL(string: "https://space.example.com/")!
    var hosts: SpaceHosts { SpaceHosts(space: space, catalogue: Fixture.catalogue) }

    func decide(_ url: String, mainFrame: Bool = true, link: Bool = false, newWindow: Bool = false,
                download: Bool = false, fromSpace: Bool = true) -> NavigationDecision {
        MobileNavigation.decide(NavigationRequest(
            url: URL(string: url)!, isMainFrame: mainFrame, isLinkActivation: link, opensNewWindow: newWindow,
            shouldDownload: download, fromConnectionPage: fromSpace), hosts: hosts, space: space)
    }

    @Test func spacePagesStayInTheView() {
        #expect(decide("https://todo.example.com/items/3", link: true) == .allow)
        #expect(decide("https://space.example.com/", link: true) == .allow)
        // From one app to another of the same Space.
        #expect(decide("https://reader.example.com/a", link: true) == .allow)
        #expect(decide("https://later.example.com/", link: true) == .allow)
    }

    @Test func tappedLinksToOtherSitesLeaveForSafari() {
        #expect(decide("https://news.ycombinator.com/", link: true) == .openExternally)
        #expect(decide("https://news.ycombinator.com/", newWindow: true) == .openExternally)
        #expect(decide("mailto:someone@example.org", link: true) == .openExternally)
        #expect(decide("tel:10086") == .cancel)
        #expect(decide("javascript:alert(1)") == .cancel)
    }

    @Test func theSignInRedirectStaysInTheView() {
        // The access layer answers a Space page with a redirect to its login; no one tapped a link.
        #expect(decide("https://team.cloudflareaccess.com/cdn-cgi/access/login/todo.example.com") == .allow)
        // On the login pages themselves, links and forms keep working until the Space is back.
        #expect(decide("https://accounts.example.org/next", link: true, fromSpace: false) == .allow)
        #expect(decide("https://todo.example.com/", fromSpace: false) == .allow)
    }

    @Test func framesAndDownloads() {
        #expect(decide("https://player.example.org/embed", mainFrame: false) == .allow)
        #expect(decide("https://todo.example.com/export.csv", link: true, download: true) == .download)
        #expect(decide("https://files.example.org/x.zip", link: true, download: true) == .openExternally)
    }

    @Test func aNewWindowForASpacePageLoadsInTheSameView() {
        #expect(decide("https://todo.example.com/print", newWindow: true) == .openExternally)
        #expect(MobileNavigation.external(URL(string: "https://todo.example.com/print")!, hosts: hosts) == .sameView)
        #expect(MobileNavigation.external(URL(string: "https://example.org/")!, hosts: hosts) == .browser)
    }
}
