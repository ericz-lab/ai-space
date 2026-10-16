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

#if canImport(UIKit)
import UIKit
import WebKit

struct SVGRasterizerTests {
    @Test(.timeLimit(.minutes(1))) @MainActor
    func snapshotPreservesArtworkOpacityAndColor() async throws {
        let svg = Data("""
        <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
          <rect width="96" height="96" fill="#ff0000"/>
        </svg>
        """.utf8)
        let image = try #require(await SVGRasterizer.shared.image(svg: svg))
        let cgImage = try #require(image.cgImage)
        var pixels = [UInt8](repeating: 0, count: 96 * 96 * 4)
        try pixels.withUnsafeMutableBytes { bytes in
            let context = try #require(CGContext(data: bytes.baseAddress, width: 96, height: 96,
                bitsPerComponent: 8, bytesPerRow: 96 * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 96, height: 96))
        }
        let center = (48 * 96 + 48) * 4
        #expect(pixels[center] > 240, "The red artwork must keep its original intensity")
        #expect(pixels[center + 1] < 15)
        #expect(pixels[center + 2] < 15)
        #expect(pixels[center + 3] > 240, "The renderer's hiding mechanism must not fade the bitmap")
    }
}
struct WebCookieSessionTests {
    @Test(.timeLimit(.minutes(1))) @MainActor
    func concurrentReadsReuseTheProfileAndSignOutStaysSignedOut() async throws {
        let id = UUID(), otherID = UUID()
        defer {
            WKWebsiteDataStore.remove(forIdentifier: id) { _ in }
            WKWebsiteDataStore.remove(forIdentifier: otherID) { _ in }
        }
        let session = WebCookieSession(identifier: id)
        async let first = session.cookies()
        async let second = session.cookies()
        let initial = await (first, second)
        #expect(initial.0.isEmpty && initial.1.isEmpty)
        #expect(session.dataStore.isPersistent)
        #expect(session.dataStore.identifier == id)

        let cookie = try #require(HTTPCookie(properties: [.domain: "session.example.com", .path: "/",
            .name: "test-session", .value: "fixture", .secure: "TRUE", .expires: Date().addingTimeInterval(3600)]))
        await session.dataStore.httpCookieStore.setCookie(cookie)
        let reopened = WebCookieSession(identifier: id)
        #expect(await reopened.cookies().contains { $0.name == cookie.name && $0.value == cookie.value })
        let other = WebCookieSession(identifier: otherID)
        #expect(await other.cookies().isEmpty)

        await session.dataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        #expect(await reopened.cookies().isEmpty)
    }
}
@MainActor
struct IconCacheTests {
    private func image(_ color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16)).image { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        }
    }

    private func pixels(_ image: UIImage?) -> [UInt8]? {
        guard let image = image?.cgImage else { return nil }
        var bytes = [UInt8](repeating: 0, count: 16 * 16 * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: 16, height: 16,
                bitsPerComponent: 8, bytesPerRow: 16 * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
        }
        return bytes
    }

    private func settle(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(condition(), "The pending icon request must finish")
    }

    @Test(.timeLimit(.minutes(1)))
    func relaunchUsesDiskAndStaleRefreshKeepsTheOldIcon() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let api = SpaceAPI(base: URL(string: "https://icons.example.com")!, cookies: { [] })
        let red = image(.red), blue = image(.blue), icon = "/api/apps/test/icon"
        let initial = Date()
        let first = IconStore(api: api, directory: directory, now: { initial }, loadImage: { _ in red })
        #expect(first.image(icon) == nil)
        try await settle { first.image(icon) != nil }

        var calls = 0
        let reopened = IconStore(api: api, directory: directory, now: { initial }, loadImage: { _ in calls += 1; return nil })
        #expect(pixels(reopened.image(icon)) == pixels(red))
        await Task.yield()
        #expect(calls == 0)

        var replacement: UIImage?
        let stale = IconStore(api: api, directory: directory, now: { initial.addingTimeInterval(2 * 86400) },
                              loadImage: { _ in calls += 1; return replacement })
        #expect(pixels(stale.image(icon)) == pixels(red))
        try await settle { calls == 1 }
        #expect(pixels(stale.image(icon)) == pixels(red))
        replacement = blue
        stale.retryFailed()
        #expect(pixels(stale.image(icon)) == pixels(red))
        try await settle { pixels(stale.image(icon)) == pixels(blue) }
        #expect(calls == 2)

        let anotherOrigin = IconStore(api: SpaceAPI(base: URL(string: "https://other.example.com")!, cookies: { [] }),
                                      directory: directory, loadImage: { _ in nil })
        #expect(anotherOrigin.image(icon) == nil)
    }

    @Test(.timeLimit(.minutes(1)))
    func iconUpdatesAreScopedAndRepeatedReadsShareOneRequest() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var waiting: CheckedContinuation<UIImage?, Never>?
        var calls = 0
        let store = IconStore(api: SpaceAPI(base: URL(string: "https://icons.example.com")!, cookies: { [] }),
                              directory: directory, loadImage: { _ in
            calls += 1
            return await withCheckedContinuation { waiting = $0 }
        })
        var visibleUpdates = 0, unrelatedUpdates = 0
        let visible = store.updates.filter { $0 == nil || $0 == "/one.svg" }.sink { _ in visibleUpdates += 1 }
        let unrelated = store.updates.filter { $0 == nil || $0 == "/two.svg" }.sink { _ in unrelatedUpdates += 1 }
        defer { visible.cancel(); unrelated.cancel() }
        for _ in 0..<100 { #expect(store.image("/one.svg") == nil) }
        try await settle { waiting != nil }
        #expect(calls == 1)
        waiting?.resume(returning: image(.red))
        try await settle { visibleUpdates == 1 }
        #expect(unrelatedUpdates == 0)
        for _ in 0..<100 { #expect(store.image("/one.svg") != nil) }
        #expect(calls == 1)
        #expect(visibleUpdates == 1)
        store.clear()
        #expect(visibleUpdates == 2)
        #expect(unrelatedUpdates == 1)
    }

    @Test(.timeLimit(.minutes(1)))
    func refreshingRetriesAFailedVisibleIconWithoutRebuildingItsParent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var calls = 0
        let red = image(.red)
        let store = IconStore(api: SpaceAPI(base: URL(string: "https://icons.example.com")!, cookies: { [] }),
                              directory: directory, loadImage: { _ in
            calls += 1
            return calls == 1 ? nil : red
        })
        var displayed: UIImage?
        let subscription = store.updates.filter { $0 == "/retry.svg" }.sink { _ in
            displayed = store.image("/retry.svg")
        }
        defer { subscription.cancel() }
        #expect(store.image("/retry.svg") == nil)
        try await settle { calls == 1 }
        store.retryFailed()
        try await settle { displayed != nil }
        #expect(calls == 2)
    }

    @Test(.timeLimit(.minutes(1)))
    func signOutDropsAnInFlightImageAndItsDiskCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var waiting: CheckedContinuation<UIImage?, Never>?
        let api = SpaceAPI(base: URL(string: "https://icons.example.com")!, cookies: { [] })
        let store = IconStore(api: api, directory: directory, loadImage: { _ in
            await withCheckedContinuation { waiting = $0 }
        })
        _ = store.image("/icon.svg")
        try await settle { waiting != nil }
        store.clear()
        waiting?.resume(returning: image(.red))
        // Let the suspended request complete after the cache's generation changes.
        try await Task.sleep(for: .milliseconds(50))
        #expect(!FileManager.default.fileExists(atPath: directory.path))
        let reopened = IconStore(api: api, directory: directory, loadImage: { _ in nil })
        #expect(reopened.image("/icon.svg") == nil)
    }
}
@MainActor
struct AppBrowserTests {
    @Test func verticalGesturesHaveThresholdsAndIgnoreHorizontalNavigation() {
        var gesture = BrowserControlGesture()
        #expect(gesture.update(x: 1, y: -10) == nil)
        #expect(gesture.update(x: 2, y: -25) == true)
        #expect(gesture.update(x: 2, y: -22) == nil)
        #expect(gesture.update(x: 2, y: -23) == nil)
        #expect(gesture.update(x: 1, y: 4) == false)
        gesture = BrowserControlGesture()
        #expect(gesture.update(x: 90, y: -30) == nil)
        #expect(gesture.update(x: 150, y: -60) == nil)
        gesture = BrowserControlGesture()
        #expect(gesture.update(x: 0, y: 30) == false)
    }

    @Test func opensOnTheFirstScreenOfThePanel() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ConnectionStore(fileURL: directory.appendingPathComponent("connections.json"))
        _ = store.add(name: "First", url: URL(string: "https://first.example.com")!)
        let second = store.add(name: "Second", url: URL(string: "https://second.example.com")!)
        let model = AppModel(store: store, screens: ScreenStore(fileURL: directory.appendingPathComponent("screens.json")))
        #expect(model.pagerID == Screens.home)
        #expect(model.tab == .panel)
        // Another Space starts on its first screen too, wherever this one was left.
        model.tab = .settings
        model.select(second.id)
        #expect(model.pagerID == Screens.home)
    }

    @Test func returnToSpaceShowsTheLastAppScreen() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ConnectionStore(fileURL: directory.appendingPathComponent("connections.json"))
        let connection = store.add(name: "Space", url: URL(string: "https://space.example.com")!)
        let screens = ScreenStore(fileURL: directory.appendingPathComponent("screens.json"))
        let model = AppModel(store: store, screens: screens)
        model.pager.id = Pager.home
        model.returnToSpace()
        #expect(model.pagerID == Screens.home)
        #expect(model.tab == .panel)

        model.addScreen(in: connection)
        let second = model.pagerID
        #expect(second != Screens.home)
        model.pagerID = Screens.home
        // Swipes write to PagerPosition directly, without AppModel's pagerID setter.
        model.pager.id = Screens.home
        model.pager.id = second
        model.pager.id = Pager.home
        model.returnToSpace()
        #expect(model.pagerID == second)
        model.pager.id = Pager.settings
        model.returnToSpace()
        #expect(model.pagerID == second)

        screens.edit(connection.id) { Screens.remove($0, second) }
        model.returnToSpace()
        #expect(model.pagerID == Screens.home)
    }

    @Test(.timeLimit(.minutes(1))) func tabsRetainPagesAndStayIsolatedUntilExplicitlyClosed() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ConnectionStore(fileURL: directory.appendingPathComponent("connections.json"))
        let first = store.add(name: "First", url: URL(string: "https://first.example.com")!)
        let second = store.add(name: "Second", url: URL(string: "https://second.example.com")!)
        let model = AppModel(store: store, screens: ScreenStore(fileURL: directory.appendingPathComponent("screens.json")))
        defer {
            WKWebsiteDataStore.remove(forIdentifier: first.id) { _ in }
            WKWebsiteDataStore.remove(forIdentifier: second.id) { _ in }
        }
        let url = first.url.appendingPathComponent("reader")
        model.open(url, title: "Reader", key: "reader", in: first)
        let reader = try #require(model.page)
        reader.session.webView.loadHTMLString("<body style='height:4000px'><input id='draft' value='unsent'></body>", baseURL: first.url)
        for _ in 0..<100 {
            if (try? await reader.session.webView.evaluateJavaScript("document.getElementById('draft').value")) as? String == "unsent" { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        model.returnToSpace()
        #expect(model.tab == .panel)
        #expect(model.page == nil)
        model.open(url, title: "Reader", key: "reader", in: first)
        #expect(model.page?.id == reader.id)
        #expect(model.page?.session === reader.session)
        #expect(try await reader.session.webView.evaluateJavaScript("document.getElementById('draft').value") as? String == "unsent")
        model.open(first.url.appendingPathComponent("notes"), title: "Notes", in: first)
        let notes = try #require(model.page)
        model.showTab(reader.id)
        #expect(model.page?.id == reader.id)
        model.closeTab(reader.id)
        #expect(model.page?.id == notes.id)
        model.select(second.id)
        #expect(model.page == nil)
        model.showTab(notes.id)
        #expect(model.page == nil, "Another Space's tab must not be selectable")
        model.open(second.url.appendingPathComponent("notes"), title: "Notes", in: second)
        let other = try #require(model.page)
        #expect(other.session.webView.configuration.websiteDataStore.identifier != notes.session.webView.configuration.websiteDataStore.identifier)
        model.signOut(first)
        #expect(model.appTabs.map(\.id) == [other.id])
        model.closeTab(other.id)
        #expect(model.page == nil && model.appTabs.isEmpty)
        model.open(second.url.appendingPathComponent("notes"), title: "Notes", in: second)
        #expect(model.page?.id != other.id, "An explicitly closed tab gets a new session")
        model.remove(second.id)
        #expect(model.appTabs.isEmpty && model.page == nil)
    }
}
@MainActor
struct AppPageBackgroundTests {
    @Test(.timeLimit(.minutes(1))) func followsPageCSSAndNavigationWithoutChangingTheWebsiteTheme() async throws {
        let url = URL(string: "https://background.example.com")!
        let session = WebSession(space: url, home: url, dataStore: .nonPersistent(), hosts: { SpaceHosts(space: url) })
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        controller.view.addSubview(session.webView)
        session.webView.frame = controller.view.bounds
        window.isHidden = false
        defer { window.isHidden = true; session.webView.removeFromSuperview() }

        func matches(_ color: UIColor, _ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> Bool {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return false }
            return abs(r - red / 255) < 0.01 && abs(g - green / 255) < 0.01 && abs(b - blue / 255) < 0.01 && a > 0.99
        }
        func waitForColor(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) async throws {
            for _ in 0..<150 {
                if matches(session.pageBackground, red, green, blue) { return }
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(matches(session.pageBackground, red, green, blue), "Native safe areas must match the rendered page background")
        }

        session.webView.loadHTMLString("<style>html,body{margin:0;min-height:100%;background:rgb(242,245,249)}</style><body>Light</body>", baseURL: url)
        try await waitForColor(242, 245, 249)
        let originalScheme = try await session.webView.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool
        _ = try await session.webView.evaluateJavaScript("document.documentElement.style.background='rgb(12,15,19)';document.body.style.background='rgb(12,15,19)'")
        try await waitForColor(12, 15, 19)
        #expect(try await session.webView.evaluateJavaScript("matchMedia('(prefers-color-scheme: dark)').matches") as? Bool == originalScheme)
        session.webView.loadHTMLString("<style>html{background:rgb(210,230,240)}body{background:transparent}</style><body>Next page</body>", baseURL: url)
        try await waitForColor(210, 230, 240)
    }
}
#endif
