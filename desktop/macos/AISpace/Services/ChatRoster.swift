import Foundation

/// The rules behind several conversations with one agent (`AgentChats`): which one New
/// Conversation reuses, which turns running on the Space a conversation here should follow, which
/// idle ones to let go, and the rows of the sidebar. Foundation only, so they are tested alone.
enum ChatRoster {
    /// One open conversation as the rules see it.
    struct Item: Equatable {
        var id: UUID
        /// The stored session it continues; nil until its first reply names one.
        var sessionID: String?
        /// The run it follows while a turn runs; nil before the Space has named the run.
        var runID: String?
        var busy = false
        var hasMessages = false
        /// Text, pictures or a picture import waiting in its field.
        var composing = false
        /// The first thing the person said in it, for its row before it is stored.
        var title: String?
        /// When it was last shown (larger is later).
        var shown = 0
        /// When it was opened (larger is later).
        var opened = 0

        /// Nothing said in it yet and nothing running: what New Conversation shows anyway.
        var blank: Bool { !hasMessages && !busy }
    }

    /// The idle conversations kept open besides the one on show and the busy ones.
    static let keep = 4

    /// The conversation New Conversation shows instead of opening another one: the one on show
    /// when nothing was said in it yet, else another such one, else nil (open a new one).
    static func blankConversation(_ items: [Item], current: UUID) -> UUID? {
        if let c = items.first(where: { $0.id == current }), c.blank { return current }
        return items.filter(\.blank).max { $0.shown < $1.shown }?.id
    }

    /// The open conversation that continues a stored session, to show it rather than load it twice.
    static func showing(_ sid: String, in items: [Item]) -> UUID? {
        items.first { $0.sessionID == sid }?.id
    }

    /// A running turn of the agent and where it goes: into an idle conversation that continues
    /// its session or an empty one (`into`), or into a new conversation (nil).
    struct Attachment: Equatable {
        var run: ChatRun
        var into: UUID?
    }

    /// The turns of `agent` running on the Space that no conversation here follows yet, oldest
    /// first. Nothing while a conversation here has sent a turn the Space has not named yet: the
    /// list may already hold that run, and following it twice would show it twice.
    static func attachments(runs: [ChatRun], agent: String, items: [Item], current: UUID, followed: Set<String>) -> [Attachment] {
        if items.contains(where: { $0.busy && $0.runID == nil }) { return [] }
        let waiting = runs
            .filter { $0.status == "running" && $0.agent == agent && !followed.contains($0.id) }
            .sorted { $0.startedAt < $1.startedAt }
        var used: Set<UUID> = []
        return waiting.map { run -> Attachment in
            let session = [run.sessionId, run.sid].compactMap { $0 }
            if let c = items.first(where: { c in !c.busy && !used.contains(c.id) && c.sessionID.map { session.contains($0) } == true }) {
                used.insert(c.id)
                return Attachment(run: run, into: c.id)
            }
            let empty = items.filter { $0.blank && !$0.composing && !used.contains($0.id) }
            if let c = empty.first(where: { $0.id == current }) ?? empty.first {
                used.insert(c.id)
                return Attachment(run: run, into: c.id)
            }
            return Attachment(run: run, into: nil)
        }
    }

    /// The conversations to let go: never the one on show or a busy one. An empty one goes at once,
    /// even with a draft (New Conversation would have shown it again rather than a new one); of the
    /// others, one with something waiting in its field stays and the `keep` shown last stay. A
    /// stored one can be opened again from the history.
    static func pruned(_ items: [Item], current: UUID, keep: Int = ChatRoster.keep) -> Set<UUID> {
        let idle = items.filter { $0.id != current && !$0.busy }
        var drop = Set(idle.filter { !$0.hasMessages }.map(\.id))
        let rest = idle.filter { $0.hasMessages && !$0.composing }.sorted { $0.shown > $1.shown }
        drop.formUnion(rest.dropFirst(keep).map(\.id))
        return drop
    }

    /// One row of the sidebar: an open conversation, a stored session, or both.
    struct Row: Identifiable, Equatable {
        var id: String
        /// The open conversation it shows, if one is open.
        var conversation: UUID?
        /// The stored session, once there is one.
        var sid: String?
        /// Nil when the session has no title (drawn as Untitled).
        var title: String?
        /// Milliseconds since 1970, for a stored session.
        var ts: Double?
        var busy = false
    }

    /// The sidebar's rows: open conversations not stored yet, newest first, then the stored
    /// sessions, newest first. A row is busy while a conversation here runs a turn in it, or while
    /// the Space lists a running turn of `agent` in its session (started on another client).
    /// `agent` is nil for an agent on a peer, whose turns the list does not hold.
    static func rows(_ items: [Item], sessions: [ChatSessionInfo], runs: [ChatRun], agent: String?) -> [Row] {
        let stored = Set(sessions.map(\.sid))
        let fresh = items
            .filter { c in c.hasMessages && !(c.sessionID.map { stored.contains($0) } ?? false) }
            .sorted { $0.opened > $1.opened }
            .map { Row(id: "c:\($0.id.uuidString)", conversation: $0.id, sid: $0.sessionID, title: $0.title, busy: $0.busy) }
        let running = runs.filter { $0.status == "running" && $0.agent == agent }
        let saved = sessions.map { s -> Row in
            let here = items.first { $0.sessionID == s.sid }
            let elsewhere = running.contains { $0.sessionId == s.sid || $0.sid == s.sid }
            let title = s.title.flatMap { $0.isEmpty ? nil : $0 }
            return Row(id: "s:\(s.sid)", conversation: here?.id, sid: s.sid, title: title, ts: s.ts, busy: here?.busy == true || elsewhere)
        }
        return fresh + saved
    }

    /// A conversation's title before it is stored: the first line of its first message.
    static func title(_ text: String) -> String? {
        let line = text.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
        return line.isEmpty ? nil : String(line.prefix(80))
    }
}
