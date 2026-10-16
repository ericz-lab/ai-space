import AVFoundation
import SwiftUI

/// Voice input for a text field (docs/panel.md#omnibox): a click records from the microphone, a
/// second click (or 90 seconds) ends the clip, the Space transcribes it through
/// `POST /api/voice/transcribe` (voice-studio, here or on a peer), and the text is handed back to
/// go into the field. Nothing is sent by itself. The button shows only when the Space says a
/// transcriber answers (`GET /api/voice`).
@MainActor
final class VoiceInput: NSObject, ObservableObject, AVAudioRecorderDelegate {
    enum State: Equatable {
        case unavailable, idle, recording, transcribing
    }

    @Published private(set) var state: State = .unavailable
    @Published var error: String?

    private static let maxDuration: TimeInterval = 90
    /// What each Space answered to `GET /api/voice`, by origin, for the life of the app.
    private static var known: [URL: Bool] = [:]

    private var recorder: AVAudioRecorder?
    private var api: SpaceAPI?
    private var deliver: ((String) -> Void)?

    /// Asks the Space whether it can transcribe, once per Space.
    func check(_ api: SpaceAPI) async {
        self.api = api
        if let known = Self.known[api.base] { state = known ? (state == .unavailable ? .idle : state) : .unavailable; return }
        struct Answer: Decodable { var transcribe: Bool? }
        let can = (try? await api.get("/api/voice", as: Answer.self))?.transcribe ?? false
        Self.known[api.base] = can
        if state == .unavailable, can { state = .idle }
    }

    func toggle(_ deliver: @escaping (String) -> Void) {
        error = nil
        switch state {
        case .recording: recorder?.stop()
        case .idle:
            self.deliver = deliver
            Task { await start() }
        default: break
        }
    }

    private func start() async {
        let granted: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: granted = true
        case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .audio)
        default: granted = false
        }
        guard granted else {
            error = String(localized: "AI Space may not use the microphone. Allow it in System Settings → Privacy & Security → Microphone.")
            return
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("aispace-voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let r = try AVAudioRecorder(url: file, settings: settings)
            r.delegate = self
            guard r.record(forDuration: Self.maxDuration) else { throw CocoaError(.fileWriteUnknown) }
            recorder = r
            state = .recording
        } catch {
            self.error = String(localized: "Could not record: \(error.localizedDescription)")
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let url = recorder.url
        Task { @MainActor in await self.finish(url) }
    }

    private func finish(_ url: URL) async {
        recorder = nil
        defer { try? FileManager.default.removeItem(at: url) }
        guard let api, let clip = try? Data(contentsOf: url), !clip.isEmpty else { state = .idle; return }
        state = .transcribing
        defer { state = .idle }
        do {
            let data = try await api.upload("/api/voice/transcribe", field: "file", filename: "voice.m4a", mimeType: "audio/mp4", data: clip)
            let text = ((try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["text"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !text.isEmpty { deliver?(text) }
        } catch {
            self.error = String(localized: "Voice input failed: \(HubStore.message(error))")
        }
    }
}

/// The microphone beside a field: hidden until the Space can transcribe, red while it listens.
struct VoiceButton: View {
    @ObservedObject var voice: VoiceInput
    let api: SpaceAPI?
    var size: CGFloat = 26
    let deliver: (String) -> Void

    var body: some View {
        Group {
            switch voice.state {
            case .unavailable:
                // Not EmptyView: a task on an empty view never runs, and this one asks the Space.
                Color.clear.frame(width: 0, height: 0)
            case .transcribing:
                ProgressView().controlSize(.small).frame(width: size, height: size)
                    .help("Transcribing…")
            case .idle, .recording:
                let recording = voice.state == .recording
                Button { voice.toggle(deliver) } label: {
                    Image(systemName: recording ? "stop.circle.fill" : "mic.circle.fill")
                        .font(.system(size: size))
                        .symbolEffect(.pulse, isActive: recording)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(recording ? AnyShapeStyle(Theme.danger) : AnyShapeStyle(.secondary))
                .help(recording ? "Stop Recording" : "Voice Input")
                .accessibilityLabel(recording ? Text("Stop Recording") : Text("Voice Input"))
            }
        }
        .task(id: api?.base) { if let api { await voice.check(api) } }
    }
}

/// Puts a transcript after what a field already holds.
func appendingTranscript(_ text: String, to field: String) -> String {
    let kept = field.trimmingCharacters(in: .whitespacesAndNewlines)
    return kept.isEmpty ? text : kept + " " + text
}
