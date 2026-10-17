import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@Suite struct ScreenshotRulesTests {
    @Test func picturesAreSentAsTheyAreOnlyWhenPNGOrJPEGWithinTheLimit() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let heic = Data([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])
        #expect(ScreenshotRules.sendable(png) == .png)
        #expect(ScreenshotRules.sendable(jpeg) == .jpeg)
        #expect(ScreenshotRules.sendable(heic) == nil)
        #expect(ScreenshotRules.sendable(png + Data(count: ScreenshotRules.maxBytes)) == nil)
        // The bus caps a call at 4 MiB; the app keeps 64 KiB of it for the envelope.
        #expect(ScreenshotRules.maxBytes < 4 * 1024 * 1024 - 64 * 1024)
    }

    @Test func onlyAScreenshotFromAroundTheNoticeIsTheOneJustTaken() {
        let noticed = Date(timeIntervalSince1970: 1_000)
        #expect(ScreenshotRules.isFresh(created: noticed.addingTimeInterval(-2), noticed: noticed))
        #expect(ScreenshotRules.isFresh(created: noticed.addingTimeInterval(1), noticed: noticed))
        #expect(!ScreenshotRules.isFresh(created: noticed.addingTimeInterval(-60), noticed: noticed))
        #expect(!ScreenshotRules.isFresh(created: nil, noticed: noticed))
    }

    @Test func fieldsCarryTheRetryIdAndOnlyWordsThatAreThere() {
        let id = UUID(uuidString: "2F1C7A9E-4B3D-4C2A-9E8F-1A2B3C4D5E6F")!
        let empty = ScreenshotRules.fields(id: id, text: "  \n", via: "screenshot")
        #expect(empty.map(\.0) == ["id", "via"])
        #expect(empty[0].1 == "2f1c7a9e-4b3d-4c2a-9e8f-1a2b3c4d5e6f")
        let words = ScreenshotRules.fields(id: id, text: " 这个排版好看 ", via: "screenshot")
        #expect(words.last! == ("text", "这个排版好看"))
    }

    @Test func aTargetsAnswerNamesWhatWasKept() throws {
        let spark = try JSONDecoder().decode(ScreenshotRules.Answer.self, from: Data(#"{"ok":true,"idea":{"id":14,"text":""},"url":"https://spark.example/?idea=14"}"#.utf8))
        #expect(spark.url == "https://spark.example/?idea=14")
        let target = ScreenshotRules.Target(id: "ai-spark/capture-image", app: "ai-spark", title: "Spark")
        #expect(ScreenshotRules.receipt(spark, target: target) == "Spark #14")
        let notes = try JSONDecoder().decode(ScreenshotRules.Answer.self, from: Data(#"{"ok":true,"label":"笔记 #9","url":"https://notes.example/?note=9"}"#.utf8))
        #expect(ScreenshotRules.receipt(notes, target: nil) == "笔记 #9")
    }

    @Test func theSpacesTargetsAreListedAndTheLastChoiceKept() throws {
        let data = Data(#"{"ok":true,"image":true,"targets":[{"id":"ai-spark/capture-image","app":"ai-spark","capability":"capture-image","title":"Spark","i18n":{"zh":{"title":"灵光一闪"}}},{"id":"david/ai-notes/capture-image","app":"ai-notes","peer":"david","title":"Notes"}]}"#.utf8)
        let a = try JSONDecoder().decode(ScreenshotRules.Availability.self, from: data)
        let targets = try #require(a.targets)
        #expect(targets.map(\.id) == ["ai-spark/capture-image", "david/ai-notes/capture-image"])
        #expect(targets[0].displayTitle(lang: "zh") == "灵光一闪")
        #expect(targets[0].displayTitle(lang: "en") == "Spark")
        #expect(ScreenshotRules.preferred(targets, last: "david/ai-notes/capture-image")?.app == "ai-notes")
        #expect(ScreenshotRules.preferred(targets, last: "gone/x")?.app == "ai-spark")
        #expect(ScreenshotRules.uploadPath(to: targets[1]) == "/api/capture/image?to=david/ai-notes/capture-image")
        #expect(ScreenshotRules.uploadPath(to: nil) == "/api/capture/image")
        // A Space older than the target list says only whether it can keep one.
        let old = try JSONDecoder().decode(ScreenshotRules.Availability.self, from: Data(#"{"ok":true,"image":true,"app":"ai-spark"}"#.utf8))
        #expect(old.image && old.targets == nil)
    }
}
