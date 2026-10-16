import AVFoundation
import Combine

/// Records one bounded clip and uses the same transcriber as the web panel. Never submits text.
@MainActor
final class OmniboxVoice: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var available = false
    @Published private(set) var recording = false
    @Published private(set) var transcribing = false
    @Published var error: String?
    var busy: Bool { recording || transcribing || starting }
    @Published private(set) var starting = false
    private var generation = 0
    private var recorder: AVAudioRecorder?
    private var api: SpaceAPI?
    private var deliver: ((String) -> Void)?

    func check(_ api: SpaceAPI) async {
        cancel()
        self.api = api
        struct Answer: Decodable { var transcribe: Bool? }
        available = (try? await api.get("/api/voice", as: Answer.self))?.transcribe == true
    }
    func toggle(api: SpaceAPI, deliver: @escaping (String) -> Void) {
        if recording { recorder?.stop(); return }
        guard !busy else { return }
        error = nil; starting = true
        let generation = generation
        self.api = api; self.deliver = deliver
        Task {
            let granted = await AVCaptureDevice.requestAccess(for: .audio)
            guard generation == self.generation else { return }
            starting = false
            guard granted else { error = String(localized: "Allow microphone access in Settings to use voice input."); return }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.record, mode: .default)
                try session.setActive(true)
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("aispace-voice-\(UUID().uuidString).m4a")
                let recorder = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1])
                self.recorder = recorder
                recorder.delegate = self
                guard recorder.record(forDuration: 90) else { throw CocoaError(.fileWriteUnknown) }
                recording = true
            } catch {
                cancel()
                self.error = error.localizedDescription
            }
        }
    }
    func cancel() {
        generation += 1
        recorder?.delegate = nil
        recorder?.stop()
        if let url = recorder?.url { try? FileManager.default.removeItem(at: url) }
        recorder = nil; deliver = nil
        recording = false; transcribing = false; starting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let url = recorder.url
        Task { @MainActor in await finish(url, successful: flag) }
    }
    private func finish(_ url: URL, successful: Bool) async {
        defer { try? FileManager.default.removeItem(at: url) }
        guard recorder?.url == url else { return }
        recorder = nil; recording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        guard successful, let api, let data = try? Data(contentsOf: url) else { error = String(localized: "Could not record audio."); return }
        let generation = generation
        transcribing = true
        defer { if generation == self.generation { transcribing = false } }
        do {
            struct Answer: Decodable { var text: String }
            let answer = try Hub.decode(Answer.self, from: try await api.upload("/api/voice/transcribe", field: "file", filename: "voice.m4a", mimeType: "audio/mp4", data: data))
            guard generation == self.generation else { return }
            let text = answer.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { deliver?(text) }
        } catch { if generation == self.generation { self.error = HubStore.message(error) } }
    }
}
