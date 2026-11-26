import Foundation

/// When holding the fn (Globe) key means "talk" (docs/macos-desktop.md#voice-input). Foundation
/// only: FnKey.swift feeds it the key events and runs its timer, the tests check the decisions.
///
/// fn is also half of fn+arrow, fn+F5, fn+Delete and the Globe key's own system action, so a press
/// arms a short timer and only fn held alone until it runs out starts recording; letting go after
/// that stops it. Once recording, other keys no longer matter.
struct FnHoldRules {
    enum Action: Equatable {
        case none
        /// Run the timer, then call `elapsed` with this token.
        case arm(Int)
        case start
        case stop
    }

    /// Long enough that a tap or a combination never starts, short enough not to clip the first word.
    static let delay: TimeInterval = 0.25

    private enum Phase: Equatable {
        case idle
        case armed(Int)
        case recording
        /// fn is still down, but it was part of a combination: nothing until it comes up.
        case spoiled
    }

    private var phase = Phase.idle
    private var tokens = 0

    /// fn is down in one of the ways this tracks: the caller watches for a missed release meanwhile.
    var holding: Bool { phase != .idle }

    /// fn went down or up. `others`: ⌘, ⌥, ⌃ or ⇧ is held with it.
    mutating func fn(down: Bool, others: Bool) -> Action {
        if down {
            // A second down without an up (both monitors, or a missed release) changes nothing.
            guard phase == .idle else { return .none }
            if others {
                phase = .spoiled
                return .none
            }
            tokens += 1
            phase = .armed(tokens)
            return .arm(tokens)
        }
        let was = phase
        phase = .idle
        return was == .recording ? .stop : .none
    }

    /// Another key went down, or another modifier changed.
    mutating func other() -> Action {
        if case .armed = phase { phase = .spoiled }
        return .none
    }

    /// The timer of `arm(token)` ran out.
    mutating func elapsed(_ token: Int) -> Action {
        guard phase == .armed(token) else { return .none }
        phase = .recording
        return .start
    }

    /// The setting went off: forget a hold in progress.
    mutating func reset() { phase = .idle }
}

/// Which modifier key a hold watches (FnKey runs one watcher per key): fn for talking into the
/// field, right ⌥ for a spoken note sent to an app. Raw values, so the decisions are tested
/// without AppKit: the key codes are Carbon's `kVK_…`, the masks bits of `NSEvent.ModifierFlags`.
struct HoldKey: Equatable {
    /// The `keyCode` of the `flagsChanged` event the key itself sends.
    let keyCode: UInt16
    /// The bit of the event's flags that is set while the key is down.
    let downMask: UInt
    /// Bits that mean another modifier is held with it.
    let othersMask: UInt
    /// How the missed-release watch reads the key: the one thing reliably readable for it.
    let poll: Poll

    enum Poll: Equatable {
        /// `NSEvent.modifierFlags` holds `.function`.
        case functionFlag
        /// `CGEventSource.keyState` of the key code: the modifier state cannot tell right ⌥ from left.
        case keyState
    }

    // NSEvent.ModifierFlags: device independent, and the device-dependent bits (NX_DEVICE…KEYMASK)
    // that tell left from right.
    static let shift: UInt = 1 << 17, control: UInt = 1 << 18, option: UInt = 1 << 19, command: UInt = 1 << 20, function: UInt = 1 << 23
    static let leftOptionDevice: UInt = 0x20, rightOptionDevice: UInt = 0x40

    /// fn (Globe), `kVK_Function`: exactly what FnKey has always read.
    static let fn = HoldKey(keyCode: 0x3F, downMask: function, othersMask: command | option | control | shift, poll: .functionFlag)
    /// Right ⌥, `kVK_RightOption`. Its own down sets `.option` too, so the device bit tells it is
    /// down, and left ⌥ (its own device bit) counts as another modifier.
    static let rightOption = HoldKey(keyCode: 0x3D, downMask: rightOptionDevice, othersMask: command | control | shift | leftOptionDevice, poll: .keyState)

    /// A `flagsChanged` event read for this key: nil when it is another key's (which counts as
    /// "another key" for FnHoldRules), else whether the key is down and whether others are held.
    func reading(keyCode: UInt16, flags: UInt) -> (down: Bool, others: Bool)? {
        guard keyCode == self.keyCode else { return nil }
        return (flags & downMask != 0, flags & othersMask != 0)
    }
}
