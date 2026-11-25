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
