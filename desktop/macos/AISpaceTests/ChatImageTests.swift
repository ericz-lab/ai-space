import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct ChatImageTests {
    @Test func imagesAreCapturedInTheTurnWithoutChangingPermissions() {
        let image = ChatImage(name: "screen.png", mediaType: "image/png", bytes: Data([1, 2, 3]))
        let turn = ChatTurnRequest(message: "", permission: .readOnly, images: [image])
        let body = turn.body(sessionID: "session")
        #expect(body["message"] as? String == "")
        #expect(body["permissionMode"] == nil)
        #expect(body["sessionId"] as? String == "session")
        #expect(body["images"] as? [[String: String]] == [["name": "screen.png", "mediaType": "image/png", "data": "AQID"]])
        #expect(ChatImage.validate([image]))
        #expect(!ChatImage.validate(Array(repeating: image, count: 5)))
        let large = ChatImage(name: "large.png", mediaType: "image/png", bytes: Data(count: 5 * 1024 * 1024))
        #expect(ChatImage.validate([large, large]))
        #expect(!ChatImage.validate([large, large, image]))
    }

    @Test func aDropThatWouldPassFourPicturesIsRefused() {
        #expect(ChatImage.fits(adding: 4, attached: 0, pending: 0))
        #expect(!ChatImage.fits(adding: 5, attached: 0, pending: 0))
        #expect(ChatImage.fits(adding: 1, attached: 2, pending: 1))
        // Pictures still being read count as attached.
        #expect(!ChatImage.fits(adding: 2, attached: 2, pending: 1))
    }
}
