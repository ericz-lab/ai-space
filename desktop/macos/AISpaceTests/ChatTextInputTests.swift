import AppKit
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct ChatTextInputTests {
    @Test func emptyAndSingleLineShareHeightAndNewlinesGrow() {
        let editor = ChatTextEditor(frame: NSRect(x: 0, y: 0, width: 300, height: 20))
        editor.font = .systemFont(ofSize: 14)
        editor.textContainerInset = .zero
        editor.textContainer?.lineFragmentPadding = 0
        let empty = editor.contentHeight(for: 300)
        editor.string = "Hello"
        #expect(editor.contentHeight(for: 300) == empty)
        editor.string = "Hello\n"
        #expect(editor.contentHeight(for: 300) > empty)
        editor.string = String(repeating: "long message ", count: 20)
        #expect(editor.contentHeight(for: 100) > empty)
        editor.string = ""
        #expect(editor.contentHeight(for: 300) == empty)
    }

    @Test func screenshotPasteReachesTheComposerAndLeavesTextAlone() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let editor = ChatTextEditor()
        editor.string = "draft"
        editor.pasteboard = { board }
        var received: [Data] = []
        editor.onImage = { received.append($0) }
        for type in [NSPasteboard.PasteboardType.png, .tiff] {
            board.clearContents()
            let data = Data([1, 2, 3])
            board.setData(data, forType: type)
            editor.paste(nil)
            #expect(received.last == data)
            #expect(editor.string == "draft")
        }
        board.clearContents()
        board.setString("ordinary text", forType: .string)
        #expect(!editor.pasteImages(from: board))
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        // Text paste uses AppKit's general pasteboard; the image hook must decline it.
        #expect(received.count == 2)
    }

    @Test func finderFilesTakePrecedenceOverTheFileIcon() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let urls = [URL(fileURLWithPath: "/tmp/screenshot.png"), URL(fileURLWithPath: "/tmp/photo.jpg")]
        board.writeObjects(urls as [NSURL])
        board.setData(Data([9]), forType: .tiff)
        let editor = ChatTextEditor()
        var received: [URL] = []
        var iconReceived = false
        editor.onImageFile = { received.append($0) }
        editor.onImage = { _ in iconReceived = true }
        #expect(editor.pasteImages(from: board))
        #expect(received == urls)
        #expect(!iconReceived)
    }

    @Test func returnSendsButShiftReturnAndCompositionDoNot() throws {
        let editor = ChatTextEditor()
        var sends = 0
        editor.onSend = { sends += 1 }
        func enter(_ modifiers: NSEvent.ModifierFlags = []) throws -> NSEvent {
            try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                                          windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        }
        editor.keyDown(with: try enter())
        #expect(sends == 1)
        editor.keyDown(with: try enter(.shift))
        #expect(sends == 1)
        editor.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        editor.keyDown(with: try enter())
        #expect(sends == 1)
    }
}
