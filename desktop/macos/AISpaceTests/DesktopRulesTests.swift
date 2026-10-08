import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct DesktopRulesTests {
    func item(_ thread: String, _ lastAt: String, unread: Bool = true, done: Bool = false) -> InboxItem {
        InboxItem(thread: thread, app: "todo", level: "info", title: nil, text: "x", url: nil, count: 1, lastAt: lastAt, unread: unread, done: done)
    }

    @Test func firstLookOnlyRecords() {
        var seen = InboxSeen()
        #expect(seen.fresh([item("a", "1"), item("b", "1")]).isEmpty)
        #expect(seen.fresh([item("a", "1"), item("b", "2"), item("c", "1"), item("d", "1", unread: false)]).map(\.thread) == ["b", "c"])
        #expect(seen.fresh([item("a", "1"), item("b", "2")]).isEmpty)
    }

    let space = URL(string: "https://space.example.com/")!

    func app(_ name: String, _ url: String) -> AppInfo {
        AppInfo(id: name, name: name, title: name, url: url)
    }

    @Test func linksFindTheirApp() {
        let apps = [app("todo", "https://todo.example.com/?lang={lang}"), app("notes", "/apps/notes/"), app("none", "")]
        #expect(AppRoutes.app(for: URL(string: "https://todo.example.com/task/3")!, in: apps, space: space)?.name == "todo")
        #expect(AppRoutes.app(for: URL(string: "https://space.example.com/apps/notes/x")!, in: apps, space: space)?.name == "notes")
        #expect(AppRoutes.app(for: URL(string: "https://space.example.com/settings")!, in: apps, space: space) == nil)
        #expect(AppRoutes.app(for: URL(string: "https://github.com/x")!, in: apps, space: space) == nil)
        #expect(apps[0].pageURL(space: space, lang: "zh")?.absoluteString == "https://todo.example.com/?lang=zh")
    }

    @Test func deepLinksNeverSend() {
        #expect(DeepLink(URL(string: "aispace://chat?agent=ai-todo/planner&text=hi")!) == .chat(agent: "ai-todo/planner", text: "hi"))
        #expect(DeepLink(URL(string: "aispace://chat")!) == .chat(agent: nil, text: nil))
        #expect(DeepLink(URL(string: "aispace://open?app=ai-todo")!) == .open(app: "ai-todo"))
        #expect(DeepLink(URL(string: "aispace://open")!) == nil)
        #expect(DeepLink(URL(string: "aispace://inbox")!) == .inbox)
        #expect(DeepLink(URL(string: "aispace://run?cmd=rm")!) == nil)
        #expect(DeepLink(URL(string: "https://chat")!) == nil)
    }

    @Test func cookiesFollowDomainPathAndSecurity() {
        func cookie(_ name: String, domain: String, path: String = "/", secure: Bool = false, expires: Date? = nil) -> HTTPCookie {
            var p: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "v", .domain: domain, .path: path]
            if secure { p[.secure] = "TRUE" }
            if let expires { p[.expires] = expires }
            return HTTPCookie(properties: p)!
        }
        let all = [
            cookie("host", domain: "space.example.com"),
            cookie("wide", domain: ".example.com"),
            cookie("other", domain: "todo.example.com"),
            cookie("api", domain: "space.example.com", path: "/api"),
            cookie("old", domain: "space.example.com", expires: Date(timeIntervalSinceNow: -60)),
            cookie("tls", domain: "space.example.com", secure: true),
        ]
        let names = { (url: String) in Set(Cookies.matching(all, for: URL(string: url)!).map(\.name)) }
        #expect(names("https://space.example.com/api/apps") == ["host", "wide", "api", "tls"])
        #expect(names("https://space.example.com/") == ["host", "wide", "tls"])
        #expect(names("http://space.example.com/apix") == ["host", "wide"])
        #expect(names("https://example.com/") == ["wide"])
    }

    @Test func responsesMapToErrors() throws {
        let base = URL(string: "https://space.example.com/")!
        func response(_ status: Int, _ url: String = "https://space.example.com/api/apps") -> HTTPURLResponse {
            HTTPURLResponse(url: URL(string: url)!, statusCode: status, httpVersion: nil, headerFields: nil)!
        }
        try SpaceAPI.check(response(200), data: Data(), expected: base)
        #expect(throws: SpaceAPIError.authenticationRequired) { try SpaceAPI.check(response(302), data: Data(), expected: base) }
        #expect(throws: SpaceAPIError.authenticationRequired) { try SpaceAPI.check(response(403), data: Data(), expected: base) }
        #expect(throws: SpaceAPIError.authenticationRequired) {
            try SpaceAPI.check(response(200, "https://team.cloudflareaccess.com/login"), data: Data(), expected: base)
        }
        #expect(throws: SpaceAPIError.http(400, "bad agent")) {
            try SpaceAPI.check(response(400), data: Data(#"{"ok":false,"error":"bad agent"}"#.utf8), expected: base)
        }
    }

    @Test func manifestTextFollowsTheLanguage() {
        let i18n: I18n = ["zh": LocalizedText(title: "待办", description: nil), "ja-JP": LocalizedText(title: "やること", description: nil)]
        #expect(Lang.pick("Todo", i18n, \.title, lang: "zh") == "待办")
        #expect(Lang.pick("Todo", i18n, \.title, lang: "ja") == "やること")
        #expect(Lang.pick("Todo", i18n, \.title, lang: "en") == "Todo")
        #expect(Lang.pick("Todo", nil, \.title, lang: "zh") == "Todo")
    }
}
