import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct DictationRulesTests {
    @Test func ownWindowWithTheKeyboardPastesItselfWithoutPermission() {
        #expect(DictationRules.delivery(ownKeyWindow: true, active: true, trusted: false) == .ownPaste)
        // Quick Chat takes the keyboard over another app without making this one active.
        #expect(DictationRules.delivery(ownKeyWindow: true, active: false, trusted: false) == .ownPaste)
        #expect(DictationRules.delivery(ownKeyWindow: true, active: false, trusted: true) == .ownPaste)
    }

    @Test func anotherAppGetsCommandVOnlyWithAccessibility() {
        #expect(DictationRules.delivery(ownKeyWindow: false, active: false, trusted: true) == .systemPaste)
        #expect(DictationRules.delivery(ownKeyWindow: false, active: false, trusted: false) == .clipboardOnly)
    }

    @Test func frontmostWithNothingFocusedLeavesTheClipboard() {
        // A posted ⌘V would come back to this app, which has no field to take it.
        #expect(DictationRules.delivery(ownKeyWindow: false, active: true, trusted: true) == .clipboardOnly)
    }

    @Test func clipboardComesBackOnlyAfterAPasteNobodyCopiedOver() {
        #expect(DictationRules.restores(.ownPaste, changeCount: 7, written: 7))
        #expect(DictationRules.restores(.systemPaste, changeCount: 7, written: 7))
        #expect(!DictationRules.restores(.systemPaste, changeCount: 8, written: 7))
        #expect(!DictationRules.restores(.clipboardOnly, changeCount: 7, written: 7))
    }

    @Test func theCapsuleShowsTheEndOfALongTranscript() {
        #expect(DictationRules.tail("  short  ") == "short")
        let words = (1...40).map { "word\($0)" }.joined(separator: " ")
        let tail = DictationRules.tail(words, limit: 60)
        #expect(tail.hasPrefix("…word"))
        #expect(tail.hasSuffix("word40"))
        #expect(tail.count <= 61)
        // No spaces: cut anywhere, the end kept.
        let chinese = String(repeating: "说", count: 200) + "完"
        #expect(DictationRules.tail(chinese, limit: 50) == "…" + String(repeating: "说", count: 49) + "完")
    }

    @Test func aClipIsAPlainWAV() {
        let pcm = Data([1, 0, 2, 0, 3, 0])
        let wav = DictationRules.wav(pcm: pcm)
        #expect(wav.count == 44 + pcm.count)
        #expect(String(decoding: wav.prefix(4), as: UTF8.self) == "RIFF")
        #expect(String(decoding: wav[8..<16], as: UTF8.self) == "WAVEfmt ")
        let u32 = { (at: Int) in wav[at..<at + 4].enumerated().reduce(0) { $0 | Int($1.element) << (8 * $1.offset) } }
        #expect(u32(4) == 36 + pcm.count)
        #expect(u32(24) == 16000)
        #expect(u32(28) == 32000)
        #expect(u32(40) == pcm.count)
        #expect(wav.suffix(pcm.count) == pcm)
    }
}
