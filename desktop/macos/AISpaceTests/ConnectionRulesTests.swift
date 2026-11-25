import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ConnectionRulesTests {
    @Test func loopbackHosts() {
        for host in ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"] {
            #expect(ConnectionRules.isLoopback(host), "\(host)")
        }
        for host in ["127.example.com", "128.0.0.1", "10.0.0.1", "127.0.0", "127.0.0.256", "space.example.com", ""] {
            #expect(!ConnectionRules.isLoopback(host), "\(host)")
        }
    }

    @Test func defaultsTheSchemeByHost() throws {
        #expect(try ConnectionRules.normalize("127.0.0.1:8700").absoluteString == "http://127.0.0.1:8700/")
        #expect(try ConnectionRules.normalize("localhost:8700/").absoluteString == "http://localhost:8700/")
        #expect(try ConnectionRules.normalize(" space.example.com ").absoluteString == "https://space.example.com/")
    }

    @Test func dropsQueryAndFragmentAndLowercasesHost() throws {
        let url = try ConnectionRules.normalize("HTTPS://Space.Example.com/panel?lang=zh#chat")
        #expect(url.absoluteString == "https://space.example.com/panel")
    }

    @Test func refusesUnsafeAddresses() {
        #expect(throws: ConnectionURLError.empty) { try ConnectionRules.normalize("  ") }
        #expect(throws: ConnectionURLError.insecureRemote) { try ConnectionRules.normalize("http://space.example.com") }
        #expect(throws: ConnectionURLError.insecureRemote) { try ConnectionRules.normalize("http://192.168.1.5:8700") }
        #expect(throws: ConnectionURLError.credentials) { try ConnectionRules.normalize("https://op:secret@space.example.com") }
        #expect(throws: ConnectionURLError.unsupportedScheme) { try ConnectionRules.normalize("file:///Users/me") }
        #expect(throws: ConnectionURLError.unsupportedScheme) { try ConnectionRules.normalize("ftp://space.example.com") }
    }

    @Test func sameOriginUsesEffectivePorts() {
        let u = { (s: String) in URL(string: s)! }
        #expect(ConnectionRules.sameOrigin(u("https://a.example.com/x"), u("https://A.example.com:443/")))
        #expect(ConnectionRules.sameOrigin(u("http://127.0.0.1:8700/api"), u("http://127.0.0.1:8700/")))
        #expect(!ConnectionRules.sameOrigin(u("http://127.0.0.1:8700/"), u("http://127.0.0.1:8701/")))
        #expect(!ConnectionRules.sameOrigin(u("http://a.example.com/"), u("https://a.example.com/")))
        #expect(!ConnectionRules.sameOrigin(u("https://a.example.com/"), u("https://b.example.com/")))
    }

    @Test func packageAppPagesOpenInTheBrowserThroughTheirEntry() {
        let local = URL(string: "http://127.0.0.1:8700/_space/apps/model-watch")!
        let page = URL(string: "http://model-watch-2636b4ce65d27c68.localhost:8702/my%20models?kind=image#top")!
        let opened = ConnectionRules.browserURL(current: page, home: local)
        #expect(opened.absoluteString == "http://127.0.0.1:8700/_space/apps/model-watch?path=/my%2520models?kind%3Dimage")
        #expect(URLComponents(url: opened, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "/my%20models?kind=image")
        let root = URL(string: "http://model-watch-2636b4ce65d27c68.localhost:8702/")!
        #expect(ConnectionRules.browserURL(current: root, home: local) == local)
        let remote = URL(string: "https://space.example.com/_space/connections/a47b/apps/model-watch")!
        #expect(ConnectionRules.browserURL(current: URL(string: "https://x.space.example.com/models")!, home: remote).absoluteString
            == "https://space.example.com/_space/connections/a47b/apps/model-watch?path=/models")
        // Before the redirect, the entry itself.
        #expect(ConnectionRules.browserURL(current: local, home: local) == local)
        #expect(ConnectionRules.browserURL(current: nil, home: local) == local)
    }

    @Test func otherAppPagesOpenAsTheyAre() {
        let own = URL(string: "https://notes.example.com/doc/1")!
        #expect(ConnectionRules.browserURL(current: own, home: URL(string: "https://notes.example.com/")!) == own)
        let routed = URL(string: "https://space.example.com/apps/notes/doc")!
        #expect(ConnectionRules.browserURL(current: routed, home: URL(string: "https://space.example.com/apps/notes/")!) == routed)
        // A link away from an app that is not a package goes where it went.
        let away = URL(string: "https://elsewhere.example.com/")!
        #expect(ConnectionRules.browserURL(current: away, home: URL(string: "https://space.example.com/apps/notes/")!) == away)
        #expect(!ConnectionRules.isPackageEntry("/_space/apps"))
        #expect(!ConnectionRules.isPackageEntry("/_space/apps/a/b"))
        #expect(ConnectionRules.isPackageEntry("/_space/connections/c/apps/a"))
    }
}
