import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct FloatingBallRulesTests {
    // A 1440 × 900 screen under its menu bar, above its Dock.
    let visible = CGRect(x: 0, y: 70, width: 1440, height: 805)
    let size = CGSize(width: 52, height: 52)

    func origin(_ saved: CGPoint?, in screen: CGRect? = nil) -> CGPoint {
        FloatingBallRules.origin(saved: saved, size: size, visible: screen ?? visible)
    }

    @Test func firstPlaceIsTheRightEdgeAThirdOfTheWayDown() {
        let o = origin(nil)
        #expect(o.x == 1440 - 52 - 12)
        #expect(o.y > visible.midY)
        #expect(o.y + 52 + 12 <= visible.maxY)
    }

    @Test func savedPlaceIsKeptWhenItFits() {
        #expect(origin(CGPoint(x: 300, y: 400)) == CGPoint(x: 300, y: 400))
    }

    @Test func savedPlaceOffTheScreenComesBackInside() {
        // Under the Dock, past the right edge, over the menu bar: each side is pulled in by the margin.
        #expect(origin(CGPoint(x: -40, y: 0)) == CGPoint(x: 12, y: 82))
        #expect(origin(CGPoint(x: 5000, y: 5000)) == CGPoint(x: 1440 - 52 - 12, y: 875 - 52 - 12))
    }

    @Test func aScreenTooSmallForTheBallStillGetsIt() {
        #expect(origin(CGPoint(x: 10, y: 10), in: CGRect(x: 0, y: 0, width: 40, height: 40)) == .zero)
    }

    let picture: (String) -> Bool = { ["public.png", "public.jpeg", "public.tiff", "public.heic"].contains($0) }

    func offer(_ types: [String], files: [String] = [], promised: Bool = false) -> FloatingBallRules.Offer {
        FloatingBallRules.offer(types: types, files: files, promised: promised, isPicture: picture)
    }

    @Test func oneFileIsTakenWhenItIsAPicture() {
        #expect(offer(["public.file-url"], files: ["public.png"]) == .file)
        #expect(offer(["public.file-url"], files: ["com.adobe.pdf"]) == .nothing)
        #expect(offer(["public.file-url"], files: ["public.png", "public.jpeg"]) == .nothing)
        #expect(offer(["public.file-url"], files: [""]) == .nothing)
    }

    @Test func pictureDataIsTakenAndAFileBesideItWins() {
        #expect(offer(["public.tiff", "public.url"]) == .picture)
        #expect(offer(["public.tiff", "public.file-url"], files: ["public.heic"]) == .file)
        #expect(offer(["public.tiff", "public.file-url"], files: ["com.adobe.pdf"]) == .nothing)
    }

    @Test func aPromiseIsTakenOnlyWithNothingBetter() {
        #expect(offer(["com.apple.pasteboard.promised-file-url", "public.url"], promised: true) == .promise)
        #expect(offer(["public.png", "com.apple.pasteboard.promised-file-url"], promised: true) == .picture)
    }

    @Test func linksAndTextAreRefused() {
        #expect(offer(["public.url", "public.utf8-plain-text"]) == .nothing)
        #expect(offer([]) == .nothing)
    }
}
