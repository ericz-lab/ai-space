import Foundation

/// How a transcript of the system-wide voice input reaches the field that has the keyboard
/// (docs/macos-desktop.md#voice-input). Foundation only: Dictation.swift reads the facts from
/// AppKit and the tests check the decisions.
enum DictationRules {
    enum Delivery: Equatable {
        /// A window of this app has the keyboard (the main window, or Quick Chat over another app):
        /// paste through the app's own responder chain, which needs no permission.
        case ownPaste
        /// Another app is in front and Accessibility is granted: post ⌘V to it.
        case systemPaste
        /// Neither: the transcript stays on the clipboard for the person to paste.
        case clipboardOnly
    }

    /// `ownKeyWindow`: NSApp.keyWindow is set. `active`: this app is in front, so a posted ⌘V
    /// would come back to it with nothing focused. `trusted`: AXIsProcessTrusted().
    static func delivery(ownKeyWindow: Bool, active: Bool, trusted: Bool) -> Delivery {
        if ownKeyWindow { return .ownPaste }
        if active || !trusted { return .clipboardOnly }
        return .systemPaste
    }

    /// The system's Accessibility prompt, once per launch, when the text will have to go into
    /// another app and the permission is missing. Recording starts either way.
    static func asksForAccessibility(ownKeyWindow: Bool, trusted: Bool, askedBefore: Bool) -> Bool {
        !ownKeyWindow && !trusted && !askedBefore
    }

    /// How long a pasted transcript holds the clipboard before what was there comes back: long
    /// enough for the app in front to read it after the posted ⌘V.
    static let restoreDelay: TimeInterval = 0.8

    /// The earlier clipboard comes back after a paste, unless something else was copied since.
    /// A transcript left for the person to paste is never taken away.
    static func restores(_ delivery: Delivery, changeCount: Int, written: Int) -> Bool {
        delivery != .clipboardOnly && changeCount == written
    }
}
