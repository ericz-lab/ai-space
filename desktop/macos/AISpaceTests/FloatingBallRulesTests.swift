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
        // Typed values: inside #expect, a bare `1440 - 52 - 12` is an Int and never equals a CGFloat.
        let o = origin(nil)
        let rightEdge: CGFloat = 1440 - 52 - 12
        #expect(o.x == rightEdge)
        #expect(o.y > visible.midY)
        #expect(o.y + size.height + FloatingBallRules.margin <= visible.maxY)
    }

    @Test func savedPlaceIsKeptWhenItFits() {
        #expect(origin(CGPoint(x: 300, y: 400)) == CGPoint(x: 300, y: 400))
    }

    @Test func savedPlaceOffTheScreenComesBackInside() {
        // Under the Dock, past the right edge, over the menu bar: each side is pulled in by the margin.
        #expect(origin(CGPoint(x: -40, y: 0)) == CGPoint(x: 12, y: 82))
        #expect(origin(CGPoint(x: 5000, y: 5000)) == CGPoint(x: 1376, y: 811))
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

    // MARK: The dial

    @Test func sectionsGoClockwiseFromTheTop() {
        let c = CGPoint(x: 200, y: 200), r: CGFloat = 80
        #expect(FloatingBallRules.section(at: CGPoint(x: 200, y: 200 + r), center: c) == .keep)
        #expect(FloatingBallRules.section(at: CGPoint(x: 200 + r, y: 200), center: c) == .assistant)
        #expect(FloatingBallRules.section(at: CGPoint(x: 200, y: 200 - r), center: c) == .todo)
        #expect(FloatingBallRules.section(at: CGPoint(x: 200 - r, y: 200), center: c) == .design)
    }

    @Test func theHubAndPastTheRimAreNoSection() {
        let c = CGPoint(x: 200, y: 200)
        #expect(FloatingBallRules.section(at: CGPoint(x: 210, y: 205), center: c) == nil)
        #expect(FloatingBallRules.section(at: CGPoint(x: 200 + FloatingBallRules.dialDiameter, y: 200), center: c) == nil)
    }

    @Test func theDialStaysWholeOnTheScreen() {
        let ball = CGPoint(x: 1440 - 38, y: 600)
        let c = FloatingBallRules.dialCenter(ball: ball, visible: visible)
        let r: CGFloat = FloatingBallRules.dialDiameter / 2
        #expect(c.x + r <= visible.maxX)
        #expect(c.y == ball.y)
        let middle = CGPoint(x: 700, y: 400)
        #expect(FloatingBallRules.dialCenter(ball: middle, visible: visible) == middle)
    }

    @Test func aSectionOpensThisMachinesEntryBeforeAPeers() {
        let refs = ["thinkbook/ai-todo", "ai-todo", "keep-notes", "david/space/assistant", "space/assistant", "thinkbook/ai-design"]
        #expect(FloatingBallRules.ref(for: .todo, among: refs) == "ai-todo")
        #expect(FloatingBallRules.ref(for: .assistant, among: refs) == "space/assistant")
        #expect(FloatingBallRules.ref(for: .design, among: refs) == "thinkbook/ai-design")
        #expect(FloatingBallRules.ref(for: .keep, among: refs) == nil)
        #expect(FloatingBallRules.ref(for: .assistant, among: ["thinkbook/space/assistant"]) == "thinkbook/space/assistant")
    }

    @Test func aSectionHandsItsWorkToItsAppsAgent() {
        let refs = ["space/assistant", "space/ui-fixer", "david/space/assistant", "thinkbook/ai-design/designer",
                    "thinkbook/ai-todo/planner", "ai-todo/planner"]
        #expect(FloatingBallRules.agent(for: .assistant, among: refs) == "space/assistant")
        #expect(FloatingBallRules.agent(for: .todo, among: refs) == "ai-todo/planner")
        #expect(FloatingBallRules.agent(for: .design, among: refs) == "thinkbook/ai-design/designer")
        #expect(FloatingBallRules.agent(for: .keep, among: refs) == nil)
    }

    @Test func eachSpaceSetsItsOwnSections() {
        #expect(FloatingBallRules.slot(.keep, in: nil) == nil)
        let slots = FloatingBallRules.setting(.todo, to: "app:vault", in: nil)
        #expect(slots == ["", "", "app:vault", ""])
        #expect(FloatingBallRules.slot(.todo, in: slots) == "app:vault")
        #expect(FloatingBallRules.slot(.keep, in: slots) == nil)
        let cleared = FloatingBallRules.setting(.todo, to: nil, in: FloatingBallRules.setting(.design, to: FloatingBallRules.emptySlot, in: slots))
        #expect(FloatingBallRules.slot(.todo, in: cleared) == nil)
        #expect(FloatingBallRules.slot(.design, in: cleared) == FloatingBallRules.emptySlot)
    }

    @Test func anAppsAgentIsFoundOnItsOwnMachineFirst() {
        let refs = ["space/assistant", "keep/keeper", "thinkbook/ai-todo/planner", "ai-todo/planner"]
        #expect(FloatingBallRules.agent(forApp: "keep", among: refs) == "keep/keeper")
        #expect(FloatingBallRules.agent(forApp: "thinkbook/ai-todo", among: refs) == "thinkbook/ai-todo/planner")
        #expect(FloatingBallRules.agent(forApp: "ai-todo", among: refs) == "ai-todo/planner")
        #expect(FloatingBallRules.agent(forApp: "david/ai-todo", among: refs) == "thinkbook/ai-todo/planner")
        #expect(FloatingBallRules.agent(forApp: "vault", among: refs) == nil)
    }
}
