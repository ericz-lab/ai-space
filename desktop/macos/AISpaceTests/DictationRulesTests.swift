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

    @Test func accessibilityIsAskedOnceAndOnlyForOtherApps() {
        #expect(DictationRules.asksForAccessibility(ownKeyWindow: false, trusted: false, askedBefore: false))
        #expect(!DictationRules.asksForAccessibility(ownKeyWindow: false, trusted: false, askedBefore: true))
        #expect(!DictationRules.asksForAccessibility(ownKeyWindow: false, trusted: true, askedBefore: false))
        #expect(!DictationRules.asksForAccessibility(ownKeyWindow: true, trusted: false, askedBefore: false))
    }

    @Test func clipboardComesBackOnlyAfterAPasteNobodyCopiedOver() {
        #expect(DictationRules.restores(.ownPaste, changeCount: 7, written: 7))
        #expect(DictationRules.restores(.systemPaste, changeCount: 7, written: 7))
        #expect(!DictationRules.restores(.systemPaste, changeCount: 8, written: 7))
        #expect(!DictationRules.restores(.clipboardOnly, changeCount: 7, written: 7))
    }
}
