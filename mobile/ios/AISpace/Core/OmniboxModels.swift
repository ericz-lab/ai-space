import Foundation

/// The shared command contract (docs/shortcuts.md). Calendar inputs remain strings, never instants.
struct ShortcutAction: Decodable, Identifiable {
    struct Input: Decodable, Identifiable {
        struct Option: Decodable { var value: String; var label: String }
        var name: String
        var type: String
        var label: String
        var required: Bool?
        var `default`: JSONValue?
        var options: [Option]?
        var min: Double?
        var max: Double?
        var id: String { name }
    }
    struct Translation: Decodable {
        var title: String?
        var inputs: [String: String]?
        var options: [String: String]?
    }
    var id: String
    var peer: String?
    var title: String
    var effect: String
    var available: Bool
    var reason: String?
    var idempotent: Bool?
    var inputs: [Input]
    var i18n: [String: Translation]?
    var translation: Translation? {
        let language = Lang.current
        return i18n?[language] ?? i18n?.first(where: { $0.key.split(separator: "-").first.map(String.init) == language })?.value
    }
    var displayTitle: String { translation?.title ?? title }
    func label(_ input: Input) -> String { translation?.inputs?[input.name] ?? input.label }

    func initial(_ args: [String: JSONValue]) -> [String: String] {
        Dictionary(uniqueKeysWithValues: inputs.map { ($0.name, (args[$0.name] ?? $0.default)?.compact ?? "") })
    }
    func valid(_ values: [String: String]) -> Bool {
        inputs.allSatisfy { input in
            let value = (values[input.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { return input.required != true }
            if input.type == "number" {
                guard let n = Double(value), n.isFinite else { return false }
                return n >= (input.min ?? -Double.greatestFiniteMagnitude) && n <= (input.max ?? Double.greatestFiniteMagnitude)
            }
            if input.type == "choice" || input.type == "task" { return input.options?.contains { $0.value == value } == true }
            return true // The server validates calendar dates, times, and periods in the supplied zone.
        }
    }
    func payload(_ values: [String: String]) -> [String: Any] {
        var result: [String: Any] = [:]
        for input in inputs {
            guard let value = values[input.name], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            result[input.name] = input.type == "number" ? Double(value).map { $0 as Any } : value
        }
        return result
    }
}

struct ShortcutIntent: Decodable, Identifiable {
    var kind: String
    var key: String
    var expression: String?
    var action: ShortcutAction?
    var args: [String: JSONValue]?
    var strong: Bool?
    var ambiguous: Bool?
    var id: String { key }
}
struct ShortcutAgentIntent: Decodable, Identifiable {
    var id: String
    var title: String
    var agent: String
    var available: Bool
    var reason: String?
}
struct ShortcutResolution: Decodable {
    var intents: [ShortcutIntent]
    var agentIntents: [ShortcutAgentIntent]
    var ambiguous: Bool
}
struct ShortcutResult: Decodable {
    struct Item: Decodable {
        var title: String
        var url: String?
        var detail: String?
        var source: String?
        var date: String?
        var time: String?
        var timezone: String?
        var at: String?
    }
    var kind: String
    var text: String?
    var value: JSONValue?
    var unit: String?
    var detail: String?
    var source: String?
    var asOf: String?
    var stale: Bool?
    var items: [Item]?
    var task: String?
    var status: String?
    var output: String?
    var error: String?
}
struct ShortcutRun: Decodable, Identifiable {
    var id: Int
    var title: String
    var status: String
    var effect: String
    var result: ShortcutResult?
    var error: String?
    var createdAt: String
}

/// Provisional text replaces its segment; final events commit even an empty correction.
struct VoiceTranscript {
    let prefix: String
    private var segments: [Int: (text: String, final: Bool)] = [:]
    init(prefix: String) { self.prefix = prefix }
    mutating func update(id: Int, text: String, final: Bool) -> String {
        if segments[id]?.final != true { segments[id] = (text, final) }
        return ([prefix] + segments.keys.sorted().compactMap { segments[$0]?.text })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }.joined(separator: " ")
    }
}

/// The realtime service accepts at most 100 ms (3,200 bytes) of PCM per message.
struct VoicePCMFrames {
    private var pending = Data()
    mutating func append(_ data: Data) -> [Data] {
        pending.append(data)
        var frames: [Data] = []
        while pending.count >= 3200 {
            frames.append(Data(pending.prefix(3200)))
            pending.removeFirst(3200)
        }
        return frames
    }
    mutating func finish() -> Data? {
        guard !pending.isEmpty else { return nil }
        defer { pending = Data() }
        return pending
    }
}
