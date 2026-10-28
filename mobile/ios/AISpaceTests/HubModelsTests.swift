import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct HubModelsTests {
    static let tasks = """
    {"ok":true,"tasks":[
      {"id":"t1","app":"todo","name":"backup","source":"manifest","orphaned":false,"enabled":true,
       "schedule":{"kind":"cron","expr":"8 3 * * *"},"target":{"kind":"command","command":"x","env":{"A":"b"}},
       "modelSelectable":false,"timeoutMs":1800000,"triggers":[],"overrides":{},
       "state":{"lastRunAt":"2026-10-13T03:08:00.000Z","lastStatus":"ok","lastDurationMs":812,"consecutiveErrors":0}},
      {"id":"t2","app":"reader","name":"digest","source":"api","orphaned":false,"enabled":true,
       "schedule":{"kind":"every","everyMs":900000},"target":{"kind":"agent"},"modelSelectable":true,
       "triggers":[{"event":"reader/article.saved","debounceMs":5000}],"overrides":{"model":"codex/basic"},"model":"codex/basic","base":{"model":"claude/junior"},
       "state":{"lastStatus":"error","lastError":"boom","consecutiveErrors":3,"pending":{"events":2}}},
      {"id":"t3","app":"reader","name":"paused","enabled":false,"schedule":{"kind":"manual"},"state":{"lastStatus":"error","consecutiveErrors":1}},
      {"id":"t4","app":"gone","name":"old","orphaned":true,"enabled":true,"schedule":{"kind":"manual"}},
      {"id":"t5","app":"todo","name":"live","enabled":true,"schedule":{"kind":"manual"},"state":{"runningAt":"2026-10-13T03:08:00.000Z","lastStatus":"ok"}},
      {"id":"t6","app":"todo","name":"new","schedule":{"kind":"at","at":"2026-11-01T00:00:00.000Z"}},
      {"name":"no id"}
    ]}
    """

    @Test func readsTasksAndTheirStates() throws {
        let tasks = try Hub.rows(SpaceTask.self, "tasks", from: Data(Self.tasks.utf8))
        // A row without an id is skipped, the rest are kept.
        #expect(tasks.map(\.id) == ["t1", "t2", "t3", "t4", "t5", "t6"])
        #expect(tasks.map(\.status) == [.ok, .error(3), .off, .orphaned, .running, .neverRan])
        #expect(tasks.filter(\.isActive).count == 4)
        #expect(tasks.filter(\.isFailing).map(\.id) == ["t2"])
        #expect(tasks[1].triggers?.map(\.event) == ["reader/article.saved"])
        #expect(tasks[1].overrides?.isEmpty == false)
        #expect(tasks[0].overrides?.isEmpty == true)
        #expect(tasks[1].state?.pending?.events == 2)
    }

    @Test func offersATaskOnlyTheModelsItsKindCanRun() throws {
        let options = try Hub.rows(ModelChoice.self, "models", from: Data("""
        {"ok":true,"models":[
          {"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku","capabilities":{"complete":true,"agent":true}},
          {"value":"slim/basic","runtime":"slim","tier":"basic","model":"luna","capabilities":{"complete":true,"agent":false}}
        ]}
        """.utf8))
        let tasks = try Hub.rows(SpaceTask.self, "tasks", from: Data(Self.tasks.utf8))
        #expect(tasks[1].eligible(options).map(\.value) == ["claude/basic"])
        #expect(tasks[0].eligible(options).map(\.value) == ["claude/basic", "slim/basic"])
        #expect(options[0].label == "claude · Basic · haiku")
    }

    @Test func greysAChoiceThatCannotBePicked() throws {
        let options = try Hub.rows(ModelChoice.self, "options", from: Data("""
        {"ok":true,"options":[
          {"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku"},
          {"value":"codex/basic","runtime":"codex","tier":"basic","model":"luna","unavailable":"signed-out"},
          {"value":"david:claude/basic","runtime":"david:claude","tier":"basic","model":"haiku","unavailable":"offline"}
        ]}
        """.utf8))
        #expect(options.map(\.isAvailable) == [true, false, false])
        #expect(options[0].shownLabel == "claude · Basic · haiku")
        #expect(options[1].shownLabel == "codex · Basic · luna (not signed in)")
        #expect(options[2].shownLabel.hasSuffix("(offline)"))
        #expect(ModelChoiceText.saved("old/basic") == "old/basic (not available)")

        let prefs = try JSONDecoder().decode(ModelPreferences.self, from: Data("""
        {"defaultModel":"codex/basic","options":[{"value":"claude/basic","runtime":"claude"},{"value":"codex/basic","runtime":"codex","unavailable":"signed-out"}]}
        """.utf8))
        #expect(prefs.canPick("claude/basic"))
        #expect(prefs.canPick(""))
        #expect(!prefs.canPick("codex/basic"))
        #expect(!prefs.canPick("gone/basic"))
    }

    @Test func aMissingKeyIsAnEmptyList() throws {
        #expect(try Hub.rows(TaskRun.self, "runs", from: Data(#"{"ok":true}"#.utf8)).isEmpty)
        let runs = try Hub.rows(TaskRun.self, "runs", from: Data(#"{"runs":[{"id":7,"taskId":"t1","startedAt":1000,"endedAt":3500,"status":"ok","trigger":"event","eventIds":[1,2]}]}"#.utf8))
        #expect(runs.first?.durationMs == 2500)
        #expect(runs.first?.eventIds == [1, 2])
    }

    @Test func readsModelUsageWithItsRowsAndWeeks() throws {
        let usage = try Hub.decode(ModelUsage.self, from: Data("""
        {"ok":true,"window":"24h","backend":"local","totals":{"calls":10,"errors":1,"tokens":1500,"costUsd":0.5,"durationMs":2000},
         "byTag":[{"calls":7,"tokens":1000,"app":"todo","tag":"plan","model":"haiku"},{"calls":3,"tokens":500,"app":"reader","tag":"digest","model":"sonnet"}],
         "byModel":[{"calls":7,"tokens":1000,"model":"haiku"}],
         "history":{"firstAt":"2026-10-01T00:00:00.000Z","totals":{"calls":40,"tokens":9000},
           "days":[{"day":"2026-10-05","tokens":100},{"day":"2026-10-11","tokens":200},{"day":"2026-10-12","tokens":300},{"day":"bad","tokens":9}]}}
        """.utf8))
        #expect(usage.totals.calls == 10)
        #expect(usage.byTag?.elements.map(\.app) == ["todo", "reader"])
        #expect(usage.byTag?.elements.first?.totals.tokens == 1000)
        // 2026-10-05 is a Monday: the 5th and the 11th share a week, the 12th starts the next.
        #expect(usage.weekly(\.tokens).map(\.value) == [300, 300])
        #expect(usage.daysRecorded(now: ISO8601.parse("2026-10-13T12:00:00.000Z")!) == 13)
    }

    @Test func readsAHubsUsageWithItsPeersCalls() throws {
        let usage = try Hub.decode(ModelUsage.self, from: Data("""
        {"ok":true,"window":"24h","backend":"local","space":"home","totals":{"calls":2},
         "byTag":[{"calls":1,"app":"david/draw","tag":"image","model":"gpt-6-luna","machine":"david"},{"calls":1,"app":"todo","tag":"plan","model":"haiku"}],
         "byModel":[{"calls":1,"model":"gpt-6-luna","machine":"david"}],
         "peers":[{"name":"david","ok":true},{"name":"lab","ok":false,"asOf":"2026-10-27T01:00:00.000Z","error":"timeout"},{"name":"old","ok":false,"error":"no ledger"}]}
        """.utf8))
        #expect(usage.space == "home")
        #expect(usage.byTag?.elements.map(\.modelOn) == ["david:gpt-6-luna", "haiku"])
        #expect(usage.byModel?.elements.first?.modelOn == "david:gpt-6-luna")
        #expect(usage.peersOff.map(\.name) == ["lab", "old"])
        #expect(usage.peersOff.first?.asOf != nil)

        let calls = try Hub.rows(ModelCall.self, "calls", from: Data("""
        {"ok":true,"calls":[
          {"id":7,"app":"david/draw","model":"gpt-6-luna","machine":"david","peer":"david","origin":"peer","status":"ok"},
          {"id":7,"app":"todo","model":"haiku","status":"error","error":"boom"}
        ]}
        """.utf8))
        #expect(calls.map(\.modelOn) == ["david:gpt-6-luna", "haiku"])
        // The same id from two ledgers stays two rows.
        #expect(Set(calls.map(\.key)).count == 2)

        let labels = try Hub.rows(AppLabel.self, "apps", from: Data(#"{"apps":[{"id":"david/draw","name":"draw","title":"Draw"},{"name":"todo","title":"Todo"}]}"#.utf8))
        #expect(labels.map { $0.id ?? $0.name } == ["david/draw", "todo"])
    }

    @Test func drawsAppUsageByTimeWhenMeasuredAndByOpensOtherwise() throws {
        let rows = try Hub.rows(AppUsageRow.self, "usage", from: Data("""
        {"ok":true,"usage":[
          {"kind":"app","key":"todo","opens":4,"activeMs":120000,"sessions":4,"lastAt":"2026-10-13T02:00:00.000Z","daily":[{"day":"2026-10-12","opens":1,"activeMs":60000},{"day":"2026-10-13","opens":3,"activeMs":60000}]},
          {"kind":"agent","key":"space/assistant","opens":2,"activeMs":null,"sessions":0,"lastAt":null,"daily":[{"day":"2026-10-13","opens":2,"activeMs":0}]}
        ]}
        """.utf8))
        let now = ISO8601.parse("2026-10-13T12:00:00.000Z")!
        #expect(rows[0].spark(days: 3, now: now) == [0, 60000, 60000])
        #expect(rows[1].spark(days: 3, now: now) == [0, 0, 2])
        #expect(rows[0].averageMs == 30000)
        #expect(rows[1].averageMs == nil)
        #expect(rows[1].id == "agent:space/assistant")
    }

    @Test func readsAPeersAppModelsOrWhyThereAreNone() {
        let fine = PeerAppModels.read(peer: "david", data: Data(#"{"ok":true,"apps":[{"app":"draw","rows":[{"tag":null,"model":"codex/basic","source":"default"}]}],"options":[{"value":"codex/basic","runtime":"codex","tier":"basic","model":"luna"}]}"#.utf8))
        #expect(fine.apps?.map(\.app) == ["draw"])
        #expect(fine.options?.map(\.value) == ["codex/basic"])
        #expect(!fine.isLoading && !fine.old && fine.error == nil)
        // An older core answers with its page.
        #expect(PeerAppModels.read(peer: "david", data: Data("<!doctype html><title>ai-space</title>".utf8)).old)
        #expect(PeerAppModels.read(peer: "david", data: Data(#"{"ok":false,"error":"timeout"}"#.utf8)).error == "timeout")
        #expect(PeerAppModels(peer: "david").isLoading)
        #expect(PeerAppModels.isOlderCore(status: 404, error: "not found"))
        #expect(!PeerAppModels.isOlderCore(status: 404, error: "unknown peer: david"))
        #expect(!PeerAppModels.isOlderCore(status: 502, error: "bad gateway"))
    }

    @Test func readsAppModelsEventsAndPackages() throws {
        let models = try Hub.rows(AppModelRows.self, "apps", from: Data(#"{"apps":[{"app":"notes","rows":[{"tag":null,"model":"codex/basic","source":"default"},{"tag":"image","manifest":"codex/intermediate","override":"claude/basic","model":"claude/basic","source":"override-tag"}]}]}"#.utf8))
        #expect(models[0].rows.map(\.id) == ["", "image"])
        #expect(models[0].rows[1].override == "claude/basic")

        let events = try Hub.rows(SpaceEvent.self, "events", from: Data(#"{"events":[{"id":5,"name":"a/b.changed","app":"a","at":"2026-10-13T03:42:58.228Z","data":{"to":23769,"from":1.5,"counts":{"binding":1},"assets":[],"who":"me","on":true}}]}"#.utf8))
        #expect(events[0].preview == #"assets: [] · counts: {"binding":1} · from: 1.5 · on: true"#)

        let catalogue = try Hub.decode(PackageCatalogue.self, from: Data(#"{"spaceId":"c551","apps":[],"remotes":[{"connectionId":"3b06","spaceId":"0d8c","available":true,"apps":[{"app":"voice","title":"Voice","version":"0.1.0","page":true,"url":"/_space/x"}]}]}"#.utf8))
        #expect(catalogue.remotes?.elements.first?.apps?.elements.first?.title == "Voice")
        let links = try Hub.rows(SpaceLink.self, "connections", from: Data(#"{"connections":[{"id":"3b06","remoteSpaceId":"0d8c","direction":"outgoing","apps":[],"enabled":true,"connected":true}]}"#.utf8))
        #expect(links.first?.connected == true)
    }

    @Test func readsTheInboxAndItsFilters() throws {
        let items = try Hub.rows(InboxThread.self, "items", from: Data(#"{"items":[{"thread":"n1","app":"trade","level":"alert","text":"first line\nsecond","count":3,"firstAt":"2026-10-13T03:33:34.175Z","lastAt":"2026-10-13T03:40:00.000Z","action":true,"unread":true,"done":false},{"thread":"n2","app":"trade","title":"Titled","text":"body"}]}"#.utf8))
        #expect(items.map(\.heading) == ["first line", "Titled"])
        #expect(InboxFilter.allCases.map(\.query) == ["filter=all", "filter=unread", "filter=open&action=1", "filter=done"])
        #expect(InboxThread.firstLine(String(repeating: "x", count: 200)).count == 140)
    }

    @Test func findsAnAgentsChatRoute() {
        #expect(ChatRoute.base(ref: "space/assistant", peer: nil) == "/api/agents/space/assistant")
        #expect(ChatRoute.base(ref: "david/ai-draw/illustrator", peer: "david") == "/api/peers/david/agents/ai-draw/illustrator")
        #expect(ChatRoute.base(ref: "broken", peer: nil) == nil)
    }

    @Test func writesFiguresAsThePanelDoes() {
        #expect(HubFormat.tokens(nil) == "–")
        #expect(HubFormat.tokens(999) == "999")
        #expect(HubFormat.tokens(1234) == "1.2K")
        #expect(HubFormat.tokens(12345) == "12K")
        #expect(HubFormat.tokens(1_234_567) == "1.23M")
        #expect(HubFormat.tokens(12_345_678) == "12.3M")
        #expect(HubFormat.tokens(2_689_400_000) == "2.69B")
        #expect(HubFormat.cost(nil) == "–")
        #expect(HubFormat.cost(0.0021) == "$0.002")
        #expect(HubFormat.cost(5.749) == "$5.75")
        #expect(HubFormat.cost(123.4) == "$123")
        #expect(HubFormat.duration(ms: 812) == "812 ms")
        #expect(HubFormat.duration(ms: nil) == "–")
    }
}
