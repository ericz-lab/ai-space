import Combine
import ImageIO
import SwiftUI

/// The desk pet's drawing, shared by the iPhone and the Mac client (docs/app-spec.md#space-mood):
/// the sheet cut into cells, the motion of PetRules.swift driven by a timer that runs only while
/// something changes and only while the pet is on show, the bubble and the click. The Mac compiles
/// this file from here (desktop/macos/scripts/sources.sh), as it does SharedCaptureView.swift.

/// The pet's sheet from the app's resources, cut into cells as they are first drawn.
@MainActor
final class PetSheet {
    static let claude = PetSheet(sprite: .claude)

    let sprite: PetSprite
    private var image: CGImage?
    private var loaded = false
    private var cells: [Int: CGImage] = [:]

    init(sprite: PetSprite) {
        self.sprite = sprite
    }

    /// The sheet, read once; nil when the app was built without it.
    private var sheet: CGImage? {
        if !loaded {
            loaded = true
            if let url = Bundle.main.url(forResource: sprite.resource, withExtension: sprite.fileExtension),
               let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
                image = CGImageSourceCreateImageAtIndex(source, 0, nil)
            }
            if image == nil { NSLog("ai-space: the pet's sheet %@.%@ is missing or unreadable", sprite.resource, sprite.fileExtension) }
        }
        return image
    }

    /// Height over width of one cell (1 for Claude's square cells).
    var aspect: Double {
        guard let sheet, sheet.width > 0 else { return 1 }
        return (Double(sheet.height) / Double(sprite.rows)) / (Double(sheet.width) / Double(sprite.columns))
    }

    func cell(column: Int, row: Int) -> CGImage? {
        let key = row * sprite.columns + column
        if let hit = cells[key] { return hit }
        guard let sheet else { return nil }
        let w = sheet.width / sprite.columns, h = sheet.height / sprite.rows
        guard let cut = sheet.cropping(to: CGRect(x: column * w, y: row * h, width: w, height: h)) else { return nil }
        cells[key] = cut
        return cut
    }
}

/// Moves one pet: its PetMotion, advanced when the time it asked for comes. Stopped, nothing runs;
/// started again, the pet carries on from where the time has taken it.
@MainActor
final class PetDriver: ObservableObject {
    @Published private(set) var motion: PetMotion?
    /// The bubble's turn to show, while the mood has a line.
    @Published private(set) var bubbleOn = false
    private(set) var mood: PetMood?

    private var timer: Timer?
    private var bubbleTimer: Timer?
    private var bubbleSince: Double?
    private var running = false
    private var stage: Double = 0
    private var width: Double = PetSize.medium.width
    let sprite: PetSprite

    init(sprite: PetSprite = .claude) {
        self.sprite = sprite
    }

    private static var now: Double { ProcessInfo.processInfo.systemUptime }

    /// The stage's width and the pet's; the first call puts the pet on it.
    func layout(stage newStage: Double, width newWidth: Double) {
        guard newStage > 0 else { return }
        stage = newStage
        width = newWidth
        let now = Self.now
        if var m = motion {
            m.resize(stage: newStage, width: newWidth, now: now)
            motion = m
        } else {
            var m = PetMotion(sprite: sprite, width: newWidth, stage: newStage, now: now)
            m.set(mood: mood, now: now)
            motion = m
        }
        schedule()
    }

    /// The mood as the Space last told it; the same one again changes nothing.
    func set(mood new: PetMood?) {
        let lineChanged = new?.say != mood?.say
        mood = new
        if var m = motion {
            m.set(mood: new, now: Self.now)
            motion = m
            schedule()
        }
        // A new line shows now, from the start of its six seconds.
        if lineChanged {
            bubbleSince = nil
            restartBubble()
        }
    }

    /// Runs while the pet is on show; stopped, no timer is left.
    func run(_ on: Bool) {
        guard on != running else { return }
        running = on
        if on {
            schedule()
            restartBubble()
        } else {
            timer?.invalidate()
            timer = nil
            bubbleTimer?.invalidate()
            bubbleTimer = nil
        }
    }

    /// A click: what the mood opens, or nil after the click animation was started.
    func click() -> SpaceMood.Open? {
        if let open = mood?.open { return open }
        guard var m = motion else { return nil }
        m.click(now: Self.now)
        motion = m
        schedule()
        return nil
    }

    /// The pet held by hand at `x` on the stage, while a drag lasts.
    func hold(at x: Double) {
        guard var m = motion else { return }
        m.hold(at: x, now: Self.now)
        motion = m
    }

    /// The pet put down by hand at `x` on the stage.
    func drop(at x: Double) {
        guard var m = motion else { return }
        m.drop(at: x, now: Self.now)
        motion = m
        schedule()
    }

    private func schedule() {
        timer?.invalidate()
        timer = nil
        guard running, var m = motion else { return }
        let delay = m.advance(to: Self.now)
        motion = m
        // At most 20 changes a second: the walk's cells skip rather than the timer racing them.
        let t = Timer(timeInterval: max(0.05, delay), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.schedule() }
        }
        // In the common modes, so the pet keeps walking while a page scrolls.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func restartBubble() {
        bubbleTimer?.invalidate()
        bubbleTimer = nil
        guard mood?.say != nil else {
            bubbleSince = nil
            bubbleOn = false
            return
        }
        if bubbleSince == nil { bubbleSince = Self.now }
        flipBubble()
    }

    private func flipBubble() {
        guard running, let since = bubbleSince else { return }
        let elapsed = Self.now - since
        bubbleOn = PetBubble.visible(elapsed: elapsed)
        let t = Timer(timeInterval: PetBubble.untilChange(elapsed: elapsed) + 0.05, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.flipBubble() }
        }
        RunLoop.main.add(t, forMode: .common)
        bubbleTimer = t
    }
}

/// One cell of the sheet, mirrored when the pet faces left (Claude's sheet walks one way only).
struct PetFigure: View {
    let image: CGImage
    let mirrored: Bool

    var body: some View {
        Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.high)
            .scaleEffect(x: mirrored ? -1 : 1, y: 1)
    }
}

/// The line over the pet, on one line at its own width (the Space's lines are short).
struct PetBubbleView: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 12))
            .foregroundStyle(Theme.text)
            .lineLimit(1)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.hairline))
            .fixedSize()
            .allowsHitTesting(false)
    }
}

/// The pet with its bubble, opening towards the middle of its stage so it never runs off an edge.
struct PetBody: View {
    @ObservedObject var driver: PetDriver
    let sheet: PetSheet
    let width: Double
    /// The bubble opens to the right of the pet's left edge (or to the left of its right edge).
    let opensRight: Bool
    var hovering = false

    var body: some View {
        let height = width * sheet.aspect
        VStack(alignment: opensRight ? .leading : .trailing, spacing: 6) {
            if let line = driver.mood?.line, driver.bubbleOn || hovering {
                // As wide as the pet for the layout; the bubble itself runs on past it, inwards.
                PetBubbleView(text: line)
                    .frame(width: width, alignment: opensRight ? .leading : .trailing)
                    .transition(.opacity)
            }
            if let m = driver.motion, let image = sheet.cell(column: m.cell.column, row: m.cell.row) {
                PetFigure(image: image, mirrored: m.facingLeft)
                    .frame(width: width, height: height)
            } else {
                Color.clear.frame(width: width, height: height)
            }
        }
        .animation(.easeInOut(duration: 0.4), value: driver.bubbleOn || hovering)
    }
}

/// The pet walking along the bottom of a view, in an overlay at the bottom edge as wide as the
/// view. Only the pet takes clicks; the rest of the strip lets them through. With Reduce Motion
/// on, it is not shown, as the panel's pet is not.
struct PetStage: View {
    @ObservedObject var driver: PetDriver
    var sheet: PetSheet = .claude
    let size: PetSize
    /// The window is on show and the page under the pet is the launcher; false stops every timer.
    let active: Bool
    let onOpen: (SpaceMood.Open) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                Color.clear
                if !reduceMotion, let m = driver.motion {
                    let opensRight = m.x + size.width / 2 < geo.size.width / 2
                    PetBody(driver: driver, sheet: sheet, width: size.width, opensRight: opensRight, hovering: hovering)
                        .contentShape(Rectangle())
                        .onTapGesture { if let open = driver.click() { onOpen(open) } }
                        .onHover { hovering = $0 }
                        .offset(x: m.x)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text("Desk pet"))
                        .accessibilityValue(Text(verbatim: driver.mood?.line ?? ""))
                        .accessibilityAddTraits(.isButton)
                }
            }
            .onAppear { driver.layout(stage: geo.size.width, width: size.width) }
            .onChange(of: geo.size.width) { _, w in driver.layout(stage: w, width: size.width) }
            .onChange(of: size) { _, s in driver.layout(stage: geo.size.width, width: s.width) }
        }
        .frame(height: size.width * sheet.aspect + DeskPetRules.bubbleRoom)
        .onAppear { driver.run(active && !reduceMotion) }
        .onDisappear { driver.run(false) }
        .onChange(of: active) { _, on in driver.run(on && !reduceMotion) }
        .onChange(of: reduceMotion) { _, reduce in driver.run(active && !reduce) }
    }
}
