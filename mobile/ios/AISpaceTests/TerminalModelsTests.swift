import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct TerminalModelsTests {
    static let status = """
    {"ok":true,"enabled":true,"backend":"python","shell":"/bin/zsh -l","passphrase":true,"idleMs":1800000,"maxSessions":4,"active":1,
     "machines":[{"name":"seoul","enabled":true,"health":"ok"},{"name":"david","peer":"david","enabled":true,"health":"ok"},
                 {"name":"attic","peer":"attic","enabled":false,"health":"ok"},{"name":"away","peer":"away","enabled":true,"health":"down"}],
     "sessions":[{"id":"b"}],
     "recent":[{"id":"b","startedAt":1791948031365,"agent":"x","bytesIn":3,"bytesOut":9,"cols":52,"rows":47},
               {"id":"a","startedAt":1791947976587,"endedAt":1791947983947,"exitCode":null,"reason":"closed","agent":"x","bytesIn":114,"bytesOut":446,"cols":52,"rows":47},
               {"id":"z","startedAt":1791947000000,"endedAt":1791947060000,"exitCode":2,"reason":"exit","agent":"x","bytesIn":1,"bytesOut":2}]}
    """

    @Test func readsTheMachinesAndWhatRan() throws {
        let s = try JSONDecoder().decode(TerminalStatus.self, from: Data(Self.status.utf8))
        #expect(s.enabled && s.passphrase)
        #expect(s.machines.map(\.name) == ["seoul", "david", "attic", "away"])
        // The Space's own machine has no peer; one that is off or down is listed and cannot open.
        #expect(s.machines.map(\.canOpen) == [true, true, false, false])
        #expect(s.machines[0].peer == nil)
        #expect(s.recent.map(\.isOpen) == [true, false, false])
        #expect(s.recent[1].exitCode == nil && s.recent[1].reason == "closed")
        #expect(s.recent[2].exitCode == 2 && s.recent[2].duration == 60)
    }

    @Test func aSpaceWithoutATerminalReadsAsOff() throws {
        let s = try JSONDecoder().decode(TerminalStatus.self, from: Data(#"{"ok":true}"#.utf8))
        #expect(!s.enabled && s.machines.isEmpty && s.recent.isEmpty)
    }

    @Test func routesFollowTheMachine() {
        let own = TerminalMachine(name: "seoul")
        let peer = TerminalMachine(name: "my box", peer: "my box")
        #expect(TerminalRoute.sessions(own) == "/api/terminal/sessions")
        #expect(TerminalRoute.sessions(peer) == "/api/peers/my%20box/terminal/sessions")
        #expect(TerminalRoute.socket(own, ticket: "a+b/c=", space: URL(string: "https://space.example.com/")!)?.absoluteString
            == "wss://space.example.com/api/terminal/ws?ticket=a+b/c%3D")
        #expect(TerminalRoute.socket(peer, ticket: "t", space: URL(string: "http://127.0.0.1:8700")!)?.absoluteString
            == "ws://127.0.0.1:8700/api/peers/my%20box/terminal/ws?ticket=t")
        #expect(TerminalRoute.resize(cols: 52, rows: 47) == #"{"type":"resize","cols":52,"rows":47}"#)
    }

    @Test func theAnswerToOpeningASession() {
        func read(_ status: Int, _ body: String) -> TerminalTicket { TerminalTicket.read(status: status, data: Data(body.utf8)) }
        #expect(read(200, #"{"ok":true,"id":"s","ticket":"abc","expiresIn":30}"#) == .ticket("abc"))
        // The terminal's own 401 is about the passphrase; the access layer's is a sign-in.
        #expect(read(401, #"{"ok":false,"error":"passphrase required"}"#) == .passphrase("passphrase required"))
        #expect(read(401, #"{"ok":false,"error":"passphrase wrong"}"#) == .passphrase("passphrase wrong"))
        #expect(read(401, "<html>login</html>") == .signIn)
        #expect(read(302, "") == .signIn)
        #expect(read(403, "<html>forbidden</html>") == .signIn)
        #expect(read(403, #"{"ok":false,"error":"cross-origin request refused"}"#) == .refused("cross-origin request refused"))
        #expect(read(404, #"{"ok":false,"error":"terminal is not enabled (SPACE_TERMINAL_ENABLED)"}"#) == .refused("terminal is not enabled (SPACE_TERMINAL_ENABLED)"))
        #expect(read(429, #"{"ok":false,"error":"too many wrong passphrases; try again in a minute"}"#) == .refused("too many wrong passphrases; try again in a minute"))
        #expect(read(502, "") == .refused("HTTP 502"))
        #expect(read(200, #"{"ok":true}"#) == .refused("no ticket"))
    }

    @Test func controlMessages() {
        #expect(TerminalControl.read(#"{"type":"ready","id":"s","backend":"python","shell":"/bin/zsh","idleMs":1800000}"#) == .ready)
        #expect(TerminalControl.read(#"{"type":"exit","code":0}"#) == .exit(code: 0, detail: nil))
        #expect(TerminalControl.read(#"{"type":"exit","code":null,"detail":"no such shell"}"#) == .exit(code: nil, detail: "no such shell"))
        #expect(TerminalControl.read(#"{"type":"error","error":"boom"}"#) == .error("boom"))
        #expect(TerminalControl.read(#"{"type":"closed","reason":"idle"}"#) == .closed(reason: "idle"))
        #expect(TerminalControl.read(#"{"type":"pong"}"#) == nil)
        #expect(TerminalControl.read("not json") == nil)
    }
}
