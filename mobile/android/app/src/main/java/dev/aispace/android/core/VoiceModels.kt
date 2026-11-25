package dev.aispace.android.core

import java.io.ByteArrayOutputStream

/**
 * The language voice input asks the Space to transcribe in (docs/speech.md#languages), the rule of
 * the Mac and iPhone clients (`VoiceLanguage` in desktop/macos/AISpace/Services/SpaceModels.swift)
 * and the web panel (src/web/voice.ts): by default the app's own language ([Lang.current]), else
 * what Settings › General › Voice language names. Sending one makes the transcriber faster and
 * keeps Mandarin from being heard as Cantonese.
 */
object VoiceLanguage {
    /** Where the setting is kept, in the app's preferences. */
    const val PREFERENCE = "voiceLanguage"
    /** The setting's value for "Same as AI Space", the default. */
    const val SAME_AS_APP = ""
    /** The setting's value for "Detect automatically": nothing is sent, the provider detects it. */
    const val DETECT = "auto"
    /** The languages Settings offers: codes every speech provider of the Space takes as they are. */
    val codes = listOf("zh", "en", "ja", "ko")

    /** A saved setting read back: anything this version does not know is the default. */
    fun setting(saved: String?): String = if (saved != null && (saved == DETECT || saved in codes)) saved else SAME_AS_APP

    /**
     * The `language` to send for a setting; empty lets the provider detect it. The app's language
     * counts only when it is one of [codes].
     */
    fun code(setting: String?, appLanguage: String = Lang.current): String {
        val value = setting ?: SAME_AS_APP
        if (value == DETECT) return ""
        if (value in codes) return value
        val primary = appLanguage.split('-', '_').first().lowercase()
        return if (primary in codes) primary else ""
    }

    /** The live protocol's `start` message (docs/speech.md#live-protocol). */
    fun startMessage(language: String): String {
        val sent = if (language in codes) language else ""
        return "{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"$sent\"}"
    }

    /** The multipart fields of a clip sent to `POST /api/voice/transcribe`: none when detecting. */
    fun uploadFields(language: String): List<Pair<String, String>> =
        if (language in codes) listOf("language" to language) else emptyList()
}

/**
 * Provisional text replaces its segment; a final event commits even an empty correction. The
 * segments follow the text already in the field, joined by a space, except between two Chinese or
 * Japanese characters (desktop/macos/AISpace/Services/DictationRules.swift `tidy`): Mandarin
 * spoken in two breaths is one sentence, not two words.
 */
class VoiceTranscript(private val prefix: String) {
    private val segments = java.util.TreeMap<Int, Pair<String, Boolean>>()

    fun update(id: Int, text: String, final: Boolean): String {
        if (segments[id]?.second != true) segments[id] = text to final
        return join(listOf(prefix) + segments.values.map { it.first })
    }

    companion object {
        /** Trimmed, non-empty pieces with a space between them where the script wants one. */
        fun join(pieces: List<String>): String {
            val out = StringBuilder()
            for (piece in pieces.map { it.trim() }.filter { it.isNotEmpty() }) {
                if (out.isNotEmpty() && !(wide(out.codePointBefore(out.length)) && wide(piece.codePointAt(0)))) out.append(' ')
                out.append(piece)
            }
            return out.toString()
        }

        /** CJK ideographs, kana, and their punctuation and full-width forms (not Hangul, which spaces words). */
        fun wide(c: Int): Boolean = c in 0x2E80..0x9FFF || c in 0xF900..0xFAFF || c in 0xFF00..0xFFEF
    }
}

/** The realtime transcriber accepts at most 100 ms (3,200 bytes) of 16 kHz PCM16 per message. */
class VoicePCMFrames {
    private var pending = ByteArray(0)

    fun append(data: ByteArray): List<ByteArray> {
        pending += data
        val frames = ArrayList<ByteArray>()
        var at = 0
        while (pending.size - at >= FRAME) {
            frames.add(pending.copyOfRange(at, at + FRAME))
            at += FRAME
        }
        pending = pending.copyOfRange(at, pending.size)
        return frames
    }

    fun finish(): ByteArray? {
        if (pending.isEmpty()) return null
        val tail = pending
        pending = ByteArray(0)
        return tail
    }

    companion object {
        const val FRAME = 3200
    }
}

/** The voice routes' answers as the clients read them (docs/speech.md#compatibility). */
object VoiceRoutes {
    /** Whether the Space can transcribe: `GET /api/voice` answers `{ ok, transcribe }`. */
    const val STATUS = "/api/voice"
    const val LIVE = "/api/voice/realtime"
    const val TRANSCRIBE = "/api/voice/transcribe"

    /** `transcribe` of `GET /api/voice`; anything unreadable is no. */
    fun canTranscribe(body: String): Boolean = Json.obj(body)?.optBoolean("transcribe", false) ?: false

    /** `text` of a `POST /api/voice/transcribe` answer, trimmed; null when it carries none. */
    fun transcribed(body: String): String? = Json.obj(body)?.takeIf { it.has("text") && !it.isNull("text") }?.optString("text")?.trim()

    /**
     * Mono 16 kHz PCM16 as a WAV file: the live recording sent as a clip when the live route does
     * not answer (DictationRules.wav on the Mac).
     */
    fun wav(pcm: ByteArray, sampleRate: Int = 16000): ByteArray {
        val out = ByteArrayOutputStream(44 + pcm.size)
        fun text(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun int32(v: Int) = repeat(4) { out.write((v ushr (8 * it)) and 0xFF) }
        fun int16(v: Int) = repeat(2) { out.write((v ushr (8 * it)) and 0xFF) }
        text("RIFF"); int32(36 + pcm.size); text("WAVE")
        text("fmt "); int32(16); int16(1); int16(1); int32(sampleRate); int32(sampleRate * 2); int16(2); int16(16)
        text("data"); int32(pcm.size)
        out.write(pcm)
        return out.toByteArray()
    }
}
