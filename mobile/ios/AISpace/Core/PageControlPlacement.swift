import CoreGraphics
import Foundation

/// Where an app page's floating button rests: against the left or the right edge, at a height
/// kept as a share of the room it has, so the place survives rotation and a keyboard.
struct PageControlPlacement: Equatable {
    enum Side: String { case left, right }

    static let diameter: CGFloat = 56
    static let sideMargin: CGFloat = 20
    static let verticalMargin: CGFloat = 12
    /// The gap between the button and its menu.
    static let menuGap: CGFloat = 12

    var side: Side = .right
    /// 0 is the top of the page, 1 the bottom.
    var vertical: Double = 1

    init(side: Side = .right, vertical: Double = 1) {
        self.side = side
        self.vertical = vertical.isFinite ? min(1, max(0, vertical)) : 1
    }

    /// The stored form is `<side>:<vertical>`; anything else is the default place.
    init(stored: String) {
        let parts = stored.split(separator: ":")
        guard parts.count == 2, let side = Side(rawValue: String(parts[0])), let vertical = Double(parts[1]) else {
            self.init()
            return
        }
        self.init(side: side, vertical: vertical)
    }

    var stored: String { "\(side.rawValue):\(vertical)" }

    var opposite: PageControlPlacement {
        PageControlPlacement(side: side == .left ? .right : .left, vertical: vertical)
    }

    /// The button's centre in a page of this size.
    func center(in size: CGSize) -> CGPoint {
        let x = Self.sideMargin + Self.diameter / 2
        let range = Self.verticalRange(in: size)
        return CGPoint(x: side == .left ? x : max(x, size.width - x),
                       y: range.lowerBound + (range.upperBound - range.lowerBound) * vertical)
    }

    /// A centre the finger may drag the button to: anywhere, but not off the page.
    static func clamped(_ point: CGPoint, in size: CGSize) -> CGPoint {
        let half = diameter / 2
        let range = verticalRange(in: size)
        return CGPoint(x: min(max(half, size.width - half), max(half, point.x)),
                       y: min(range.upperBound, max(range.lowerBound, point.y)))
    }

    /// The place a released button snaps to: the nearer edge, at the height it was let go.
    static func settled(at point: CGPoint, in size: CGSize) -> PageControlPlacement {
        let range = verticalRange(in: size)
        let travel = range.upperBound - range.lowerBound
        let y = min(range.upperBound, max(range.lowerBound, point.y))
        return PageControlPlacement(side: point.x < size.width / 2 ? .left : .right,
                                    vertical: travel > 0 ? Double((y - range.lowerBound) / travel) : 1)
    }

    /// The menu opens on the side of the button that has more room.
    func menuAbove(in size: CGSize) -> Bool { center(in: size).y >= size.height / 2 }

    /// The height left for the menu on that side, and how far the page's edge is from it.
    func menuRoom(in size: CGSize) -> (inset: CGFloat, height: CGFloat) {
        let y = center(in: size).y
        let edge = menuAbove(in: size) ? size.height - y : y
        let inset = edge + Self.diameter / 2 + Self.menuGap
        return (inset, max(120, size.height - inset - Self.verticalMargin))
    }

    private static func verticalRange(in size: CGSize) -> ClosedRange<CGFloat> {
        let top = verticalMargin + diameter / 2
        return top...max(top, size.height - top)
    }
}
