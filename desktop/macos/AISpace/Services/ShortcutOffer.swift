import Foundation

/// Shortcuts in Home's command box (docs/shortcuts.md#native-search-and-shared-resolution): after a
/// pause in typing the Space reads the text (`POST /api/shortcuts/resolve`), and when it names one
/// thing to run (arithmetic, a conversion, an action named at its start, such as `待办 明天下午3点 写周报`)
/// the box offers it before Ask Space Assistant, and Return opens the panel's Shortcuts page on it
/// (`/?page=shortcuts&run=<text>`, src/web/Shortcuts.tsx), where its form is filled from the text.
/// The rule is the web panel's (`intentToRun` in src/web/shortcuts.ts) and the Linux client's
/// (desktop/linux/src/core/shortcuts.ts). Read leniently: an answer this client does not understand
/// offers nothing, and the box goes on as before.
struct ShortcutOffer: Equatable {
    var title: String
    /// What the text filled, one line: "Title: Write the report · Date: tomorrow".
    var detail: String

    static let resolvePath = "/api/shortcuts/resolve"
    /// The box asks the Space after this pause in typing.
    static let resolveAfter: Duration = .milliseconds(250)

    /// The page Return opens for the sentence.
    static func runPath(_ text: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return "/?page=shortcuts&run=" + (text.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// The offer for a resolve answer, or nil: the first intent, when it is arithmetic, a conversion or
    /// an action named at the start, the sentence means one thing only, no agent's skill took it, and
    /// the action can run. Arithmetic shows its expression under `calculator`.
    static func from(_ data: Data, lang: String, calculator: String) -> ShortcutOffer? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if root["ambiguous"] as? Bool == true { return nil }
        if let agents = root["agentIntents"] as? [Any], !agents.isEmpty { return nil }
        guard let first = (root["intents"] as? [Any])?.first as? [String: Any], let kind = first["kind"] as? String else { return nil }
        if kind == "calc" {
            guard let e = first["expression"] as? String, !e.isEmpty else { return nil }
            return ShortcutOffer(title: calculator, detail: e)
        }
        guard kind == "action" || kind == "convert" else { return nil }
        if kind == "action", first["strong"] as? Bool != true || first["ambiguous"] as? Bool == true { return nil }
        guard let action = first["action"] as? [String: Any], action["available"] as? Bool != false else { return nil }
        let translated = (action["i18n"] as? [String: Any])?.first { $0.key.split(separator: "-").first.map(String.init) == lang }?.value as? [String: Any]
        let title = nonEmpty(translated?["title"]) ?? nonEmpty(action["title"]) ?? nonEmpty(action["id"]) ?? ""
        let labels = translated?["inputs"] as? [String: Any] ?? [:]
        let args = first["args"] as? [String: Any] ?? [:]
        var parts: [String] = []
        for case let input as [String: Any] in action["inputs"] as? [Any] ?? [] {
            guard let name = input["name"] as? String, let value = scalar(args[name]), !value.isEmpty else { continue }
            parts.append("\(nonEmpty(labels[name]) ?? nonEmpty(input["label"]) ?? name): \(value)")
        }
        return ShortcutOffer(title: title, detail: parts.joined(separator: " · "))
    }

    private static func nonEmpty(_ v: Any?) -> String? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return s
    }

    private static func scalar(_ v: Any?) -> String? {
        switch v {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }
}
