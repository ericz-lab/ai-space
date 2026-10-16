import AVFoundation
import Combine

/// Streams bounded mono PCM to the panel's shared realtime transcriber. Never submits text.
@MainActor
final class OmniboxVoice: ObservableObject {
    @Published private(set) var recording = false
    @Published private(set) var transcribing = false
    @Published private(set) var starting = false
    @Published var error: String?
    var busy: Bool { recording || transcribing || starting }
    private var generation = 0
    private var engine: AVAudioEngine?
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var sender: Task<Void, Never>?
    private var deadline: Task<Void, Never>?
    private var audio: AsyncStream<Data>.Continuation?
    private var transcript = VoiceTranscript(prefix: "")
    private var deliver: ((String) -> Void)?

    func toggle(api: SpaceAPI, prefix: String, deliver: @escaping (String) -> Void) {
        if starting { cancel(); return }
        if recording { stop(); return }
        guard !busy else { return }
        error = nil; starting = true
        transcript = VoiceTranscript(prefix: prefix)
        self.deliver = deliver
        let generation = generation
        timeout(130, generation: generation)
        receiver = Task {
            guard await AVCaptureDevice.requestAccess(for: .audio) else {
                if generation == self.generation { fail(String(localized: "Allow microphone access in Settings to use voice input.")) }
                return
            }
            guard generation == self.generation else { return }
            do {
                var url = URLComponents(url: api.url("/api/voice/realtime"), resolvingAgainstBaseURL: true)!
                url.scheme = url.scheme == "https" ? "wss" : "ws"
                let socket = await api.socket(url.url!)
                guard generation == self.generation else { socket.cancel(); return }
                self.socket = socket
                socket.resume()
                try await socket.send(.string("{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"\"}"))
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
                        if starting { try capture(generation: generation); starting = false; recording = true; timeout(90, generation: generation, stopRecording: true) }
                    case "partial", "final":
                        guard let id = event.segment_id, let text = event.text else { throw SpaceAPIError.invalidResponse }
                        self.deliver?(transcript.update(id: id, text: text, final: event.type == "final"))
                    case "done": cancel(); return
                    case "error": fail(event.message ?? String(localized: "Voice transcription failed.")); return
                    default: break
                    }
                }
            } catch { if generation == self.generation { fail(HubStore.message(error)) } }
        }
    }

    private func capture(generation: Int) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: output) else { throw SpaceAPIError.invalidResponse }
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingOldest(160))
        audio = continuation
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16000 / format.sampleRate)) + 32
            guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: converted, error: &conversionError) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true; state.pointee = .haveData; return buffer
            }
            if status == .error {
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.fail(String(localized: "Could not record audio."))
                }
                return
            }
            guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
            let data = Data(bytes: samples[0], count: Int(converted.frameLength) * 2)
            if case .dropped = continuation.yield(data) {
                Task { @MainActor [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.fail(String(localized: "Voice connection is too slow."))
                }
            }
        }
        sender = Task {
            do {
                var frames = VoicePCMFrames()
                for await data in stream {
                    guard generation == self.generation, let socket else { return }
                    for frame in frames.append(data) { try await socket.send(.data(frame)) }
                }
                guard generation == self.generation, let socket else { return }
                if let tail = frames.finish() { try await socket.send(.data(tail)) }
                try await socket.send(.string("{\"type\":\"stop\"}"))
            } catch { if generation == self.generation { fail(HubStore.message(error)) } }
        }
        try engine.start()
    }

    private func releaseAudio() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        engine = nil
        audio?.finish(); audio = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func stop() {
        recording = false; transcribing = true
        releaseAudio()
        timeout(70, generation: generation)
    }
    private func timeout(_ seconds: UInt64, generation: Int, stopRecording: Bool = false) {
        deadline?.cancel()
        deadline = Task {
            do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
            guard generation == self.generation else { return }
            if stopRecording { stop() } else { fail(String(localized: "Voice connection timed out.")) }
        }
    }
    private func fail(_ message: String) { cancel(); error = message }
    func cancel() {
        generation += 1
        deadline?.cancel(); deadline = nil
        receiver?.cancel(); receiver = nil
        sender?.cancel(); sender = nil
        releaseAudio()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
        deliver = nil
        recording = false; transcribing = false; starting = false
    }
}

private struct VoiceEvent: Decodable {
    var type: String
    var segment_id: Int?
    var text: String?
    var message: String?
}
