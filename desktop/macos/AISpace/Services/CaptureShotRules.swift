import Foundation

/// The screenshot that goes along with a spoken note (right ⌥, docs/macos-desktop.md#spoken-notes):
/// when one is taken, how big it may be, which route carries the note, and what a failure leads
/// to. Foundation only: Desktop/ScreenShot.swift takes the picture, Dictation.swift sends it, and
/// the tests check the decisions. A screenshot problem never loses the words: every path without
/// a usable picture is the text route as before.
enum CaptureShotRules {
    /// The longest side of the picture, in pixels.
    static let maxLongSide = 2560
    /// The largest JPEG sent: well under the 4 MiB cap on the whole call, leaving room for the
    /// words and the multipart envelope.
    static let budget = 3 * 1024 * 1024
    /// The file's name in the multipart `file` field.
    static let filename = "screen.jpg"
    static let mimeType = "image/jpeg"
    /// How long a send waits for a picture still being taken; past that the words go alone.
    static let wait: TimeInterval = 1.5

    /// One try at encoding: the longest side and the JPEG quality.
    struct Step: Equatable {
        let longSide: Int
        let quality: Double
    }

    /// Tried in order until one fits the budget: quality first, then size.
    static let steps: [Step] = [
        Step(longSide: 2560, quality: 0.8),
        Step(longSide: 2560, quality: 0.65),
        Step(longSide: 2048, quality: 0.6),
        Step(longSide: 1600, quality: 0.55),
        Step(longSide: 1280, quality: 0.5),
    ]

    /// Whether this press takes a screenshot: right ⌥ only, with the setting on and Screen Recording
    /// granted. fn never does; without the grant the note is words only.
    static func takes(_ destination: DictationRules.Destination, enabled: Bool, granted: Bool) -> Bool {
        destination == .capture && enabled && granted
    }

    /// Whether the system's Screen Recording prompt is shown on this press: the first use with the
    /// setting on and no grant, once. It is the system's own panel and never blocks the key.
    static func asks(_ destination: DictationRules.Destination, enabled: Bool, granted: Bool, askedBefore: Bool) -> Bool {
        destination == .capture && enabled && !granted && !askedBefore
    }

    /// A target that takes pictures as well as words (`kinds` of `GET /api/capture`). A Space
    /// older than `kinds` says nothing, which counts as words only.
    static func takesImage(_ target: ScreenshotRules.Target) -> Bool {
        target.kinds?.contains("image") == true
    }

    /// `width` × `height` scaled down so the longest side is at most `longSide`; never scaled up.
    static func size(width: Int, height: Int, longSide: Int = maxLongSide) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > longSide, long > 0 else { return (max(width, 1), max(height, 1)) }
        let scale = Double(longSide) / Double(long)
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// The first encoding within the budget, trying `steps` in order; nil when none fits or none
    /// could be made, and the note then goes without it.
    static func firstFitting(_ steps: [Step] = steps, encode: (Step) -> Data?) -> (data: Data, step: Step)? {
        for step in steps {
            guard let data = encode(step) else { continue }
            if !data.isEmpty, data.count <= budget { return (data, step) }
        }
        return nil
    }

    /// The route a note goes by.
    enum Route: Equatable {
        /// `POST /api/capture/image?to=` with the screenshot and the words.
        case image
        /// `POST /api/capture/text?to=` with the words alone, as before.
        case text
    }

    /// One request when the target takes both kinds and a picture is in hand; else the words alone.
    static func route(_ target: ScreenshotRules.Target, shot: Bool) -> Route {
        shot && takesImage(target) ? .image : .text
    }

    /// `POST /api/capture/image?to=<id>`.
    static func imagePath(to target: ScreenshotRules.Target) -> String {
        ScreenshotRules.uploadPath(to: target)
    }

    /// The form fields before the file: the same `id` as the text route would carry, `via: voice`
    /// and the words.
    static func fields(text: String, id: UUID) -> [(String, String)] {
        ScreenshotRules.fields(id: id, text: text, via: "voice")
    }

    /// What follows a failed try: the same route again, the words alone through the text route,
    /// or nothing (the note goes to the clipboard). A target that refuses the picture (404, 400,
    /// 413) gets the words once through the text route with the same `id`; a network error is
    /// tried again once, as before.
    static func next(after error: Error, route: Route, retried: Bool) -> Route? {
        if route == .image, case SpaceAPIError.http(let status, _) = error, [400, 404, 413].contains(status) { return .text }
        if !retried, DictationRules.retries(error) { return route }
        return nil
    }

    /// The most tries one note makes: the first, one network retry and one fall back to words.
    static let maxTries = 4

    /// The capsule after the target kept the note; `shot` when the screenshot went with it.
    static func sentNote(title: String, label: String?, shot: Bool) -> String {
        guard shot else { return DictationRules.sentNote(title: title, label: label) }
        let label = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return label.isEmpty
            ? String(localized: "Sent to \(title) · with a screenshot")
            : String(localized: "Sent to \(title) · \(label) · with a screenshot")
    }
}
