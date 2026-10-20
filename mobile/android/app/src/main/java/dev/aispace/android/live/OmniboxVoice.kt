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
import dev.aispace.android.core.VoicePCMFrames
import dev.aispace.android.core.VoiceTranscript
import dev.aispace.android.core.int
import dev.aispace.android.core.str
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.net.URI
import java.util.concurrent.atomic.AtomicInteger

/**
 * Streams bounded mono 16 kHz PCM to the panel's shared realtime transcriber
 * (`/api/voice/realtime`, docs/shortcuts.md), the iPhone's OmniboxVoice. Never submits text: what
 * is said lands in the field. Recording starts at once; what is said before the transcriber is
 * ready (a cold model load takes about 15 s) is held, up to 50 s, and sent first.
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
    val busy: Boolean get() = recording || transcribing || starting

    private var generation = 0
    private var record: AudioRecord? = null
    private var socket: WebSocket? = null
    private var capture: Job? = null
    private var sender: Job? = null
    private var deadline: Job? = null
    private var audio: Channel<ByteArray>? = null
    private var ready = false
    /** Bytes captured and not yet sent: held while the model loads, a lag after. */
    private var backlog: AtomicInteger? = null
    private var transcript = VoiceTranscript("")
    private var deliver: ((String) -> Unit)? = null

    /**
     * Starts recording, or stops it (what was said is still transcribed), or gives up while it
     * starts. The microphone permission is the caller's to have asked for.
     */
    fun toggle(api: SpaceApi, prefix: String, deliver: (String) -> Unit) {
        if (starting) return cancel()
        if (recording) return stop()
        if (busy) return
        error = null
        starting = true
        transcript = VoiceTranscript(prefix)
        this.deliver = deliver
        val generation = generation
        timeout(130, generation)
        try {
            capture(generation)
        } catch (e: Exception) {
            return fail(HubText.get(R.string.omnibox_voice_record_failed))
        }
        starting = false
        recording = true
        timeout(90, generation, stopRecording = true)
        scope.launch {
            val url = socketURL(api.url("/api/voice/realtime")) ?: return@launch fail(HubText.get(R.string.omnibox_voice_failed))
            val socket = try {
                api.socket(url, Listener(generation))
            } catch (e: Exception) {
                if (generation == this@OmniboxVoice.generation) fail(HubStore.message(e))
                return@launch
            }
            if (generation != this@OmniboxVoice.generation) {
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
        val backlog = AtomicInteger(0)
        audio = channel
        this.backlog = backlog
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
                if (backlog.get() + n > MAX_BACKLOG) {
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
                backlog.addAndGet(n)
                channel.trySend(buffer.copyOf(n))
            }
            channel.close()
        }
    }

    /** Once the transcriber is ready: what was held goes first, then live audio, then stop. */
    private fun send(generation: Int) {
        val channel = audio ?: return
        val backlog = backlog ?: return
        sender = scope.launch {
            val frames = VoicePCMFrames()
            for (data in channel) {
                val socket = socket
                if (generation != this@OmniboxVoice.generation || socket == null) return@launch
                for (frame in frames.append(data)) socket.send(frame.toByteString())
                backlog.addAndGet(-data.size)
            }
            val socket = socket
            if (generation != this@OmniboxVoice.generation || socket == null) return@launch
            frames.finish()?.let { socket.send(it.toByteString()) }
            socket.send("{\"type\":\"stop\"}")
        }
    }

    private inner class Listener(private val generation: Int) : WebSocketListener() {
        private fun onMain(block: () -> Unit) {
            scope.launch { if (generation == this@OmniboxVoice.generation) block() }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send("{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"\"}")
        }

        override fun onMessage(webSocket: WebSocket, text: String) = onMain { event(text) }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = onMain { event(bytes.utf8()) }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onMain {
            fail(if (response?.code == 401 || response?.code == 403) HubText.get(R.string.hub_error_sign_in) else t.localizedMessage ?: HubText.get(R.string.omnibox_voice_failed))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onMain { if (busy) cancel() }
    }

    private fun event(text: String) {
        val event = Json.obj(text) ?: return fail(HubText.get(R.string.omnibox_voice_failed))
        when (event.str("type")) {
            "ready" -> if (!ready) {
                ready = true
                send(generation)
            }
            "partial", "final" -> {
                val id = event.int("segment_id")
                val words = event.str("text")
                if (id == null || words == null) return fail(HubText.get(R.string.omnibox_voice_failed))
                deliver?.invoke(transcript.update(id, words, event.str("type") == "final"))
            }
            "done" -> cancel()
            "error" -> fail(event.str("message") ?: HubText.get(R.string.omnibox_voice_failed))
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
        timeout(70, generation)
    }

    private fun timeout(seconds: Long, generation: Int, stopRecording: Boolean = false) {
        deadline?.cancel()
        deadline = scope.launch {
            delay(seconds * 1000)
            if (generation != this@OmniboxVoice.generation) return@launch
            if (stopRecording) stop() else fail(HubText.get(R.string.omnibox_voice_timed_out))
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
        capture?.cancel()
        capture = null
        audio?.close()
        audio = null
        releaseAudio()
        socket?.close(1001, null)
        socket = null
        deliver = null
        backlog = null
        ready = false
        recording = false
        transcribing = false
        starting = false
    }

    companion object {
        private const val RATE = 16000
        /** 50 s of 16 kHz PCM16 captured and not yet sent; the transcriber accepts 60 s pending. */
        private const val MAX_BACKLOG = 50 * 32000

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
