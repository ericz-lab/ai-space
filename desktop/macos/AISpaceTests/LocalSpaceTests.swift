import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct LocalSpaceTests {
    let identity = Data(#"{"product":"ai-space","api":1,"version":"0.3.0","edition":"server","installation":"external"}"#.utf8)

    @Test func theIdentityAnswerNamesTheProduct() {
        #expect(SpaceCheck.isSpace(status: 200, body: identity))
        #expect(!SpaceCheck.isSpace(status: 200, body: Data(#"{"product":"something-else"}"#.utf8)))
        #expect(!SpaceCheck.isSpace(status: 200, body: Data(#"{"ok":true}"#.utf8)))
        #expect(!SpaceCheck.isSpace(status: 200, body: Data("<html>".utf8)))
        #expect(!SpaceCheck.isSpace(status: 404, body: identity))
        #expect(!SpaceCheck.isSpace(status: 401, body: identity))
    }

    @Test func thePortComesFromTheEnvFile() {
        #expect(LocalSpaceRules.port(fromEnv: "SPACE_PORT=8711\n") == 8711)
        #expect(LocalSpaceRules.port(fromEnv: "# ai-space\nSPACE_NAME=mac\r\nSPACE_PORT=\"9001\"\r\nOTHER=1") == 9001)
        #expect(LocalSpaceRules.port(fromEnv: "export SPACE_PORT = '9002'  ") == 9002)
        #expect(LocalSpaceRules.port(fromEnv: "SPACE_PORT=9003 # the panel") == 9003)
        #expect(LocalSpaceRules.port(fromEnv: "SPACE_PORT=8701\nSPACE_PORT=8702\n") == 8702)
        #expect(LocalSpaceRules.port(fromEnv: "#SPACE_PORT=8711\nSPACE_PORTAL=1\nMY_SPACE_PORT=2") == nil)
        #expect(LocalSpaceRules.port(fromEnv: "SPACE_PORT=\nSPACE_PORT=abc\nSPACE_PORT=0\nSPACE_PORT=70000") == nil)
        #expect(LocalSpaceRules.port(fromEnv: "") == nil)
    }

    @Test func theEnvFileIsTheWorkspaces() {
        let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        #expect(LocalSpaceRules.envFile(environment: [:], home: home).path == "/Users/someone/.ai-space/.env")
        #expect(LocalSpaceRules.envFile(environment: ["SPACE_HOME": " "], home: home).path == "/Users/someone/.ai-space/.env")
        #expect(LocalSpaceRules.envFile(environment: ["SPACE_HOME": "/srv/space"], home: home).path == "/srv/space/.env")
    }

    @Test func candidatesAreTheWorkspacesPortThenTheDefault() {
        #expect(LocalSpaceRules.candidatePorts(envText: nil) == [8700])
        #expect(LocalSpaceRules.candidatePorts(envText: "SPACE_NAME=mac") == [8700])
        #expect(LocalSpaceRules.candidatePorts(envText: "SPACE_PORT=8711") == [8711, 8700])
        #expect(LocalSpaceRules.candidatePorts(envText: "SPACE_PORT=8700") == [8700])
    }

    @Test func theRequestAsksTheLoopbackForItsIdentity() {
        let r = LocalSpaceRules.identityRequest(port: 8711)
        #expect(r.url?.absoluteString == "http://127.0.0.1:8711/api/space")
        #expect(r.timeoutInterval == 2)
        #expect(LocalSpaceRules.url(port: 8700).absoluteString == "http://127.0.0.1:8700/")
        #expect(ConnectionRules.isLoopback(LocalSpaceRules.url(port: 8700).host ?? ""))
    }

    /// A probe over made-up ports: `answers` is what each port says.
    private func probe(env: String?, answers: [Int: (Int, Data)], asked: Asked = Asked()) -> LocalSpaceProbe {
        LocalSpaceProbe(envText: { env }, fetch: { request in
            let port = request.url?.port ?? 0
            await asked.add(port)
            return answers[port].map { (status: $0.0, body: $0.1) }
        }, sleep: { _ in await asked.slept() })
    }

    actor Asked {
        var ports: [Int] = []
        var sleeps = 0
        func add(_ port: Int) { ports.append(port) }
        func slept() { sleeps += 1 }
    }

    @Test func aSpaceOnTheDefaultPortIsFound() async {
        let found = await probe(env: nil, answers: [8700: (200, identity)]).find()
        #expect(found?.absoluteString == "http://127.0.0.1:8700/")
    }

    @Test func theWorkspacesPortIsAskedFirst() async {
        let asked = Asked()
        let found = await probe(env: "SPACE_PORT=8711", answers: [8711: (200, identity), 8700: (200, identity)], asked: asked).find()
        #expect(found?.absoluteString == "http://127.0.0.1:8711/")
        #expect(await asked.ports == [8711])
    }

    @Test func aSilentWorkspacePortFallsBackToTheDefault() async {
        let asked = Asked()
        let found = await probe(env: "SPACE_PORT=8711", answers: [8700: (200, identity)], asked: asked).find()
        #expect(found?.absoluteString == "http://127.0.0.1:8700/")
        #expect(await asked.ports == [8711, 8700])
    }

    @Test func nothingOrSomethingElseIsNotFound() async {
        #expect(await probe(env: nil, answers: [:]).find() == nil)
        #expect(await probe(env: nil, answers: [8700: (200, Data("<html>hello</html>".utf8))]).find() == nil)
        #expect(await probe(env: nil, answers: [8700: (200, Data(#"{"product":"other"}"#.utf8))]).find() == nil)
        #expect(await probe(env: nil, answers: [8700: (403, identity)]).find() == nil)
    }

    @Test func waitingGivesUpAfterItsAttempts() async {
        let asked = Asked()
        #expect(await probe(env: nil, answers: [:], asked: asked).wait(attempts: 3, interval: 0) == nil)
        #expect(await asked.ports == [8700, 8700, 8700])
        #expect(await asked.sleeps == 2)
    }

    @Test func waitingReturnsOnceTheSpaceAnswers() async {
        let asked = Asked()
        let late = LocalSpaceProbe(envText: { nil }, fetch: { [identity] _ in
            await asked.add(8700)
            return await asked.ports.count >= 3 ? (status: 200, body: identity) : nil
        }, sleep: { _ in })
        #expect(await late.wait(attempts: 30, interval: 0)?.absoluteString == "http://127.0.0.1:8700/")
        #expect(await asked.ports.count == 3)
    }
}
