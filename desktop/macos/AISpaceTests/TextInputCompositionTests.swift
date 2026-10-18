import AppKit
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

@MainActor
struct TextInputCompositionTests {
    @Test func candidateConfirmationIsNotSubmission() {
        let editor = NSTextView(frame: .zero)
        #expect(!TextInputComposition.isActive(in: editor))
        editor.setMarkedText("nihao", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(TextInputComposition.isActive(in: editor))
        editor.insertText("你好", replacementRange: editor.markedRange())
        #expect(editor.string == "你好")
        #expect(!TextInputComposition.isActive(in: editor))
    }

    @Test func cancellingCompositionRestoresNormalReturn() {
        let editor = NSTextView(frame: .zero)
        editor.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        #expect(TextInputComposition.isActive(in: editor))
        editor.unmarkText()
        #expect(!TextInputComposition.isActive(in: editor))
        #expect(!TextInputComposition.isActive(in: nil))
    }
}
