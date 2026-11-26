import AppKit
import ApplicationServices
import Carbon.HIToolbox

/// Holding a modifier key alone in any app (docs/macos-desktop.md#voice-input): fn (Globe) to
/// talk into the field, right ⌥ to send a spoken note to an app; one instance per key, named for
/// the first. A Carbon hot key cannot be a bare modifier, so this watches key events: the global
/// monitor sees other apps' keys only while AI Space is trusted for Accessibility, the local one
/// sees its own windows. HoldKey says which events are the key's, FnHoldRules decides what a
/// press means. Installed only while the setting is on.
@MainActor
final class FnKey {
    private let key: HoldKey
    private let began: () -> Void
    private let ended: () -> Void
    private var rules = FnHoldRules()
    private var monitors: [Any] = []
    private var timer: Timer?
    /// While the key is down: its state read directly, for a release no monitor delivered.
    private var watch: Timer?
    private var seenDown = false
    /// While not trusted: notices the grant, since a global monitor made before it hears nothing.
    private var trustWatch: Timer?

    init(key: HoldKey = .fn, began: @escaping () -> Void, ended: @escaping () -> Void) {
        self.key = key
        self.began = began
        self.ended = ended
    }

    /// What macOS does itself on the Globe key (System Settings › Keyboard › "Press 🌐 key to"),
    /// read from its own preferences: 0 is Do Nothing. Unset reads as acting, since the default
    /// on a Globe keyboard is the emoji picker or the input source.
    static var systemActsOnGlobeKey: Bool {
        (CFPreferencesCopyAppValue("AppleFnUsageType" as CFString, "com.apple.HIToolbox" as CFString) as? Int) != 0
    }

    func set(enabled: Bool) {
        remove()
        if enabled { install() }
    }

    private func install() {
        let mask: NSEvent.EventTypeMask = [.flagsChanged, .keyDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            let (type, key, flags) = (event.type, event.keyCode, event.modifierFlags)
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.feed(type, key: key, flags: flags) }
            } else {
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.feed(type, key: key, flags: flags) } }
            }
        }) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.feed(event.type, key: event.keyCode, flags: event.modifierFlags) }
            return event
        }) { monitors.append(local) }
        if !AXIsProcessTrusted() {
            trustWatch = Self.schedule(3, repeats: true) { [weak self] in
                guard let self, AXIsProcessTrusted() else { return }
                self.remove()
                self.install()
            }
        }
    }

    private func remove() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        trustWatch?.invalidate(); trustWatch = nil
        timer?.invalidate(); timer = nil
        stopWatching()
        // A recording in progress ends as if the key came up.
        if rules.fn(down: false, others: false) == .stop { ended() }
        rules.reset()
    }

    private func feed(_ type: NSEvent.EventType, key: UInt16, flags: NSEvent.ModifierFlags) {
        if type == .flagsChanged, let read = self.key.reading(keyCode: key, flags: flags.rawValue) {
            run(rules.fn(down: read.down, others: read.others))
        } else {
            run(rules.other())
        }
    }

    private func run(_ action: FnHoldRules.Action) {
        switch action {
        case .arm(let token):
            timer?.invalidate()
            timer = Self.schedule(FnHoldRules.delay, repeats: false) { [weak self] in
                guard let self else { return }
                self.run(self.rules.elapsed(token))
            }
            startWatching()
        case .start: began()
        case .stop: ended()
        case .none: break
        }
        if !rules.holding { stopWatching() }
    }

    /// A release the monitors miss (secure input in a password field takes key events from them)
    /// would leave the microphone on. The key's state is read every 0.1 s; it counts only after it
    /// once showed the key down, so a system that never reports it there changes nothing.
    private func startWatching() {
        stopWatching()
        watch = Self.schedule(0.1, repeats: true) { [weak self] in
            guard let self else { return }
            if self.isDown() { self.seenDown = true }
            else if self.seenDown { self.run(self.rules.fn(down: false, others: false)) }
        }
    }

    /// On the common modes, so the timers also run while a menu is open.
    private static func schedule(_ interval: TimeInterval, repeats: Bool, _ action: @escaping @MainActor () -> Void) -> Timer {
        let timer = Timer(timeInterval: interval, repeats: repeats) { _ in MainActor.assumeIsolated { action() } }
        RunLoop.main.add(timer, forMode: .common)
        return timer
    }

    /// fn from the modifier state, as always; right ⌥ by its key code, since the modifier state
    /// says only that some ⌥ is down.
    private func isDown() -> Bool {
        switch key.poll {
        case .functionFlag: return NSEvent.modifierFlags.contains(.function)
        case .keyState: return CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(key.keyCode))
        }
    }

    private func stopWatching() {
        watch?.invalidate(); watch = nil
        seenDown = false
    }
}
