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

    @Test func measuringAtAnotherWidthLeavesTheEditorAlone() {
        let editor = ChatTextEditor(frame: NSRect(x: 0, y: 0, width: 300, height: 20))
        editor.font = .systemFont(ofSize: 14)
        editor.textContainer?.lineFragmentPadding = 0
        editor.string = String(repeating: "输入较长的文字会", count: 6)
        _ = editor.contentHeight(for: 40)
        _ = editor.contentHeight(for: .infinity)
        #expect(editor.frame.width == 300)
        #expect(editor.contentHeight(for: 40) > editor.contentHeight(for: 300))
    }

    @Test func theScrollViewKeepsTheEditorAsWideAsTheField() {
        let scroll = ChatTextScrollView(frame: NSRect(x: 0, y: 0, width: 280, height: 40))
        scroll.hasHorizontalScroller = false
        let editor = ChatTextEditor(frame: NSRect(x: 0, y: 0, width: 70, height: 20))
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.textContainer?.widthTracksTextView = true
        scroll.documentView = editor
        editor.string = String(repeating: "输入较长的文字会", count: 6)
        scroll.contentView.scroll(to: NSPoint(x: 120, y: 0))
        scroll.tile()
        #expect(editor.frame.width == scroll.contentSize.width)
        #expect(scroll.contentView.bounds.origin.x == 0)
        scroll.setFrameSize(NSSize(width: 200, height: 40))
        scroll.tile()
        #expect(editor.frame.width == scroll.contentSize.width)
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
