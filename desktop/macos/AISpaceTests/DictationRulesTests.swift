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

    @Test func segmentsOfChineseJoinWithoutSpaces() {
        #expect(DictationRules.tidy("今天天气不错， 我们出去走走 好吗") == "今天天气不错，我们出去走走好吗")
        #expect(DictationRules.tidy("打开 Xcode 然后 运行") == "打开 Xcode 然后运行")
        #expect(DictationRules.tidy("hello world") == "hello world")
    }
}

/// Right ⌥: the transcript goes to an app of the Space as a note (docs/macos-desktop.md#voice-input).
struct DictationCaptureTests {
    private func target(_ id: String, _ title: String) -> ScreenshotRules.Target {
        ScreenshotRules.Target(id: id, app: id.components(separatedBy: "/").dropLast().last ?? id, title: title)
    }

    @Test func onlyTheKeyThatStartedItEndsIt() {
        #expect(DictationRules.ends(.field, recording: .field))
        #expect(DictationRules.ends(.capture, recording: .capture))
        #expect(!DictationRules.ends(.field, recording: .capture))
        #expect(!DictationRules.ends(.capture, recording: .field))
        #expect(!DictationRules.ends(.capture, recording: nil))
    }

    @Test func theCapsuleNamesTheKeyToLetGo() {
        #expect(DictationRules.listeningHint(.field) == "Listening… let go of fn to finish")
        #expect(DictationRules.listeningHint(.capture) == "Listening… let go of right ⌥ to finish")
    }

    @Test func theChosenTargetWhileItIsThereElseTheFirst() {
        let targets = [target("decree/issue", "Decree"), target("david/keep/note", "Keep")]
        #expect(DictationRules.captureTarget(targets, chosen: "david/keep/note")?.id == "david/keep/note")
        #expect(DictationRules.captureTarget(targets, chosen: "gone/app")?.id == "decree/issue")
        #expect(DictationRules.captureTarget(targets, chosen: nil)?.id == "decree/issue")
        #expect(DictationRules.captureTarget([], chosen: "decree/issue") == nil)
    }

    @Test func theNoteGoesToTheTargetWithAUUID() {
        #expect(DictationRules.capturePath(to: target("decree/issue", "Decree")) == "/api/capture/text?to=decree/issue")
        #expect(DictationRules.capturePath(to: target("david/decree/issue", "Decree")) == "/api/capture/text?to=david/decree/issue")
        let id = UUID(uuidString: "6B0F3C1E-2D4A-4E5B-8C7D-9E0F1A2B3C4D")!
        let body = DictationRules.captureBody(text: "明天十点开会", id: id)
        #expect(body["text"] as? String == "明天十点开会")
        #expect(body["via"] as? String == "voice")
        #expect(body["id"] as? String == "6b0f3c1e-2d4a-4e5b-8c7d-9e0f1a2b3c4d")
    }

    @Test func onlyANetworkErrorIsRetried() {
        #expect(DictationRules.retries(URLError(.networkConnectionLost)))
        #expect(DictationRules.retries(URLError(.timedOut)))
        #expect(!DictationRules.retries(SpaceAPIError.http(404, "nope")))
        #expect(!DictationRules.retries(SpaceAPIError.authenticationRequired))
    }

    @Test func whatTheCapsuleSays() {
        #expect(DictationRules.sentNote(title: "Decree", label: "Decree #3") == "Sent to Decree · Decree #3")
        #expect(DictationRules.sentNote(title: "Decree", label: nil) == "Sent to Decree")
        #expect(DictationRules.sentNote(title: "Decree", label: "  ") == "Sent to Decree")
        #expect(DictationRules.failedNote(title: "Decree", reason: "offline") == "Could not send to Decree (offline). The text is on the clipboard.")
        #expect(DictationRules.noTargetNote(space: "seoul") == "No app on seoul takes spoken notes.")
    }

    @Test func theTargetsAndTheAnswerAreRead() throws {
        let list = try JSONDecoder().decode(DictationRules.TextTargets.self, from: Data(#"{"ok":true,"image":true,"targets":[],"text":true,"textTargets":[{"id":"decree/issue","app":"decree","capability":"issue","title":"Decree","i18n":{"zh":{"title":"口谕"}},"kinds":["text"]}]}"#.utf8))
        #expect(list.textTargets?.map(\.id) == ["decree/issue"])
        #expect(list.textTargets?.first?.displayTitle(lang: "zh") == "口谕")
        // A Space older than the text kind.
        #expect(try JSONDecoder().decode(DictationRules.TextTargets.self, from: Data(#"{"ok":true,"image":true,"targets":[]}"#.utf8)).textTargets == nil)
        let answer = try JSONDecoder().decode(DictationRules.CaptureAnswer.self, from: Data(#"{"ok":true,"decree":{"id":3},"label":"口谕 #3"}"#.utf8))
        #expect(answer.label == "口谕 #3")
        #expect(DictationRules.kept(answer))
        #expect(!DictationRules.kept(DictationRules.CaptureAnswer(ok: false)))
        #expect(DictationRules.kept(nil))
    }
}
