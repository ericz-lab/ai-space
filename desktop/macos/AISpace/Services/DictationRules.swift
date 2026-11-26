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

    /// Where a transcript goes: fn types it into the field that has the keyboard, right ⌥ sends it
    /// to an app of the Space as a note (`POST /api/capture/text`, docs/events.md#capture).
    enum Destination: Equatable {
        case field
        case capture
    }

    /// A key's release ends the recording only when that key started it: fn let go while a
    /// right-⌥ note is being recorded (or the other way round) changes nothing.
    static func ends(_ released: Destination, recording: Destination?) -> Bool {
        released == recording
    }

    /// What the capsule says while it listens: which key to let go of.
    static func listeningHint(_ destination: Destination) -> String {
        switch destination {
        case .field: return String(localized: "Listening… let go of fn to finish")
        case .capture: return String(localized: "Listening… let go of right ⌥ to finish")
        }
    }

    /// The app a spoken note goes to: the one chosen for this Space when it still takes text,
    /// else the first.
    static func captureTarget(_ targets: [ScreenshotRules.Target], chosen: String?) -> ScreenshotRules.Target? {
        targets.first { $0.id == chosen } ?? targets.first
    }

    /// `GET /api/capture`, as far as spoken notes go: the targets that take `text`. A Space older
    /// than the text kind has none.
    struct TextTargets: Decodable, Equatable {
        var textTargets: [ScreenshotRules.Target]?
    }

    /// The target's answer to a note: `ok`, and how to name what was kept ("Decree #3").
    struct CaptureAnswer: Decodable, Equatable {
        var ok: Bool?
        var url: String?
        var label: String?
    }

    /// The target took the note: a 2xx answer that does not say `ok: false`.
    static func kept(_ answer: CaptureAnswer?) -> Bool {
        answer?.ok != false
    }

    /// `POST /api/capture/text?to=<id>`, the id encoded as a query value.
    static func capturePath(to target: ScreenshotRules.Target) -> String {
        var c = URLComponents()
        c.path = "/api/capture/text"
        c.queryItems = [URLQueryItem(name: "to", value: target.id)]
        return c.string ?? "/api/capture/text"
    }

    /// The note as the route takes it; `id` stays the same on the retry.
    static func captureBody(text: String, id: UUID) -> [String: Any] {
        ["text": text, "via": "voice", "id": id.uuidString.lowercased()]
    }

    /// A failure worth sending the same note again: the network, not the Space's answer.
    static func retries(_ error: Error) -> Bool {
        error is URLError
    }

    /// The capsule after the target kept the note: its title, and its own name for what was kept.
    static func sentNote(title: String, label: String?) -> String {
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return label.isEmpty ? String(localized: "Sent to \(title)") : String(localized: "Sent to \(title) · \(label)")
    }

    /// The capsule after sending failed: the note is on the clipboard instead, so nothing said is lost.
    static func failedNote(title: String, reason: String) -> String {
        String(localized: "Could not send to \(title) (\(reason)). The text is on the clipboard.")
    }

    /// The capsule before recording when the Space has nowhere to send a note.
    static func noTargetNote(space: String) -> String {
        String(localized: "No app on \(space) takes spoken notes.")
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

    /// The transcript's segments are joined by a space (VoiceTranscript), which is wrong inside
    /// Chinese or Japanese text: a space between two such characters is dropped, one beside a
    /// Latin word or a digit stays.
    static func tidy(_ text: String) -> String {
        let chars = Array(text)
        var out = ""
        for (i, c) in chars.enumerated() {
            if c == " ", i > 0, i + 1 < chars.count, wide(chars[i - 1]), wide(chars[i + 1]) { continue }
            out.append(c)
        }
        return out
    }

    /// CJK ideographs, kana, and their punctuation and full-width forms.
    private static func wide(_ c: Character) -> Bool {
        guard let v = c.unicodeScalars.first?.value else { return false }
        return (0x2E80...0x9FFF).contains(v) || (0xF900...0xFAFF).contains(v) || (0xFF00...0xFFEF).contains(v)
    }
}
