import Foundation

/// What each Space answered to `GET /api/voice` (whether it can transcribe), by origin, kept for
/// a short while (docs/macos-desktop.md#voice-input). Not for the life of the app: a Space can
/// gain or lose its voice interface while the app runs, and switching back to it must not meet an
/// old answer. A request that failed is never remembered, and a failed transcription forgets the
/// Space's answer so the next press asks again.
struct VoiceProbes {
    static let lifetime: TimeInterval = 60

    private var answers: [URL: (can: Bool, at: Date)] = [:]

    /// The Space's answer while it is fresh, else nil: ask it.
    func answer(_ base: URL, now: Date = Date()) -> Bool? {
        guard let a = answers[base], now.timeIntervalSince(a.at) < Self.lifetime, now >= a.at else { return nil }
        return a.can
    }

    mutating func remember(_ can: Bool, for base: URL, now: Date = Date()) {
        answers[base] = (can, now)
    }

    mutating func forget(_ base: URL) {
        answers[base] = nil
    }
}
