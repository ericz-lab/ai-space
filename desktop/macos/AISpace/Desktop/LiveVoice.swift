import AVFoundation
import Combine
import os

/// Live transcription for voice input in any app (docs/macos-desktop.md#voice-input): the
/// iPhone client's OmniboxVoice on the Mac, which has no audio session. The microphone streams
/// mono 16 kHz PCM16 over `WS /api/voice/realtime` and `text` follows the partial and final
/// events (VoiceTranscript). What is said before the transcriber is ready (a cold model load takes
/// about 15 s) is held and sent first. `stop` flushes, waits for `done` and hands the text over
/// once. When the live route is refused or drops before it was ready, the same recording goes up
/// as a WAV clip to `POST /api/voice/transcribe` instead: a Space whose transcriber has no live
/// socket (an API provider) still answers. Both routes are told the language (VoiceLanguage).
@MainActor
final class LiveVoice: ObservableObject {
    enum State: Equatable {
        case idle
        /// Asking for the microphone.
        case starting
        case recording
        /// Released: the last audio and the final text are on their way.
        case finishing
    }

    @Published private(set) var state = State.idle
    /// The transcript so far: the final segments and the current one's draft.
    @Published private(set) var text = ""
    @Published var error: String?

    private nonisolated static let bytesPerSecond = 32000
    /// Held while the model loads; the Space holds about a minute more.
    private nonisolated static let maxBacklog = 50 * bytesPerSecond
    private nonisolated static let maxSeconds = 90

    /// What the microphone tap shares with the main actor.
    private struct Held {
        /// Captured and not yet sent: held while the model loads, a lag after.
        var bytes = 0
        /// The whole recording, kept until the live route is ready in case it never is.
        var clip: Data? = Data()
        /// False once the recording goes up as a clip: nothing more into the live stream.
        var live = true
    }

    private enum TapEvent: Sendable { case failed, full }

    private var generation = 0
    private var api: SpaceAPI?
    private var engine: AVAudioEngine?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var audio: AsyncStream<Data>.Continuation?
    private var captured: AsyncStream<Data>?
    private var held: OSAllocatedUnfairLock<Held>?
    private var ready = false
    private var clipOnly = false
    private var transcript = VoiceTranscript(prefix: "")
    private var deliver: ((String) -> Void)?
    /// What this recording is transcribed in (VoiceLanguage), read once when it starts.
    private var language = ""

    /// Records until `stop`, 90 seconds, or 50 seconds held for a transcriber that is not ready.
    /// `deliver` gets the final text once, never an empty one.
    func start(api: SpaceAPI, deliver: @escaping (String) -> Void) {
        guard state == .idle else { return }
        error = nil
        text = ""
        state = .starting
        self.api = api
        self.deliver = deliver
        language = VoiceLanguage.current
        transcript = VoiceTranscript(prefix: "")
        let generation = generation
        receiver = Task {
            guard await Self.microphoneAllowed() else {
                if generation == self.generation {
                    fail(String(localized: "AI Space may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone."))
                }
                return
            }
            guard generation == self.generation else { return }
            do {
                try capture(generation: generation)
            } catch {
                fail(String(localized: "Could not record: \(error.localizedDescription)"))
                return
            }
            state = .recording
            timeout(Self.maxSeconds, generation: generation)
            await listen(api: api, generation: generation)
        }
    }

    /// The key was let go. Before the microphone opened there is nothing to keep.
    func stop() {
        switch state {
        case .starting: cancel()
        case .recording:
            state = .finishing
            releaseAudio()
            if clipOnly { upload(generation: generation) } else { timeout(70, generation: generation) }
        case .finishing, .idle: break
        }
    }

    private static func microphoneAllowed() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }

    private func listen(api: SpaceAPI, generation: Int) async {
        var url = URLComponents(url: api.url("/api/voice/realtime"), resolvingAgainstBaseURL: true)!
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        let socket = await api.socket(url.url!)
        guard generation == self.generation else { socket.cancel(); return }
        self.socket = socket
        socket.resume()
        do {
            try await socket.send(.string(VoiceLanguage.startMessage(language: language)))
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard generation == self.generation else { return }
                let data: Data
                switch message {
                case .data(let value): data = value
                case .string(let value): data = Data(value.utf8)
                @unknown default: throw SpaceAPIError.invalidResponse
                }
                let event = try JSONDecoder().decode(VoiceEvent.self, from: data)
                switch event.type {
                case "ready":
                    if !ready {
                        ready = true
                        held?.withLock { $0.clip = nil }
                        send(generation: generation)
                    }
                case "partial", "final":
                    guard let id = event.segment_id, let value = event.text else { throw SpaceAPIError.invalidResponse }
                    text = transcript.update(id: id, text: value, final: event.type == "final")
                case "done":
                    finish(text)
                    return
                case "error":
                    if ready { fail(event.message ?? String(localized: "Voice input failed.")) } else { fallBack() }
                    return
                default: break
                }
            }
        } catch {
            guard generation == self.generation else { return }
            // A refused upgrade (no live provider: 503) or a dropped link before `ready`.
            if ready { fail(HubStore.message(error)) } else { fallBack() }
        }
    }

    private func capture(generation: Int) throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: output) else { throw SpaceAPIError.invalidResponse }
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        let held = OSAllocatedUnfairLock(initialState: Held())
        audio = continuation
        captured = stream
        self.held = held
        let tap = Self.tap(format: format, output: output, converter: converter, held: held, continuation: continuation) { [weak self] event in
            Task { @MainActor in
                guard let self, self.generation == generation else { return }
                switch event {
                case .failed: self.fail(String(localized: "Could not record audio."))
                // Held as long as allowed while the model loads: stop recording and keep it.
                case .full: if !self.ready { self.stop() } else { self.fail(String(localized: "The voice connection is too slow.")) }
                }
            }
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: format, block: tap)
        self.engine = engine
        try engine.start()
    }

    /// The microphone tap, off the main actor: converts each buffer and shares it through `held`.
    private nonisolated static func tap(format: AVAudioFormat, output: AVAudioFormat, converter: AVAudioConverter,
                                        held: OSAllocatedUnfairLock<Held>, continuation: AsyncStream<Data>.Continuation,
                                        report: @escaping @Sendable (TapEvent) -> Void) -> AVAudioNodeTapBlock {
        { buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / format.sampleRate)) + 32
            guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: converted, error: &conversionError) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true
                state.pointee = .haveData
                return buffer
            }
            if status == .error { report(.failed); return }
            guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
            let data = Data(bytes: samples[0], count: Int(converted.frameLength) * 2)
            enum Outcome { case send, kept, full }
            let outcome = held.withLock { h -> Outcome in
                if h.clip != nil, h.clip!.count + data.count <= maxSeconds * bytesPerSecond { h.clip!.append(data) }
                guard h.live else { return .kept }
                guard h.bytes + data.count <= maxBacklog else { return .full }
                h.bytes += data.count
                return .send
            }
            switch outcome {
            case .send: continuation.yield(data)
            case .full: report(.full)
            case .kept: break
            }
        }
    }

    /// Once the transcriber is ready: what was held goes first, then live audio, then stop.
    private func send(generation: Int) {
        guard let stream = captured, let held else { return }
        captured = nil
        sender = Task {
            do {
                var frames = VoicePCMFrames()
                for await data in stream {
                    guard generation == self.generation, let socket else { return }
                    for frame in frames.append(data) { try await socket.send(.data(frame)) }
                    held.withLock { $0.bytes -= data.count }
                }
                guard generation == self.generation, let socket else { return }
                if let tail = frames.finish() { try await socket.send(.data(tail)) }
                try await socket.send(.string("{\"type\":\"stop\"}"))
            } catch {
                if generation == self.generation { fail(HubStore.message(error)) }
            }
        }
    }

    /// The live route will not answer: the recording, whole, goes up as a clip on release.
    private func fallBack() {
        guard !clipOnly else { return }
        clipOnly = true
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        sender?.cancel()
        sender = nil
        held?.withLock { $0.live = false }
        audio?.finish()
        captured = nil
        if state == .finishing { upload(generation: generation) }
    }

    private func upload(generation: Int) {
        let pcm = held?.withLock { $0.clip }
        guard let api, let pcm, !pcm.isEmpty else { finish(""); return }
        deadline?.cancel()
        receiver = Task {
            do {
                let data = try await api.upload("/api/voice/transcribe", field: "file", filename: "voice.wav", mimeType: "audio/wav",
                                                data: DictationRules.wav(pcm: pcm), fields: VoiceLanguage.uploadFields(language: language))
                guard generation == self.generation else { return }
                finish(((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["text"] as? String) ?? "")
            } catch {
                if generation == self.generation { fail(String(localized: "Voice input failed: \(HubStore.message(error))")) }
            }
        }
    }

    private func finish(_ final: String) {
        let deliver = self.deliver
        let final = final.trimmingCharacters(in: .whitespacesAndNewlines)
        cancel()
        if !final.isEmpty { deliver?(final) }
    }

    private func releaseAudio() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        audio?.finish()
        audio = nil
    }

    /// Recording ends at the limit as if released; finishing that takes too long gives up, or,
    /// when the live route never became ready, sends the clip.
    private func timeout(_ seconds: Int, generation: Int) {
        deadline?.cancel()
        deadline = Task {
            do { try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000) } catch { return }
            guard generation == self.generation else { return }
            switch state {
            case .recording: stop()
            case .finishing: if ready { fail(String(localized: "Voice connection timed out.")) } else { fallBack() }
            case .starting, .idle: break
            }
        }
    }

    private func fail(_ message: String) {
        cancel()
        error = message
    }

    func cancel() {
        generation += 1
        deadline?.cancel(); deadline = nil
        receiver?.cancel(); receiver = nil
        sender?.cancel(); sender = nil
        releaseAudio()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        deliver = nil
        captured = nil; held = nil
        ready = false; clipOnly = false
        state = .idle
        text = ""
    }
}

private struct VoiceEvent: Decodable {
    var type: String
    var segment_id: Int?
    var text: String?
    var message: String?
}
