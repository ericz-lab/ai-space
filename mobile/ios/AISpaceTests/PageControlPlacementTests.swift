import CoreGraphics
import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct PageControlPlacementTests {
    let page = CGSize(width: 400, height: 800)

    @Test func restsAtTheBottomRightUntilMoved() {
        let placement = PageControlPlacement()
        #expect(placement.center(in: page) == CGPoint(x: 352, y: 760))
        #expect(PageControlPlacement(side: .left, vertical: 0).center(in: page) == CGPoint(x: 48, y: 40))
    }

    @Test func snapsToTheNearerEdgeAndKeepsItsHeight() {
        let left = PageControlPlacement.settled(at: CGPoint(x: 199, y: 400), in: page)
        #expect(left.side == .left)
        #expect(left.center(in: page) == CGPoint(x: 48, y: 400))
        let right = PageControlPlacement.settled(at: CGPoint(x: 200, y: 400), in: page)
        #expect(right.center(in: page) == CGPoint(x: 352, y: 400))
        // A release beyond the page rests at its margin.
        #expect(PageControlPlacement.settled(at: CGPoint(x: -80, y: -50), in: page) == PageControlPlacement(side: .left, vertical: 0))
        #expect(PageControlPlacement.settled(at: CGPoint(x: 900, y: 2000), in: page) == PageControlPlacement())
    }

    @Test func keepsItsShareOfTheHeightWhenThePageChangesSize() {
        let placement = PageControlPlacement.settled(at: CGPoint(x: 10, y: 400), in: page)
        #expect(placement.center(in: CGSize(width: 800, height: 400)) == CGPoint(x: 48, y: 200))
        // A page too small for the button's travel still gets a finite place.
        #expect(PageControlPlacement().center(in: .zero) == CGPoint(x: 48, y: 40))
        #expect(PageControlPlacement.settled(at: .zero, in: .zero).vertical == 1)
    }

    @Test func aDraggedButtonStaysOnThePage() {
        #expect(PageControlPlacement.clamped(CGPoint(x: -20, y: 900), in: page) == CGPoint(x: 28, y: 760))
        #expect(PageControlPlacement.clamped(CGPoint(x: 500, y: 0), in: page) == CGPoint(x: 372, y: 40))
        #expect(PageControlPlacement.clamped(CGPoint(x: 200, y: 300), in: page) == CGPoint(x: 200, y: 300))
    }

    @Test func theMenuOpensWhereThereIsRoom() {
        let bottom = PageControlPlacement()
        #expect(bottom.menuAbove(in: page))
        #expect(bottom.menuRoom(in: page).inset == 80)
        #expect(bottom.menuRoom(in: page).height == 708)
        let top = PageControlPlacement(side: .left, vertical: 0)
        #expect(!top.menuAbove(in: page))
        #expect(top.menuRoom(in: page).inset == 80)
        // A short page keeps a usable menu.
        #expect(bottom.menuRoom(in: CGSize(width: 400, height: 150)).height == 120)
    }

    @Test func storesAndRestoresItsPlace() {
        let placement = PageControlPlacement(side: .left, vertical: 0.25)
        #expect(PageControlPlacement(stored: placement.stored) == placement)
        #expect(PageControlPlacement(stored: "") == PageControlPlacement())
        #expect(PageControlPlacement(stored: "middle:0.5") == PageControlPlacement())
        #expect(PageControlPlacement(stored: "left:9").vertical == 1)
        #expect(PageControlPlacement(stored: "left:nan").vertical == 1)
        #expect(placement.opposite == PageControlPlacement(side: .right, vertical: 0.25))
    }
}
