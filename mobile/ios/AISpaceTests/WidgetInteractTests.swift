import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// A card's interactions: the web panel's src/web/widget-interact.test.ts case for case, then what the
/// native clients read from the payload (views, copy, actions, frames) and how they stay whole when a
/// Space sends none of it or sends it malformed. The Mac and the iPhone both run it.

private func blocks(_ json: String) -> [WidgetBlock] {
    (try? JSONDecoder().decode(Lossy<WidgetBlock>.self, from: Data(json.utf8)))?.elements ?? []
}

private func widgets(_ items: String, layout: String? = nil) -> Catalogue? {
    try? Catalogue.decode(CataloguePayload(apps: Data(#"{"ok":true,"apps":[]}"#.utf8), agents: Data(#"{"agents":[]}"#.utf8),
                                           widgets: Data(#"{"ok":true,"widgets":[\#(items)]}"#.utf8),
                                           peers: nil, layout: layout.map { Data($0.utf8) }, router: nil, fetchedAt: Date()))
}

struct WidgetInteractTests {
    @Test func nearestIndexIsTheSlotUnderThePointer() {
        #expect(WidgetInteract.nearestIndex(0, width: 200, count: 10) == 0)
        #expect(WidgetInteract.nearestIndex(19.9, width: 200, count: 10) == 0)
        #expect(WidgetInteract.nearestIndex(20, width: 200, count: 10) == 1)
        #expect(WidgetInteract.nearestIndex(199, width: 200, count: 10) == 9)
        #expect(WidgetInteract.nearestIndex(260, width: 200, count: 10) == 9)
        #expect(WidgetInteract.nearestIndex(-5, width: 200, count: 10) == 0)
        #expect(WidgetInteract.nearestIndex(150, width: 200, count: 1) == 0)
        #expect(WidgetInteract.nearestIndex(10, width: 0, count: 5) == -1)
        #expect(WidgetInteract.nearestIndex(10, width: 100, count: 0) == -1)
    }

    @Test func pagesOfRows() {
        #expect(WidgetInteract.pages([1, 2], per: 2) == [[1, 2]])
        #expect(WidgetInteract.pages([Int](), per: 2) == [[]])
        #expect(WidgetInteract.pages([1, 2, 3, 4, 5], per: 2) == [[1, 2], [3, 4], [5]])
        #expect(WidgetInteract.pages(Array(0..<11), per: 10).map(\.count) == [10, 1])
    }

    @Test func aClearHorizontalSwipeMovesOnePage() {
        #expect(WidgetInteract.swipePage(0, pages: 3, dx: -80, dy: 5) == 1)
        #expect(WidgetInteract.swipePage(1, pages: 3, dx: 80, dy: 5) == 0)
        #expect(WidgetInteract.swipePage(2, pages: 3, dx: -80, dy: 0) == 2)
        #expect(WidgetInteract.swipePage(0, pages: 3, dx: -20, dy: 0) == 0)
        #expect(WidgetInteract.swipePage(0, pages: 3, dx: -60, dy: 60) == 0)
        #expect(WidgetInteract.step(0, pages: 3, forward: false) == 0)
        #expect(WidgetInteract.step(1, pages: 3, forward: true) == 2)
        #expect(WidgetInteract.step(2, pages: 3, forward: true) == 2)
    }

    @Test func blockChangesByPlaceTypeAndLabel() {
        func m(_ label: String, _ v: Double?) -> String { #"{"type":"metric","label":"\#(label)","value":\#(v.map { "\($0)" } ?? "null")}"# }
        func s(_ label: String, _ v: String) -> String { #"{"type":"status","label":"\#(label)","value":"\#(v)"}"# }
        func tr(_ vs: [Double?]) -> String {
            let pts = vs.enumerated().map { #"{"t":"2026-11-0\#($0.offset + 1)","v":\#($0.element.map { "\($0)" } ?? "null")}"# }
            return #"{"type":"trend","label":"t","style":"line","points":[\#(pts.joined(separator: ","))]}"#
        }
        func b(_ xs: [String]) -> [WidgetBlock] { blocks("[\(xs.joined(separator: ","))]") }
        #expect(WidgetInteract.blockChanges(nil, b([m("a", 1)])) == [nil])
        #expect(WidgetInteract.blockChanges(b([m("a", 1), m("b", 5), s("c", "up"), m("d", 1), tr([1, 2])]),
                                            b([m("a", 2), m("b", 4), s("c", "down"), m("other", 9), tr([1, 2, nil])])) == [.up, .down, .text, nil, nil])
        #expect(WidgetInteract.blockChanges(b([m("a", nil)]), b([m("a", 3)])) == [.text])
        #expect(WidgetInteract.blockChanges(b([m("a", 3)]), b([m("a", 3)])) == [nil])
        #expect(WidgetInteract.blockChanges(b([tr([1, 2])]), b([tr([1, 2, 1])])) == [.down])
        // A block that moved to another place is a different thing there: no flash.
        #expect(WidgetInteract.blockChanges(b([m("a", 1), m("b", 2)]), b([m("b", 3), m("a", 1)])) == [nil, nil])
    }

    @Test func theChosenViewIsKeptPerWidget() {
        let defaults = UserDefaults(suiteName: "aispace-views-\(UUID().uuidString)")!
        #expect(WidgetViewChoice.load("usage/spend", ids: ["today", "7d"], defaults: defaults) == "today")
        WidgetViewChoice.save("usage/spend", view: "7d", defaults: defaults)
        WidgetViewChoice.save("other/w", view: "b", defaults: defaults)
        #expect(WidgetViewChoice.load("usage/spend", ids: ["today", "7d"], defaults: defaults) == "7d")
        #expect(WidgetViewChoice.load("usage/spend", ids: ["today", "30d"], defaults: defaults) == "today")
        #expect(defaults.dictionary(forKey: WidgetViewChoice.key) as? [String: String] == ["usage/spend": "7d", "other/w": "b"])
        defaults.set("not a map", forKey: WidgetViewChoice.key)
        #expect(WidgetViewChoice.load("usage/spend", ids: ["today", "7d"], defaults: defaults) == "today")
    }

    @Test func aPointsTimeIsShownWhenFinerThanADay() {
        #expect(!WidgetInteract.isTimed("2026-10-14"))
        #expect(!WidgetInteract.isTimed("2026-10-14T00:00:00Z"))
        #expect(!WidgetInteract.isTimed("2026-10-14T00:00:00.000Z"))
        #expect(!WidgetInteract.isTimed("2026-10-14T00:00+00:00"))
        #expect(WidgetInteract.isTimed("2026-10-14T05:00:00Z"))
        #expect(WidgetInteract.isTimed("2026-10-14T00:00:30Z"))
    }

    // MARK: The payload

    static let todo = #"""
    {"id":"todo/today","app":"todo","name":"today","title":"Todo","kind":"items","size":"1x2","ok":true,"items":[],
     "frame":{"w":0.5,"h":412},
     "blocks":[
       {"type":"metric","label":"Open","value":3,"copy":"three"},
       {"type":"status","label":"Buy milk","value":"today","action":{"id":"done:1","kind":"check","label":{"en":"Mark done","zh":"标记完成"}}},
       {"type":"status","label":"Odd","value":"x","action":{"id":"x","kind":"input","label":"no input on a block"}},
       {"type":"status","label":"Bad id","value":"x","action":{"id":"has space","kind":"button","label":"b"},"copy":""},
       {"type":"status","label":"Restart","value":"down","action":{"id":"restart:api","kind":"button","label":"Restart","confirm":"Restart now?"}}
     ],
     "views":[
       {"id":"today","label":"Today","blocks":[{"type":"metric","label":"Open","value":3}]},
       {"id":"week","label":{"en":"Week","zh":"本周"},"blocks":[{"type":"metric","label":"Open","value":9,"action":{"id":"done:9","kind":"check","label":"x"}}]},
       {"id":"today","label":"Again","blocks":[{"type":"metric","label":"Open","value":1}]},
       {"id":"Bad","label":"Bad id","blocks":[{"type":"metric","label":"Open","value":1}]},
       {"id":"empty","label":"Empty","blocks":[{"type":"nope","label":"x"}]}
     ],
     "actions":[
       {"id":"add","kind":"input","label":"Add","placeholder":{"en":"Add a task…","zh":"添加待办…"}},
       {"id":"add2","kind":"input","label":"A second input"},
       {"id":"rerun","kind":"button","label":"Run","confirm":{"en":"Run now?"}},
       {"id":"tick","kind":"check","label":"no check on a card"},
       {"id":"later","kind":"teleport","label":"unknown kind"},
       {"id":"b2","kind":"button","label":"Two"},
       {"id":"b3","kind":"button","label":"Three"}
     ]}
    """#

    @Test func viewsCopyActionsAndFrameAreRead() throws {
        let w = try #require(widgets(Self.todo)?.widgets.first)
        #expect(w.storedFrame == WidgetFrame(w: 0.5, h: 412))
        let b = w.blocks?.elements ?? []
        #expect(b.count == 5)
        #expect(b[0].copy == "three")
        #expect(b[1].action == WidgetAction(id: "done:1", kind: .check, label: .byLanguage(["en": "Mark done", "zh": "标记完成"])))
        // An input is no block's control, an id out of the contract is no action, empty copy is none.
        #expect(b[2].action == nil)
        #expect(b[3].action == nil && b[3].copy == nil)
        #expect(b[4].action?.confirm == .plain("Restart now?"))
        // Two to four views with unique ids; the repeated, malformed and empty ones are dropped.
        #expect(w.cardViews?.map(\.id) == ["today", "week"])
        #expect(w.cardViews?[1].label.text(lang: "zh") == "本周")
        // One input, buttons, at most three; a check or an unknown kind is no card control.
        #expect(w.cardActions.map(\.id) == ["add", "rerun", "b2"])
        #expect(w.cardActions[0].placeholder?.text(lang: "zh") == "添加待办…")
        #expect(w.declaredActions == ["add", "rerun", "b2", "done:1", "restart:api", "done:9"])
    }

    @Test func aPeersCardHasNoActionsWhateverItsPayloadSays() throws {
        let peer = Self.todo.replacingOccurrences(of: #""id":"todo/today","#, with: #""id":"lab/todo/today","peer":"lab","#)
        let w = try #require(widgets(peer)?.widgets.first)
        #expect(w.cardActions.isEmpty)
        #expect(w.declaredActions.isEmpty)
        #expect(w.cardViews?.count == 2)
    }

    @Test func malformedNewFieldsLeaveTheCardAsItWas() throws {
        let odd = #"""
        {"id":"a/w","app":"a","name":"w","title":"A","kind":"items","size":"2x1","ok":true,"items":[{"text":"one"}],
         "frame":{"w":"wide","h":300},"views":"nope","actions":{"id":"x"},
         "blocks":[{"type":"metric","label":"M","value":1,"action":"click me","copy":42},{"type":"hologram","label":"?"}]}
        """#
        let c = try #require(widgets(odd + #",{"id":"b/w","app":"b","name":"w","title":"B","ok":true,"items":[],"frame":{"w":0.5,"h":-1}}"#))
        #expect(c.widgets.map(\.id) == ["a/w", "b/w"])
        let w = c.widgets[0]
        #expect(w.storedFrame == nil && w.cardViews == nil && w.cardActions.isEmpty)
        #expect(w.blocks?.elements.count == 1)
        #expect(w.blocks?.elements.first?.action == nil && w.blocks?.elements.first?.copy == nil)
        #expect(c.widgets[1].storedFrame == nil)
    }

    @Test func anOlderSpaceHasNoSteplessLayout() throws {
        let old = #"{"ok":true,"layout":{"order":{"apps":[],"agents":[],"widgets":[]},"hidden":[],"sizes":{},"hiddenWidgets":[],"screens":null}}"#
        #expect(widgets("", layout: old)?.hasStepless == false)
        #expect(widgets("", layout: nil)?.hasStepless == false)
        let new = #"{"ok":true,"layout":{"order":{"apps":[],"agents":[],"widgets":[]},"hidden":[],"sizes":{},"hiddenWidgets":[],"screens":null,"frames":{},"widgetAlign":"center"}}"#
        #expect(widgets("", layout: new)?.widgetAlign == .center)
    }

    @Test func theAnswerOfAnActionOrARefresh() {
        let fresh = #"{"ok":true,"message":{"en":"Added","zh":"已添加"},"widget":{"id":"todo/today","app":"todo","name":"today","title":"Todo","ok":true,"items":[]}}"#
        guard case .ok(let w, let message) = WidgetAnswer.decode(status: 200, data: Data(fresh.utf8)) else { Issue.record("not ok"); return }
        #expect(w.id == "todo/today")
        #expect(message?.text(lang: "zh") == "已添加")
        #expect(WidgetAnswer.decode(status: 502, data: Data(#"{"ok":false,"error":"the bank list is read-only"}"#.utf8)) == .failed("the bank list is read-only"))
        #expect(WidgetAnswer.decode(status: 404, data: Data("Not Found".utf8)) == .failed("HTTP 404"))
        #expect(WidgetAnswer.decode(status: 200, data: Data(#"{"ok":true}"#.utf8)) == .failed("HTTP 200"))
    }
}
