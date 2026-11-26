import AppKit
import SwiftUI

/// What the voice overlay shows (docs/macos-desktop.md#voice-input): one model for both keys,
/// set by DictationHUD and drawn by DictationHUDView. What it says and for how long is in
/// DictationRules; this holds the facts of the recording on show.
@MainActor
final class DictationOverlayModel: ObservableObject {
    @Published var destination = DictationRules.Destination.field
    /// The app a note goes to, by its localized title, once the Space named it.
    @Published var target: String?
    /// The name of the Space that listens.
    @Published var space: String?
    @Published var phase = DictationRules.OverlayPhase.starting
    /// What was heard so far; for a kept note, the note itself.
    @Published var text = ""
    /// The meter's history, newest on the right (DictationRules.push).
    @Published var levels = Array(repeating: 0.0, count: DictationRules.meterBars)
    /// Seconds since the microphone opened.
    @Published var elapsed = 0
    /// On screen: drives the appear and leave animations.
    @Published var visible = false
    /// Leaving: a fade only, no scale.
    @Published var leaving = false
}

/// The large card that says what voice input is doing, above the bottom of the screen under the
/// pointer. A borderless non-activating panel at status-bar level on every Space and over
/// full-screen apps: it never takes the keyboard or the pointer, so the field being dictated
/// into keeps both.
@MainActor
final class DictationHUD {
    let model = DictationOverlayModel()
    private lazy var panel: NSPanel = makePanel()
    /// Counts what was shown, so a result's timer hides only that result.
    private var shown = 0
    private var clock: Timer?
    private var since: Date?

    /// The card's width: about 560 pt, at most 90% of the visible width.
    static func cardWidth(visibleWidth: CGFloat) -> CGFloat { min(560, visibleWidth * 0.9) }
    /// Room around the card in the panel for its shadow.
    static let margin: CGFloat = 48
    /// The panel's height: the tallest card (four lines of transcript) and its margin.
    static let height: CGFloat = 420

    var space: String? {
        get { model.space }
        set { model.space = newValue }
    }

    var target: String? {
        get { model.target }
        set { model.target = newValue }
    }

    /// A key was pressed: a fresh overlay in that key's mode.
    func begin(_ destination: DictationRules.Destination, space: String?) {
        stopClock()
        model.destination = destination
        model.target = nil
        model.space = space
        model.text = ""
        model.levels = Array(repeating: 0, count: DictationRules.meterBars)
        model.elapsed = 0
        set(.starting)
    }

    func follow(_ state: LiveVoice.State, text: String) {
        switch state {
        case .starting:
            model.text = text
            set(.starting)
        case .recording:
            model.text = text
            if since == nil { startClock() }
            if model.phase != .listening { set(.listening) }
        case .finishing:
            stopClock()
            model.text = text
            model.levels = Array(repeating: 0, count: DictationRules.meterBars)
            if model.phase != .transcribing { set(.transcribing) }
        case .idle:
            stopClock()
            // Waits a turn: the transcript is delivered right after the recorder goes idle, and a
            // note on its way or a result shown then keeps the card.
            let mine = shown
            DispatchQueue.main.async { [weak self] in
                guard let self, self.shown == mine else { return }
                switch self.model.phase {
                case .starting, .listening, .transcribing: self.hide()
                case .sending, .kept, .note: break
                }
            }
        }
    }

    /// The microphone's level, while it listens.
    func level(_ value: Double) {
        guard model.phase == .listening else { return }
        model.levels = DictationRules.push(model.levels, value)
    }

    /// A note on its way to its app.
    func sending(_ text: String) {
        model.text = text
        set(.sending)
    }

    /// The app kept the note.
    func kept(label: String?, text: String) {
        model.text = text
        set(.kept(label: label))
    }

    /// Anything gone wrong or worth saying; `clipboard`: the text waits there (shown longer).
    func note(_ text: String, clipboard: Bool = false) {
        stopClock()
        set(.note(text, clipboard: clipboard))
    }

    private func set(_ phase: DictationRules.OverlayPhase) {
        model.phase = phase
        show()
        guard let seconds = DictationRules.shows(phase) else { return }
        let mine = shown
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.shown == mine else { return }
            self.hide()
        }
    }

    private func show() {
        shown += 1
        let pointer = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { NSMouseInRect(pointer, $0.frame, false) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let width = Self.cardWidth(visibleWidth: visible.width)
        let size = NSSize(width: width + 2 * Self.margin, height: Self.height)
        // The card's bottom edge about 16% of the visible height above the bottom.
        let origin = NSPoint(x: visible.midX - size.width / 2, y: visible.minY + visible.height * 0.16 - Self.margin)
        let wasOut = !panel.isVisible || !model.visible
        (panel.contentView as? NSHostingView<DictationOverlayPanelView>)?.rootView = DictationOverlayPanelView(model: model, width: width)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
        if wasOut {
            model.leaving = false
            model.visible = false
            panel.orderFrontRegardless()
            DispatchQueue.main.async { [weak self] in self?.model.visible = true }
        } else {
            model.leaving = false
            model.visible = true
        }
    }

    private func hide() {
        shown += 1
        stopClock()
        model.leaving = true
        model.visible = false
        let mine = shown
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self, self.shown == mine else { return }
            self.panel.orderOut(nil)
        }
    }

    private func startClock() {
        since = Date()
        model.elapsed = 0
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let since = self.since else { return }
                let seconds = Int(Date().timeIntervalSince(since))
                if seconds != self.model.elapsed { self.model.elapsed = seconds }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        clock = timer
    }

    private func stopClock() {
        clock?.invalidate(); clock = nil
        since = nil
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 656, height: Self.height),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The card draws its own shadow; the window's would outline the whole transparent panel.
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.isExcludedFromWindowsMenu = true
        panel.ignoresMouseEvents = true
        panel.contentView = NSHostingView(rootView: DictationOverlayPanelView(model: model, width: 560))
        return panel
    }
}

/// The panel's content: the card at the bottom, with room around it for the shadow.
struct DictationOverlayPanelView: View {
    @ObservedObject var model: DictationOverlayModel
    let width: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            DictationHUDView(model: model, width: width)
                .opacity(model.visible ? 1 : 0)
                .scaleEffect(model.visible || model.leaving || reduceMotion ? 1 : 0.94, anchor: .bottom)
                .animation(.easeOut(duration: 0.16), value: model.visible)
        }
        .padding(DictationHUD.margin)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The card itself: the mode badge, the Space and the timer; the meter or progress; the words;
/// what letting go does. Or a result: a kept note, or a note about what went wrong.
struct DictationHUDView: View {
    @ObservedObject var model: DictationOverlayModel
    let width: CGFloat

    private var tint: Color { model.destination == .field ? Theme.accent : Theme.warning }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            switch model.phase {
            case .starting, .listening:
                DictationMeter(levels: model.levels, tint: tint, breathing: model.phase == .starting)
                transcript(dimmed: false)
            case .transcribing, .sending:
                DictationProgressLine(tint: tint)
                transcript(dimmed: true)
            case .kept(let label):
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(Theme.success)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: DictationRules.keptTitle(title: model.target ?? "", label: label))
                            .font(.system(size: 20, weight: .semibold))
                        if !model.text.isEmpty {
                            Text(verbatim: model.text).font(.system(size: 15)).foregroundStyle(.secondary)
                                .lineLimit(2).truncationMode(.tail).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            case .note(let message, _):
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 30)).foregroundStyle(Theme.warning)
                    Text(verbatim: message).font(.system(size: 15)).fixedSize(horizontal: false, vertical: true)
                }
            }
            if let footer = DictationRules.footer(model.phase, destination: model.destination, target: model.target) {
                HStack(spacing: 8) {
                    Text(verbatim: DictationRules.keyCap(model.destination))
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.primary.opacity(0.22), lineWidth: 1))
                    Text(verbatim: footer).font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .foregroundStyle(Theme.text)
        .padding(24)
        .frame(width: width, alignment: .leading)
        .background {
            // The shadow on the shape alone: on the card it would blur every bar and word too.
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.regularMaterial)
                .shadow(color: .black.opacity(0.22), radius: 32, y: 16)
                .shadow(color: .black.opacity(0.10), radius: 6, y: 2)
        }
        .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: model.destination == .field ? "mic.fill" : "square.and.pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(tint, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: DictationRules.badgeTitle(model.destination, target: model.target))
                        .font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    if let detail = DictationRules.badgeDetail(model.destination) {
                        Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            .padding(.leading, 5).padding(.trailing, 14).padding(.vertical, 5)
            .background(tint.opacity(0.13), in: Capsule())
            Spacer(minLength: 8)
            if let space = model.space {
                Text(verbatim: space).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.primary.opacity(0.08), in: Capsule())
                    .accessibilityLabel(Text("Listening with \(space)"))
            }
            if showsTimer {
                Text(verbatim: DictationRules.elapsedLabel(model.elapsed))
                    .font(.system(size: 15, weight: .medium)).monospacedDigit()
                    .foregroundStyle(DictationRules.timerWarns(elapsed: model.elapsed) ? Theme.danger : Color.secondary)
            }
        }
    }

    private var showsTimer: Bool {
        switch model.phase {
        case .listening, .transcribing: return true
        case .starting, .sending, .kept, .note: return false
        }
    }

    @ViewBuilder private func transcript(dimmed: Bool) -> some View {
        if model.text.isEmpty {
            if !dimmed {
                Text("Speak now").font(.system(size: 22, weight: .semibold)).foregroundStyle(.secondary)
            } else {
                Text("Transcribing…").font(.system(size: 22, weight: .medium)).foregroundStyle(.tertiary)
            }
        } else {
            Text(verbatim: DictationRules.tail(DictationRules.tidy(model.text), units: DictationRules.overlayUnits))
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(dimmed ? AnyShapeStyle(.secondary) : AnyShapeStyle(Theme.text))
                .lineLimit(4).truncationMode(.head)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The live level: a row of rounded bars, the newest level on the right. Before the microphone
/// is on they sit low and breathe (still, with Reduce Motion).
struct DictationMeter: View {
    let levels: [Double]
    let tint: Color
    let breathing: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let height: CGFloat = 48
    private static let floor: CGFloat = 5

    var body: some View {
        Group {
            if breathing && !reduceMotion {
                TimelineView(.animation) { context in
                    let t = context.date.timeIntervalSinceReferenceDate
                    bars { i in Self.floor + 5 * CGFloat((1 + sin(t * 2.6 - Double(i) * 0.32)) / 2) }
                }
            } else if breathing {
                bars { _ in Self.floor }
            } else {
                bars { i in Self.floor + (Self.height - Self.floor) * CGFloat(i < levels.count ? levels[i] : 0) }
            }
        }
        .frame(height: Self.height)
        .accessibilityHidden(true)
    }

    private func bars(_ height: @escaping (Int) -> CGFloat) -> some View {
        HStack(alignment: .center, spacing: 5) {
            ForEach(0..<DictationRules.meterBars, id: \.self) { i in
                Capsule()
                    .fill(tint.opacity(breathing ? 0.45 : 0.55 + 0.45 * (i < levels.count ? levels[i] : 0)))
                    .frame(maxWidth: .infinity)
                    .frame(height: height(i))
            }
        }
        .animation(.linear(duration: DictationRules.levelInterval * 2), value: levels)
    }
}

/// After the key is let go: a thin line with a segment running along it (still, with Reduce
/// Motion), in the mode's tint, where the meter was.
struct DictationProgressLine: View {
    let tint: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let segment = geo.size.width * 0.28
            ZStack(alignment: .leading) {
                Capsule().fill(tint.opacity(0.18))
                if reduceMotion {
                    Capsule().fill(tint).frame(width: segment)
                } else {
                    TimelineView(.animation) { context in
                        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                        Capsule().fill(tint).frame(width: segment)
                            .offset(x: (geo.size.width + segment) * t - segment)
                    }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 6)
        .padding(.vertical, 21)
        .accessibilityHidden(true)
    }
}
