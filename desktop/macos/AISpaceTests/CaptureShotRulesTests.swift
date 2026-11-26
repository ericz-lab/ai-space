import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct CaptureShotRulesTests {
    private func target(_ kinds: [String]?) -> ScreenshotRules.Target {
        ScreenshotRules.Target(id: "david/decree/issue", app: "decree", peer: "david", title: "Decree", kinds: kinds)
    }

    private func fits(_ size: (width: Int, height: Int), _ width: Int, _ height: Int) -> Bool {
        size.width == width && size.height == height
    }

    @Test func onlyTheCaptureKeyTakesAScreenshotAndOnlyWithTheSettingAndTheGrant() {
        #expect(CaptureShotRules.takes(.capture, enabled: true, granted: true))
        #expect(!CaptureShotRules.takes(.field, enabled: true, granted: true))
        #expect(!CaptureShotRules.takes(.capture, enabled: false, granted: true))
        #expect(!CaptureShotRules.takes(.capture, enabled: true, granted: false))
    }

    @Test func theSystemPromptShowsOnceOnFirstUseWithoutTheGrant() {
        #expect(CaptureShotRules.asks(.capture, enabled: true, granted: false, askedBefore: false))
        #expect(!CaptureShotRules.asks(.capture, enabled: true, granted: false, askedBefore: true))
        #expect(!CaptureShotRules.asks(.capture, enabled: true, granted: true, askedBefore: false))
        #expect(!CaptureShotRules.asks(.capture, enabled: false, granted: false, askedBefore: false))
        #expect(!CaptureShotRules.asks(.field, enabled: true, granted: false, askedBefore: false))
    }

    @Test func thePictureGoesOnlyToATargetThatTakesBothKinds() {
        #expect(CaptureShotRules.route(target(["text", "image"]), shot: true) == .image)
        #expect(CaptureShotRules.route(target(["image", "text"]), shot: false) == .text)
        #expect(CaptureShotRules.route(target(["text"]), shot: true) == .text)
        // A Space older than `kinds` says nothing: words only.
        #expect(CaptureShotRules.route(target(nil), shot: true) == .text)
    }

    @Test func targetsReadTheirKindsFromTheList() throws {
        let json = #"{"textTargets":[{"id":"david/decree/issue","app":"decree","capability":"issue","peer":"david","title":"Decree","kinds":["text","image"]},{"id":"notes/note","app":"notes","title":"Notes"}]}"#
        let list = try JSONDecoder().decode(DictationRules.TextTargets.self, from: Data(json.utf8))
        #expect(list.textTargets?.map(CaptureShotRules.takesImage) == [true, false])
    }

    @Test func theImageRouteCarriesTheWordsTheSameIdAndViaVoice() {
        let id = UUID()
        let fields = CaptureShotRules.fields(text: "  这个按钮是不是错位了  ", id: id)
        #expect(fields.map(\.0) == ["id", "via", "text"])
        #expect(fields.map(\.1) == [id.uuidString.lowercased(), "voice", "这个按钮是不是错位了"])
        // The text route carries the same id.
        #expect(DictationRules.captureBody(text: "x", id: id)["id"] as? String == fields[0].1)
        #expect(CaptureShotRules.imagePath(to: target(["text", "image"])) == "/api/capture/image?to=david/decree/issue")
        #expect(CaptureShotRules.filename == "screen.jpg")
        #expect(CaptureShotRules.mimeType == "image/jpeg")
    }

    @Test func theLongSideIsCappedAndNeverScaledUp() {
        #expect(fits(CaptureShotRules.size(width: 5120, height: 2880), 2560, 1440))
        #expect(fits(CaptureShotRules.size(width: 2880, height: 5120), 1440, 2560))
        #expect(fits(CaptureShotRules.size(width: 3024, height: 1964), 2560, 1663))
        #expect(fits(CaptureShotRules.size(width: 1920, height: 1080), 1920, 1080))
        #expect(fits(CaptureShotRules.size(width: 5120, height: 2880, longSide: 1280), 1280, 720))
    }

    @Test func theBudgetLeavesRoomUnderTheCallCap() {
        #expect(CaptureShotRules.budget <= ScreenshotRules.maxBytes)
        #expect(CaptureShotRules.budget <= 3 * 1024 * 1024)
        #expect(CaptureShotRules.steps.allSatisfy { $0.longSide <= CaptureShotRules.maxLongSide })
        // Quality steps down first, then size, never up again.
        let steps = CaptureShotRules.steps
        #expect(zip(steps, steps.dropFirst()).allSatisfy { $1.longSide <= $0.longSide && $1.quality <= $0.quality })
    }

    @Test func encodingStepsDownUntilItFits() {
        var tried: [CaptureShotRules.Step] = []
        let sizes = [5_000_000, 3_500_000, 2_000_000, 1_000_000]
        let fitted = CaptureShotRules.firstFitting { step in
            tried.append(step)
            return Data(count: sizes[tried.count - 1])
        }
        #expect(fitted?.data.count == 2_000_000)
        #expect(fitted?.step == CaptureShotRules.steps[2])
        #expect(tried == Array(CaptureShotRules.steps.prefix(3)))
    }

    @Test func aPictureThatNeverFitsOrFailsToEncodeIsDropped() {
        #expect(CaptureShotRules.firstFitting { _ in Data(count: CaptureShotRules.budget + 1) } == nil)
        #expect(CaptureShotRules.firstFitting { _ in nil } == nil)
        #expect(CaptureShotRules.firstFitting { _ in Data() } == nil)
        // A failed step is skipped, not the end.
        var n = 0
        let fitted = CaptureShotRules.firstFitting { _ in n += 1; return n == 1 ? nil : Data(count: 10) }
        #expect(fitted?.step == CaptureShotRules.steps[1])
    }

    @Test func aTargetRefusingThePictureGetsTheWordsThroughTheTextRoute() {
        for status in [400, 404, 413] {
            #expect(CaptureShotRules.next(after: SpaceAPIError.http(status, "no"), route: .image, retried: false) == .text)
            #expect(CaptureShotRules.next(after: SpaceAPIError.http(status, "no"), route: .image, retried: true) == .text)
            // The text route refusing is the end, as before.
            #expect(CaptureShotRules.next(after: SpaceAPIError.http(status, "no"), route: .text, retried: false) == nil)
        }
        #expect(CaptureShotRules.next(after: SpaceAPIError.http(500, "boom"), route: .image, retried: false) == nil)
        #expect(CaptureShotRules.next(after: SpaceAPIError.authenticationRequired, route: .image, retried: false) == nil)
    }

    @Test func aNetworkErrorIsTriedAgainOnceOnTheSameRoute() {
        let lost = URLError(.networkConnectionLost)
        #expect(CaptureShotRules.next(after: lost, route: .image, retried: false) == .image)
        #expect(CaptureShotRules.next(after: lost, route: .image, retried: true) == nil)
        #expect(CaptureShotRules.next(after: lost, route: .text, retried: false) == .text)
        #expect(CaptureShotRules.next(after: lost, route: .text, retried: true) == nil)
    }

    @Test func everyPathEndsWithinTheTryLimit() {
        // The worst path: image lost, image again, refused, text lost... the loop's bound covers it.
        var route = CaptureShotRules.Route.image
        var retried = false
        var tries = 1
        let errors: [Error] = [URLError(.timedOut), SpaceAPIError.http(413, "big"), URLError(.timedOut), URLError(.timedOut)]
        for error in errors {
            guard let next = CaptureShotRules.next(after: error, route: route, retried: retried) else { break }
            if next == route { retried = true }
            route = next
            tries += 1
        }
        #expect(route == .text)
        #expect(tries <= CaptureShotRules.maxTries)
    }

    @Test func theKeptTitleSaysWhenTheScreenshotWentWithIt() {
        #expect(CaptureShotRules.keptTitle(title: "Decree", label: nil, shot: false) == DictationRules.keptTitle(title: "Decree", label: nil))
        #expect(CaptureShotRules.keptTitle(title: "Decree", label: "Decree #3", shot: false) == DictationRules.keptTitle(title: "Decree", label: "Decree #3"))
        #expect(CaptureShotRules.keptTitle(title: "Decree", label: "Decree #3", shot: true) == "Kept in Decree · Decree #3 · with a screenshot")
        #expect(CaptureShotRules.keptTitle(title: "Decree", label: nil, shot: true) == "Kept in Decree · with a screenshot")
        #expect(CaptureShotRules.keptTitle(title: "Decree", label: "  ", shot: true) == CaptureShotRules.keptTitle(title: "Decree", label: nil, shot: true))
    }

    @Test func theOverlayMarksTheScreenshotWhileItListensAndSends() {
        let going: [DictationRules.OverlayPhase] = [.starting, .listening, .transcribing, .sending]
        for phase in going {
            #expect(CaptureShotRules.marks(phase, destination: .capture, attached: true))
            // Not attached (no grant, words-only target, not in yet, refused): no mark.
            #expect(!CaptureShotRules.marks(phase, destination: .capture, attached: false))
            // fn never takes a screenshot, so never shows the mark.
            #expect(!CaptureShotRules.marks(phase, destination: .field, attached: true))
        }
        // The result names it in its title instead; a note about a failure has no mark.
        #expect(!CaptureShotRules.marks(.kept(label: "Decree #3"), destination: .capture, attached: true))
        #expect(!CaptureShotRules.marks(.note("x", clipboard: true), destination: .capture, attached: true))
    }
}
