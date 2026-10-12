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
}
