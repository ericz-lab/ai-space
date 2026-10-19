import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The Local edition's contract with `space local --json` (src/space/local.ts) and the saved
/// connection's `managed` flag.
struct LocalEditionTests {
    // Decoder fixtures are synthetic paths; no installed runtime is required.
    static let dshPath = "/fixture/DeepSeek Harness.app/bin/dsh"
    static let statusJSON = """
    {"ok":true,"state":"managed","bundle":{"product":"ai-space","edition":"local","version":"0.2.0","commit":"bbbbbbbbbbbbbbbb"},
     "installed":{"product":"ai-space","edition":"local","version":"0.1.0","commit":"aaaaaaaaaaaaaaaa","path":"/x"},
     "ownership":{"managedBy":"ai-space-local"},"workspace":{"path":"/Users/u/.ai-space","exists":true,"locked":true},
     "port":8700,"url":"http://127.0.0.1:8700/","running":{"product":"ai-space","api":1,"version":"0.1.0","edition":"local","installation":"managed"},
     "service":{"label":"ai.space.local","plist":true,"loaded":true,"running":true,"disabled":false,"pid":42,"detail":"loaded/active/running"},
     "runtimes":{"claude":"/Users/u/.local/bin/claude","codex":null,"dsh":"\(dshPath)"}}
    """

    @Test func decodesStatusAndSeesAnUpdate() throws {
        let s = try LocalOutput.decode(LocalStatus.self, from: Data(Self.statusJSON.utf8))
        #expect(s.state == .managed)
        #expect(s.updateAvailable)
        #expect(s.ownServiceRunning)
        #expect(s.service.pid == 42)
        #expect(s.runtimes.claude == "/Users/u/.local/bin/claude")
        #expect(s.runtimes.codex == nil)
        #expect(s.runtimes.dsh == Self.dshPath)
        #expect(s.runtimes.any)
    }

    @Test(arguments: [#"{"claude":"/fixture/bin/claude"}"#, #"{"claude":"/fixture/bin/claude","dsh":null}"#, #"{}"#, #"{"dsh":null}"#])
    func decodesStatusWithoutDeepseek(runtimesJSON: String) throws {
        var json = try #require(JSONSerialization.jsonObject(with: Data(Self.statusJSON.utf8)) as? [String: Any])
        json["runtimes"] = try JSONSerialization.jsonObject(with: Data(runtimesJSON.utf8))
        let s = try LocalOutput.decode(LocalStatus.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(s.runtimes.dsh == nil)
        #expect(s.runtimes.codex == nil)
        #expect(s.runtimes.any == (s.runtimes.claude != nil))
    }

    @Test func freshSetupDoesNotReuseADeletedWorkspacesKeychainToken() throws {
        var s = try LocalOutput.decode(LocalStatus.self, from: Data(Self.statusJSON.utf8))
        #expect(!s.needsDeviceCredential(hasStoredToken: true))
        #expect(s.needsDeviceCredential(hasStoredToken: false))
        s.state = .absent
        s.workspace.exists = false
        #expect(s.needsDeviceCredential(hasStoredToken: true))
        s.state = .foreign
        s.workspace.exists = true
        #expect(s.needsDeviceCredential(hasStoredToken: true))
    }

    @Test func aRefusalBecomesAnErrorWithItsStatus() throws {
        let json = #"{"ok":false,"code":"foreign","error":"/Users/u/.ai-space exists and was not made by this app","status":"# + Self.statusJSON.replacingOccurrences(of: "\"managed\",\"bundle\"", with: "\"foreign\",\"bundle\"").replacingOccurrences(of: "{\"ok\":true,", with: "{") + "}"
        do {
            _ = try LocalOutput.decode(LocalStatus.self, from: Data(json.utf8))
            Issue.record("expected a refusal")
        } catch let f as LocalFailure {
            #expect(f.code == "foreign")
            #expect(f.status?.state == .foreign)
            #expect(f.errorDescription?.contains("was not made") == true)
        }
    }

    @Test func outputThatIsNotJSONIsReported() {
        #expect(throws: LocalFailure.self) { try LocalOutput.decode(LocalStatus.self, from: Data("Segmentation fault".utf8)) }
    }

    @Test func decodesAnInstallWithItsDeviceAndApps() throws {
        let json = #"{"ok":true,"apps":[{"file":"hello.spaceapp","app":"hello","version":"1.0.0","status":"installed"}],"version":"0.1.0","release":"/r","workspace":"/w","url":"http://127.0.0.1:8700/","migrated":false,"upgraded":false,"device":{"id":1,"name":"Mac","token":"spd_x"}}"#
        let r = try LocalOutput.decode(LocalInstallResult.self, from: Data(json.utf8))
        #expect(r.device?.token == "spd_x")
        #expect(r.apps.first?.status == "installed")
    }

    @Test func aConnectionSavedBeforeTheLocalEditionIsNotManaged() throws {
        let old = #"[{"id":"6F1C1B7E-3C39-4D55-9D1E-0C5C2A6B8F10","name":"Home","url":"http://127.0.0.1:8700/","isDefault":true}]"#
        let list = try JSONDecoder().decode([Connection].self, from: Data(old.utf8))
        #expect(list.first?.managed == false)
        var c = list[0]
        c.managed = true
        let again = try JSONDecoder().decode(Connection.self, from: JSONEncoder().encode(c))
        #expect(again.managed)
    }

    @Test func theDeviceSessionRequestCarriesTheToken() {
        let r = DeviceSession.request(base: URL(string: "http://127.0.0.1:8700/")!, token: "spd_abc")
        #expect(r.url?.absoluteString == "http://127.0.0.1:8700/api/auth/device/session")
        #expect(r.httpMethod == "POST")
        #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer spd_abc")
        let response = HTTPURLResponse(url: r.url!, statusCode: 200, httpVersion: nil, headerFields: ["Set-Cookie": "space_session=t0k; Path=/; Max-Age=60; HttpOnly; SameSite=Lax"])!
        let cookies = DeviceSession.cookies(from: response, base: URL(string: "http://127.0.0.1:8700/")!)
        #expect(cookies.first?.name == "space_session")
        #expect(cookies.first?.value == "t0k")
    }

    @Test func noBundleInTheClientEdition() {
        #expect(LocalBundle.find(resources: URL(fileURLWithPath: "/nonexistent")) == nil)
    }
}
