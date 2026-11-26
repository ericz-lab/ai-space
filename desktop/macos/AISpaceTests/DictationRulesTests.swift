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

    @Test func theOverlayShowsTheEndOfALongTranscript() {
        #expect(DictationRules.tail("  short  ", units: 120) == "short")
        let words = (1...40).map { "word\($0)" }.joined(separator: " ")
        let tail = DictationRules.tail(words, units: 60)
        #expect(tail.hasPrefix("…word"))
        #expect(tail.hasSuffix("word40"))
        #expect(tail.count <= 61)
        // No spaces: cut anywhere, the end kept.
        let chinese = String(repeating: "说", count: 200) + "完"
        #expect(DictationRules.tail(chinese, units: 100) == "…" + String(repeating: "说", count: 49) + "完")
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
        #expect(DictationRules.keptTitle(title: "Decree", label: "Decree #3") == "Kept in Decree · Decree #3")
        #expect(DictationRules.keptTitle(title: "Decree", label: nil) == "Kept in Decree")
        #expect(DictationRules.keptTitle(title: "Decree", label: "  ") == "Kept in Decree")
        #expect(DictationRules.failedNote(title: "Decree", reason: "offline") == "Could not send to Decree (offline). The text is on the clipboard.")
        #expect(DictationRules.failedNote(title: "Decree", reason: "The network connection was lost. ") == "Could not send to Decree (The network connection was lost). The text is on the clipboard.")
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

/// The large voice overlay: what it says for each key and phase, and how long a result stays.
struct DictationOverlayTests {
    @Test func theBadgeTellsTheKeysApart() {
        #expect(DictationRules.badgeTitle(.field, target: nil) == "Voice input")
        #expect(DictationRules.badgeTitle(.field, target: "Decree") == "Voice input")
        #expect(DictationRules.badgeDetail(.field) == "into the current field")
        #expect(DictationRules.badgeTitle(.capture, target: "Decree") == "Note to Decree")
        // Before the Space named the app.
        #expect(DictationRules.badgeTitle(.capture, target: nil) == "Spoken note")
        #expect(DictationRules.badgeDetail(.capture) == nil)
        #expect(DictationRules.keyCap(.field) == "fn")
        #expect(DictationRules.keyCap(.capture) == "right ⌥")
    }

    @Test func theFooterSaysWhatLettingGoDoesThenWhatIsHappening() {
        #expect(DictationRules.footer(.starting, destination: .field, target: nil) == "let go to insert")
        #expect(DictationRules.footer(.listening, destination: .field, target: nil) == "let go to insert")
        #expect(DictationRules.footer(.listening, destination: .capture, target: "Decree") == "let go to send to Decree")
        #expect(DictationRules.footer(.starting, destination: .capture, target: nil) == "let go to send")
        #expect(DictationRules.footer(.transcribing, destination: .capture, target: "Decree") == "Transcribing…")
        #expect(DictationRules.footer(.sending, destination: .capture, target: "Decree") == "Sending to Decree…")
        #expect(DictationRules.footer(.kept(label: "Decree #3"), destination: .capture, target: "Decree") == nil)
        #expect(DictationRules.footer(.note("x", clipboard: false), destination: .field, target: nil) == nil)
    }

    @Test func theTimerWarnsInTheLastTenSeconds() {
        #expect(DictationRules.maxRecordingSeconds == 90)
        #expect(!DictationRules.timerWarns(elapsed: 0))
        #expect(!DictationRules.timerWarns(elapsed: 79))
        #expect(DictationRules.timerWarns(elapsed: 80))
        #expect(DictationRules.timerWarns(elapsed: 90))
        #expect(DictationRules.elapsedLabel(7) == "0:07")
        #expect(DictationRules.elapsedLabel(65) == "1:05")
        #expect(DictationRules.elapsedLabel(90) == "1:30")
        #expect(DictationRules.elapsedLabel(-3) == "0:00")
    }

    @Test func howLongEachResultStays() {
        #expect(DictationRules.shows(.kept(label: nil)) == 2.5)
        #expect(DictationRules.shows(.note("x", clipboard: false)) == 4)
        #expect(DictationRules.shows(.note("x", clipboard: true)) == 6)
        for phase: DictationRules.OverlayPhase in [.starting, .listening, .transcribing, .sending] {
            #expect(DictationRules.shows(phase) == nil)
        }
    }

    @Test func theTailFitsFourLinesOfLargeType() {
        let short = "Remind me to call the bank"
        #expect(DictationRules.tail(short, units: DictationRules.overlayUnits) == short)
        let long = String(repeating: "word ", count: 60) + "end"
        let tail = DictationRules.tail(long, units: 160)
        #expect(tail.hasPrefix("…"))
        #expect(tail.hasSuffix("end"))
        #expect(tail.count <= 161)
        // Cut at a word.
        #expect(tail.dropFirst().hasPrefix("word"))
        // A wide character counts twice: 160 units hold 80 of them.
        let chinese = String(repeating: "说", count: 120)
        #expect(DictationRules.tail(chinese, units: 160) == "…" + String(repeating: "说", count: 80))
    }

    @Test func theMeterLevel() {
        #expect(DictationRules.meterLevel(rms: 0) == 0)
        #expect(DictationRules.meterLevel(rms: 1) == 1)
        // −30 dB, halfway between silence (−50) and full (−10).
        #expect(abs(DictationRules.meterLevel(rms: 0.0316) - 0.5) < 0.01)
        // Rises fast, falls slowly.
        #expect(DictationRules.smooth(previous: 0, sample: 1) == 0.7)
        #expect(DictationRules.smooth(previous: 1, sample: 0) == 0.75)
        let levels = DictationRules.push(Array(repeating: 0, count: 36), 0.5)
        #expect(levels.count == 36)
        #expect(levels.last == 0.5)
        #expect(DictationRules.push([], 2, count: 3) == [0, 0, 1])
        #expect(DictationRules.meterBars == 36)
        #expect(DictationRules.levelInterval >= 0.05)
    }
}
