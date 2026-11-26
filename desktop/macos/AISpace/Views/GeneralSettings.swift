import ApplicationServices
import SwiftUI

/// Settings > General: the desktop conveniences, each optional.
struct GeneralSettings: View {
    @ObservedObject var prefs: Preferences
    @ObservedObject var store: ConnectionStore
    @ObservedObject var model: AppModel
    /// The Space's places for a spoken note (`GET /api/capture`, `textTargets`); nil until read.
    @State private var captureTargets: [ScreenshotRules.Target]?
    @State private var captureTargetsFailed = false

    /// The Space that transcribes, and so the one whose apps get a note.
    private var listening: Connection? { model.selected ?? store.defaultConnection }

    var body: some View {
        Form {
            Picker("Quick Chat shortcut", selection: $prefs.quickChat) {
                ForEach(Preferences.Shortcut.allCases) { Text($0.label).tag($0) }
            }
            if prefs.quickChatTaken {
                Text("Another app already uses this shortcut, so it does nothing here. Pick another one.")
                    .font(.caption).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            }
            Text("Opens a chat with an agent over any app. Services > Ask ai-space sends selected text to it, and Shortcuts can open aispace://chat?agent=<app>/<agent>&text=… — a message is never sent without you.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("Hold fn to talk", isOn: $prefs.voiceInput)
                .onChange(of: prefs.voiceInput) { _, on in
                    // The system's own prompt, which opens Privacy & Security → Accessibility.
                    if on, !AXIsProcessTrusted() { AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) }
                }
            Text("Hold the fn (🌐) key in any app and talk: the words show at the bottom of the screen as you speak, and when you let go the text goes into the field you are typing in. Seeing fn in other apps and typing into them needs AI Space allowed in System Settings → Privacy & Security → Accessibility.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if prefs.voiceInput, store.connections.count > 1 {
                Text("What you say is sent to the Space chosen at the top left of the window, and to no other. When it cannot transcribe, voice input says so and sends nothing.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if prefs.voiceInput, !AXIsProcessTrusted() {
                Text("AI Space is not allowed under Accessibility yet, so fn is seen only while AI Space is in front.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if prefs.voiceInput, FnKey.systemActsOnGlobeKey {
                Text("macOS acts on this key too. Set System Settings → Keyboard → “Press 🌐 key to” to “Do Nothing”, or letting go of fn may also open the emoji picker, change the input source or start Dictation.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Toggle("Hold right ⌥ to capture", isOn: $prefs.voiceCapture)
                .onChange(of: prefs.voiceCapture) { _, on in
                    if on, !AXIsProcessTrusted() { AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) }
                }
            Text("Hold the right ⌥ key in any app and say something: when you let go, the words are sent to an app of the Space as a note, and typed nowhere. A tap, or ⌥ with another key, works as before. Seeing the key in other apps needs AI Space allowed in System Settings → Privacy & Security → Accessibility.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if prefs.voiceCapture, let space = listening {
                captureDestination(space)
            }
            if prefs.voiceCapture, !AXIsProcessTrusted() {
                Text("AI Space is not allowed under Accessibility yet, so right ⌥ is seen only while AI Space is in front.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Picker("Voice language", selection: $prefs.voiceLanguage) {
                Text("Same as AI Space").tag(VoiceLanguage.sameAsApp)
                Text("Detect automatically").tag(VoiceLanguage.detect)
                ForEach(VoiceLanguage.codes, id: \.self) { code in
                    Text(verbatim: Locale.current.localizedString(forLanguageCode: code) ?? code).tag(code)
                }
            }
            Text("The language you speak, for holding fn and for the microphone beside a field. Naming it makes the transcript faster and more accurate; by default it is the language AI Space is shown in.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("Show the floating ball", isOn: $prefs.floatingBall)
            Text("A small ball over every app. Drop a picture on it to keep the picture in an app of the Space; drag the ball to move it, click it for Pending Shares. Space → Floating Ball shows or hides it too.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("Show the desk pet", isOn: $prefs.pet)
            if prefs.pet {
                Picker("Where", selection: $prefs.petPlace) {
                    Text("In the window").tag(PetPlace.window)
                    Text("On the desktop, over every app").tag(PetPlace.desktop)
                }
                Picker("Size", selection: $prefs.petSize) {
                    Text("Small").tag(PetSize.small)
                    Text("Medium").tag(PetSize.medium)
                    Text("Large").tag(PetSize.large)
                }
            }
            Text("Claude walks along the bottom and shows what the Space is doing. Click it to open that chat or the inbox. Space → Desk Pet shows or hides it too.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Toggle("Show in the menu bar", isOn: $prefs.menuBar)
            Toggle("Notify me of new inbox messages", isOn: $prefs.notifications)
            Text("The unread count also shows on the Dock icon. Notifications follow the Space's inbox; nothing is sent twice.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .formStyle(.grouped)
        .frame(width: 520)
        .task(id: "\(prefs.voiceCapture) \(listening?.id.uuidString ?? "")") { await loadCaptureTargets() }
    }

    /// Where right ⌥ sends a note: a picker when the Space has several places, else what there is.
    @ViewBuilder private func captureDestination(_ space: Connection) -> some View {
        if captureTargetsFailed {
            Text("\(space.name) is not connected. Voice input needs the Space.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        } else if let targets = captureTargets {
            if targets.isEmpty {
                Text(verbatim: DictationRules.noTargetNote(space: space.name))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if targets.count == 1 {
                Text("Notes go to \(targets[0].displayTitle()) on \(space.name).")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Picker("Send to", selection: Binding(
                    get: { DictationRules.captureTarget(targets, chosen: prefs.voiceCaptureTargets[space.id.uuidString])?.id ?? "" },
                    set: { prefs.voiceCaptureTargets[space.id.uuidString] = $0 })) {
                    ForEach(targets) { Text(verbatim: $0.displayTitle()).tag($0.id) }
                }
            }
        }
    }

    private func loadCaptureTargets() async {
        captureTargets = nil
        captureTargetsFailed = false
        guard prefs.voiceCapture, let space = listening else { return }
        do {
            captureTargets = try await model.loader(for: space).api.get("/api/capture", as: DictationRules.TextTargets.self).textTargets ?? []
        } catch {
            captureTargetsFailed = true
        }
    }
}
