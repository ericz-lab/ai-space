package dev.aispace.android.live

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.aispace.android.R
import dev.aispace.android.core.Json
import dev.aispace.android.core.SpaceApi
import dev.aispace.android.core.VoiceLanguage
import dev.aispace.android.core.VoicePCMFrames
import dev.aispace.android.core.VoiceRoutes
import dev.aispace.android.core.VoiceTranscript
import dev.aispace.android.core.int
import dev.aispace.android.core.str
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/**
 * Streams bounded mono 16 kHz PCM to the panel's shared realtime transcriber
 * (`/api/voice/realtime`, docs/speech.md#live-protocol), the iPhone's OmniboxVoice, for the command
 * box and the chat's message field. Never submits text: what is said lands in the field. Recording
 * starts at once; what is said before the transcriber is ready (a cold model load takes about
 * 15 s) is held, up to 50 s, and sent first. The `start` names the language (VoiceLanguage).
 *
 * When the live route is refused or drops before it was ready, the same recording goes up as a
 * WAV clip to `POST /api/voice/transcribe` instead, as the Mac's LiveVoice does: a Space whose
 * transcriber has no live socket (an API provider) still answers. The microphone shows only when
 * the Space says it can transcribe ([check], `GET /api/voice`).
 *
 * State is Compose snapshot state, changed on the main thread ([scope] is the app's).
 */
class OmniboxVoice(private val scope: CoroutineScope) {
    var recording by mutableStateOf(false)
        private set
    var transcribing by mutableStateOf(false)
        private set
    var starting by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    /** The Space can transcribe: the microphone is offered. */
    var available by mutableStateOf(false)
        private set
    val busy: Boolean get() = recording || transcribing || starting

    /** What the capture loop shares with the main thread, guarded by itself. */
    private class Held {
        /** Captured and not yet sent: held while the model loads, a lag after. */
        var bytes = 0
        /** The whole recording, kept until the live route is ready in case it never is. */
        var clip: ByteArrayOutputStream? = ByteArrayOutputStream()
        /** False once the recording goes up as a clip: nothing more into the live stream. */
        var live = true
    }

    private var generation = 0
    private var api: SpaceApi? = null
    private var language = ""
    private var record: AudioRecord? = null
    private var socket: WebSocket? = null
    private var capture: Job? = null
    private var sender: Job? = null
    private var deadline: Job? = null
    private var uploading: Job? = null
    private var audio: Channel<ByteArray>? = null
    private var held: Held? = null
    private var ready = false
    private var clipOnly = false
    private var transcript = VoiceTranscript("")
    private var deliver: ((String) -> Unit)? = null

    /**
     * Asks the Space whether it can transcribe, once per Space for the life of the app. Only an
     * answer is remembered: a request that failed (signed out, offline) is asked again next time.
     */
    suspend fun check(api: SpaceApi) {
        known[api.base]?.let {
            available = it
            return
        }
        available = false
        val can = try {
            VoiceRoutes.canTranscribe(api.text(VoiceRoutes.STATUS))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        known[api.base] = can
        available = can
    }

    /**
     * Starts recording, or stops it (what was said is still transcribed), or gives up while it
     * starts. [language] is what VoiceLanguage chose for this recording; empty lets the provider
     * detect it. The microphone permission is the caller's to have asked for.
     */
    fun toggle(api: SpaceApi, prefix: String, language: String, deliver: (String) -> Unit) {
        if (starting) return cancel()
        if (recording) return stop()
        if (busy) return
        error = null
        starting = true
        transcript = VoiceTranscript(prefix)
        this.deliver = deliver
        this.api = api
        this.language = language
        val generation = generation
        try {
            capture(generation)
        } catch (e: Exception) {
            return fail(HubText.get(R.string.omnibox_voice_record_failed))
        }
        starting = false
        recording = true
        timeout(MAX_SECONDS, generation, stopRecording = true)
        scope.launch {
            val url = socketURL(api.url(VoiceRoutes.LIVE)) ?: return@launch fail(HubText.get(R.string.omnibox_voice_failed))
            val socket = try {
                api.socket(url, Listener(generation))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (generation == this@OmniboxVoice.generation) fallBack()
                return@launch
            }
            if (generation != this@OmniboxVoice.generation || clipOnly) {
                socket.cancel()
                return@launch
            }
            this@OmniboxVoice.socket = socket
        }
    }

    @SuppressLint("MissingPermission")
    private fun capture(generation: Int) {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (min <= 0) throw IllegalStateException("no recorder")
        val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, 4 * VoicePCMFrames.FRAME))
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            record.release()
            throw IllegalStateException("recorder not initialized")
        }
        record.startRecording()
        this.record = record
        val channel = Channel<ByteArray>(Channel.UNLIMITED)
        val held = Held()
        audio = channel
        this.held = held
        capture = scope.launch(Dispatchers.IO) {
            val buffer = ByteArray(VoicePCMFrames.FRAME)
            while (isActive) {
                val n = record.read(buffer, 0, buffer.size)
                if (n < 0) {
                    // After Stop the recorder may refuse further reads: that is the end, not a failure.
                    if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                        scope.launch { if (generation == this@OmniboxVoice.generation) fail(HubText.get(R.string.omnibox_voice_record_failed)) }
                    }
                    break
                }
                if (n == 0) {
                    // Stopped: no more audio comes.
                    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) break
                    continue
                }
                val data = buffer.copyOf(n)
                val outcome = synchronized(held) {
                    held.clip?.let { if (it.size() + n <= MAX_CLIP) it.write(data) }
                    when {
                        !held.live -> Outcome.KEPT
                        held.bytes + n > MAX_BACKLOG -> Outcome.FULL
                        else -> {
                            held.bytes += n
                            Outcome.SEND
                        }
                    }
                }
                when (outcome) {
                    Outcome.SEND -> channel.trySend(data)
                    Outcome.KEPT -> {}
                    Outcome.FULL -> {
                        scope.launch {
                            if (generation != this@OmniboxVoice.generation) return@launch
                            // Held as long as allowed while the model loads: stop recording and keep it.
                            if (!ready) {
                                if (recording) stop()
                            } else {
                                fail(HubText.get(R.string.omnibox_voice_slow))
                            }
                        }
                        break
                    }
                }
            }
            channel.close()
        }
    }

    private enum class Outcome { SEND, KEPT, FULL }

    /** Once the transcriber is ready: what was held goes first, then live audio, then stop. */
    private fun send(generation: Int) {
        val channel = audio ?: return
        val held = held ?: return
        sender = scope.launch {
            val frames = VoicePCMFrames()
            for (data in channel) {
                val socket = socket
                if (generation != this@OmniboxVoice.generation || socket == null) return@launch
                for (frame in frames.append(data)) socket.send(frame.toByteString())
                synchronized(held) { held.bytes -= data.size }
            }
            val socket = socket
            if (generation != this@OmniboxVoice.generation || socket == null) return@launch
            frames.finish()?.let { socket.send(it.toByteString()) }
            socket.send("{\"type\":\"stop\"}")
        }
    }

    private inner class Listener(private val generation: Int) : WebSocketListener() {
        private fun onMain(block: () -> Unit) {
            scope.launch { if (generation == this@OmniboxVoice.generation && !clipOnly) block() }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(VoiceLanguage.startMessage(language))
        }

        override fun onMessage(webSocket: WebSocket, text: String) = onMain { event(text) }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = onMain { event(bytes.utf8()) }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain {
            when {
                // The access layer wants a sign-in: a clip would be refused the same way.
                response?.code == 401 || response?.code == 403 -> fail(HubText.get(R.string.hub_error_sign_in))
                // A refused upgrade (no live provider: 503) or a dropped link before `ready`.
                !ready -> fallBack()
                else -> fail(t.localizedMessage ?: HubText.get(R.string.omnibox_voice_failed))
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain {
            if (!busy) return@onMain
            if (!ready) fallBack() else cancel()
        }
    }

    private fun event(text: String) {
        val event = Json.obj(text) ?: return fail(HubText.get(R.string.omnibox_voice_failed))
        when (event.str("type")) {
            "ready" -> if (!ready) {
                ready = true
                held?.let { synchronized(it) { it.clip = null } }
                send(generation)
            }
            "partial", "final" -> {
                val id = event.int("segment_id")
                val words = event.str("text")
                if (id == null || words == null) return fail(HubText.get(R.string.omnibox_voice_failed))
                deliver?.invoke(transcript.update(id, words, event.str("type") == "final"))
            }
            "done" -> cancel()
            "error" -> if (ready) fail(event.str("message") ?: HubText.get(R.string.omnibox_voice_failed)) else fallBack()
        }
    }

    /** The live route will not answer: the recording, whole, goes up as a clip once it ends. */
    private fun fallBack() {
        if (clipOnly) return
        clipOnly = true
        socket?.cancel()
        socket = null
        sender?.cancel()
        sender = null
        held?.let { synchronized(it) { it.live = false } }
        audio?.close()
        if (transcribing) upload(generation)
    }

    private fun upload(generation: Int) {
        val api = api ?: return cancel()
        deadline?.cancel()
        uploading = scope.launch {
            // The capture loop reads what the recorder still has before the clip is complete.
            capture?.join()
            if (generation != this@OmniboxVoice.generation) return@launch
            val pcm = held?.let { synchronized(it) { it.clip?.toByteArray() } }
            if (pcm == null || pcm.isEmpty()) return@launch cancel()
            try {
                val wav = withContext(Dispatchers.Default) { VoiceRoutes.wav(pcm) }
                val answer = api.upload(VoiceRoutes.TRANSCRIBE, "file", "voice.wav", "audio/wav", wav, VoiceLanguage.uploadFields(language))
                if (generation != this@OmniboxVoice.generation) return@launch
                val heard = VoiceRoutes.transcribed(answer)
                val text = if (heard.isNullOrEmpty()) null else transcript.update(0, heard, true)
                val deliver = deliver
                cancel()
                if (text != null) deliver?.invoke(text)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (generation == this@OmniboxVoice.generation) fail(HubStore.message(e))
            }
        }
    }

    private fun releaseAudio() {
        record?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
            }
            it.release()
        }
        record = null
    }

    private fun stop() {
        recording = false
        transcribing = true
        // The capture loop reads what is left and closes the channel; the sender then says stop.
        record?.let {
            try {
                it.stop()
            } catch (_: IllegalStateException) {
            }
        }
        if (clipOnly) upload(generation) else timeout(FINISH_SECONDS, generation)
    }

    /**
     * Recording ends at the limit as if stopped; finishing that takes too long gives up, or, when
     * the live route never became ready, sends the clip.
     */
    private fun timeout(seconds: Long, generation: Int, stopRecording: Boolean = false) {
        deadline?.cancel()
        deadline = scope.launch {
            delay(seconds * 1000)
            if (generation != this@OmniboxVoice.generation) return@launch
            when {
                stopRecording -> stop()
                ready -> fail(HubText.get(R.string.omnibox_voice_timed_out))
                else -> fallBack()
            }
        }
    }

    private fun fail(message: String) {
        cancel()
        error = message
    }

    fun cancel() {
        generation += 1
        deadline?.cancel()
        deadline = null
        sender?.cancel()
        sender = null
        uploading?.cancel()
        uploading = null
        capture?.cancel()
        capture = null
        audio?.close()
        audio = null
        releaseAudio()
        socket?.close(1001, null)
        socket = null
        deliver = null
        held = null
        api = null
        ready = false
        clipOnly = false
        recording = false
        transcribing = false
        starting = false
    }

    companion object {
        private const val RATE = 16000
        private const val BYTES_PER_SECOND = 32000
        /** 50 s of 16 kHz PCM16 captured and not yet sent; the transcriber accepts 60 s pending. */
        private const val MAX_BACKLOG = 50 * BYTES_PER_SECOND
        private const val MAX_SECONDS = 90L
        /** The whole of the longest recording, kept for the clip. */
        private const val MAX_CLIP = 90 * BYTES_PER_SECOND
        /** How long the last audio and the final text may take after Stop. */
        private const val FINISH_SECONDS = 70L

        /** What each Space answered to `GET /api/voice`, by origin, for the life of the app. */
        private val known = ConcurrentHashMap<URI, Boolean>()

        /** The socket address of a page address: http → ws, https → wss. */
        fun socketURL(url: URI): URI? {
            val scheme = when (url.scheme?.lowercase()) {
                "https" -> "wss"
                "http" -> "ws"
                else -> return null
            }
            val text = url.toString()
            return try {
                URI(scheme + text.substring(text.indexOf(':')))
            } catch (e: Exception) {
                null
            }
        }
    }
}
