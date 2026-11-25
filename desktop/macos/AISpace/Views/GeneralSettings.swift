import ApplicationServices
import SwiftUI

/// Settings > General: the desktop conveniences, each optional.
struct GeneralSettings: View {
    @ObservedObject var prefs: Preferences
    @ObservedObject var store: ConnectionStore

    var body: some View {
        Form {
            Picker("Quick Chat shortcut", selection: $prefs.quickChat) {
                ForEach(Preferences.Shortcut.allCases) { Text($0.label).tag($0) }
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
                Picker("Transcribe with", selection: Binding(get: { prefs.voiceInputSpace ?? "" }, set: { prefs.voiceInputSpace = $0.isEmpty ? nil : $0 })) {
                    Text("The selected Space").tag("")
                    ForEach(store.connections) { Text($0.name).tag($0.id.uuidString) }
                }
                Text("What you say is sent to this Space and to no other. When it cannot transcribe, voice input says so and sends nothing.")
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
    }
}
