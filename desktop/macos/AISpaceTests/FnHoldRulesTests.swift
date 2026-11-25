import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct FnHoldRulesTests {
    @Test func holdingFnAloneStartsAndReleasingStops() {
        var rules = FnHoldRules()
        guard case .arm(let token) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        #expect(rules.holding)
        #expect(rules.elapsed(token) == .start)
        #expect(rules.fn(down: false, others: false) == .stop)
        #expect(!rules.holding)
    }

    @Test func aTapNeverStarts() {
        var rules = FnHoldRules()
        guard case .arm(let token) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        #expect(rules.fn(down: false, others: false) == .none)
        // The timer of that tap runs out after the release.
        #expect(rules.elapsed(token) == .none)
    }

    @Test func aCombinationNeverStarts() {
        // fn+arrow, fn+F5, fn+Delete: a key before the timer runs out.
        var rules = FnHoldRules()
        guard case .arm(let token) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        #expect(rules.other() == .none)
        #expect(rules.elapsed(token) == .none)
        #expect(rules.holding)
        #expect(rules.fn(down: false, others: false) == .none)
        #expect(!rules.holding)
        // ⌃ held before fn went down.
        #expect(rules.fn(down: true, others: true) == .none)
        #expect(rules.fn(down: false, others: false) == .none)
    }

    @Test func otherKeysWhileRecordingAreIgnored() {
        var rules = FnHoldRules()
        guard case .arm(let token) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        #expect(rules.elapsed(token) == .start)
        #expect(rules.other() == .none)
        #expect(rules.fn(down: true, others: false) == .none)
        #expect(rules.fn(down: false, others: false) == .stop)
    }

    @Test func anOldTimerDoesNotStartTheNextPress() {
        var rules = FnHoldRules()
        guard case .arm(let first) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        _ = rules.fn(down: false, others: false)
        guard case .arm(let second) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        #expect(first != second)
        #expect(rules.elapsed(first) == .none)
        #expect(rules.elapsed(second) == .start)
    }

    @Test func resetForgetsAHold() {
        var rules = FnHoldRules()
        guard case .arm(let token) = rules.fn(down: true, others: false) else { Issue.record("not armed"); return }
        rules.reset()
        #expect(rules.elapsed(token) == .none)
        #expect(rules.fn(down: false, others: false) == .none)
    }
}
