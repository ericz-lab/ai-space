import Foundation

/// The Space's catalogue as the phone reads it: `GET /api/apps`, `/api/agents`, `/api/widgets`,
/// `/api/peers`, `/api/panel/layout` and `/api/router` (shapes in src/space/panel/view.ts,
/// widgets.ts, layout.ts and src/space/peers/client.ts). Every field the app can live without
/// is optional and a malformed row is skipped, so an older or newer server still decodes.

/// An array that drops the elements it cannot decode instead of failing as a whole.
struct Lossy<Element: Decodable>: Decodable {
    var elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let value = try? container.decode(Element.self) { out.append(value) } else { _ = try? container.decode(Skipped.self) }
        }
        elements = out
    }

    private struct Skipped: Decodable {}
}

extension Lossy: Equatable where Element: Equatable {}
extension Lossy: Hashable where Element: Hashable {}

struct CatalogApp: Decodable, Hashable {
    struct Service: Decodable, Hashable {
        var port: Int?
        var health: String?
    }

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
    var manifestOnly: Bool?
    var hidden: Bool?
    var service: Service?
}

struct CatalogWidget: Decodable, Hashable, Identifiable {
    struct Item: Decodable, Hashable {
        var text: String
        var url: String?
        var time: String?
    }

    var id: String
    var peer: String?
    var stale: Bool?
    var app: String
    var name: String
    var title: String
    var i18n: I18n?
    var icon: String?
    var link: String?
    var kind: String?
    /// The card size the operator or the manifest chose: 1x1, 2x1, 1x2 or 2x2.
    var size: String?
    var ok: Bool?
    var items: [Item]?
    /// A state card instead of the list (Core/WidgetBlocks.swift); empty or absent means the list.
    var blocks: Lossy<WidgetBlock>?
    var asOf: String?
    var staleAfterMs: Double?
    var error: String?
}

struct PeerStatus: Decodable, Hashable, Identifiable {
    var name: String
    var health: String?
    var asOf: String?
    var error: String?
    var stale: Bool?
    var apps: Int?
    var agents: Int?
    var widgets: Int?

    var id: String { name }
    /// A peer whose snapshot is old or whose last refresh failed: its entries are last known, not live.
    var isOffline: Bool { stale == true || (health != nil && health != "ok") }
}

/// What kind of thing a catalogue entry is; the raw value is the prefix of the panel's entry key.
enum EntryKind: String, Codable, CaseIterable {
    case app, agent, widget
}

/// Whether an entry can be expected to answer.
enum Reach: Equatable {
    /// Its service answered the Space's health probe.
    case up
    /// Its service did not answer the probe.
    case down
    /// A service that has not been probed, or an older server that does not say.
    case unknown
    /// No service of its own: a link to a page elsewhere.
    case link
    /// It lives on a peer that is not answering; this is the last snapshot.
    case peerOffline
    /// The operator paused the app.
    case paused
}

/// One app, agent or widget, keyed the way the panel keys it (`app:<id>`, `agent:<id>`,
/// `widget:<id>`, peer prefix included), so a pin survives a title change.
struct CatalogueEntry: Identifiable, Hashable {
    var kind: EntryKind
    /// The layout id: `<name>`, `<app>/<name>`, or the same behind `<peer>/`.
    var ref: String
    var title: String
    var detail: String?
    var i18n: I18n?
    /// An emoji, an http(s) URL, or a path on the Space.
    var icon: String?
    var peer: String?
    /// The page to open: the app's `url` or the widget's `link`, `{lang}` not yet filled in.
    var link: String?
    var reach: Reach

    var id: String { key }
    var key: String { "\(kind.rawValue):\(ref)" }

    func displayTitle(lang: String = Lang.current) -> String { Lang.pick(title, i18n, \.title, lang: lang) }

    func displayDetail(lang: String = Lang.current) -> String? {
        let text = Lang.pick(detail ?? "", i18n, \.description, lang: lang)
        return text.isEmpty ? nil : text
    }

    /// The page with `{lang}` filled in, resolved against the Space when it is a path.
    func pageURL(space: URL, lang: String = Lang.current) -> URL? {
        guard let link, !link.isEmpty else { return nil }
        let filled = link.replacingOccurrences(of: "{lang}", with: lang)
        guard let url = URL(string: filled, relativeTo: space)?.absoluteURL,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
        else { return nil }
        return url
    }
}

/// The raw answers of one refresh, kept on the phone so the last known catalogue can be shown,
/// marked as such, while the Space cannot be reached.
struct CataloguePayload: Codable, Equatable {
    var apps: Data
    var agents: Data
    var widgets: Data
    var peers: Data?
    var layout: Data?
    var router: Data?
    var fetchedAt: Date
}

enum CatalogueError: Error, Equatable {
    /// The answer is not what ai-space sends for this route.
    case notASpace(String)
}

struct Catalogue: Equatable {
    var apps: [CatalogueEntry] = []
    /// One entry per agent, whatever the number of machines it runs on: each group's primary (AgentGroups).
    var agents: [CatalogueEntry] = []
    /// Every agent with its variants on each machine; the chat picks the machine.
    var agentGroups: [AgentGroup] = []
    var widgets: [CatalogWidget] = []
    var peers: [PeerStatus] = []
    /// The panel's screens, home first; nil while the Space has stored none (the panel seeds them on its first load).
    var screens: [PanelScreen]?
    /// `SPACE_DOMAIN` when the Space routes app hostnames itself (docs/router.md).
    var domain: String?
    /// The icons of the panel's own tiles by name (`builtins` of `/api/apps`: inbox, terminal, settings, …).
    var builtinIcons: [String: String] = [:]
    var fetchedAt = Date.distantPast

    var entries: [CatalogueEntry] { apps + agents + widgets.map(Self.entry) }

    /// The panel's screens as a browser shows them: the stored ones, or the home screen it would seed.
    var panelScreens: [PanelScreen] {
        screens ?? Screens.seed(apps: apps.map(\.ref), agents: agents.map(\.ref), widgets: widgets.map(\.id))
    }

    /// Entry keys pinned to the panel's home screen, in order.
    var homePins: [String] { panelScreens.first?.items ?? [] }

    func entry(_ key: String) -> CatalogueEntry? { entries.first { $0.key == key } ?? agent(key) }

    /// An agent on any machine by its entry key (`agent:<ref>`), not only the one that stands for its group.
    func agent(_ key: String) -> CatalogueEntry? {
        agentGroups.flatMap(\.machines).first(where: { $0.key == key }) ?? agents.first(where: { $0.key == key })
    }

    /// The group an agent's variant belongs to.
    func agentGroup(_ entry: CatalogueEntry) -> AgentGroup? {
        AgentGroups.group(agentGroups, ref: entry.ref)
    }

    /// An app by its layout id or, failing that, its bare name (the first match, local before peers).
    func app(named name: String) -> CatalogueEntry? {
        apps.first { $0.ref == name } ?? apps.first { $0.ref.split(separator: "/").last.map(String.init) == name }
    }

    func peer(_ name: String?) -> PeerStatus? { name.flatMap { n in peers.first { $0.name == n } } }

    private struct AppsBody: Decodable { var ok: Bool?; var apps: Lossy<CatalogApp> }
    private struct AgentsBody: Decodable { var agents: Lossy<AgentInfo> }
    private struct WidgetsBody: Decodable { var widgets: Lossy<CatalogWidget> }
    private struct PeersBody: Decodable { var peers: Lossy<PeerStatus> }
    private struct LayoutBody: Decodable {
        struct Layout: Decodable { var screens: Lossy<PanelScreen>? }
        var layout: Layout
    }
    private struct RouterBody: Decodable { var domain: String? }
    private struct BuiltinsBody: Decodable { var builtins: [String: String]? }

    static func decode(_ payload: CataloguePayload) throws -> Catalogue {
        let decoder = JSONDecoder()
        func required<T: Decodable>(_ type: T.Type, _ data: Data, _ route: String) throws -> T {
            do { return try decoder.decode(T.self, from: data) } catch { throw CatalogueError.notASpace(route) }
        }
        let appsBody = try required(AppsBody.self, payload.apps, "/api/apps")
        let agentsBody = try required(AgentsBody.self, payload.agents, "/api/agents")
        let widgetsBody = try required(WidgetsBody.self, payload.widgets, "/api/widgets")
        let peers = payload.peers.flatMap { try? decoder.decode(PeersBody.self, from: $0) }?.peers.elements ?? []
        let offline = Set(peers.filter(\.isOffline).map(\.name))

        var out = Catalogue()
        out.peers = peers
        out.apps = appsBody.apps.elements
            .filter { $0.hidden != true && $0.status != "archived" && !($0.url ?? "").isEmpty }
            .map { entry($0, offlinePeers: offline) }
        out.agentGroups = AgentGroups.group(agentsBody.agents.elements.map { entry($0, offlinePeers: offline) })
        out.agents = out.agentGroups.map(\.primary)
        // Read apart: an older Space, or one whose icons are not strings, still has its apps.
        out.builtinIcons = (try? decoder.decode(BuiltinsBody.self, from: payload.apps))?.builtins ?? [:]
        out.widgets = widgetsBody.widgets.elements
        if let data = payload.layout, let body = try? decoder.decode(LayoutBody.self, from: data) {
            out.screens = body.layout.screens?.elements
        }
        if let data = payload.router, let domain = (try? decoder.decode(RouterBody.self, from: data))?.domain, !domain.isEmpty {
            out.domain = domain.lowercased()
        }
        out.fetchedAt = payload.fetchedAt
        return out
    }

    static func entry(_ a: CatalogApp, offlinePeers: Set<String> = []) -> CatalogueEntry {
        let reach: Reach
        if a.stale == true || a.peer.map(offlinePeers.contains) == true {
            reach = .peerOffline
        } else if a.status == "paused" {
            reach = .paused
        } else if let service = a.service {
            switch service.health {
            case "ok": reach = .up
            case "down": reach = .down
            default: reach = .unknown
            }
        } else {
            reach = .link
        }
        return CatalogueEntry(kind: .app, ref: a.id, title: a.title, detail: a.description, i18n: a.i18n,
                              icon: a.icon, peer: a.peer, link: a.url, reach: reach)
    }

    static func entry(_ a: AgentInfo, offlinePeers: Set<String> = []) -> CatalogueEntry {
        CatalogueEntry(kind: .agent, ref: a.id, title: a.title, detail: a.description, i18n: a.i18n,
                       icon: a.avatar, peer: a.peer, link: nil,
                       reach: a.stale == true || a.peer.map(offlinePeers.contains) == true ? .peerOffline : .unknown)
    }

    static func entry(_ w: CatalogWidget) -> CatalogueEntry {
        CatalogueEntry(kind: .widget, ref: w.id, title: w.title, detail: nil, i18n: w.i18n,
                       icon: w.icon, peer: w.peer, link: w.link,
                       reach: w.stale == true ? .peerOffline : (w.ok == false ? .down : .unknown))
    }
}

// MARK: One agent across machines

/// One agent, whatever the number of machines it runs on (src/web/agent-groups.ts,
/// docs/peers.md#agents-on-several-machines). An app deployed on this machine and on peers lists
/// the same `<app>/<name>` agent once per machine, and every peer's Space Assistant is there too;
/// the library, the search and the agents list show one entry per group, and the chat picks the
/// machine. Each variant keeps its own ref, sessions and chat routes, since a turn runs where the
/// app lives.
struct AgentGroup: Hashable, Identifiable {
    /// `<app>/<name>`, the same on every machine.
    var key: String
    /// The variant that stands for the group: the local one, else the first peer that answers, else the first listed.
    var primary: CatalogueEntry
    /// Every machine's variant, the local one first, then the peers in the catalogue's order.
    var machines: [CatalogueEntry]

    var id: String { key }
    /// More than one machine to choose from.
    var isShared: Bool { machines.count > 1 }

    func variant(peer: String?) -> CatalogueEntry? { machines.first { $0.peer == peer } }
}

enum AgentGroups {
    /// `<app>/<name>` of an agent's ref, without the `<peer>/` in front of a peer's.
    static func key(ref: String, peer: String?) -> String {
        guard let peer, ref.hasPrefix(peer + "/") else { return ref }
        return String(ref.dropFirst(peer.count + 1))
    }

    static func key(of entry: CatalogueEntry) -> String { key(ref: entry.ref, peer: entry.peer) }

    /// Groups in the order their first variant has in the catalogue; within a group the local variant comes first.
    static func group(_ agents: [CatalogueEntry]) -> [AgentGroup] {
        var order: [String] = []
        var byKey: [String: AgentGroup] = [:]
        for a in agents {
            let k = key(of: a)
            guard var g = byKey[k] else {
                order.append(k)
                byKey[k] = AgentGroup(key: k, primary: a, machines: [a])
                continue
            }
            if a.peer == nil && g.primary.peer != nil {
                g.primary = a
                g.machines.insert(a, at: 0)
            } else {
                g.machines.append(a)
                // An offline peer does not stand for the group while another peer answers.
                if g.primary.peer != nil && g.primary.isOffline && !a.isOffline { g.primary = a }
            }
            byKey[k] = g
        }
        return order.compactMap { byKey[$0] }
    }

    /// The group whose variant has this ref.
    static func group(_ groups: [AgentGroup], ref: String) -> AgentGroup? {
        groups.first { g in g.machines.contains { $0.ref == ref } }
    }

    /// The variant a tile opens: the machine chosen last time (`""` for this one) when it is still
    /// listed and answering, else the primary. The choice is kept, so it comes back once that
    /// machine answers again.
    static func preferred(_ g: AgentGroup, remembered: String?) -> CatalogueEntry {
        guard let remembered else { return g.primary }
        guard let m = g.machines.first(where: { ($0.peer ?? "") == remembered }), !m.isOffline else { return g.primary }
        return m
    }

    /// Screen items with every agent key pointed at its group's primary and repeats dropped, so a
    /// layout pinned before the grouping (one key per machine) shows one tile; keys of agents the
    /// catalogue does not list are kept as they are.
    static func canonical(_ items: [String], _ groups: [AgentGroup]) -> [String] {
        var out: [String] = []
        for item in items {
            var next = item
            if item.hasPrefix("agent:"), let g = group(groups, ref: String(item.dropFirst("agent:".count))) {
                next = g.primary.key
            }
            if !out.contains(next) { out.append(next) }
        }
        return out
    }
}

/// The machine last chosen for each agent, on this device, per Space: the peer's name, or `""`
/// for the Space's own machine; nil when never chosen.
enum MachineChoice {
    private static func key(_ space: UUID, _ group: String) -> String { "chatMachine.\(space.uuidString).\(group)" }

    static func remembered(_ group: String, space: UUID, defaults: UserDefaults = .standard) -> String? {
        defaults.string(forKey: key(space, group))
    }

    static func remember(_ group: String, peer: String?, space: UUID, defaults: UserDefaults = .standard) {
        defaults.set(peer ?? "", forKey: key(space, group))
    }
}

extension CatalogueEntry {
    /// It lives on a peer that does not answer: shown, but not sent to.
    var isOffline: Bool { reach == .peerOffline }
}
