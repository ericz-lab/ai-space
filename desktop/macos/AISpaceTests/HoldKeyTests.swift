import Carbon.HIToolbox
import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// Which `flagsChanged` events are the watched key's, and what they say (FnKey feeds the answer to FnHoldRules).
struct HoldKeyTests {
    // Flags as NSEvent reports them: the device-independent bit and the device bit of the side.
    private let rightOptionDown = HoldKey.option | HoldKey.rightOptionDevice
    private let leftOptionDown = HoldKey.option | HoldKey.leftOptionDevice

    @Test func theKeyCodesAreCarbons() {
        #expect(HoldKey.fn.keyCode == UInt16(kVK_Function))
        #expect(HoldKey.rightOption.keyCode == UInt16(kVK_RightOption))
        #expect(UInt16(kVK_Option) != UInt16(kVK_RightOption))
    }

    @Test func fnReadsAsItAlwaysHas() {
        #expect(HoldKey.fn.reading(keyCode: 0x3F, flags: HoldKey.function)! == (true, false))
        #expect(HoldKey.fn.reading(keyCode: 0x3F, flags: 0)! == (false, false))
        // Any of ⌘ ⌥ ⌃ ⇧ held with it, either side.
        for other in [HoldKey.command, HoldKey.option, HoldKey.control, HoldKey.shift] {
            #expect(HoldKey.fn.reading(keyCode: 0x3F, flags: HoldKey.function | other)! == (true, true))
        }
        #expect(HoldKey.fn.reading(keyCode: UInt16(kVK_RightOption), flags: rightOptionDown) == nil)
        #expect(HoldKey.fn.poll == .functionFlag)
    }

    @Test func rightOptionAloneIsDownAndUp() {
        let key = HoldKey.rightOption
        #expect(key.reading(keyCode: UInt16(kVK_RightOption), flags: rightOptionDown)! == (true, false))
        #expect(key.reading(keyCode: UInt16(kVK_RightOption), flags: 0)! == (false, false))
        #expect(key.poll == .keyState)
    }

    @Test func leftOptionIsAnotherKey() {
        let key = HoldKey.rightOption
        // Its own event is not the watched key's, so it spoils an armed hold like any other key.
        #expect(key.reading(keyCode: UInt16(kVK_Option), flags: leftOptionDown) == nil)
        // Right ⌥ pressed while left ⌥ is held: a combination.
        #expect(key.reading(keyCode: UInt16(kVK_RightOption), flags: leftOptionDown | HoldKey.rightOptionDevice)! == (true, true))
        // Right ⌥ let go while left ⌥ stays down: `.option` is still set, the right device bit is not.
        #expect(key.reading(keyCode: UInt16(kVK_RightOption), flags: leftOptionDown)! == (false, true))
    }

    @Test func otherModifiersWithRightOptionAreACombination() {
        let key = HoldKey.rightOption
        for other in [HoldKey.command, HoldKey.control, HoldKey.shift] {
            #expect(key.reading(keyCode: UInt16(kVK_RightOption), flags: rightOptionDown | other)! == (true, true))
        }
    }

    @Test func rightOptionWithALetterNeverStarts() {
        // ⌥ + a letter types a special character: the letter goes down before the timer runs out.
        var rules = FnHoldRules()
        let down = HoldKey.rightOption.reading(keyCode: UInt16(kVK_RightOption), flags: rightOptionDown)!
        guard case .arm(let token) = rules.fn(down: down.down, others: down.others) else { Issue.record("not armed"); return }
        #expect(rules.other() == .none)
        #expect(rules.elapsed(token) == .none)
        let up = HoldKey.rightOption.reading(keyCode: UInt16(kVK_RightOption), flags: 0)!
        #expect(rules.fn(down: up.down, others: up.others) == .none)
    }
}
