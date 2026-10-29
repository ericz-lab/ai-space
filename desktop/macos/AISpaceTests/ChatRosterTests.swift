import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ChatRosterTests {
    let a = UUID(), b = UUID(), c = UUID(), d = UUID(), e = UUID(), f = UUID()

    func item(_ id: UUID, sid: String? = nil, run: String? = nil, busy: Bool = false, messages: Bool = true,
              composing: Bool = false, title: String? = nil, shown: Int = 0, opened: Int = 0) -> ChatRoster.Item {
        ChatRoster.Item(id: id, sessionID: sid, runID: run, busy: busy, hasMessages: messages,
                        composing: composing, title: title, shown: shown, opened: opened)
    }

    func run(_ id: String, agent: String = "ai-design/designer", status: String = "running", at: Double = 0,
             sessionId: String? = nil, sid: String? = nil) -> ChatRun {
        ChatRun(id: id, agent: agent, message: "draw \(id)", status: status, startedAt: at, lastSeq: 0, sessionId: sessionId, sid: sid)
    }

    // MARK: New Conversation

    @Test func newConversationKeepsAnEmptyOneOnShow() {
        #expect(ChatRoster.blankConversation([item(a, messages: false, composing: true)], current: a) == a)
    }

    @Test func newConversationOpensAnotherWhileTheOneOnShowRuns() {
        // A busy conversation is never reused, even before its first reply.
        #expect(ChatRoster.blankConversation([item(a, busy: true, messages: false)], current: a) == nil)
        #expect(ChatRoster.blankConversation([item(a, busy: true)], current: a) == nil)
    }

    @Test func newConversationGoesToAnEmptyOneAlreadyOpen() {
        let items = [item(a), item(b, messages: false, shown: 1), item(c, messages: false, shown: 3)]
        #expect(ChatRoster.blankConversation(items, current: a) == c)
    }

    @Test func aStoredSessionAlreadyOpenIsShownNotLoadedAgain() {
        let items = [item(a, sid: "s1"), item(b, sid: "s2")]
        #expect(ChatRoster.showing("s2", in: items) == b)
        #expect(ChatRoster.showing("s3", in: items) == nil)
    }

    // MARK: Following turns that run on the Space

    @Test func eachRunningTurnGetsAConversationOldestFirst() {
        let items = [item(a, messages: false)]
        let plan = ChatRoster.attachments(runs: [run("r2", at: 2), run("r1", at: 1)], agent: "ai-design/designer",
                                          items: items, current: a, followed: [])
        // The empty conversation on show takes the oldest; the next needs a new one.
        #expect(plan.map(\.run.id) == ["r1", "r2"])
        #expect(plan.map(\.into) == [a, nil])
    }

    @Test func aTurnAlreadyFollowedOrOfAnotherAgentOrOverIsLeft() {
        let runs = [run("mine"), run("other", agent: "product-desk/pm"), run("done", status: "done")]
        let plan = ChatRoster.attachments(runs: runs, agent: "ai-design/designer", items: [item(a)], current: a, followed: ["mine"])
        #expect(plan.isEmpty)
    }

    @Test func nothingIsFollowedWhileATurnSentHereHasNoRunYet() {
        // The list may already hold the run that turn started: following it would show it twice.
        let items = [item(a, busy: true), item(b, messages: false)]
        let plan = ChatRoster.attachments(runs: [run("r1")], agent: "ai-design/designer", items: items, current: b, followed: [])
        #expect(plan.isEmpty)
    }

    @Test func aTurnInASessionOpenHereGoesIntoThatConversation() {
        let items = [item(a, sid: "s1", shown: 2), item(b, messages: false)]
        let byResumed = ChatRoster.attachments(runs: [run("r1", sessionId: "s1")], agent: "ai-design/designer", items: items, current: b, followed: [])
        #expect(byResumed.map(\.into) == [a])
        let byNamed = ChatRoster.attachments(runs: [run("r1", sid: "s1")], agent: "ai-design/designer", items: items, current: b, followed: [])
        #expect(byNamed.map(\.into) == [a])
    }

    @Test func aBusyOrWrittenInConversationTakesNoOtherTurn() {
        let items = [item(a, sid: "s1", run: "r0", busy: true), item(b, messages: false, composing: true)]
        let plan = ChatRoster.attachments(runs: [run("r1", sessionId: "s1")], agent: "ai-design/designer", items: items, current: b, followed: ["r0"])
        #expect(plan.map(\.into) == [nil])
    }

    // MARK: Letting go

    @Test func theOneOnShowBusyOnesAndUnsentTextStay() {
        let items = [item(a, messages: false), item(b, busy: true), item(c, composing: true, shown: 0), item(d, messages: false, composing: true)]
        // An empty conversation goes even with a draft: New Conversation would have reused it.
        #expect(ChatRoster.pruned(items, current: a, keep: 0) == [d])
    }

    @Test func onlyTheIdleConversationsShownLastStay() {
        let items = [item(a, shown: 9), item(b, shown: 1), item(c, shown: 4), item(d, shown: 2), item(e, messages: false, shown: 8), item(f, shown: 3)]
        #expect(ChatRoster.pruned(items, current: a, keep: 2) == [b, d, e])
    }

    // MARK: The sidebar

    @Test func openConversationsNotStoredYetComeFirstThenTheHistory() {
        let items = [
            item(a, busy: true, title: "Landing page", opened: 1),
            item(b, busy: true, title: "Login page", opened: 2),
            item(c, sid: "s1", busy: true, opened: 0),
            item(d, messages: false, opened: 3),
        ]
        let sessions = [ChatSessionInfo(sid: "s1", title: "Pricing", ts: 20), ChatSessionInfo(sid: "s2", title: "", ts: 10)]
        let rows = ChatRoster.rows(items, sessions: sessions, runs: [], agent: "ai-design/designer")
        #expect(rows.map(\.id) == ["c:\(b.uuidString)", "c:\(a.uuidString)", "s:s1", "s:s2"])
        #expect(rows.map(\.busy) == [true, true, true, false])
        #expect(rows[2].conversation == c)
        #expect(rows[3].conversation == nil)
        #expect(rows[3].title == nil)
    }

    @Test func aSessionRunningOnAnotherClientIsMarkedBusy() {
        let sessions = [ChatSessionInfo(sid: "s1"), ChatSessionInfo(sid: "s2"), ChatSessionInfo(sid: "s3")]
        let runs = [run("r1", sessionId: "s1"), run("r2", sid: "s2"), run("r3", agent: "product-desk/pm", sessionId: "s3")]
        let rows = ChatRoster.rows([], sessions: sessions, runs: runs, agent: "ai-design/designer")
        #expect(rows.map(\.busy) == [true, true, false])
        // A peer's agent: the Space's list holds only this machine's turns.
        #expect(ChatRoster.rows([], sessions: sessions, runs: runs, agent: nil).allSatisfy { !$0.busy })
    }

    @Test func anOpenConversationWhoseSessionIsNotListedYetStaysAnOpenRow() {
        // Its first reply named the session; the history has not been read again yet.
        let rows = ChatRoster.rows([item(a, sid: "new", title: "Hi")], sessions: [ChatSessionInfo(sid: "s1")], runs: [], agent: "x/y")
        #expect(rows.map(\.id) == ["c:\(a.uuidString)", "s:s1"])
    }

    @Test func titleIsTheFirstLineOfTheFirstMessage() {
        #expect(ChatRoster.title("  Make a landing page \nwith a hero") == "Make a landing page")
        #expect(ChatRoster.title("\n\n") == nil)
        #expect(ChatRoster.title(String(repeating: "x", count: 200))?.count == 80)
    }
}
