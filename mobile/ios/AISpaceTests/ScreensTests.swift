import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ScreensTests {
    let screens = [
        PanelScreen(id: "home", items: ["app:todo", "builtin:inbox", "agent:space/assistant", "widget:todo/today", "app:docs"]),
        PanelScreen(id: "s1", items: ["app:reader"]),
    ]

    @Test func pinsOnceAndUnpinsFromOneScreenOnly() {
        var s = Screens.pin(screens, "s1", "app:todo")
        s = Screens.pin(s, "s1", "app:todo")
        #expect(s[1].items == ["app:reader", "app:todo"])
        #expect(Screens.isPinned(s, "s1", "app:todo"))
        s = Screens.unpin(s, "home", "app:todo")
        #expect(!Screens.isPinned(s, "home", "app:todo"))
        #expect(Screens.isPinned(s, "s1", "app:todo"))
        #expect(Screens.pin(screens, "nowhere", "app:todo") == screens)
    }

    @Test func reordersAGroupAndLeavesTheRestInPlace() {
        // The tiles move among themselves; the built-in tile and the widget between them stay put.
        let tiles = ["app:todo", "agent:space/assistant", "app:docs"]
        let s = Screens.reorder(screens, "home", group: tiles, to: ["app:docs", "app:todo", "agent:space/assistant"])
        #expect(s[0].items == ["app:docs", "builtin:inbox", "app:todo", "widget:todo/today", "agent:space/assistant"])
        // An order that is not the same entries changes nothing.
        #expect(Screens.reorder(screens, "home", group: tiles, to: ["app:docs", "app:todo"]) == screens)
        #expect(Screens.reorder(screens, "home", group: tiles, to: ["app:docs", "app:todo", "app:other"]) == screens)
    }

    @Test func addsAScreenWithAFreshIdUpToTheLimit() throws {
        let made = try #require(Screens.add(screens))
        #expect(made.id == "s2")
        #expect(made.screens.last == PanelScreen(id: "s2"))
        // An id in use is passed over.
        let taken = try #require(Screens.add(screens + [PanelScreen(id: "s3")]))
        #expect(taken.id == "s4")
        let full = (0..<Screens.limit).map { PanelScreen(id: $0 == 0 ? "home" : "s\($0)") }
        #expect(Screens.add(full) == nil)
    }

    @Test func homeCannotBeRemoved() {
        #expect(Screens.remove(screens, "home") == screens)
        #expect(Screens.remove(screens, "s1").map(\.id) == ["home"])
    }

    @Test func seedsTheHomeScreenAsThePanelDoes() {
        let apps = (1...10).map { "a\($0)" }
        let s = Screens.seed(apps: apps, agents: ["x/one"], widgets: ["x/w"])
        #expect(s.count == 1 && s[0].id == "home")
        #expect(s[0].items == (1...8).map { "app:a\($0)" } + ["builtin:inbox", "builtin:terminal", "builtin:settings", "agent:x/one", "widget:x/w"])
    }

    @Test func decodesAScreenWithoutANameOrItems() throws {
        let s = try JSONDecoder().decode(PanelScreen.self, from: Data(#"{"id":"s9"}"#.utf8))
        #expect(s == PanelScreen(id: "s9"))
    }
}

@MainActor
struct ScreenStoreTests {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("aispace-screens-\(UUID().uuidString)/screens.json")
    let a = UUID()
    let b = UUID()
    let panel = [
        PanelScreen(id: "home", items: ["app:todo", "builtin:inbox", "agent:space/assistant", "app:todo", "widget:todo/today", "app:gone"]),
        PanelScreen(id: "s2", items: ["app:docs", "builtin:terminal", "builtin:settings"]),
    ]

    @Test func copiesThePanelOnceAndKeepsItsOwnFromThenOn() {
        let store = ScreenStore(fileURL: file)
        #expect(store.screens(a) == [PanelScreen(id: "home")])
        store.seed(a, from: panel)
        // Built-in tiles are the panel's own windows, but for Settings, which the phone draws too;
        // a pin whose entry is gone is kept for when it returns.
        #expect(store.screens(a) == [
            PanelScreen(id: "home", items: ["app:todo", "agent:space/assistant", "widget:todo/today", "app:gone"]),
            PanelScreen(id: "s2", items: ["app:docs", "builtin:settings"]),
        ])
        // The panel changes later; the phone does not follow.
        store.seed(a, from: [PanelScreen(id: "home", items: ["app:reader"])])
        #expect(store.screens(a).first?.items.first == "app:todo")
        #expect(ScreenStore(fileURL: file).screens(a) == store.screens(a))
    }

    @Test func aPanelWithNothingPinnedIsNotCopiedYet() {
        let store = ScreenStore(fileURL: file)
        store.seed(a, from: [PanelScreen(id: "home", items: ["builtin:inbox"])])
        store.seed(a, from: panel)
        #expect(store.screens(a).count == 2)
    }

    @Test func aLayoutMadeByHandIsNotOverwritten() {
        let store = ScreenStore(fileURL: file)
        store.edit(a) { Screens.pin($0, Screens.home, "app:notes") }
        store.seed(a, from: panel)
        #expect(store.screens(a) == [PanelScreen(id: "home", items: ["app:notes"])])
        #expect(store.isPinned("app:notes", a))
        #expect(!store.isPinned("app:notes", b))
    }

    @Test func resetTakesThePanelAsItIsNow() {
        let store = ScreenStore(fileURL: file)
        store.edit(a) { Screens.pin($0, Screens.home, "app:notes") }
        store.reset(a, from: panel)
        #expect(store.screens(a).map(\.id) == ["home", "s2"])
        #expect(!store.isPinned("app:notes", a))
    }

    @Test func eachSpaceHasItsOwnScreensAndHomeAlwaysStays() {
        let store = ScreenStore(fileURL: file)
        store.seed(a, from: panel)
        store.edit(b) { _ in [PanelScreen(id: "s1", items: ["app:reader"]), PanelScreen(id: "s1")] }
        #expect(store.screens(b) == [PanelScreen(id: "home"), PanelScreen(id: "s1", items: ["app:reader"])])
        store.forget(a)
        #expect(store.screens(a) == [PanelScreen(id: "home")])
        #expect(ScreenStore(fileURL: file).screens(b).count == 2)
    }
}

struct WidgetBlocksTests {
    static let widgets = """
    {"ok":true,"widgets":[{"id":"btc/ind","app":"btc","name":"ind","title":"Indicators","kind":"items","size":"2x1","ok":true,"items":[],
      "asOf":"2026-10-13T02:00:00.000Z","staleAfterMs":600000,"blocks":[
      {"type":"gauge","label":{"en":"Fear & Greed","zh":"恐贪指数"},"value":57,"min":0,"max":100,"display":"57 Greed","zones":[{"to":25,"tone":"negative"},{"to":45,"tone":"warning"},{"to":55,"tone":"neutral"},{"to":100,"tone":"positive"}]},
      {"type":"trend","label":"ETF flow","style":"bar","signed":true,"format":"currency","points":[{"t":"2026-10-10","v":120000000},{"t":"2026-10-11","v":null},{"t":"2026-10-12","v":-2500000}]},
      {"type":"metric","label":"Open interest","value":221886,"unit":"BTC","decimals":0,"delta":{"value":0.1,"format":"percent"}},
      {"type":"hologram","label":"From a newer server","value":1},
      {"type":"progress","label":"Reading","value":50,"max":100,"format":"percent"},
      {"type":"status","label":"Feed","value":{"en":"Live"},"tone":"positive","time":"2026-10-13T01:59:00Z"},
      {"type":"metric","label":"Missing","value":null}
    ]}]}
    """

    var blocks: [WidgetBlock] {
        let payload = Fixture.payload(widgets: Self.widgets)
        return (try? Catalogue.decode(payload))?.widgets.first?.blocks?.elements ?? []
    }

    @Test func decodesTheBlocksItKnowsAndSkipsTheRest() {
        #expect(blocks.map(\.type) == [.gauge, .trend, .metric, .progress, .status, .metric])
        #expect(blocks[0].label.text(lang: "zh") == "恐贪指数")
        #expect(blocks[0].label.text(lang: "fr") == "Fear & Greed")
    }

    @Test func leadsWithTheValueAsThePanelWritesIt() {
        #expect(blocks[0].shown(lang: "en") == "57 Greed")
        #expect(blocks[0].effectiveTone == .positive)
        #expect(blocks[0].position(57) == 0.57)
        // The last point that has a value, signed, large amounts abbreviated.
        #expect(blocks[1].shown(lang: "en") == "-$2.5M")
        #expect(blocks[2].shown(lang: "en") == "221,886 BTC")
        #expect(blocks[3].shown(lang: "en") == "50%")
        #expect(blocks[3].fraction == 0.5)
        #expect(blocks[4].shown(lang: "en") == "Live")
        #expect(blocks[5].shown(lang: "en") == nil)
    }

    @Test func decodesTanksWithTheirLevels() {
        let widgets = """
        {"ok":true,"widgets":[{"id":"r2/usage","app":"r2","name":"usage","title":"Usage","kind":"items","size":"2x1","ok":true,"items":[],"blocks":[
          {"type":"tanks","label":"Nearest 10 GB","tanks":[
            {"label":"a","value":7.5,"max":10,"display":"7.5 GB","tone":"warning"},
            {"label":"b","value":12,"max":10,"tone":"negative"},
            {"label":"c","value":null,"max":10}]}
        ]}]}
        """
        let block = (try? Catalogue.decode(Fixture.payload(widgets: widgets)))?.widgets.first?.blocks?.elements.first
        #expect(block?.type == .tanks)
        #expect(block?.shown(lang: "en") == nil)
        let tanks = block?.tanks ?? []
        #expect(tanks.count == 3)
        #expect(tanks[0].shown(lang: "en") == "7.5 GB")
        #expect(tanks[0].tone == .warning)
        #expect(tanks[1].level == 1.2)
        #expect(tanks[1].shown(lang: "en") == "120%")
        #expect(tanks[2].level == 0)
        #expect(tanks[2].shown(lang: "en") == nil)
    }

    @Test func writesNumbersInTheReadersUnits() {
        #expect(BlockFormat.string(1234.5, BlockNumber(), lang: "en") == "1,234.5")
        #expect(BlockFormat.string(12.345, BlockNumber(format: "percent"), lang: "en") == "12.3%")
        #expect(BlockFormat.string(1_500_000, BlockNumber(format: "compact"), lang: "en") == "1.5M")
        #expect(BlockFormat.string(1_500_000, BlockNumber(format: "compact"), lang: "zh") == "150万")
        #expect(BlockFormat.string(3.2, BlockNumber(), lang: "en", signed: true) == "+3.2")
        #expect(BlockFormat.string(82750, BlockNumber(format: "currency", decimals: 0), lang: "en") == "$82,750")
    }

    @Test func sizesAndAge() {
        #expect(WidgetLayout.rows(size: "1x1") == 2)
        #expect(WidgetLayout.rows(size: "2x2") == 10)
        #expect(WidgetLayout.rows(size: nil) == 2)
        let now = ISO8601.parse("2026-10-13T02:20:00Z")!
        #expect(WidgetLayout.isOutdated(asOf: "2026-10-13T02:00:00.000Z", staleAfterMs: 600_000, now: now))
        #expect(!WidgetLayout.isOutdated(asOf: "2026-10-13T02:15:00.000Z", staleAfterMs: 600_000, now: now))
        #expect(!WidgetLayout.isOutdated(asOf: nil, staleAfterMs: 600_000, now: now))
    }
}
