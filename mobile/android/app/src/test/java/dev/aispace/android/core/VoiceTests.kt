package dev.aispace.android.core

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Voice input's rules: the language sent, the transcript, the frames and the clip (the Mac's and iPhone's tests). */
class VoiceTests {
    @Test fun theDefaultFollowsTheAppsLanguageWhenItIsOneOfTheCodes() {
        assertEquals("zh", VoiceLanguage.code(VoiceLanguage.SAME_AS_APP, appLanguage = "zh"))
        assertEquals("zh", VoiceLanguage.code(null, appLanguage = "zh-Hans-CN"))
        assertEquals("en", VoiceLanguage.code(null, appLanguage = "en_US"))
        assertEquals("ja", VoiceLanguage.code("", appLanguage = "ja"))
        // A language no provider is sure to take as it is: the provider detects it.
        assertEquals("", VoiceLanguage.code("", appLanguage = "fr"))
        assertEquals("", VoiceLanguage.code("", appLanguage = ""))
    }

    @Test fun detectSendsNothingAndAChosenCodeWinsOverTheAppsLanguage() {
        assertEquals("", VoiceLanguage.code(VoiceLanguage.DETECT, appLanguage = "zh"))
        assertEquals("ko", VoiceLanguage.code("ko", appLanguage = "zh"))
        assertEquals("en", VoiceLanguage.code("en", appLanguage = "fr"))
        // A setting this version does not know is the default.
        assertEquals("zh", VoiceLanguage.code("zh-Hans", appLanguage = "zh"))
        assertEquals("", VoiceLanguage.code("de", appLanguage = "fr"))
    }

    @Test fun aSavedSettingIsReadBackOnlyWhenItIsOneOfTheChoices() {
        assertEquals(VoiceLanguage.SAME_AS_APP, VoiceLanguage.setting(null))
        assertEquals(VoiceLanguage.SAME_AS_APP, VoiceLanguage.setting("fr"))
        assertEquals(VoiceLanguage.DETECT, VoiceLanguage.setting("auto"))
        assertEquals("ja", VoiceLanguage.setting("ja"))
    }

    @Test fun theStartMessageCarriesABareCodeOrNothing() {
        val zh = JSONObject(VoiceLanguage.startMessage("zh"))
        assertEquals("start", zh.getString("type"))
        assertEquals("pcm_s16le", zh.getString("format"))
        assertEquals(16000, zh.getInt("sample_rate"))
        assertEquals(1, zh.getInt("channels"))
        assertEquals("zh", zh.getString("language"))
        assertEquals("", JSONObject(VoiceLanguage.startMessage("")).getString("language"))
        assertEquals("", JSONObject(VoiceLanguage.startMessage("zh\",\"x\":\"")).getString("language"))
    }

    @Test fun anUploadNamesTheLanguageOnlyWhenThereIsOne() {
        assertEquals(listOf("language" to "en"), VoiceLanguage.uploadFields("en"))
        assertTrue(VoiceLanguage.uploadFields("").isEmpty())
    }

    @Test fun aVoiceTranscriptReplacesPartialsAndCommitsFinalCorrections() {
        val transcript = VoiceTranscript("Existing text ")
        assertEquals("Existing text hel", transcript.update(0, "hel", false))
        assertEquals("Existing text hello", transcript.update(0, "hello", false))
        assertEquals("Existing text Hello.", transcript.update(0, "Hello.", true))
        assertEquals("Existing text Hello.", transcript.update(0, "stale", false))
        assertEquals("Existing text Hello. noise", transcript.update(1, "noise", false))
        assertEquals("Existing text Hello.", transcript.update(1, "", true))
        assertEquals("Existing text Hello. Last", transcript.update(3, "Last", true))
        assertEquals("Existing text Hello. Next Last", transcript.update(2, "Next", true))
    }

    @Test fun chineseSegmentsJoinWithoutASpace() {
        val transcript = VoiceTranscript("")
        assertEquals("今天天气不错，", transcript.update(0, "今天天气不错，", true))
        assertEquals("今天天气不错，我们去公园吧。", transcript.update(1, "我们去公园吧。", true))
        // Beside a Latin word or a digit the space stays.
        assertEquals("今天天气不错，我们去公园吧。 OK", transcript.update(2, "OK", false))
        assertEquals("打开 notes 应用", VoiceTranscript("打开").update(0, "notes 应用", true))
        assertEquals("记下 3 点开会", VoiceTranscript("记下").update(0, "3 点开会", true))
        // Japanese, and the text already in the field.
        assertEquals("会議は明日です", VoiceTranscript("会議は").update(0, "明日です", true))
        // Korean spaces its words.
        assertEquals("안녕 하세요", VoiceTranscript("안녕").update(0, "하세요", true))
        // A space the speaker's own text has inside a segment is left alone.
        assertEquals("Hello 世界", VoiceTranscript("").update(0, "Hello 世界", true))
    }

    @Test fun voiceFramesKeepTheirOrderAndFlushTheTail() {
        val frames = VoicePCMFrames()
        val first = ByteArray(2800) { 1 }
        val second = ByteArray(4000) { 2 }
        assertTrue(frames.append(first).isEmpty())
        val emitted = frames.append(second)
        assertEquals(listOf(3200, 3200), emitted.map { it.size })
        val tail = frames.finish()!!
        assertEquals(400, tail.size)
        assertArrayEquals(first + second, emitted.reduce { a, b -> a + b } + tail)
        assertNull(frames.finish())
    }

    @Test fun theStatusAndTheTranscriptionAreReadLeniently() {
        assertTrue(VoiceRoutes.canTranscribe("""{"ok":true,"transcribe":true}"""))
        assertFalse(VoiceRoutes.canTranscribe("""{"ok":true,"transcribe":false}"""))
        assertFalse(VoiceRoutes.canTranscribe("""{"ok":true}"""))
        assertFalse(VoiceRoutes.canTranscribe("<html>"))
        assertEquals("你好", VoiceRoutes.transcribed("""{"ok":true,"text":" 你好 ","segments":[]}"""))
        assertNull(VoiceRoutes.transcribed("""{"ok":true}"""))
        assertNull(VoiceRoutes.transcribed("nope"))
    }

    @Test fun aClipIsAMono16kHzWav() {
        val pcm = ByteArray(6) { it.toByte() }
        val wav = VoiceRoutes.wav(pcm)
        assertEquals(44 + pcm.size, wav.size)
        assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(wav, 8, 4, Charsets.US_ASCII))
        assertEquals("data", String(wav, 36, 4, Charsets.US_ASCII))
        fun int32(at: Int) = (0 until 4).sumOf { (wav[at + it].toInt() and 0xFF) shl (8 * it) }
        fun int16(at: Int) = (0 until 2).sumOf { (wav[at + it].toInt() and 0xFF) shl (8 * it) }
        assertEquals(36 + pcm.size, int32(4))
        assertEquals(1, int16(20)) // PCM
        assertEquals(1, int16(22)) // mono
        assertEquals(16000, int32(24))
        assertEquals(32000, int32(28))
        assertEquals(16, int16(34))
        assertEquals(pcm.size, int32(40))
        assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
    }
}
