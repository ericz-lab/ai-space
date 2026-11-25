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

    /// How long a pasted transcript holds the clipboard before what was there comes back: long
    /// enough for the app in front to read it after the posted ⌘V.
    static let restoreDelay: TimeInterval = 0.8

    /// The earlier clipboard comes back after a paste, unless something else was copied since.
    /// A transcript left for the person to paste is never taken away.
    static func restores(_ delivery: Delivery, changeCount: Int, written: Int) -> Bool {
        delivery != .clipboardOnly && changeCount == written
    }

    /// How much of a long live transcript the capsule shows: its end, which is what is being said,
    /// cut at a word when one ends near the cut (a language without spaces is cut anywhere).
    static func tail(_ text: String, limit: Int = 120) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count > limit else { return text }
        var kept = text.suffix(limit)
        if let space = kept.prefix(limit / 6).firstIndex(of: " ") { kept = kept[kept.index(after: space)...] }
        return "…" + kept
    }

    /// Mono 16 kHz PCM16 as a WAV file: the live recording sent as a clip when the live route
    /// does not answer.
    static func wav(pcm: Data, sampleRate: Int = 16000) -> Data {
        var out = Data()
        func put(_ text: String) { out.append(Data(text.utf8)) }
        func put32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { out.append(contentsOf: $0) } }
        func put16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { out.append(contentsOf: $0) } }
        put("RIFF"); put32(36 + pcm.count); put("WAVE")
        put("fmt "); put32(16); put16(1); put16(1); put32(sampleRate); put32(sampleRate * 2); put16(2); put16(16)
        put("data"); put32(pcm.count)
        out.append(pcm)
        return out
    }
}
