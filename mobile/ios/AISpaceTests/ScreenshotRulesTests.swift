import Foundation
import Testing

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

    @Test func theCapturersAnswerIsRead() throws {
        let data = Data(#"{"ok":true,"idea":{"id":14,"text":"","source":"image"},"url":"https://spark.example/?idea=14"}"#.utf8)
        let answer = try JSONDecoder().decode(ScreenshotRules.Answer.self, from: data)
        #expect(answer == .init(idea: .init(id: 14), url: "https://spark.example/?idea=14"))
        let none = try JSONDecoder().decode(ScreenshotRules.Availability.self, from: Data(#"{"ok":true,"image":false}"#.utf8))
        #expect(!none.image)
    }
}
