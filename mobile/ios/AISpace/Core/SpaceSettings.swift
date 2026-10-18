import Foundation

/// What the Space's own settings show about itself (src/web/SettingsStatus.tsx): the services it
/// knows of and the backups of its apps, from `GET /api/services` and `GET /api/backups`. Peers
/// come with the catalogue. A malformed row is skipped, as in the catalogue.

struct SpaceService: Decodable, Hashable, Identifiable {
    var app: String
    var peer: String?
    var title: String
    var i18n: I18n?
    var icon: String?
    var port: Int?
    var health: String?
    var status: String?
    /// Who runs the process: the Space, or the operator (docs/supervision.md).
    var supervisor: String?

    var id: String { peer.map { "\($0)/\(app)" } ?? app }
    var displayTitle: String { Lang.pick(title, i18n, \.title) }

    enum State: Equatable {
        case running, down, paused, unknown
    }

    var state: State {
        if status == "paused" || status == "archived" { return .paused }
        switch health {
        case "ok": return .running
        case "down": return .down
        default: return .unknown
        }
    }
}

struct SpaceBackup: Decodable, Hashable, Identifiable {
    var app: String
    var count: Int?
    /// Milliseconds since 1970, as the route sends them.
    var lastAt: Double?
    var lastStatus: String?
    var lastError: String?
    var lastOkAt: Double?
    var lastOkBytes: Double?
    var stale: Bool?
    var retired: Bool?

    var id: String { app }
    var lastOk: Date? { lastOkAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    enum State: Equatable {
        /// The last run saved a snapshot, recently enough.
        case ok
        /// The newest snapshot is older than the Space allows.
        case stale
        case failed
        /// No backup task will run again; the snapshots are history.
        case retired
        case none
    }

    var state: State {
        if retired == true { return .retired }
        if lastStatus == "error" { return .failed }
        if stale == true { return .stale }
        return lastOkAt == nil ? .none : .ok
    }
}

/// The Space's default model (`GET` and `PUT /api/model/preferences`): what app requests and
/// new Space Assistant chats use when nothing chooses a model for them.
struct ModelPreferences: Decodable, Equatable {
    struct Option: Codable, Hashable, Identifiable {
        var value: String
        var runtime: String?
        var tier: String?
        var model: String?

        var id: String { value }
        /// "codex · basic · gpt-6-luna", as the panel's menu writes it.
        var label: String {
            let parts = [runtime, tier.map { $0.prefix(1).uppercased() + $0.dropFirst() }, model].compactMap { $0 }.filter { !$0.isEmpty }
            return parts.isEmpty ? value : parts.joined(separator: " · ")
        }
    }

    /// nil while the Space follows its environment's defaults.
    var defaultModel: String?
    var appDefault: String?
    var baseDefault: String?
    var options: [Option]

    private enum CodingKeys: String, CodingKey { case defaultModel, appDefault, baseDefault, options }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultModel = try? c.decode(String.self, forKey: .defaultModel)
        appDefault = try? c.decode(String.self, forKey: .appDefault)
        baseDefault = try? c.decode(String.self, forKey: .baseDefault)
        options = try c.decode(Lossy<Option>.self, forKey: .options).elements
    }

    /// The label of a value, also of one the Space no longer offers.
    func label(_ value: String) -> String { options.first { $0.value == value }?.label ?? value }
}

struct SpaceSettings: Equatable {
    var services: [SpaceService] = []
    var backups: [SpaceBackup] = []
    var models: ModelPreferences?
    /// Where the backups go, when the Space says.
    var backupTarget: String?

    private struct ServicesBody: Decodable { var services: Lossy<SpaceService> }
    private struct BackupsBody: Decodable { var target: String?; var backups: Lossy<SpaceBackup> }

    static func decode(services: Data?, backups: Data?, models: Data? = nil) -> SpaceSettings {
        let decoder = JSONDecoder()
        var out = SpaceSettings()
        if let services, let body = try? decoder.decode(ServicesBody.self, from: services) {
            out.services = body.services.elements.filter { $0.status != "archived" }
        }
        if let backups, let body = try? decoder.decode(BackupsBody.self, from: backups) {
            out.backups = body.backups.elements
            out.backupTarget = body.target
        }
        out.models = models.flatMap { try? decoder.decode(ModelPreferences.self, from: $0) }
        return out
    }
}
