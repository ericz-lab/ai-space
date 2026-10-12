import Foundation

/// The Space API's shapes as the desktop app reads them (src/web/api.ts has the full ones).
/// Every field the app can live without is optional, so a newer or older server still decodes.

/// Manifest text by language tag: `{ "zh": { "title": ..., "description": ... } }`.
typealias I18n = [String: LocalizedText]

struct LocalizedText: Decodable, Hashable {
    var title: String?
    var description: String?
}

enum Lang {
    /// The first preferred language's primary tag, `en` or `zh` in practice.
    static var current: String {
        let first = Locale.preferredLanguages.first ?? "en"
        return String(first.split(separator: "-").first ?? "en").lowercased()
    }

    static func pick(_ base: String, _ i18n: I18n?, _ key: KeyPath<LocalizedText, String?>, lang: String = current) -> String {
        guard let i18n else { return base }
        if let v = i18n[lang]?[keyPath: key], !v.isEmpty { return v }
        if let match = i18n.first(where: { $0.key.split(separator: "-").first.map(String.init) == lang })?.value[keyPath: key], !match.isEmpty {
            return match
        }
        return base
    }
}

struct AgentInfo: Decodable, Identifiable, Hashable {
    var id: String
    var peer: String?
    var app: String
    var name: String
    var title: String
    var description: String?
    var i18n: I18n?
    var avatar: String?
    var runtime: String?

    var displayTitle: String { Lang.pick(title, i18n, \.title) }

    /// The route base of the agent's chat: local, or forwarded to the peer that owns it.
    var base: String {
        let prefix = peer.map { "/api/peers/\(SpacePath.escape($0))" } ?? "/api"
        return "\(prefix)/agents/\(SpacePath.escape(app))/\(SpacePath.escape(name))"
    }
}

struct AppInfo: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var peer: String?
    var stale: Bool?
    var title: String
    var description: String?
    var i18n: I18n?
    var icon: String?
    var url: String?
    var status: String?
    var hidden: Bool?

    var displayTitle: String { Lang.pick(title, i18n, \.title) }

    /// The app's page with `{lang}` filled in, resolved against the Space when it is a path.
    func pageURL(space: URL, lang: String = Lang.current) -> URL? {
        guard let url, !url.isEmpty else { return nil }
        let filled = url.replacingOccurrences(of: "{lang}", with: lang)
        return URL(string: filled, relativeTo: space)?.absoluteURL
    }
}

struct AppsResponse: Decodable {
    var apps: [AppInfo]
}

struct AgentsResponse: Decodable {
    var agents: [AgentInfo]
}

struct InboxItem: Decodable, Identifiable, Hashable {
    var thread: String
    var app: String
    var level: String
    var title: String?
    var text: String
    var url: String?
    var count: Int
    var lastAt: String
    var unread: Bool
    var done: Bool

    var id: String { thread }
}

struct InboxSummary: Decodable, Hashable {
    var unread: Int
    var open: Int
}

struct InboxResponse: Decodable {
    var items: [InboxItem]
    var summary: InboxSummary
}

struct ChatRun: Decodable, Identifiable, Hashable {
    var id: String
    var agent: String
    var message: String
    var status: String
    var startedAt: Double
    var lastSeq: Int
}

struct RunsResponse: Decodable {
    var runs: [ChatRun]
}

enum SpacePath {
    static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }
}
