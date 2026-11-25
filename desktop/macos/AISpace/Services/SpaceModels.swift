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

/// The language voice input asks the Space to transcribe in (docs/speech.md#languages), the same
/// rule on the Mac and the iPhone: by default the app's own language (`Lang.current`), else what
/// Settings › General › Voice Language names. Sending one makes the transcriber faster and keeps
/// Mandarin from being heard as Cantonese.
enum VoiceLanguage {
    /// Where the setting is kept, in the app's user defaults.
    static let defaultsKey = "voiceLanguage"
    /// The setting's value for "Same as AI Space", the default.
    static let sameAsApp = ""
    /// The setting's value for "Detect automatically": nothing is sent, the provider detects it.
    static let detect = "auto"
    /// The languages Settings offers: codes every speech provider of the Space takes as they are.
    static let codes = ["zh", "en", "ja", "ko"]

    /// The `language` to send for a setting; empty lets the provider detect it. The app's language
    /// counts only when it is one of `codes`.
    static func code(setting: String?, appLanguage: String = Lang.current) -> String {
        let setting = setting ?? sameAsApp
        if setting == detect { return "" }
        if codes.contains(setting) { return setting }
        let primary = String(appLanguage.split(separator: "-").first ?? "").lowercased()
        return codes.contains(primary) ? primary : ""
    }

    /// The code for the setting saved on this device.
    static var current: String { code(setting: UserDefaults.standard.string(forKey: defaultsKey)) }

    /// The live protocol's `start` message (docs/speech.md#live-protocol).
    static func startMessage(language: String) -> String {
        let language = codes.contains(language) ? language : ""
        return "{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"\(language)\"}"
    }

    /// The multipart fields of a clip sent to `POST /api/voice/transcribe`: none when detecting.
    static func uploadFields(language: String) -> [(String, String)] {
        codes.contains(language) ? [("language", language)] : []
    }
}

/// The placeholders a manifest `url` may carry for the client that opens it (docs/app-spec.md#app-pages):
/// `{lang}`, and `{accent}`, the accent of the theme on show as `<light>.<dark>`, six hex digits each
/// (docs/ui-kit.md#accent). The percent-encoded forms are the same placeholders after URL normalisation.
enum PagePlaceholders {
    /// The `{accent}` value of this client's theme; the views' `Theme.current` keeps it. Empty until a
    /// theme is set, which a page reads as no accent and ignores.
    static var accent = ""

    /// `<light>.<dark>` from two 0xRRGGBB colours.
    static func accent(light: UInt32, dark: UInt32) -> String {
        String(format: "%06x.%06x", light & 0xFFFFFF, dark & 0xFFFFFF)
    }

    static func fill(_ url: String, lang: String, accent: String = PagePlaceholders.accent) -> String {
        url.replacingOccurrences(of: "{lang}", with: lang).replacingOccurrences(of: "%7Blang%7D", with: lang)
            .replacingOccurrences(of: "{accent}", with: accent).replacingOccurrences(of: "%7Baccent%7D", with: accent)
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
    /// Set on a peer's agent while that machine does not answer.
    var stale: Bool?

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

    /// The app's page with `{lang}` and `{accent}` filled in, resolved against the Space when it is a path.
    func pageURL(space: URL, lang: String = Lang.current, accent: String = PagePlaceholders.accent) -> URL? {
        guard let url, !url.isEmpty else { return nil }
        let filled = PagePlaceholders.fill(url, lang: lang, accent: accent)
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
    /// The stored session the turn continues, if any.
    var sessionId: String? = nil
    /// The session the runtime named for the turn, once it has.
    var sid: String? = nil
}

struct RunsResponse: Decodable {
    var runs: [ChatRun]
}

enum SpacePath {
    static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
    }
}
