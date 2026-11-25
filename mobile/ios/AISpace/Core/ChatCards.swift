import Foundation

/// Chat cards (docs/chat-cards.md, v2 styles in plan section 11): what an app agent's tools did in
/// a turn, drawn under the reply. ai-space extracts and checks them; a client only draws them and
/// calls two routes. This file holds what the Mac and the iPhone share without a view: the card as
/// it arrives (live `cards` event or a restored session's `ai` message), the fallback rules of the
/// styles, which items can be undone, the header button's words and the request bodies. It follows
/// the web panel's behaviour (src/web/ChatCards.tsx, src/web/Chat.tsx).

/// The built-in look of a card's items (`style`; plan 11.1).
enum ChatCardStyle: String, CaseIterable, Equatable {
    case rows, compact, gallery, agenda, stat
}

/// An item's own icon (`icon`; plan 11.2), drawn as an SF Symbol in place of the open circle.
enum ChatCardIcon: String, CaseIterable, Equatable {
    case check, note, link, calendar, image, file, person, chart, clock, flag, bell, folder

    var symbol: String {
        switch self {
        case .check: return "checkmark.circle"
        case .note: return "note.text"
        case .link: return "link"
        case .calendar: return "calendar"
        case .image: return "photo"
        case .file: return "doc"
        case .person: return "person"
        case .chart: return "chart.bar"
        case .clock: return "clock"
        case .flag: return "flag"
        case .bell: return "bell"
        case .folder: return "folder"
        }
    }
}

/// A small label after an item's secondary line (`tags[]`); an unknown `tone` is `neutral`.
struct ChatCardTag: Hashable {
    enum Tone: String, Hashable { case neutral, accent, positive, warning, negative }
    var text: String
    var tone: Tone = .neutral

    init(text: String, tone: Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    init?(_ raw: Any) {
        guard let d = raw as? [String: Any], let text = ChatCardJSON.line(d["text"]) else { return nil }
        self.text = text
        tone = (d["tone"] as? String).flatMap(Tone.init(rawValue:)) ?? .neutral
    }

    static func list(_ raw: Any?) -> [ChatCardTag]? {
        guard let array = raw as? [Any] else { return nil }
        let tags = array.compactMap(ChatCardTag.init).prefix(4)
        return tags.isEmpty ? nil : Array(tags)
    }
}

/// A date an app gives (`date`: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`), in the app's own time zone
/// and kept as written: no time zone is applied.
struct ChatCardDate: Hashable {
    var year: Int
    var month: Int
    var day: Int
    var hour: Int?
    var minute: Int?

    init(year: Int, month: Int, day: Int, hour: Int? = nil, minute: Int? = nil) {
        self.year = year
        self.month = month
        self.day = day
        self.hour = hour
        self.minute = minute
    }

    init?(_ text: String) {
        let s = Array(text.utf8)
        func digits(_ range: Range<Int>) -> Int? {
            guard range.upperBound <= s.count, range.allSatisfy({ (48...57).contains(s[$0]) }) else { return nil }
            return Int(String(decoding: s[range], as: UTF8.self))
        }
        guard s.count == 10 || s.count == 16, s[4] == 45, s[7] == 45,
              let y = digits(0..<4), let m = digits(5..<7), let d = digits(8..<10),
              (1...12).contains(m), (1...31).contains(d) else { return nil }
        year = y
        month = m
        day = d
        if s.count == 16 {
            guard s[10] == 84, s[13] == 58, let h = digits(11..<13), let mi = digits(14..<16), h < 24, mi < 60 else { return nil }
            hour = h
            minute = mi
        }
        // 2026-02-30 is not a day.
        guard components.isValidDate(in: Self.calendar) else { return nil }
    }

    /// Gregorian, in GMT: only the wall-clock fields are read, so no zone may shift them.
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "GMT")!
        return c
    }()

    private var components: DateComponents { DateComponents(year: year, month: month, day: day) }

    var sameDayKey: String { "\(year)-\(month)-\(day)" }

    /// `HH:MM` when the date has a time.
    var time: String? {
        guard let hour, let minute else { return nil }
        return String(format: "%02d:%02d", hour, minute)
    }

    /// The weekday in the interface's language: 周四 / Thu.
    func weekday(lang: String) -> String {
        guard let date = Self.calendar.date(from: components) else { return "" }
        return Self.formatter(lang: lang, format: "EEE").string(from: date)
    }

    /// The month in the interface's language: 12月 / Dec.
    func monthName(lang: String) -> String {
        guard let date = Self.calendar.date(from: components) else { return "" }
        return Self.formatter(lang: lang, format: "LLL").string(from: date)
    }

    /// Whether the date block needs its month line: the month or the year is not today's.
    func needsMonth(today: Date = Date(), calendar: Calendar = .current) -> Bool {
        let now = calendar.dateComponents([.year, .month], from: today)
        return now.year != year || now.month != month
    }

    private static func formatter(lang: String, format: String) -> DateFormatter {
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: lang == "zh" ? "zh_CN" : "en_US")
        f.dateFormat = format
        return f
    }
}

/// One record a card shows. The v2 fields are optional; a value of the wrong type is read as absent
/// (ai-space has already dropped any card that breaks the format).
struct ChatCardItem: Hashable {
    var id: String
    var title: String
    var detail: String?
    var url: String?
    var version: Int?
    var when: String?
    var date: ChatCardDate?
    var tags: [ChatCardTag]?
    var image: String?
    var icon: ChatCardIcon?
    var value: String?
    var progress: Double?

    init(id: String, title: String, detail: String? = nil, url: String? = nil, version: Int? = nil, when: String? = nil,
         date: ChatCardDate? = nil, tags: [ChatCardTag]? = nil, image: String? = nil, icon: ChatCardIcon? = nil,
         value: String? = nil, progress: Double? = nil) {
        self.id = id
        self.title = title
        self.detail = detail
        self.url = url
        self.version = version
        self.when = when
        self.date = date
        self.tags = tags
        self.image = image
        self.icon = icon
        self.value = value
        self.progress = progress
    }

    init?(_ raw: Any) {
        guard let d = raw as? [String: Any], let id = ChatCardJSON.id(d["id"]), let title = ChatCardJSON.line(d["title"]) else { return nil }
        self.id = id
        self.title = title
        detail = ChatCardJSON.line(d["detail"])
        url = ChatCardJSON.line(d["url"])
        version = ChatCardJSON.int(d["version"])
        when = ChatCardJSON.line(d["when"])
        date = ChatCardJSON.line(d["date"]).flatMap(ChatCardDate.init)
        tags = ChatCardTag.list(d["tags"])
        image = ChatCardJSON.line(d["image"])
        icon = (d["icon"] as? String).flatMap(ChatCardIcon.init(rawValue:))
        value = ChatCardJSON.line(d["value"])
        progress = ChatCardJSON.number(d["progress"]).flatMap { (0...1).contains($0) ? $0 : nil }
    }

    /// `detail` split on ` · ` into its muted segments.
    var detailSegments: [String] {
        (detail ?? "").components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// A card as ai-space sends it. `raw` is the card's JSON as received, which the state route takes
/// back as it is (`{ agent, card }`), so nothing of a newer card format is lost on the way.
struct ChatCard: Hashable {
    var kind: String
    var title: String?
    var items: [ChatCardItem]
    /// A `value` card's value as shown.
    var text: String?
    /// The capability that answers the items' current state.
    var state: String?
    /// The capability behind `actions.undo`.
    var undo: String?
    /// The style named, as written; `style` is what is drawn.
    var styleName: String?
    var raw: Data

    static let kinds: Set<String> = ["receipt", "list", "value"]

    init?(_ any: Any) {
        guard let d = any as? [String: Any], let kind = d["kind"] as? String, Self.kinds.contains(kind),
              let raw = try? JSONSerialization.data(withJSONObject: d, options: [.sortedKeys]) else { return nil }
        var items: [ChatCardItem] = []
        if let list = d["items"] as? [Any] {
            for entry in list {
                // A card that breaks a rule is dropped whole, never repaired (docs/chat-cards.md).
                guard let item = ChatCardItem(entry) else { return nil }
                items.append(item)
            }
        }
        self.kind = kind
        title = ChatCardJSON.line(d["title"])
        self.items = items
        text = ChatCardJSON.line(d["text"])
        state = ChatCardJSON.line(d["state"])
        undo = ((d["actions"] as? [String: Any])?["undo"]).flatMap(ChatCardJSON.line)
        styleName = d["style"] as? String
        self.raw = raw
        if kind == "value" ? text == nil : items.isEmpty { return nil }
    }

    /// The cards of a JSON list; one that cannot be read is left out, the others stay.
    static func list(_ raw: Any?) -> [ChatCard] {
        (raw as? [Any] ?? []).compactMap(ChatCard.init)
    }

    /// The JSON object the state route takes back.
    var json: Any { (try? JSONSerialization.jsonObject(with: raw)) ?? [:] }

    /// What is drawn (plan 11.1): an unknown name is `rows`; so is a style whose required field is
    /// missing on any item, and `stat` on a `receipt`. Judged on the card as printed, so the look
    /// does not change when the state answer arrives.
    var style: ChatCardStyle {
        guard let name = styleName, let named = ChatCardStyle(rawValue: name), !items.isEmpty else { return .rows }
        switch named {
        case .rows, .compact: return named
        case .gallery: return items.allSatisfy { $0.image != nil } ? named : .rows
        case .agenda: return items.allSatisfy { $0.date != nil } ? named : .rows
        case .stat: return kind != "receipt" && items.allSatisfy { $0.value != nil } ? named : .rows
        }
    }
}

/// A card as a reply holds it: its index in its cards event (what an action names) and that
/// event's token, in memory only. A restored card has no token.
struct ShownChatCard: Identifiable, Equatable {
    let id: String
    var card: ChatCard
    var index: Int
    var token: String?

    init(card: ChatCard, index: Int, token: String? = nil, id: String = UUID().uuidString) {
        self.id = id
        self.card = card
        self.index = index
        self.token = token
    }

    /// The cards of a live `{"type":"cards","cards":[…],"token":"…"}` run event; nil for any other event.
    static func event(_ line: String) -> [ShownChatCard]? {
        guard line.contains("\"cards\""), let data = line.data(using: .utf8),
              let ev = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              ev["type"] as? String == "cards", let list = ev["cards"] as? [Any] else { return nil }
        let token = ev["token"] as? String
        // The index is the card's place in the event as sent, so a card left out here still counts.
        return list.enumerated().compactMap { i, raw in ChatCard(raw).map { ShownChatCard(card: $0, index: i, token: token) } }
    }

    /// The cards of a restored `ai` message: read-only, no token.
    static func restored(_ cards: [ChatCard]) -> [ShownChatCard] {
        cards.enumerated().map { ShownChatCard(card: $1, index: $0) }
    }
}

/// One item as the card's `state` or undo capability answers it; given fields replace the printed ones.
struct ChatCardItemState: Equatable {
    enum Status: String, Equatable { case active, done, removed }
    var id: String
    var status: Status
    var title: String?
    var detail: String?
    var url: String?
    var version: Int?
    var changed = false
    var when: String?
    var date: ChatCardDate?
    var tags: [ChatCardTag]?
    var image: String?
    var icon: ChatCardIcon?
    var value: String?
    var progress: Double?

    init(id: String, status: Status, title: String? = nil, detail: String? = nil, url: String? = nil, changed: Bool = false) {
        self.id = id
        self.status = status
        self.title = title
        self.detail = detail
        self.url = url
        self.changed = changed
    }

    init?(_ raw: Any) {
        guard let d = raw as? [String: Any], let id = ChatCardJSON.id(d["id"]),
              let status = (d["status"] as? String).flatMap(Status.init(rawValue:)) else { return nil }
        self.id = id
        self.status = status
        title = ChatCardJSON.line(d["title"])
        detail = ChatCardJSON.line(d["detail"])
        url = ChatCardJSON.line(d["url"])
        version = ChatCardJSON.int(d["version"])
        changed = d["changed"] as? Bool == true
        when = ChatCardJSON.line(d["when"])
        date = ChatCardJSON.line(d["date"]).flatMap(ChatCardDate.init)
        tags = ChatCardTag.list(d["tags"])
        image = ChatCardJSON.line(d["image"])
        icon = (d["icon"] as? String).flatMap(ChatCardIcon.init(rawValue:))
        value = ChatCardJSON.line(d["value"])
        progress = ChatCardJSON.number(d["progress"]).flatMap { (0...1).contains($0) ? $0 : nil }
    }

    static func list(_ raw: Any?) -> [ChatCardItemState] {
        (raw as? [Any] ?? []).compactMap(ChatCardItemState.init)
    }
}

/// An item as drawn: the printed one with the app's current answer over it.
struct ChatCardShownItem: Equatable, Identifiable {
    enum Status: Equatable { case active, done, removed }
    var id: String
    var title: String
    var status: Status
    var changed: Bool
    var detailSegments: [String]
    var url: String?
    var when: String?
    var date: ChatCardDate?
    var tags: [ChatCardTag]
    var image: String?
    var icon: ChatCardIcon?
    var value: String?
    var progress: Double?

    /// The pill after the row: Undone, Changed elsewhere or Done (in that order, as the web's).
    enum Pill: Equatable { case undone, changed, done }
    var pill: Pill? {
        status == .removed ? .undone : changed ? .changed : status == .done ? .done : nil
    }

    /// The text a compact row shows on its right: `value`, else `when`, else the first detail segment.
    var compactValue: String? { value ?? when ?? detailSegments.first }
    /// The grey line under a gallery picture: `when`, else the first detail segment.
    var gallerySubtitle: String? { when ?? detailSegments.first }
}

/// The web panel's rules for a card (src/web/ChatCards.tsx), shared by both clients.
enum ChatCardRules {
    /// An item as drawn. A removed item keeps its printed title and loses its detail, link, time,
    /// tags and progress, as the web shows it (`#id` and the Undone pill).
    static func shown(_ item: ChatCardItem, _ state: ChatCardItemState?) -> ChatCardShownItem {
        let removed = state?.status == .removed
        let status: ChatCardShownItem.Status = removed ? .removed : state?.status == .done ? .done : .active
        let detail = removed ? nil : (state?.detail ?? item.detail)
        let segments = (detail ?? "").components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return ChatCardShownItem(
            id: item.id,
            title: (!removed ? state?.title : nil) ?? item.title,
            status: status,
            changed: state?.changed == true,
            detailSegments: segments,
            url: removed ? nil : (state?.url ?? item.url),
            when: removed ? nil : (state?.when ?? item.when),
            date: state?.date ?? item.date,
            tags: removed ? [] : (state?.tags ?? item.tags ?? []),
            image: state?.image ?? item.image,
            icon: state?.icon ?? item.icon,
            value: state?.value ?? item.value,
            progress: removed ? nil : (state?.progress ?? item.progress))
    }

    /// Whether a reply's cards may act: it is the conversation's latest (no message of the person
    /// after it). The token, which only a live event carries, is the other half (`canUndo`).
    static func actionable(isUser: [Bool], at index: Int) -> Bool {
        guard index < isUser.count else { return false }
        return !isUser[(index + 1)...].contains(true)
    }

    /// Whether the card shows undo controls at all.
    static func canUndo(_ shown: ShownChatCard, actionable: Bool, readOnly: Bool) -> Bool {
        actionable && !readOnly && shown.token != nil && shown.card.undo != nil
    }

    /// Whether one item can still be undone: not removed and not changed elsewhere.
    static func undoable(_ id: String, states: [String: ChatCardItemState], canUndo: Bool) -> Bool {
        canUndo && states[id]?.status != .removed && states[id]?.changed != true
    }

    /// The ids the header button takes back.
    static func open(_ card: ChatCard, states: [String: ChatCardItemState], canUndo: Bool) -> [String] {
        card.items.map(\.id).filter { undoable($0, states: states, canUndo: canUndo) }
    }

    /// The header button's words (src/web/ChatCards.tsx `undoLabel`).
    enum UndoLabel: Equatable { case one, all, rest(Int) }
    static func undoLabel(total: Int, open: Int) -> UndoLabel {
        total <= 1 ? .one : open == total ? .all : .rest(open)
    }

    /// Whether an item has its own undo button: on a card of several items, in a style that has
    /// them (compact and stat keep only the header's).
    static func rowUndo(style: ChatCardStyle, many: Bool, undoable: Bool) -> Bool {
        guard many, undoable else { return false }
        switch style {
        case .rows, .agenda, .gallery: return true
        case .compact, .stat: return false
        }
    }

    /// Whether a rows or agenda row opens as a whole: read-only and with a link. While the card
    /// can act, the title is the link and the row holds the undo button.
    static func rowLink(canUndo: Bool, url: String?) -> Bool { !canUndo && url != nil }

    /// The agenda's date blocks: only the first of consecutive items on the same day shows one.
    static func showsDateBlock(_ items: [ChatCardShownItem], at index: Int) -> Bool {
        guard let date = items[index].date else { return false }
        return index == 0 || items[index - 1].date?.sameDayKey != date.sameDayKey
    }

    /// The gallery's columns: three, two when the card's content is narrower than 360 points.
    static func galleryColumns(width: CGFloat) -> Int { width < 360 ? 2 : 3 }

    // MARK: Requests

    /// `POST …/agents/cards/state`: the agent and the card as received.
    static func stateBody(agent: String, card: ChatCard) -> [String: Any] {
        ["agent": agent, "card": card.json]
    }

    /// `POST …/agents/cards/action`: only the token, the card's index in its event and the ids.
    static func undoBody(token: String, card: Int, items: [String]) -> [String: Any] {
        ["token": token, "card": card, "action": "undo", "items": items]
    }

    /// What an answer of the state or action route says.
    enum Outcome: Equatable {
        case items([ChatCardItemState])
        /// The token is gone: the card is read-only from now on.
        case readOnly
        case failed(String)
    }

    static func outcome(status: Int, data: Data) -> Outcome {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if body["readOnly"] as? Bool == true { return .readOnly }
        guard (200..<300).contains(status), body["ok"] as? Bool == true else {
            return .failed(body["error"] as? String ?? "HTTP \(status)")
        }
        return .items(ChatCardItemState.list(body["items"]))
    }
}

/// Where an agent's cards are answered: the Space's own `/api/agents/cards/*` for a local agent,
/// a peer's `/api/peers/<peer>/agents/cards/*` for one on a peer, with the agent as `<app>/<name>`.
struct ChatCardRoute: Equatable {
    var prefix: String
    var agent: String

    /// From the base of the agent's chat routes, `<prefix>/agents/<app>/<name>` (ChatRoute.base,
    /// AgentInfo.base), its parts escaped.
    init?(base: String) {
        let parts = base.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 4, parts[parts.count - 3] == "agents",
              let app = parts[parts.count - 2].removingPercentEncoding, let name = parts[parts.count - 1].removingPercentEncoding,
              !app.isEmpty, !name.isEmpty else { return nil }
        prefix = parts[..<(parts.count - 3)].joined(separator: "/")
        agent = "\(app)/\(name)"
    }

    var state: String { "\(prefix)/agents/cards/state" }
    var action: String { "\(prefix)/agents/cards/action" }
}

/// The app heading an agent's cards: its icon and display name, either may be missing (cardApp in
/// src/web/ChatCards.tsx).
struct ChatCardApp: Equatable {
    var icon: String?
    var name: String?

    init(icon: String? = nil, name: String? = nil) {
        self.icon = icon
        self.name = name
    }
}

/// Reading the loose JSON of a card.
enum ChatCardJSON {
    static func line(_ v: Any?) -> String? {
        guard let s = v as? String else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// An id: a string, or an integer taken as its string.
    static func id(_ v: Any?) -> String? {
        if let n = number(v), n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return line(v)
    }

    static func int(_ v: Any?) -> Int? {
        guard let n = number(v), n == n.rounded(), abs(n) < 1e15 else { return nil }
        return Int(n)
    }

    /// A JSON number; `true` and `false` are not numbers here, though Foundation bridges them to one.
    static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
}

/// Any JSON value, for reading a card list out of a `Decodable` row.
struct ChatCardsField: Decodable {
    let cards: [ChatCard]

    init(from decoder: Decoder) throws {
        cards = ChatCard.list(try AnyJSON(from: decoder).value)
    }

    private struct AnyJSON: Decodable {
        let value: Any

        init(from decoder: Decoder) throws {
            if var array = try? decoder.unkeyedContainer() {
                var out: [Any] = []
                while !array.isAtEnd { out.append(try array.decode(AnyJSON.self).value) }
                value = out
            } else if let object = try? decoder.container(keyedBy: Key.self) {
                var out: [String: Any] = [:]
                for key in object.allKeys { out[key.stringValue] = try object.decode(AnyJSON.self, forKey: key).value }
                value = out
            } else {
                let single = try decoder.singleValueContainer()
                if single.decodeNil() { value = NSNull() }
                else if let b = try? single.decode(Bool.self) { value = b }
                else if let i = try? single.decode(Int.self) { value = NSNumber(value: i) }
                else if let d = try? single.decode(Double.self) { value = NSNumber(value: d) }
                else { value = try single.decode(String.self) }
            }
        }

        private struct Key: CodingKey {
            var stringValue: String
            var intValue: Int? { nil }
            init(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }
    }
}
