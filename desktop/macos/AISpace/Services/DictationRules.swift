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

    // MARK: The voice overlay (DictationOverlay.swift draws it; what it says and for how long is here)

    /// What the overlay shows, from the press to the result.
    enum OverlayPhase: Equatable {
        /// Pressed: the Space is being asked and the microphone opened.
        case starting
        case listening
        /// Released: the final text is on its way.
        case transcribing
        /// A note on its way to its app.
        case sending
        /// The app kept the note, naming it `label` when it says.
        case kept(label: String?)
        /// Anything gone wrong or worth saying; `clipboard`: the text was left on the clipboard.
        case note(String, clipboard: Bool)
    }

    /// The mode badge's title, which tells the two keys apart: "Voice input", or "Note to <app>"
    /// once the app is known.
    static func badgeTitle(_ destination: Destination, target: String?) -> String {
        switch destination {
        case .field: return String(localized: "Voice input")
        case .capture: return target.map { String(localized: "Note to \($0)") } ?? String(localized: "Spoken note")
        }
    }

    /// The badge's second line: where fn's text goes. A note's app is in the title already.
    static func badgeDetail(_ destination: Destination) -> String? {
        destination == .field ? String(localized: "into the current field") : nil
    }

    /// The key cap in the footer.
    static func keyCap(_ destination: Destination) -> String {
        destination == .field ? "fn" : String(localized: "right ⌥")
    }

    /// The footer: what letting go does, then what is happening; nil once there is a result.
    static func footer(_ phase: OverlayPhase, destination: Destination, target: String?) -> String? {
        switch phase {
        case .starting, .listening:
            switch destination {
            case .field: return String(localized: "let go to insert")
            case .capture: return target.map { String(localized: "let go to send to \($0)") } ?? String(localized: "let go to send")
            }
        case .transcribing: return String(localized: "Transcribing…")
        case .sending: return target.map { String(localized: "Sending to \($0)…") } ?? String(localized: "Sending…")
        case .kept, .note: return nil
        }
    }

    /// The longest recording (LiveVoice stops by itself then), and when the timer warns of it.
    static let maxRecordingSeconds = 90
    static func timerWarns(elapsed: Int) -> Bool { elapsed >= maxRecordingSeconds - 10 }

    /// The elapsed timer: `0:07`, `1:25`.
    static func elapsedLabel(_ seconds: Int) -> String {
        let s = max(0, seconds)
        return "\(s / 60):" + (s % 60 < 10 ? "0" : "") + "\(s % 60)"
    }

    /// How long a result stays: a kept note 2.5 s, a note 4 s, 6 s when the text waits on the
    /// clipboard. The other phases stay until the next one.
    static func shows(_ phase: OverlayPhase) -> TimeInterval? {
        switch phase {
        case .kept: return 2.5
        case .note(_, let clipboard): return clipboard ? 6 : 4
        case .starting, .listening, .transcribing, .sending: return nil
        }
    }

    /// How much of the live transcript the overlay shows: four lines of its large type, about
    /// 40 Latin characters or 20 wide ones a line. A wide character counts twice.
    static let overlayUnits = 160

    /// The end of `text` within `units` (a CJK character counts 2): what is being said, cut at a
    /// word when one ends near the cut (a language without spaces is cut anywhere).
    static func tail(_ text: String, units: Int) -> String {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var used = 0
        var start = text.endIndex
        while start > text.startIndex {
            let before = text.index(before: start)
            let cost = wide(text[before]) ? 2 : 1
            if used + cost > units { break }
            used += cost
            start = before
        }
        guard start > text.startIndex else { return text }
        var kept = text[start...]
        if let space = kept.prefix(max(1, units / 6)).firstIndex(of: " ") { kept = kept[kept.index(after: space)...] }
        return "…" + kept
    }

    /// The meter's bars, and how often the level moves them (at most 20 times a second).
    static let meterBars = 36
    static let levelInterval: TimeInterval = 0.05

    /// A buffer's RMS (0…1 of full scale) as the meter's 0…1: −50 dB is silence, −10 dB full.
    static func meterLevel(rms: Double) -> Double {
        let db = 20 * log10(max(rms, 0.000_01))
        return min(1, max(0, (db + 50) / 40))
    }

    /// Smoothing: a louder sample is taken almost at once, a quieter one eased toward, so the
    /// bars rise with a syllable and settle rather than flicker.
    static func smooth(previous: Double, sample: Double) -> Double {
        let weight = sample > previous ? 0.7 : 0.25
        return previous + (sample - previous) * weight
    }

    /// The meter's history: the newest level on the right, the oldest dropped.
    static func push(_ levels: [Double], _ level: Double, count: Int = meterBars) -> [Double] {
        let all = levels + [min(1, max(0, level))]
        let kept = Array(all.suffix(count))
        return Array(repeating: 0, count: max(0, count - kept.count)) + kept
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

    /// The overlay after the target kept the note: its title, and its own name for what was kept.
    static func keptTitle(title: String, label: String?) -> String {
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return label.isEmpty ? String(localized: "Kept in \(title)") : String(localized: "Kept in \(title) · \(label)")
    }

    /// The overlay after sending failed: the note is on the clipboard instead, so nothing said is lost.
    static func failedNote(title: String, reason: String) -> String {
        // The reason sits in parentheses: its own closing full stop would read twice.
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ".。"))
        return String(localized: "Could not send to \(title) (\(reason)). The text is on the clipboard.")
    }

    /// The overlay before recording when the Space has nowhere to send a note.
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
