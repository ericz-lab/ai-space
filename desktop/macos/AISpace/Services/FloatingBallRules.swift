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
