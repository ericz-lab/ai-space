import Foundation
import Testing
#if canImport(AISpace)
@testable import AISpace
#endif

/// The language voice input sends, on the Mac and the iPhone alike (VoiceLanguage in SpaceModels.swift).
struct VoiceLanguageTests {
    @Test func theDefaultIsTheAppsLanguage() {
        #expect(VoiceLanguage.code(setting: nil, appLanguage: "zh") == "zh")
        #expect(VoiceLanguage.code(setting: VoiceLanguage.sameAsApp, appLanguage: "en") == "en")
        #expect(VoiceLanguage.code(setting: "", appLanguage: "zh-Hans") == "zh")
        #expect(VoiceLanguage.code(setting: "", appLanguage: "en-US") == "en")
    }

    @Test func anAppLanguageWithNoCodeIsDetected() {
        #expect(VoiceLanguage.code(setting: nil, appLanguage: "fr") == "")
        #expect(VoiceLanguage.code(setting: nil, appLanguage: "") == "")
    }

    @Test func theSettingOverridesTheAppsLanguage() {
        #expect(VoiceLanguage.code(setting: "en", appLanguage: "zh") == "en")
        #expect(VoiceLanguage.code(setting: "ja", appLanguage: "en") == "ja")
        #expect(VoiceLanguage.code(setting: VoiceLanguage.detect, appLanguage: "zh") == "")
        // A value this build does not know (from a newer one) is the default.
        #expect(VoiceLanguage.code(setting: "xx", appLanguage: "zh") == "zh")
    }

    @Test func theStartMessageAndTheUploadCarryIt() throws {
        let start = try #require(JSONSerialization.jsonObject(with: Data(VoiceLanguage.startMessage(language: "zh").utf8)) as? [String: Any])
        #expect(start["type"] as? String == "start")
        #expect(start["format"] as? String == "pcm_s16le")
        #expect(start["sample_rate"] as? Int == 16000)
        #expect(start["channels"] as? Int == 1)
        #expect(start["language"] as? String == "zh")
        let detect = try #require(JSONSerialization.jsonObject(with: Data(VoiceLanguage.startMessage(language: "").utf8)) as? [String: Any])
        #expect(detect["language"] as? String == "")
        #expect(VoiceLanguage.uploadFields(language: "en").map { "\($0.0)=\($0.1)" } == ["language=en"])
        #expect(VoiceLanguage.uploadFields(language: "").isEmpty)
    }
}
