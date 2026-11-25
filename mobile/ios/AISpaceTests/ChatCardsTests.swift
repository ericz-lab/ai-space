import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// Chat cards (docs/chat-cards.md and plan section 11) as the Mac and the iPhone read them.
struct ChatCardsTests {
    private static func json(_ text: String) -> Any { try! JSONSerialization.jsonObject(with: Data(text.utf8)) }

    private static let receipt = #"""
    {"v":1,"kind":"receipt","title":"已添加 2 条待办","state":"card-state","actions":{"undo":"card-undo","edit":"card-edit"},
     "items":[{"id":72,"title":"开会","detail":"后天 周四 08:00 · 高","url":"https://todo.example/?todo=72","version":1},
              {"id":"73","title":"交报销","version":2}]}
    """#

    // MARK: Decoding

    @Test func readsAV1CardFromALiveEvent() throws {
        let line = #"{"type":"cards","token":"tok-1","cards":[\#(Self.receipt.replacingOccurrences(of: "\n", with: "")),{"v":1,"kind":"list","items":[{"id":"9","title":"x"}]}]}"#
        let shown = try #require(ShownChatCard.event(line))
        #expect(shown.count == 2)
        #expect(shown.map(\.index) == [0, 1])
        #expect(shown.allSatisfy { $0.token == "tok-1" })
        let card = shown[0].card
        #expect(card.kind == "receipt")
        #expect(card.title == "已添加 2 条待办")
        #expect(card.state == "card-state")
        #expect(card.undo == "card-undo")
        #expect(card.items.map(\.id) == ["72", "73"])
        #expect(card.items[0].detailSegments == ["后天 周四 08:00", "高"])
        #expect(card.items[0].url == "https://todo.example/?todo=72")
        #expect(card.items[1].version == 2)
        #expect(card.style == .rows)
        #expect(shown[1].card.undo == nil)
    }

    @Test func otherEventsAreNotCards() {
        #expect(ShownChatCard.event(#"{"type":"assistant","message":{"content":[]}}"#) == nil)
        #expect(ShownChatCard.event(#"{"type":"user","cards":[]}"#) == nil)
        #expect(ShownChatCard.event("not json") == nil)
    }

    @Test func aCardWithoutATokenHasNone() throws {
        let shown = try #require(ShownChatCard.event(#"{"type":"cards","cards":[{"v":1,"kind":"list","items":[{"id":"1","title":"a"}]}]}"#))
        #expect(shown.first?.token == nil)
    }

    @Test func anUnreadableCardIsLeftOutAndKeepsTheOthersIndex() throws {
        let line = #"{"type":"cards","token":"t","cards":[{"v":1,"kind":"draft","items":[{"id":"1","title":"a"}]},{"v":1,"kind":"list","items":[{"id":"2","title":"b"}]}]}"#
        let shown = try #require(ShownChatCard.event(line))
        #expect(shown.count == 1)
        // The action names the card's place in the event as sent.
        #expect(shown[0].index == 1)
    }

    @Test func dropsACardWholeWhenAnItemIsBroken() {
        #expect(ChatCard(Self.json(#"{"kind":"list","items":[{"id":"1","title":"a"},{"id":"2"}]}"#)) == nil)
        #expect(ChatCard(Self.json(#"{"kind":"list","items":[]}"#)) == nil)
        #expect(ChatCard(Self.json(#"{"kind":"value"}"#)) == nil)
        #expect(ChatCard(Self.json(#"{"kind":"value","text":"12 条"}"#))?.text == "12 条")
    }

    @Test func ignoresUnknownFields() throws {
        let card = try #require(ChatCard(Self.json(#"{"v":1,"kind":"list","future":{"x":1},"items":[{"id":"1","title":"a","shape":"star"}]}"#)))
        #expect(card.items.first?.title == "a")
        // The card goes back to the state route as received, unknown fields and all.
        let back = card.json as? [String: Any]
        #expect(back?["future"] != nil)
    }

    @Test func readsEveryV2Field() throws {
        let card = try #require(ChatCard(Self.json(#"""
        {"v":1,"kind":"list","style":"agenda","items":[{"id":"1","title":"体检","when":"后天 周四 08:00","date":"2026-11-26T08:00",
          "tags":[{"text":"高","tone":"warning"},{"text":"家"},{"text":"x","tone":"sparkly"}],
          "image":"https://todo.example/a.png","icon":"bell","value":"¥3,200","progress":0.4}]}
        """#)))
        let item = try #require(card.items.first)
        #expect(item.when == "后天 周四 08:00")
        #expect(item.date == ChatCardDate(year: 2026, month: 11, day: 26, hour: 8, minute: 0))
        #expect(item.tags == [ChatCardTag(text: "高", tone: .warning), ChatCardTag(text: "家"), ChatCardTag(text: "x", tone: .neutral)])
        #expect(item.image == "https://todo.example/a.png")
        #expect(item.icon == .bell)
        #expect(item.value == "¥3,200")
        #expect(item.progress == 0.4)
        #expect(card.style == .agenda)
    }

    @Test func unknownNamesFallBack() throws {
        let card = try #require(ChatCard(Self.json(#"{"kind":"list","style":"carousel","items":[{"id":"1","title":"a","icon":"rocket","tags":[{"text":"t","tone":"loud"}]}]}"#)))
        #expect(card.style == .rows)
        #expect(card.items[0].icon == nil)
        #expect(card.items[0].tags?.first?.tone == .neutral)
        // A style that is not a string is no style here (ai-space drops such a card before it is sent).
        #expect(ChatCard(Self.json(#"{"kind":"list","style":3,"items":[{"id":"1","title":"a"}]}"#))?.style == .rows)
    }

    @Test func mapsTheTwelveIconsToSymbols() {
        #expect(ChatCardIcon.allCases.count == 12)
        #expect(Set(ChatCardIcon.allCases.map(\.symbol)).count == 12)
        #expect(ChatCardIcon(rawValue: "calendar")?.symbol == "calendar")
    }

    @Test func readsDatesAsWritten() {
        #expect(ChatCardDate("2026-11-26") == ChatCardDate(year: 2026, month: 11, day: 26))
        #expect(ChatCardDate("2026-11-26T23:59")?.time == "23:59")
        #expect(ChatCardDate("2026-11-26")?.time == nil)
        #expect(ChatCardDate("2026-02-30") == nil)
        #expect(ChatCardDate("2026-11-26T24:00") == nil)
        #expect(ChatCardDate("2026-11-26 08:00") == nil)
        #expect(ChatCardDate("26-11-2026") == nil)
        #expect(ChatCardDate("2026-11-26T08:00Z") == nil)
        let thursday = ChatCardDate(year: 2026, month: 11, day: 26)
        #expect(thursday.weekday(lang: "zh") == "周四")
        #expect(thursday.weekday(lang: "en") == "Thu")
        #expect(thursday.monthName(lang: "zh") == "11月")
        #expect(thursday.monthName(lang: "en") == "Nov")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        let today = calendar.date(from: DateComponents(year: 2026, month: 11, day: 24))!
        #expect(!thursday.needsMonth(today: today, calendar: calendar))
        #expect(ChatCardDate(year: 2026, month: 12, day: 1).needsMonth(today: today, calendar: calendar))
        #expect(ChatCardDate(year: 2027, month: 11, day: 1).needsMonth(today: today, calendar: calendar))
    }

    @Test func dropsOutOfRangeOrMistypedValues() throws {
        let item = try #require(ChatCardItem(Self.json(#"{"id":"1","title":"a","progress":1.5,"when":3,"tags":"x","value":12,"version":true}"#)))
        #expect(item.progress == nil)
        #expect(item.when == nil)
        #expect(item.tags == nil)
        #expect(item.value == nil)
        #expect(item.version == nil)
        #expect(ChatCardItem(Self.json(#"{"id":true,"title":"a"}"#)) == nil)
        #expect(ChatCardItem(Self.json(#"{"id":1,"title":"a"}"#))?.id == "1")
        let tags = ChatCardTag.list(Self.json(#"[{"text":"1"},{"text":"2"},{"text":"3"},{"text":"4"},{"text":"5"}]"#))
        #expect(tags?.count == 4)
    }

    @Test func restoresASessionsCardsWithoutAToken() throws {
        let body = #"""
        {"ok":true,"messages":[
          {"role":"user","text":"add two"},
          {"role":"ai","text":"Added.","cards":[{"v":1,"kind":"receipt","actions":{"undo":"card-undo"},"items":[{"id":"1","title":"a"}]},{"kind":"nope"}]}
        ]}
        """#
        let stored = try Hub.rows(ChatStored.self, "messages", from: Data(body.utf8))
        #expect(stored.count == 2)
        #expect(stored[0].cards.isEmpty)
        #expect(stored[1].cards.count == 1)
        let shown = ShownChatCard.restored(stored[1].cards)
        #expect(shown.first?.token == nil)
        #expect(shown.first?.index == 0)
        // Without a token nothing can be undone, even on the latest reply.
        #expect(!ChatCardRules.canUndo(shown[0], actionable: true, readOnly: false))
    }

    @Test func aBrokenCardsFieldKeepsTheMessage() throws {
        let body = #"{"messages":[{"role":"ai","text":"hi","cards":"oops"}]}"#
        let stored = try Hub.rows(ChatStored.self, "messages", from: Data(body.utf8))
        #expect(stored.first?.text == "hi")
        #expect(stored.first?.cards.isEmpty == true)
    }

    // MARK: Styles

    private static func card(_ style: String, kind: String = "list", items: String) -> ChatCard {
        ChatCard(json(#"{"kind":"\#(kind)","style":"\#(style)","items":[\#(items)]}"#))!
    }

    @Test func aStylesRequiredFieldMissingDrawsRows() {
        #expect(Self.card("gallery", items: #"{"id":"1","title":"a","image":"/a.png"},{"id":"2","title":"b","image":"/b.png"}"#).style == .gallery)
        #expect(Self.card("gallery", items: #"{"id":"1","title":"a","image":"/a.png"},{"id":"2","title":"b"}"#).style == .rows)
        #expect(Self.card("agenda", items: #"{"id":"1","title":"a","date":"2026-11-26"}"#).style == .agenda)
        #expect(Self.card("agenda", items: #"{"id":"1","title":"a","date":"tomorrow"}"#).style == .rows)
        #expect(Self.card("stat", items: #"{"id":"1","title":"a","value":"12"}"#).style == .stat)
        #expect(Self.card("stat", items: #"{"id":"1","title":"a"}"#).style == .rows)
        #expect(Self.card("compact", items: #"{"id":"1","title":"a"}"#).style == .compact)
        #expect(Self.card("rows", items: #"{"id":"1","title":"a"}"#).style == .rows)
    }

    @Test func statIsForListAndValueCardsOnly() {
        #expect(Self.card("stat", kind: "receipt", items: #"{"id":"1","title":"a","value":"12"}"#).style == .rows)
        let value = ChatCard(Self.json(#"{"kind":"value","text":"3","style":"stat","items":[{"id":"1","title":"a","value":"3"}]}"#))
        #expect(value?.style == .stat)
        // A value card without items draws its text the rows way.
        #expect(ChatCard(Self.json(#"{"kind":"value","text":"3","style":"stat"}"#))?.style == .rows)
    }

    @Test func compactAndGalleryPickTheirSecondaryText() {
        var item = ChatCardRules.shown(ChatCardItem(id: "1", title: "a", detail: "x · y", when: "明天", value: "12"), nil)
        #expect(item.compactValue == "12")
        #expect(item.gallerySubtitle == "明天")
        item = ChatCardRules.shown(ChatCardItem(id: "1", title: "a", detail: "x · y", when: "明天"), nil)
        #expect(item.compactValue == "明天")
        item = ChatCardRules.shown(ChatCardItem(id: "1", title: "a", detail: "x · y"), nil)
        #expect(item.compactValue == "x")
        #expect(item.gallerySubtitle == "x")
    }

    @Test func agendaShowsOneDateBlockPerDay() {
        let items = ["2026-11-26T08:00", "2026-11-26T10:00", "2026-11-27", "2026-11-26"].enumerated().map { i, date in
            ChatCardRules.shown(ChatCardItem(id: "\(i)", title: "t", date: ChatCardDate(date)), nil)
        }
        #expect(items.indices.map { ChatCardRules.showsDateBlock(items, at: $0) } == [true, false, true, true])
    }

    @Test func galleryNarrowsToTwoColumns() {
        #expect(ChatCardRules.galleryColumns(width: 359) == 2)
        #expect(ChatCardRules.galleryColumns(width: 360) == 3)
    }

    @Test func onlySomeStylesHaveAnUndoPerItem() {
        for style in [ChatCardStyle.rows, .agenda, .gallery] {
            #expect(ChatCardRules.rowUndo(style: style, many: true, undoable: true))
            #expect(!ChatCardRules.rowUndo(style: style, many: false, undoable: true))
            #expect(!ChatCardRules.rowUndo(style: style, many: true, undoable: false))
        }
        #expect(!ChatCardRules.rowUndo(style: .compact, many: true, undoable: true))
        #expect(!ChatCardRules.rowUndo(style: .stat, many: true, undoable: true))
    }

    // MARK: State, actionable and undoable

    @Test func theAppsAnswerGoesOverWhatWasPrinted() {
        let printed = ChatCardItem(id: "72", title: "开会", detail: "后天 08:00 · 高", url: "https://t/?72", when: "后天", tags: [ChatCardTag(text: "高")], progress: 0.2)
        var state = ChatCardItemState(id: "72", status: .active, title: "开会（改到 B）", detail: "后天 09:30", changed: true)
        state.progress = 0.5
        let changed = ChatCardRules.shown(printed, state)
        #expect(changed.title == "开会（改到 B）")
        #expect(changed.detailSegments == ["后天 09:30"])
        #expect(changed.url == "https://t/?72")
        #expect(changed.progress == 0.5)
        #expect(changed.pill == .changed)
        let removed = ChatCardRules.shown(printed, ChatCardItemState(id: "72", status: .removed, title: "x"))
        #expect(removed.title == "开会")
        #expect(removed.detailSegments.isEmpty)
        #expect(removed.url == nil)
        #expect(removed.when == nil)
        #expect(removed.tags.isEmpty)
        #expect(removed.pill == .undone)
        #expect(ChatCardRules.shown(printed, ChatCardItemState(id: "72", status: .done)).pill == .done)
        #expect(ChatCardRules.shown(printed, nil).pill == nil)
    }

    @Test func readsStateAnswersWithV2Fields() {
        let states = ChatCardItemState.list(Self.json(#"""
        [{"id":1,"status":"done","when":"今天","tags":[{"text":"高","tone":"negative"}],"value":"3","changed":true},
         {"id":"2","status":"archived"},{"status":"active"}]
        """#))
        #expect(states.count == 1)
        #expect(states[0].id == "1")
        #expect(states[0].status == .done)
        #expect(states[0].when == "今天")
        #expect(states[0].tags?.first?.tone == .negative)
        #expect(states[0].changed)
    }

    @Test func onlyTheLatestReplysCardsAct() {
        let thread = [true, false, true, false]
        #expect(!ChatCardRules.actionable(isUser: thread, at: 1))
        #expect(ChatCardRules.actionable(isUser: thread, at: 3))
        // A message the person queued after the reply ends it, as on the web.
        #expect(!ChatCardRules.actionable(isUser: [true, false, true], at: 1))
        #expect(!ChatCardRules.actionable(isUser: thread, at: 9))
    }

    @Test func whichItemsCanBeUndone() throws {
        let card = try #require(ChatCard(Self.json(Self.receipt)))
        let live = ShownChatCard(card: card, index: 0, token: "t")
        #expect(ChatCardRules.canUndo(live, actionable: true, readOnly: false))
        #expect(!ChatCardRules.canUndo(live, actionable: false, readOnly: false))
        #expect(!ChatCardRules.canUndo(live, actionable: true, readOnly: true))
        let list = try #require(ChatCard(Self.json(#"{"kind":"list","items":[{"id":"1","title":"a"}]}"#)))
        #expect(!ChatCardRules.canUndo(ShownChatCard(card: list, index: 0, token: "t"), actionable: true, readOnly: false))

        var states: [String: ChatCardItemState] = [:]
        #expect(ChatCardRules.open(card, states: states, canUndo: true) == ["72", "73"])
        #expect(ChatCardRules.open(card, states: states, canUndo: false).isEmpty)
        states["73"] = ChatCardItemState(id: "73", status: .removed)
        #expect(ChatCardRules.open(card, states: states, canUndo: true) == ["72"])
        states["73"] = ChatCardItemState(id: "73", status: .active, changed: true)
        #expect(!ChatCardRules.undoable("73", states: states, canUndo: true))
        states["73"] = ChatCardItemState(id: "73", status: .done)
        #expect(ChatCardRules.undoable("73", states: states, canUndo: true))
    }

    @Test func theHeaderButtonsWords() {
        #expect(ChatCardRules.undoLabel(total: 1, open: 1) == .one)
        #expect(ChatCardRules.undoLabel(total: 3, open: 3) == .all)
        #expect(ChatCardRules.undoLabel(total: 3, open: 2) == .rest(2))
    }

    @Test func aReadOnlyRowWithALinkOpensAsAWhole() {
        #expect(ChatCardRules.rowLink(canUndo: false, url: "https://x"))
        #expect(!ChatCardRules.rowLink(canUndo: true, url: "https://x"))
        #expect(!ChatCardRules.rowLink(canUndo: false, url: nil))
    }

    // MARK: Requests

    @Test func routesFollowTheAgentsMachine() throws {
        let local = try #require(ChatCardRoute(base: "/api/agents/ai-todo/planner"))
        #expect(local.state == "/api/agents/cards/state")
        #expect(local.action == "/api/agents/cards/action")
        #expect(local.agent == "ai-todo/planner")
        let peer = try #require(ChatCardRoute(base: "/api/peers/my%20mac/agents/ai-todo/planner"))
        #expect(peer.state == "/api/peers/my%20mac/agents/cards/state")
        #expect(peer.action == "/api/peers/my%20mac/agents/cards/action")
        #expect(peer.agent == "ai-todo/planner")
        #expect(ChatCardRoute(base: "/api/apps/x") == nil)
    }

    @Test func requestBodiesCarryOnlyWhatTheContractNames() throws {
        let card = try #require(ChatCard(Self.json(Self.receipt)))
        let undo = ChatCardRules.undoBody(token: "tok", card: 2, items: ["72"])
        #expect(Set(undo.keys) == ["token", "card", "action", "items"])
        #expect(undo["token"] as? String == "tok")
        #expect(undo["card"] as? Int == 2)
        #expect(undo["action"] as? String == "undo")
        #expect(undo["items"] as? [String] == ["72"])
        let state = ChatCardRules.stateBody(agent: "ai-todo/planner", card: card)
        #expect(Set(state.keys) == ["agent", "card"])
        let sent = try #require(state["card"] as? [String: Any])
        #expect(sent["kind"] as? String == "receipt")
        #expect((sent["items"] as? [Any])?.count == 2)
        #expect(JSONSerialization.isValidJSONObject(state))
    }

    @Test func readsTheRoutesAnswers() {
        #expect(ChatCardRules.outcome(status: 409, data: Data(#"{"ok":false,"readOnly":true}"#.utf8)) == .readOnly)
        #expect(ChatCardRules.outcome(status: 500, data: Data(#"{"ok":false,"error":"boom"}"#.utf8)) == .failed("boom"))
        #expect(ChatCardRules.outcome(status: 502, data: Data("<html>".utf8)) == .failed("HTTP 502"))
        #expect(ChatCardRules.outcome(status: 200, data: Data(#"{"ok":true,"items":[{"id":"1","status":"removed"}]}"#.utf8))
            == .items([ChatCardItemState(id: "1", status: .removed)]))
    }

    // MARK: The store

    @MainActor
    @Test func theStoreReadsStateAndUndoes() async throws {
        let card = try #require(ChatCard(Self.json(Self.receipt)))
        var calls: [(String, [String: Any])] = []
        var answers: [(Int, String)] = [
            (200, #"{"ok":true,"items":[{"id":"73","status":"done"}]}"#),
            (200, #"{"ok":true,"items":[{"id":"72","status":"removed"}]}"#),
            (409, #"{"ok":false,"readOnly":true}"#),
        ]
        let stores = ChatCardStores(route: ChatCardRoute(base: "/api/peers/p/agents/ai-todo/planner")) { path, body in
            calls.append((path, body))
            let (status, text) = answers.removeFirst()
            return (status, Data(text.utf8))
        }
        let shown = ShownChatCard(card: card, index: 1, token: "tok")
        let store = stores.store(for: shown)
        #expect(stores.store(for: shown) === store)
        await store.refresh()
        #expect(calls[0].0 == "/api/peers/p/agents/cards/state")
        #expect(calls[0].1["agent"] as? String == "ai-todo/planner")
        #expect(store.states["73"]?.status == .done)
        await store.undo(["72"])
        #expect(calls[1].0 == "/api/peers/p/agents/cards/action")
        #expect(calls[1].1["card"] as? Int == 1)
        #expect(calls[1].1["items"] as? [String] == ["72"])
        #expect(store.states["72"]?.status == .removed)
        #expect(!store.readOnly)
        await store.undo(["73"])
        #expect(store.readOnly)
        #expect(store.note != nil)
        #expect(!ChatCardRules.canUndo(shown, actionable: true, readOnly: store.readOnly))
    }

    @MainActor
    @Test func aCardWithoutStateAsksNothing() async throws {
        let card = try #require(ChatCard(Self.json(#"{"kind":"list","items":[{"id":"1","title":"a"}]}"#)))
        var asked = false
        let stores = ChatCardStores(route: ChatCardRoute(base: "/api/agents/a/b")) { _, _ in
            asked = true
            return (200, Data("{}".utf8))
        }
        let store = stores.store(for: ShownChatCard(card: card, index: 0))
        await store.refresh()
        await store.undo(["1"])
        #expect(!asked)
    }
}
