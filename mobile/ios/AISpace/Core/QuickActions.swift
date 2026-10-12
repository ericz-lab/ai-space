import Foundation

/// Home-screen quick actions: the first favourite apps, each as an `aispace://open` link that
/// goes through the same handler as a link from Shortcuts or another app (DeepLink).
struct QuickAction: Equatable {
    static let type = "dev.ai-space.ios.open"
    /// iOS shows about four; more are dropped by the system.
    static let limit = 4

    var title: String
    var subtitle: String?
    var url: URL

    static func items(favorites: [String], catalogue: Catalogue, lang: String = Lang.current) -> [QuickAction] {
        favorites.lazy
            .compactMap { catalogue.entry($0) }
            .filter { $0.kind == .app }
            .prefix(limit)
            .compactMap { e in
                link(app: e.ref).map { QuickAction(title: e.displayTitle(lang: lang), subtitle: e.peer, url: $0) }
            }
    }

    static func link(app: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = DeepLink.scheme
        parts.host = "open"
        parts.queryItems = [URLQueryItem(name: "app", value: app)]
        return parts.url
    }
}
