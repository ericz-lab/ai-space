import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// A random source that plays back fixed numbers, the last one again once they run out.
final class FixedRandom {
    private var values: [Double]
    init(_ values: [Double]) { self.values = values }
    func next() -> Double { values.count > 1 ? values.removeFirst() : (values.first ?? 0) }
}

struct PetRulesTests {
    func mood(_ state: String, move: String = "roam", say: String? = nil, open: SpaceMood.Open? = nil) -> SpaceMood {
        SpaceMood(ok: true, state: state, reason: nil, move: move, say: say.map { SpaceMood.Line(en: $0, zh: "中文") }, open: open)
    }

    @Test func theMoodDecodesFromTheRoute() throws {
        let json = #"{"ok":true,"state":"waiting","reason":"approval","move":"stay","say":{"en":"Planner is waiting for you","zh":"规划师 在等你"},"open":{"kind":"chat","agent":"ai-todo/planner"},"counts":{"running":1,"waiting":1,"failed":0,"unread":0,"feedback":0},"asOf":"2026-11-13T10:00:00.000Z"}"#
        let m = try JSONDecoder().decode(SpaceMood.self, from: Data(json.utf8))
        #expect(m.state == "waiting")
        #expect(m.open == SpaceMood.Open(kind: "chat", agent: "ai-todo/planner"))
        #expect(m.say?.text(lang: "zh") == "规划师 在等你")
        #expect(m.say?.text(lang: "en") == "Planner is waiting for you")
        // A newer state or a bare answer still decodes.
        #expect(try JSONDecoder().decode(SpaceMood.self, from: Data(#"{"state":"dancing"}"#.utf8)).state == "dancing")
    }

    @Test func claudeShowsEachStateAsThePanelDoes() {
        #expect(PetMood.shown(mood("working"))?.rest == "look")
        #expect(PetMood.shown(mood("waiting", move: "stay")) == PetMood(rest: "hop", stay: true, once: nil, say: nil, open: nil))
        #expect(PetMood.shown(mood("waiting"))?.rest == "look")
        #expect(PetMood.shown(mood("error", move: "stay"))?.stay == true)
        #expect(PetMood.shown(mood("done"))?.once == "jump")
        #expect(PetMood.shown(mood("sleep", move: "stay"))?.rest == "sleep")
        // Idle, an unknown state, a failed read or none: rest as without a mood.
        #expect(PetMood.shown(mood("idle")) == nil)
        #expect(PetMood.shown(mood("dancing")) == nil)
        #expect(PetMood.shown(SpaceMood(ok: false, state: "working")) == nil)
        #expect(PetMood.shown(nil) == nil)
        // Every animation the table names is on the sheet.
        let sprite = PetSprite.claude
        let rests: [String] = sprite.rests.map({ $0.name })
        let named: [String] = Array(sprite.moodRests.values) + Array(sprite.moodOnce.values) + rests + [sprite.walk, sprite.click]
        for name in named {
            #expect(sprite.anims[name] != nil, "\(name)")
        }
    }

    @Test func aPetThatStaysWalksToItsCornerAndRestsFacingIn() {
        let r = FixedRandom([0.5])
        var m = PetMotion(width: 80, stage: 1000, now: 0, random: r.next)
        m.set(mood: PetMood.shown(mood("waiting", move: "stay")), now: 0)
        #expect(m.walking)
        #expect(m.animation == "walk")
        let corner: Double = 1000 - 80 - 24
        #expect(m.corner == corner)
        // 55 points a second at its drawn width: from 460 to 896 takes about 8 seconds.
        var t = 0.0
        while m.walking && t < 20 {
            t += 0.05
            m.advance(to: t)
        }
        #expect(m.x == corner)
        #expect(m.facingLeft)
        #expect(m.animation == "hop")
        #expect(t > 7 && t < 9)
    }

    @Test func speedFollowsTheSizeSoTheFeetStayPlanted() {
        let r = FixedRandom([0])
        #expect(PetMotion(width: 80, stage: 500, now: 0, random: r.next).speed == 55)
        #expect(PetMotion(width: 110, stage: 500, now: 0, random: r.next).speed == 55.0 * 110 / 80)
    }

    @Test func doneSpinsOnceThenRests() {
        // 0.9: no walk, so the pet rests where it is.
        let r = FixedRandom([0, 0.9])
        var m = PetMotion(width: 80, stage: 600, now: 0, random: r.next)
        m.set(mood: PetMood.shown(mood("done")), now: 1)
        #expect(m.animation == "jump")
        // The same mood read again changes nothing.
        m.set(mood: PetMood.shown(mood("done")), now: 1.1)
        #expect(m.animation == "jump")
        m.advance(to: 1 + 0.72 + 0.01)
        #expect(m.animation == "look")
        #expect(m.frame == 0)
    }

    @Test func framesFollowTheClockAndHoldTheFirstCellAfterAPause() {
        let r = FixedRandom([0, 0.9])
        var m = PetMotion(width: 80, stage: 600, now: 0, random: r.next)
        m.set(mood: PetMood.shown(mood("waiting", move: "stay")), now: 0)
        // Walks to the corner first; put it there.
        m.drop(at: m.corner, now: 0)
        #expect(m.animation == "hop")
        let step = 0.9 / 12
        m.advance(to: step * 3 + 0.001)
        #expect(m.frame == 3)
        m.advance(to: step * 12 + 0.001)
        #expect(m.frame == 0)
        // The first cell is held 1.4 s longer after each loop.
        m.advance(to: step * 13 + 0.5)
        #expect(m.frame == 0)
        m.advance(to: step * 13 + 1.4 + 0.001)
        #expect(m.frame == 1)
        #expect(m.cell.row == 3)
    }

    @Test func aClickJumpsAndAHeldPetGoesNowhere() {
        let r = FixedRandom([0, 0.9])
        var m = PetMotion(width: 80, stage: 600, now: 0, random: r.next)
        m.click(now: 0)
        #expect(m.animation == "jump")
        m.hold(at: 300, now: 0.1)
        #expect(m.x == 300)
        #expect(!m.walking)
        m.advance(to: 60)
        #expect(m.x == 300)
        m.hold(at: 5000, now: 61)
        #expect(m.x == 520)
    }

    @Test func aResizedStageKeepsThePetOnIt() {
        let r = FixedRandom([1, 0.9])
        var m = PetMotion(width: 80, stage: 1000, now: 0, random: r.next)
        #expect(m.x == 920)
        m.resize(stage: 500, now: 1)
        #expect(m.x == 420)
        m.resize(stage: 500, width: 110, now: 2)
        #expect(m.x == 390)
    }

    @Test func theBubbleComesAndGoes() {
        #expect(PetBubble.visible(elapsed: 0))
        #expect(PetBubble.visible(elapsed: 5.9))
        #expect(!PetBubble.visible(elapsed: 6.1))
        #expect(!PetBubble.visible(elapsed: 19.9))
        #expect(PetBubble.visible(elapsed: 20.1))
        #expect(PetBubble.untilChange(elapsed: 2) == 4)
        #expect(PetBubble.untilChange(elapsed: 10) == 10)
    }

    @Test func theDesktopPetsWindowFollowsItAndStaysOnTheScreen() {
        // A screen's visible area above the Dock.
        let visible = CGRect(x: 0, y: 70, width: 1440, height: 805)
        let pet = CGSize(width: 80, height: 80)
        let w = 80 + 2 * DeskPetRules.bubbleWidth
        let middle = DeskPetRules.window(x: 600, pet: pet, visible: visible)
        #expect(middle == CGRect(x: 640 - w / 2, y: 70, width: w, height: 80 + DeskPetRules.bubbleRoom))
        #expect(DeskPetRules.sprite(x: 600, pet: pet, window: middle, visible: visible) == CGRect(x: 600 - (640 - w / 2), y: 0, width: 80, height: 80))
        // At the left edge the window stops at the screen; the pet moves inside it.
        let left = DeskPetRules.window(x: 0, pet: pet, visible: visible)
        #expect(left.minX == 0)
        #expect(DeskPetRules.sprite(x: 0, pet: pet, window: left, visible: visible).minX == 0)
        let right = DeskPetRules.window(x: 1360, pet: pet, visible: visible)
        #expect(right.maxX == 1440)
        #expect(DeskPetRules.sprite(x: 1360, pet: pet, window: right, visible: visible).maxX == right.width)
    }

    @Test func aRememberedSpotIsAFractionOfTheScreen() {
        #expect(DeskPetRules.fraction(x: 680, stage: 1440, width: 80) == 0.5)
        #expect(DeskPetRules.x(fraction: 0.5, stage: 1000, width: 80) == 460)
        #expect(DeskPetRules.fraction(x: 9999, stage: 1440, width: 80) == 1)
        #expect(DeskPetRules.fraction(x: 10, stage: 50, width: 80) == 0)
    }
}
