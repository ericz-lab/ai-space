import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct ChatStoreTests {
    /// A Space nobody answers at: the turn fails in the background, after what is checked here.
    private func store() -> ChatStore {
        ChatStore(api: SpaceAPI(base: URL(string: "http://127.0.0.1:9")!, cookies: { [] }), base: "/api/agents/space/assistant")
    }

    @Test func aQuestionFromSearchLeavesTheFieldAndItsPicturesAlone() {
        let chat = store()
        let picture = ChatImage(name: "a.png", mediaType: "image/png", bytes: Data([1, 2, 3]))
        chat.draft = "half a thought"
        chat.images = [picture]
        chat.send(text: "  what is due today?  ", intentID: nil, timezone: "UTC")
        #expect(chat.draft == "half a thought")
        #expect(chat.images == [picture])
        let asked = chat.bubbles.first { $0.isUser }
        #expect(asked?.text == "what is due today?")
        #expect(asked?.images.isEmpty == true)
        #expect(chat.isRunning)
    }

    @Test func anEmptyQuestionSendsNothing() {
        let chat = store()
        chat.send(text: "   ")
        #expect(chat.bubbles.isEmpty)
        #expect(!chat.isRunning)
    }

    @Test func theFieldStillSendsItsOwnTextAndPictures() {
        let chat = store()
        let picture = ChatImage(name: "a.png", mediaType: "image/png", bytes: Data([1]))
        chat.draft = "look"
        chat.images = [picture]
        chat.send()
        #expect(chat.draft.isEmpty && chat.images.isEmpty)
        #expect(chat.bubbles.first?.images == [picture])
    }
}
