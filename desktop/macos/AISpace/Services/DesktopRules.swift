import Foundation

/// Which inbox threads deserve a Mac notification: unread ones that are new or changed since
/// the last look. The first look at a connection only records what is there, so connecting
/// never floods the screen with old messages.
struct InboxSeen: Codable, Equatable {
    var lastAt: [String: String] = [:]
    var seeded = false

    mutating func fresh(_ items: [InboxItem]) -> [InboxItem] {
        defer { seeded = true }
        var out: [InboxItem] = []
        for item in items {
            if seeded && item.unread && !item.done && lastAt[item.thread] != item.lastAt { out.append(item) }
            lastAt[item.thread] = item.lastAt
        }
        // Forget threads that are gone so the record does not grow without bound.
        let present = Set(items.map(\.thread))
        if lastAt.count > 2000 { lastAt = lastAt.filter { present.contains($0.key) } }
        return out
    }
}

/// Which app, if any, a link belongs to: such links open as that app's own window.
enum AppRoutes {
    static func app(for url: URL, in apps: [AppInfo], space: URL) -> AppInfo? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        var best: (app: AppInfo, length: Int)?
        for app in apps {
            guard let page = app.pageURL(space: space), ConnectionRules.sameOrigin(page, url) else { continue }
            var length = 0
            if ConnectionRules.sameOrigin(page, space) {
                // An app served from the panel's own origin owns its path, never the panel's root.
                let prefix = page.path.hasSuffix("/") ? String(page.path.dropLast()) : page.path
                guard !prefix.isEmpty, url.path == prefix || url.path.hasPrefix(prefix + "/") else { continue }
                length = prefix.count
            }
            if best == nil || length > best!.length { best = (app, length) }
        }
        return best?.app
    }
}

/// `aispace://` links, for Shortcuts and other apps. A link may fill in a message but never
/// sends it: any web page can open such a link, so sending always waits for the operator.
enum DeepLink: Equatable {
    case chat(agent: String?, text: String?)
    case open(app: String)
    case inbox
    case show

    static let scheme = "aispace"

    init?(_ url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = { (name: String) in items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
        switch url.host?.lowercased() ?? "" {
        case "chat": self = .chat(agent: q("agent"), text: q("text").map { String($0.prefix(20_000)) })
        case "open":
            guard let app = q("app") else { return nil }
            self = .open(app: app)
        case "inbox": self = .inbox
        case "", "show": self = .show
        default: return nil
        }
    }
}
