import Foundation

/// The floating ball: a small round window over every app that takes one dropped picture.
/// These are its rules without AppKit, so the tests can run them.
enum FloatingBallRules {
    static let diameter: CGFloat = 52
    /// The ball never stands closer than this to the edge of the screen's visible area.
    static let margin: CGFloat = 12

    /// Where the ball stands: its saved place, kept inside the screen's visible area (a screen
    /// that was unplugged must not take the ball with it); with no saved place, the right edge a
    /// third of the way down, clear of the menu bar, the Dock and the corners.
    static func origin(saved: CGPoint?, size: CGSize, visible: CGRect) -> CGPoint {
        let minX = visible.minX + margin, maxX = visible.maxX - size.width - margin
        let minY = visible.minY + margin, maxY = visible.maxY - size.height - margin
        guard maxX >= minX, maxY >= minY else { return visible.origin }
        let wanted = saved ?? CGPoint(x: maxX, y: visible.maxY - visible.height / 3 - size.height / 2)
        return CGPoint(x: min(max(wanted.x, minX), maxX), y: min(max(wanted.y, minY), maxY))
    }

    // MARK: The dial

    /// The glass disc that opens around the ball under the pointer: four sections around a hub.
    static let dialDiameter: CGFloat = 236
    /// The hub in the middle, where the ball stands and the section under the pointer is named.
    static let hubDiameter: CGFloat = 84

    /// The four places the dial opens, clockwise from the top.
    enum Section: Int, CaseIterable, Equatable {
        case keep, assistant, todo, design

        /// The middle of the section, in degrees counterclockwise from the right (y up).
        var angle: CGFloat {
            switch self {
            case .keep: 90
            case .assistant: 0
            case .todo: 270
            case .design: 180
            }
        }

        /// The app of the Space the section stands for (an agent's app for the assistant).
        var app: String {
            switch self {
            case .keep: "keep"
            case .assistant: "space"
            case .todo: "ai-todo"
            case .design: "ai-design"
            }
        }

        /// The name shown while the Space has no such entry.
        var fallbackTitle: String {
            switch self {
            case .keep: "Keep"
            case .assistant: "Space Assistant"
            case .todo: "Todo"
            case .design: "Design Studio"
            }
        }
    }

    /// The section under `point` (y up) of a dial centred on `center`: none in the hub or past the rim.
    static func section(at point: CGPoint, center: CGPoint) -> Section? {
        let dx = point.x - center.x, dy = point.y - center.y
        let r = (dx * dx + dy * dy).squareRoot()
        guard r >= hubDiameter / 2, r <= dialDiameter / 2 else { return nil }
        var degrees = atan2(dy, dx) * 180 / .pi
        if degrees < 0 { degrees += 360 }
        switch degrees {
        case 45..<135: return .keep
        case 135..<225: return .design
        case 225..<315: return .todo
        default: return .assistant
        }
    }

    /// Where the dial opens: centred on the ball, moved in just enough to stay whole on the screen.
    static func dialCenter(ball: CGPoint, visible: CGRect) -> CGPoint {
        let r = dialDiameter / 2 + 4
        let minX = visible.minX + r, maxX = visible.maxX - r
        let minY = visible.minY + r, maxY = visible.maxY - r
        guard maxX >= minX, maxY >= minY else { return CGPoint(x: visible.midX, y: visible.midY) }
        return CGPoint(x: min(max(ball.x, minX), maxX), y: min(max(ball.y, minY), maxY))
    }

    /// The entry that shows a section (its icon and name) among the catalogue's refs (`<peer>/`
    /// before a peer's): the app itself, or the Space Assistant agent for the assistant's section.
    /// This machine's first, else the first peer that has it.
    static func ref(for section: Section, among refs: [String]) -> String? {
        let name = section == .assistant ? "space/assistant" : section.app
        let depth = name.split(separator: "/").count
        let matches = refs.filter { ref in
            ref == name || (ref.hasSuffix("/" + name) && ref.split(separator: "/").count == depth + 1)
        }
        return matches.first { $0 == name } ?? matches.first
    }

    /// A configured section left empty; "" (or no setting) is the section's default app.
    static let emptySlot = "-"

    /// The section's setting for one Space: nil for the default app, `emptySlot` for none, else
    /// an entry key (`app:<ref>`, `agent:<ref>`).
    static func slot(_ section: Section, in slots: [String]?) -> String? {
        guard let slots, slots.indices.contains(section.rawValue), !slots[section.rawValue].isEmpty else { return nil }
        return slots[section.rawValue]
    }

    /// Slots with one section set to `key` (nil for the default), the others kept.
    static func setting(_ section: Section, to key: String?, in slots: [String]?) -> [String] {
        var out = slots ?? []
        while out.count < Section.allCases.count { out.append("") }
        out[section.rawValue] = key ?? ""
        return out
    }

    /// The agent of an app (`<name>` or `<peer>/<name>`) among agent refs: one on the app's own
    /// machine first, else the same app on another machine. Nil when the app has no agent.
    static func agent(forApp app: String, among refs: [String]) -> String? {
        let parts = app.split(separator: "/").map(String.init)
        guard let name = parts.last else { return nil }
        let peer = parts.count > 1 ? parts[0] : nil
        let matches = refs.filter { ref in
            let r = ref.split(separator: "/").map(String.init)
            return (r.count == 2 || r.count == 3) && r[r.count - 2] == name
        }
        return matches.first { ref in
            let r = ref.split(separator: "/").map(String.init)
            return (r.count == 3 ? r[0] : nil) == peer
        } ?? matches.first
    }

    /// The agent a section hands its text and pictures to, among agent refs (`<app>/<name>`, behind
    /// `<peer>/` for a peer's): the app's own agent, this machine's first; for the assistant's
    /// section, Space Assistant. Nil when the app has no agent.
    static func agent(for section: Section, among refs: [String]) -> String? {
        let matches = refs.filter { ref in
            let parts = ref.split(separator: "/").map(String.init)
            guard parts.count == 2 || parts.count == 3 else { return false }
            return parts[parts.count - 2] == section.app && (section != .assistant || parts.last == "assistant")
        }
        return matches.first { $0.split(separator: "/").count == 2 } ?? matches.first
    }

    /// What a drag offers the ball.
    enum Offer: Equatable {
        /// One file whose type is a picture (Finder, the Desktop, Photos).
        case file
        /// Picture data on the pasteboard itself (Preview, Safari's image drag, a screenshot).
        case picture
        /// A file the source writes on request (a browser's image drag): taken when it arrives.
        case promise
        case nothing
    }

    /// `types` are the pasteboard's type identifiers, `files` the content types of its file URLs
    /// (one per file), `promised` whether it carries a file promise; `isPicture` says whether a
    /// type identifier is an image. A file wins over data, so nothing is read twice; more than one
    /// file is refused, as the editor takes one picture at a time.
    static func offer(types: [String], files: [String], promised: Bool = false, isPicture: (String) -> Bool) -> Offer {
        if !files.isEmpty { return files.count == 1 && isPicture(files[0]) ? .file : .nothing }
        if types.contains(where: isPicture) { return .picture }
        return promised ? .promise : .nothing
    }
}
