import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct OmniboxTests {
    static let action = """
    {"id":"todo/create","peer":"seoul","title":"Create todo","effect":"write","available":true,"inputs":[
    {"name":"title","type":"text","label":"Title","required":true},
    {"name":"date","type":"date","label":"Date","default":"tomorrow"},
    {"name":"time","type":"time","label":"Time"},
    {"name":"count","type":"number","label":"Count","min":1,"max":10},
    {"name":"kind","type":"choice","label":"Kind","options":[{"value":"work","label":"Work"}]}]}
    """
    @Test func parsesResolutionWithoutLosingPeerOrAmbiguity() throws {
        let data = Data("""
        {"ok":true,"ambiguous":true,"intents":[{"kind":"action","key":"seoul:todo/create","strong":true,"action":\(Self.action),"args":{"title":"Report","time":"15:00"}}],"agentIntents":[{"id":"news","title":"News","agent":"news/curator","available":false,"reason":"Missing skill"}]}
        """.utf8)
        let result = try Hub.decode(ShortcutResolution.self, from: data)
        #expect(result.ambiguous)
        #expect(result.intents.first?.action?.peer == "seoul")
        #expect(result.intents.first?.args?["time"] == .string("15:00"))
        #expect(result.agentIntents.first?.available == false)
    }
    @Test func formsPreserveCalendarValuesAndValidateNumbersAndOptions() throws {
        let action = try Hub.decode(ShortcutAction.self, from: Data(Self.action.utf8))
        var values = action.initial(["title": .string("Report"), "time": .string("15:00")])
        #expect(values["date"] == "tomorrow")
        #expect(action.valid(values))
        #expect(action.payload(values)["date"] as? String == "tomorrow")
        #expect(action.payload(values)["time"] as? String == "15:00")
        values["count"] = "nan"
        #expect(!action.valid(values))
        values["count"] = "11"
        #expect(!action.valid(values))
        values["count"] = "2.5"
        #expect(action.valid(values))
        #expect(action.payload(values)["count"] as? Double == 2.5)
        values["kind"] = "missing"
        #expect(!action.valid(values))
        values["kind"] = "work"
        values["title"] = " "
        #expect(!action.valid(values))
    }
    @Test func readsEveryResultKindAndUnknownOutcomes() throws {
        for result in [
            "{\"kind\":\"value\",\"value\":12.5,\"text\":\"12.5 USD\",\"stale\":true}",
            "{\"kind\":\"list\",\"items\":[{\"title\":\"News\",\"url\":\"https://example.com\"}]}",
            "{\"kind\":\"receipt\",\"items\":[{\"id\":\"1\",\"title\":\"Created\"}]}",
            "{\"kind\":\"task\",\"taskId\":\"daily\",\"task\":\"Daily\",\"status\":\"running\"}"
        ] {
            let run = try Hub.decode(ShortcutRun.self, from: Data("""
            {"id":1,"title":"Action","status":"unknown","effect":"write","createdAt":"2026-10-17T00:00:00.000Z","result":\(result)}
            """.utf8))
            #expect(run.status == "unknown")
            #expect(run.result != nil)
        }
    }
    @Test func localNamesRankAheadOfDescriptions() {
        let notes = CatalogueEntry(kind: .app, ref: "notes", title: "Notes", reach: .up)
        let todo = CatalogueEntry(kind: .app, ref: "todo", title: "Todo", detail: "notes on tasks", reach: .up)
        #expect(OmniboxRules.rank("notes", [todo, notes]).first?.ref == "notes")
        #expect(OmniboxRules.opensByDefault("notes", notes))
        #expect(!OmniboxRules.opensByDefault("tasks", todo))
    }
}

@MainActor
struct OmniboxStoreTests {
    private var api: SpaceAPI { SpaceAPI(base: URL(string: "https://space.example")!, cookies: { [] }) }

    @Test func transportRetryKeepsTheOriginalRequestAndCannotDoubleSubmit() async throws {
        let action = try Hub.decode(ShortcutAction.self, from: Data(OmniboxTests.action.utf8))
        var bodies: [[String: Any]] = []
        let execution = ShortcutExecution(api: api, action: action, args: ["title": .string("Report")], send: { _, body in
            bodies.append(body)
            if bodies.count == 1 { throw URLError(.networkConnectionLost) }
            return Data("""
            {"run":{"id":7,"title":"Report","status":"ok","effect":"write","createdAt":"2026-10-17T00:00:00.000Z"}}
            """.utf8)
        })
        execution.submit()
        execution.submit()
        while execution.busy { await Task.yield() }
        #expect(bodies.count == 1)
        #expect(execution.error != nil)
        execution.values["title"] = "Changed after timeout"
        execution.submit()
        while execution.busy { await Task.yield() }
        #expect(bodies.count == 2)
        #expect(bodies[0]["requestId"] as? String == bodies[1]["requestId"] as? String)
        #expect((bodies[1]["args"] as? [String: Any])?["title"] as? String == "Report")
        #expect(bodies[1]["peer"] as? String == "seoul")
        #expect(execution.run?.id == 7)
        #expect(!execution.canSubmit)
    }

    @Test func rejectedCalendarInputCanBeCorrected() async throws {
        let action = try Hub.decode(ShortcutAction.self, from: Data(OmniboxTests.action.utf8))
        let execution = ShortcutExecution(api: api, action: action, args: ["title": .string("Report"), "date": .string("invalid")], send: { _, _ in
            throw SpaceAPIError.http(400, "Invalid date")
        })
        execution.submit()
        while execution.busy { await Task.yield() }
        #expect(!execution.hasSubmitted)
        #expect(execution.canSubmit)
        #expect(execution.error != nil)
    }

    @Test func lateResolutionCannotReplaceNewText() async throws {
        var firstStarted = false
        let store = OmniboxStore(api: api, send: { _, body in
            let text = body["text"] as! String
            if text == "old" {
                firstStarted = true
                try await Task.sleep(nanoseconds: 350_000_000)
            }
            return Data("""
            {"intents":[],"agentIntents":[{"id":"\(text)","title":"\(text)","agent":"news/curator","available":true}],"ambiguous":false}
            """.utf8)
        })
        let old = Task { await store.resolve("old") }
        while !firstStarted { await Task.yield() }
        await store.resolve("new")
        await old.value
        #expect(store.resolvedText == "new")
        #expect(store.resolution?.agentIntents.first?.id == "new")
        #expect(!store.resolving)
        await store.resolve("")
        #expect(store.resolution == nil)
    }

    @Test func cancellationDuringDebounceDoesNotRequestAnything() async {
        var calls = 0
        let store = OmniboxStore(api: api, send: { _, _ in calls += 1; return Data() })
        let task = Task { await store.resolve("todo") }
        task.cancel()
        await task.value
        #expect(calls == 0)
        #expect(store.error == nil)
    }
}
