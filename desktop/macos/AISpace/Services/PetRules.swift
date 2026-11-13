import Foundation

/// The desk pet (docs/app-spec.md#space-mood): the panel's Claude, drawn by the native clients from
/// the same sheet (src/web/public/pet-claude.webp, made by src/web/pets/claude.py) with the same
/// animations and the same table for the Space's mood as src/web/Pet.tsx. These are its rules
/// without AppKit or UIKit, so the tests can run them; the iPhone client compiles this file too.

/// The Space's mood as `GET /api/pets/mood` answers it. Every field but `state` may be missing,
/// and a state this client does not know rests as `idle`.
struct SpaceMood: Decodable, Equatable {
    struct Line: Decodable, Equatable {
        var en: String
        var zh: String?

        /// The line in the language on show: Chinese for `zh`, English otherwise; nil when empty.
        func text(lang: String = Lang.current) -> String? {
            let t = lang == "zh" ? (zh ?? en) : en
            return t.isEmpty ? nil : t
        }
    }

    /// What a click opens: `chat` with the agent's id (`<app>/<agent>`), or `inbox`.
    struct Open: Decodable, Equatable {
        var kind: String
        var agent: String?
    }

    var ok: Bool?
    var state: String
    var reason: String?
    var move: String?
    var say: Line?
    var open: Open?
}

/// One row of the sheet: `frames` cells from the left, played over `ms`; with `pause`, the first
/// cell is held that much longer after each loop.
struct PetAnimation: Equatable {
    let row: Int
    let frames: Int
    let ms: Int
    var pause: Int = 0

    /// How long one cell shows, in seconds.
    var step: Double { Double(ms) / Double(max(frames, 1)) / 1000 }
}

/// A sheet and how to move it.
struct PetSprite {
    /// The sheet's file in the app's resources, without its extension.
    let resource: String
    let fileExtension: String
    let columns: Int
    let rows: Int
    /// Width in points the scuttle is drawn for; `PetSize` scales it, and the speed with it.
    let width: Double
    /// Points per second at `width`.
    let speed: Double
    let anims: [String: PetAnimation]
    let walk: String
    /// Rest animations to pick from when there is no mood, with their weights.
    let rests: [(name: String, weight: Double)]
    /// Played once on a click when the mood opens nothing.
    let click: String
    /// The Space's mood: the animation the pet rests in by state (`<state>/stay` when it waits in its
    /// corner); a state not listed rests as without a mood.
    let moodRests: [String: String]
    /// Played once as a state begins.
    let moodOnce: [String: String]

    /// Claude, as `CLAUDE` in src/web/Pet.tsx (src/web/pet-claude.test.ts compares the two).
    static let claude = PetSprite(
        resource: "pet-claude", fileExtension: "webp", columns: 12, rows: 5, width: 80, speed: 55,
        anims: [
            "walk": PetAnimation(row: 0, frames: 8, ms: 320),
            "sleep": PetAnimation(row: 1, frames: 12, ms: 3600),
            "look": PetAnimation(row: 2, frames: 12, ms: 2880),
            "hop": PetAnimation(row: 3, frames: 12, ms: 900, pause: 1400),
            "jump": PetAnimation(row: 4, frames: 12, ms: 720),
        ],
        walk: "walk",
        rests: [("look", 0.5), ("sleep", 0.38), ("hop", 0.12)],
        click: "jump",
        moodRests: ["working": "look", "waiting": "look", "waiting/stay": "hop", "error": "look", "done": "look", "sleep": "sleep"],
        moodOnce: ["done": "jump"])
}

/// Where the pet walks: along the bottom of the main window, or along the bottom of the screen
/// over every app (the Mac and Linux; the iPhone has the window only).
enum PetPlace: String, CaseIterable, Identifiable {
    case window, desktop
    var id: String { rawValue }
}

/// How big the pet is drawn.
enum PetSize: String, CaseIterable, Identifiable {
    case small, medium, large
    var id: String { rawValue }

    /// Width in points; the height follows the sheet's cells.
    var width: Double {
        switch self {
        case .small: return 60
        case .medium: return 80
        case .large: return 110
        }
    }
}

/// A mood in the sprite's terms: what it rests in, whether it waits in its corner, what it plays
/// once as the mood begins, what it says and what a click opens.
struct PetMood: Equatable {
    var rest: String
    var stay: Bool
    var once: String?
    var say: SpaceMood.Line?
    var open: SpaceMood.Open?

    /// Nil, rest as without a mood, for a state the sprite does not list (`idle`, a newer one).
    static func shown(_ mood: SpaceMood?, sprite: PetSprite = .claude) -> PetMood? {
        guard let mood, mood.ok != false else { return nil }
        let stay = mood.move == "stay"
        guard let rest = (stay ? sprite.moodRests["\(mood.state)/stay"] : nil) ?? sprite.moodRests[mood.state],
              sprite.anims[rest] != nil else { return nil }
        return PetMood(rest: rest, stay: stay, once: sprite.moodOnce[mood.state], say: mood.say, open: mood.open)
    }

    /// What tells one mood from the next: a new one starts the pet's behaviour over.
    var key: String { "\(rest)/\(stay)/\(once ?? "")" }

    /// The line over the pet, in the language on show.
    var line: String? { say?.text() }
}

/// The pet's walk and its frames, as src/web/Pet.tsx moves it: walk to a random spot, rest a
/// while, walk again; a mood that stays sends it to the bottom-right corner, where it rests facing
/// into the page. Time is in seconds, place in points from the left of the stage. The view calls
/// `advance(to:)` when the time it returned comes, so nothing runs between two changes.
struct PetMotion {
    let sprite: PetSprite
    /// The pet's width in points.
    private(set) var width: Double
    /// The stage it walks along.
    private(set) var stage: Double
    private(set) var x: Double = 0
    private(set) var animation: String
    private(set) var frame = 0
    private(set) var facingLeft = false
    private(set) var mood: PetMood?

    private var target: Double?
    private var oneShot = false
    private var nextFrame: Double = 0
    private var nextBehave: Double?
    private var lastMove: Double = 0
    private let random: () -> Double

    /// Clear of the corner's edge, as the panel's pet waits clear of its dock.
    static let cornerGap: Double = 24

    init(sprite: PetSprite = .claude, width: Double, stage: Double, now: Double, random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        self.sprite = sprite
        self.width = width
        self.stage = stage
        self.random = random
        animation = sprite.rests.first?.name ?? sprite.walk
        x = random() * max(0, stage - width)
        lastMove = now
        behave(now: now)
    }

    /// Points per second at this size, so the feet stay planted at any width.
    var speed: Double { sprite.speed * width / sprite.width }

    var walking: Bool { target != nil }

    /// Where a pet that stays waits.
    var corner: Double { max(0, stage - width - Self.cornerGap) }

    /// The cell on show: its column and row in the sheet.
    var cell: (column: Int, row: Int) {
        (min(frame, sprite.columns - 1), sprite.anims[animation]?.row ?? 0)
    }

    /// A new mood: played once if it begins with an animation, else the behaviour starts over. The
    /// same mood again changes nothing.
    mutating func set(mood new: PetMood?, now: Double) {
        let changed = new?.key != mood?.key
        mood = new
        guard changed else { return }
        if !playOnce(new?.once, now: now) { behave(now: now) }
    }

    /// A click that opens nothing: the click animation once.
    mutating func click(now: Double) {
        _ = playOnce(sprite.click, now: now)
    }

    /// The stage changed size (a resized window, another screen): the pet stays on it, and one that
    /// stays follows its corner.
    mutating func resize(stage new: Double, width w: Double? = nil, now: Double) {
        stage = new
        if let w { width = w }
        x = min(max(0, x), max(0, stage - width))
        if let t = target { target = min(max(0, t), max(0, stage - width)) }
        if mood?.stay == true, !walking { behave(now: now) }
    }

    /// The pet held by hand at `newX` (a drag in progress): it follows, and does nothing else until dropped.
    mutating func hold(at newX: Double, now: Double) {
        x = min(max(0, newX), max(0, stage - width))
        target = nil
        oneShot = false
        nextBehave = nil
        lastMove = now
    }

    /// The pet put down somewhere else by hand (a drag of the desktop pet).
    mutating func drop(at newX: Double, now: Double) {
        x = min(max(0, newX), max(0, stage - width))
        target = nil
        oneShot = false
        lastMove = now
        behave(now: now)
    }

    /// Everything due by `now`: the walk, the frames, the next behaviour. Returns the seconds until
    /// the next change; the frames of a resting pet change a few times a second at most.
    @discardableResult
    mutating func advance(to now: Double) -> Double {
        // The walk: at the sprite's speed, the cell changing with it, so the feet do not slide.
        if let t = target {
            let dx = speed * max(0, now - lastMove)
            if abs(t - x) <= dx {
                x = t
                target = nil
                behave(now: now)
            } else {
                x += t > x ? dx : -dx
            }
        }
        lastMove = now
        if let at = nextBehave, now >= at, !walking, !oneShot {
            nextBehave = nil
            behave(now: now)
        }
        // At most one loop of frames per call: a late call skips cells, it never replays them.
        var guardCount = 0
        while now >= nextFrame, guardCount < 64 {
            guardCount += 1
            stepFrame(now: now)
        }
        var next = nextFrame - now
        if let at = nextBehave, !walking { next = min(next, at - now) }
        return max(0.016, next)
    }

    // MARK: Behaviour

    private mutating func stepFrame(now: Double) {
        guard let a = sprite.anims[animation] else { nextFrame = now + 1; return }
        frame += 1
        if frame >= a.frames {
            frame = 0
            if oneShot {
                oneShot = false
                behave(now: now)
                return
            }
        }
        nextFrame += frame == 0 && a.pause > 0 ? a.step + Double(a.pause) / 1000 : a.step
        // A call long after the last one starts the timing again from now.
        if nextFrame < now - 1 { nextFrame = now + a.step }
    }

    private mutating func set(animation name: String, now: Double) {
        guard sprite.anims[name] != nil else { return }
        animation = name
        frame = 0
        nextFrame = now + (sprite.anims[name]?.step ?? 1)
    }

    /// Plays `name` once, then behaves as before; false when the sprite lacks it or plays it already.
    private mutating func playOnce(_ name: String?, now: Double) -> Bool {
        guard let name, name != animation || !oneShot, sprite.anims[name] != nil else { return false }
        target = nil
        nextBehave = nil
        oneShot = true
        set(animation: name, now: now)
        return true
    }

    private mutating func walk(to place: Double, now: Double) {
        target = place
        facingLeft = place < x
        lastMove = now
        nextBehave = nil
        set(animation: sprite.walk, now: now)
    }

    private func pickRest() -> String {
        if let mood { return mood.rest }
        var r = random()
        for rest in sprite.rests {
            r -= rest.weight
            if r <= 0 { return rest.name }
        }
        return sprite.rests.first?.name ?? sprite.walk
    }

    /// Walk somewhere, or rest; a mood that stays sends the pet to its corner and keeps it there.
    private mutating func behave(now: Double) {
        oneShot = false
        nextBehave = nil
        if mood?.stay == true {
            if abs(x - corner) > 2 { return walk(to: corner, now: now) }
            facingLeft = true
            target = nil
            return set(animation: pickRest(), now: now)
        }
        // A pet with a mood rests longer between walks.
        let calm = mood != nil
        if random() < (calm ? 0.3 : 0.45) {
            walk(to: random() * max(0, stage - width), now: now)
        } else {
            target = nil
            set(animation: pickRest(), now: now)
            nextBehave = now + (calm ? 6 + random() * 10 : 1.8 + random() * 3.5)
        }
    }
}

/// The bubble over the pet comes and goes while its line stays: shown at once when the line
/// changes, then 6 seconds shown and 14 hidden; pointing at the pet shows it too.
enum PetBubble {
    static let shown: Double = 6
    static let hidden: Double = 14

    /// Whether the bubble shows `elapsed` seconds after its line appeared.
    static func visible(elapsed: Double) -> Bool {
        guard elapsed >= 0 else { return false }
        return elapsed.truncatingRemainder(dividingBy: shown + hidden) < shown
    }

    /// Seconds until the bubble next appears or goes.
    static func untilChange(elapsed: Double) -> Double {
        let t = max(0, elapsed).truncatingRemainder(dividingBy: shown + hidden)
        return t < shown ? shown - t : shown + hidden - t
    }
}

/// Where the desktop pet walks: the bottom of the screen's visible area (above the Dock), and
/// where on it the pet was left, as a fraction of its width, so another screen size keeps it.
enum DeskPetRules {
    /// The window over the pet holds its bubble too: this much room above the sprite.
    static let bubbleRoom: Double = 72
    /// The widest bubble (PetBubbleView), which opens to one side of the pet.
    static let bubbleWidth: Double = 220

    /// The window's frame for a pet `size` wide and high at `x` on a stage along `visible`'s bottom
    /// (y up, as AppKit counts): centred on the pet, room for the bubble on either side, kept on the screen.
    static func window(x: Double, pet: CGSize, visible: CGRect) -> CGRect {
        let w = Double(pet.width) + 2 * bubbleWidth
        let h = Double(pet.height) + bubbleRoom
        let left = Double(visible.minX) + x + Double(pet.width) / 2 - w / 2
        let clamped = min(max(left, Double(visible.minX)), Double(visible.maxX) - w)
        return CGRect(x: clamped, y: Double(visible.minY), width: w, height: h)
    }

    /// The pet's own rectangle inside that window (y up), where clicks land.
    static func sprite(x: Double, pet: CGSize, window: CGRect, visible: CGRect) -> CGRect {
        CGRect(x: Double(visible.minX) + x - Double(window.minX), y: 0, width: Double(pet.width), height: Double(pet.height))
    }

    /// A remembered place, as a fraction of the stage.
    static func fraction(x: Double, stage: Double, width: Double) -> Double {
        let room = stage - width
        return room > 0 ? min(max(x / room, 0), 1) : 0
    }

    static func x(fraction: Double, stage: Double, width: Double) -> Double {
        max(0, stage - width) * min(max(fraction, 0), 1)
    }
}
