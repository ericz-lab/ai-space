import Foundation

/// Home-screen quick actions: the first apps of the home screen, each as an `aispace://open` link that
/// goes through the same handler as a link from Shortcuts or another app (DeepLink).
struct QuickAction: Equatable {
    static let type = "dev.ai-space.ios.open"
    /// iOS shows about four; more are dropped by the system.
    static let limit = 4

    var title: String
    var subtitle: String?
    var url: URL

    static func items(pins: [String], catalogue: Catalogue, lang: String = Lang.current) -> [QuickAction] {
        pins.lazy
            .compactMap { catalogue.entry($0) }
            .filter { $0.kind == .app }
            .prefix(limit)
            .compactMap { e in
                link(app: e.ref).map { QuickAction(title: e.displayTitle(lang: lang), subtitle: e.peer, url: $0) }
            }
    }

    /// What a shortcut item brings back: the link, and the Space whose app it opens. The
    /// link alone names an app, and the Space on show after a cold start is the default one,
    /// which need not be the one the items were made for.
    struct Target: Equatable {
        var url: URL
        var space: UUID?
    }

    func userInfo(space: UUID) -> [String: String] {
        ["url": url.absoluteString, "space": space.uuidString]
    }

    static func target(userInfo: [String: Any]?) -> Target? {
        guard let text = userInfo?["url"] as? String, let url = URL(string: text) else { return nil }
        return Target(url: url, space: (userInfo?["space"] as? String).flatMap(UUID.init(uuidString:)))
    }

    static func link(app: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = DeepLink.scheme
        parts.host = "open"
        parts.queryItems = [URLQueryItem(name: "app", value: app)]
        return parts.url
    }
}
