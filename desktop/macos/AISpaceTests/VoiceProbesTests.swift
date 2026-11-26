import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

struct VoiceProbesTests {
    let mac = URL(string: "http://127.0.0.1:7777")!
    let seoul = URL(string: "https://seoul.example.com")!
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func anAnswerIsKeptPerSpace() {
        var probes = VoiceProbes()
        probes.remember(true, for: seoul, now: t0)
        probes.remember(false, for: mac, now: t0)
        #expect(probes.answer(seoul, now: t0.addingTimeInterval(5)) == true)
        #expect(probes.answer(mac, now: t0.addingTimeInterval(5)) == false)
        #expect(probes.answer(URL(string: "https://other.example.com")!, now: t0) == nil)
    }

    @Test func anOldAnswerIsAskedAgain() {
        // Switching back to a Space a while later must not meet what it said before.
        var probes = VoiceProbes()
        probes.remember(false, for: seoul, now: t0)
        #expect(probes.answer(seoul, now: t0.addingTimeInterval(VoiceProbes.lifetime - 1)) == false)
        #expect(probes.answer(seoul, now: t0.addingTimeInterval(VoiceProbes.lifetime)) == nil)
        // A clock set back does not make an answer live forever.
        #expect(probes.answer(seoul, now: t0.addingTimeInterval(-10)) == nil)
    }

    @Test func aFailedRecordingForgetsOnlyThatSpace() {
        var probes = VoiceProbes()
        probes.remember(true, for: seoul, now: t0)
        probes.remember(true, for: mac, now: t0)
        probes.forget(seoul)
        #expect(probes.answer(seoul, now: t0) == nil)
        #expect(probes.answer(mac, now: t0) == true)
    }
}
