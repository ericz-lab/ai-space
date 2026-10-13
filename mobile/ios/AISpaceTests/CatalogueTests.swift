import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// Answers shaped like a real Space's (a hub with one peer), trimmed.
enum Fixture {
    static let apps = """
    {"ok":true,"apps":[
      {"id":"docs","name":"docs","title":"Bun Docs","i18n":{"zh":{"title":"Bun 文档"}},"icon":"📚","url":"https://bun.sh/docs","status":"active","manifestOnly":true,"hidden":false,"agents":[],"widgets":[]},
      {"id":"todo","name":"todo","title":"Todo","description":"Tasks and reminders.","i18n":{"zh":{"title":"待办","description":"任务与提醒。"}},"icon":"/api/apps/todo/icon","url":"https://todo.example.com/?lang={lang}","status":"active","manifestOnly":false,"hidden":false,"service":{"port":8801,"health":"ok"},"agents":[],"widgets":[]},
      {"id":"reader","name":"reader","title":"Reader","icon":"📰","url":"https://reader.example.com/","status":"active","hidden":false,"service":{"port":8803,"health":"down"}},
      {"id":"sleeper","name":"sleeper","title":"Sleeper","url":"https://sleeper.example.com/","status":"paused","hidden":false,"service":{"port":8804,"health":"down"}},
      {"id":"secret","name":"secret","title":"Secret","url":"https://secret.example.com/","status":"active","hidden":true},
      {"id":"old","name":"old","title":"Old","url":"https://old.example.com/","status":"archived","hidden":false},
      {"id":"worker","name":"worker","title":"Worker","status":"active","hidden":false,"service":{"port":8805,"health":"ok"}},
      {"id":"broken","title":42},
      {"id":"david/voice-studio","name":"voice-studio","peer":"david","stale":true,"title":"Voice Studio","i18n":{"zh":{"title":"语音工作室"}},"icon":"🎙️","url":"https://voice.example.com/","status":"active","hidden":false,"service":{"port":8811,"health":"ok"}}
    ],"builtins":{"inbox":"/inbox.svg"},"asOf":"2026-10-12T03:34:23.759Z"}
    """
    static let agents = """
    {"ok":true,"agents":[
      {"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant","i18n":{"zh":{"title":"空间助手"}},"avatar":"/assistant.svg","appIcon":"✨","runtime":"claude","modelOptions":[{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku"}]},
      {"id":"todo/planner","app":"todo","name":"planner","title":"Planner","description":"Plans the day.","i18n":{"zh":{"title":"规划师"}},"avatar":"✅","appIcon":"✅"}
    ]}
    """
    static let widgets = """
    {"ok":true,"widgets":[
      {"id":"todo/today","app":"todo","name":"today","title":"Todo · Today","i18n":{"zh":{"title":"待办 · 今天"}},"icon":"✅","link":"https://todo.example.com/","kind":"items","size":"2x1","refreshMs":60000,"ok":true,"items":[{"text":"Review","url":"https://todo.example.com/1","time":"2026-10-12T03:34:23.784Z"}]},
      {"id":"reader/unread","app":"reader","name":"unread","title":"Reader","icon":"📰","link":"https://reader.example.com/","kind":"items","size":"1x1","refreshMs":60000,"ok":false,"error":"widget source unavailable"}
    ],"hidden":[]}
    """
    static let peers = """
    {"ok":true,"peers":[{"name":"david","url":"http://127.0.0.1:18710","health":"down","asOf":"2026-10-12T03:34:17.782Z","error":"fetch failed","stale":true,"apps":1,"agents":0,"widgets":0,"services":1,"duplicates":[]}]}
    """
    static let layout = """
    {"ok":true,"layout":{"order":{"apps":[],"agents":[],"widgets":[]},"hidden":[],"sizes":{},"hiddenWidgets":[],"screens":[{"id":"home","name":"Home","items":["app:todo","builtin:inbox","agent:space/assistant","app:todo","widget:todo/today","app:gone"]},{"id":"s2","name":"","items":["app:docs"]}]}}
    """
    static let router = """
    {"ok":true,"router":"caddy","domain":"Example.com","port":8080,"routes":[]}
    """

    static func payload(apps: String = apps, agents: String = agents, widgets: String = widgets, peers: String? = peers,
                        layout: String? = layout, router: String? = router) -> CataloguePayload {
        CataloguePayload(apps: Data(apps.utf8), agents: Data(agents.utf8), widgets: Data(widgets.utf8),
                         peers: peers.map { Data($0.utf8) }, layout: layout.map { Data($0.utf8) },
                         router: router.map { Data($0.utf8) }, fetchedAt: Date(timeIntervalSince1970: 1_790_000_000))
    }

    static var catalogue: Catalogue { try! Catalogue.decode(payload()) }
}

struct CatalogueTests {
    let space = URL(string: "https://space.example.com/")!

    @Test func listsTheAppsAPersonCanOpen() throws {
        let c = try Catalogue.decode(Fixture.payload())
        // Hidden, archived, page-less and malformed rows are left out; the rest keep the server's order.
        #expect(c.apps.map(\.ref) == ["docs", "todo", "reader", "sleeper", "david/voice-studio"])
        #expect(c.apps.map(\.key).first == "app:docs")
        #expect(c.agents.map(\.key) == ["agent:space/assistant", "agent:todo/planner"])
        #expect(c.widgets.map(\.id) == ["todo/today", "reader/unread"])
        #expect(c.fetchedAt == Date(timeIntervalSince1970: 1_790_000_000))
    }

    @Test func saysHowReachableEachAppIs() {
        let c = Fixture.catalogue
        let reach = Dictionary(uniqueKeysWithValues: c.apps.map { ($0.ref, $0.reach) })
        #expect(reach["docs"] == .link)
        #expect(reach["todo"] == .up)
        #expect(reach["reader"] == .down)
        #expect(reach["sleeper"] == .paused)
        // A stale snapshot wins over the health it recorded while the peer still answered.
        #expect(reach["david/voice-studio"] == .peerOffline)
        #expect(c.peers.first?.isOffline == true)
        #expect(c.peer("david")?.asOf == "2026-10-12T03:34:17.782Z")
    }

    @Test func aDownPeerMarksItsEntriesEvenWithoutTheStaleFlag() throws {
        let apps = Fixture.apps.replacingOccurrences(of: "\"stale\":true,", with: "")
        let c = try Catalogue.decode(Fixture.payload(apps: apps))
        #expect(c.app(named: "voice-studio")?.reach == .peerOffline)
    }

    @Test func picksTheTitleOfTheLanguage() {
        let todo = Fixture.catalogue.app(named: "todo")!
        #expect(todo.displayTitle(lang: "en") == "Todo")
        #expect(todo.displayTitle(lang: "zh") == "待办")
        #expect(todo.displayTitle(lang: "fr") == "Todo")
        #expect(todo.displayDetail(lang: "zh") == "任务与提醒。")
        #expect(Fixture.catalogue.app(named: "docs")?.displayDetail(lang: "zh") == nil)
    }

    @Test func resolvesPagesAgainstTheSpace() {
        let c = Fixture.catalogue
        #expect(c.app(named: "todo")?.pageURL(space: space, lang: "zh")?.absoluteString == "https://todo.example.com/?lang=zh")
        let path = CatalogueEntry(kind: .app, ref: "wiki", title: "Wiki", link: "/wiki/", reach: .link)
        #expect(path.pageURL(space: space)?.absoluteString == "https://space.example.com/wiki/")
        let script = CatalogueEntry(kind: .app, ref: "x", title: "X", link: "javascript:alert(1)", reach: .link)
        #expect(script.pageURL(space: space) == nil)
        #expect(c.agents[0].pageURL(space: space) == nil)
    }

    @Test func readsTheHomeScreenAndTheDomain() throws {
        let c = Fixture.catalogue
        #expect(c.homePins == ["app:todo", "builtin:inbox", "agent:space/assistant", "app:todo", "widget:todo/today", "app:gone"])
        #expect(c.screens?.map(\.id) == ["home", "s2"])
        #expect(c.screens?.last?.items == ["app:docs"])
        #expect(c.domain == "example.com")
        let bare = try Catalogue.decode(Fixture.payload(peers: nil, layout: "{\"ok\":true,\"layout\":{\"screens\":null}}", router: "{\"ok\":true,\"domain\":\"\"}"))
        // A Space that has stored no screens yet shows the home screen its panel would seed.
        #expect(bare.screens == nil)
        #expect(bare.homePins.first == "app:docs")
        #expect(bare.homePins.contains("builtin:inbox"))
        #expect(bare.homePins.contains("widget:todo/today"))
        #expect(bare.domain == nil)
        #expect(bare.peers.isEmpty)
    }

    @Test func refusesAnAnswerThatIsNotASpace() {
        #expect(throws: CatalogueError.notASpace("/api/apps")) {
            try Catalogue.decode(Fixture.payload(apps: "<html>Sign in</html>"))
        }
        #expect(throws: CatalogueError.notASpace("/api/agents")) {
            try Catalogue.decode(Fixture.payload(agents: "{\"ok\":false,\"error\":\"nope\"}"))
        }
    }

    @Test func findsAnAppByIdThenByName() {
        let c = Fixture.catalogue
        #expect(c.app(named: "david/voice-studio")?.ref == "david/voice-studio")
        #expect(c.app(named: "voice-studio")?.ref == "david/voice-studio")
        #expect(c.app(named: "nope") == nil)
        #expect(c.entry("widget:todo/today")?.kind == .widget)
    }

    @Test func thePayloadSurvivesTheCache() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("aispace-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = CatalogueCache(directory: dir)
        let id = UUID()
        #expect(cache.load(id) == nil)
        cache.save(Fixture.payload(), id)
        #expect(cache.load(id) == Fixture.payload())
        #expect(try Catalogue.decode(cache.load(id)!) == Fixture.catalogue)
        cache.remove(id)
        #expect(cache.load(id) == nil)
    }
}

struct CatalogueSearchTests {
    let entries = Fixture.catalogue.entries

    func find(_ q: String) -> [String] { CatalogueSearch.filter(entries, query: q).map(\.key) }

    @Test func matchesEnglishChineseAndId() {
        #expect(find("todo").contains("app:todo"))
        #expect(find("待办") == ["app:todo", "widget:todo/today"])
        #expect(find("voice-studio") == ["app:david/voice-studio"])
        #expect(find("语音") == ["app:david/voice-studio"])
        #expect(find("空间助手") == ["agent:space/assistant"])
    }

    @Test func everyWordMustMatchAndCaseDoesNot() {
        #expect(find("TODO today") == ["widget:todo/today"])
        #expect(find("todo nothing").isEmpty)
        #expect(find("  ").count == entries.count)
        #expect(find("reminders") == ["app:todo"])
        // Full-width letters, as a Chinese keyboard may type them.
        #expect(find("ｔｏｄｏ").contains("app:todo"))
    }
}

struct QuickActionTests {
    @Test func theFirstAppsOfHomeBecomeActions() {
        let c = Fixture.catalogue
        let items = QuickAction.items(pins: ["agent:space/assistant", "app:todo", "app:gone", "app:david/voice-studio", "app:docs", "app:reader", "app:sleeper"], catalogue: c, lang: "zh")
        #expect(items.map(\.title) == ["待办", "语音工作室", "Bun 文档", "Reader"])
        #expect(items[1].subtitle == "david")
        #expect(items[1].url.absoluteString == "aispace://open?app=david/voice-studio")
        // The link is what the deep-link handler reads back.
        #expect(DeepLink(items[1].url) == .open(app: "david/voice-studio"))
        #expect(DeepLink(QuickAction.link(app: "a b&c")!) == .open(app: "a b&c"))
    }

    @Test func anActionNamesTheSpaceItWasMadeFor() throws {
        let space = UUID()
        let action = try #require(QuickAction.items(pins: ["app:todo"], catalogue: Fixture.catalogue).first)
        // Two Spaces may each have a "todo"; the shortcut item says which one it opens.
        let info = action.userInfo(space: space)
        #expect(QuickAction.target(userInfo: info) == QuickAction.Target(url: action.url, space: space))
        // An item published before the Space was carried still opens, in the Space on show.
        #expect(QuickAction.target(userInfo: ["url": "aispace://open?app=todo"]) == QuickAction.Target(url: action.url, space: nil))
        #expect(QuickAction.target(userInfo: ["url": "aispace://open?app=todo", "space": "not a uuid"])?.space == nil)
        #expect(QuickAction.target(userInfo: ["space": space.uuidString]) == nil)
        #expect(QuickAction.target(userInfo: nil) == nil)
    }
}

struct IconSourceTests {
    let space = URL(string: "https://space.example.com/")!

    @Test func theSpacesOwnIconsGoThroughItsSession() {
        #expect(IconSource("/api/apps/todo/icon", space: space) == .space("/api/apps/todo/icon"))
        #expect(IconSource("https://space.example.com/assistant.svg", space: space) == .space("https://space.example.com/assistant.svg"))
        #expect(IconSource("HTTPS://SPACE.example.com:443/a.png", space: space) == .space("HTTPS://SPACE.example.com:443/a.png"))
    }

    @Test func anIconOnAnotherSiteIsNotTheSpaces() {
        let cdn = "https://cdn.example.net/todo.png"
        #expect(IconSource(cdn, space: space) == .external(URL(string: cdn)!))
        // Another app's hostname, another port and a scheme-relative address are other origins too.
        #expect(IconSource("https://todo.example.com/icon.png", space: space) == .external(URL(string: "https://todo.example.com/icon.png")!))
        #expect(IconSource("https://space.example.com:8443/a.png", space: space) == .external(URL(string: "https://space.example.com:8443/a.png")!))
        #expect(IconSource("//cdn.example.net/todo.png", space: space) == .external(URL(string: cdn)!))
        #expect(IconSource("file:///etc/hosts", space: space) == nil)
    }

    /// Why the split exists: the Space's API reads a 200 from any other origin as "sign in".
    @Test func theSpaceAPIRefusesAnAnswerFromAnotherOrigin() {
        let cdn = URL(string: "https://cdn.example.net/todo.png")!
        let ok = HTTPURLResponse(url: cdn, statusCode: 200, httpVersion: nil, headerFields: nil)!
        #expect(throws: SpaceAPIError.authenticationRequired) { try SpaceAPI.check(ok, data: Data(), expected: space) }
    }
}
