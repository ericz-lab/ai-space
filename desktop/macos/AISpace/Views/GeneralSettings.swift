import SwiftUI

/// Settings > General: the desktop conveniences, each optional.
struct GeneralSettings: View {
    @ObservedObject var prefs: Preferences

    var body: some View {
        Form {
            Picker("Quick Chat shortcut", selection: $prefs.quickChat) {
                ForEach(Preferences.Shortcut.allCases) { Text($0.label).tag($0) }
            }
            Text("Opens a chat with an agent over any app. Services > Ask ai-space sends selected text to it, and Shortcuts can open aispace://chat?agent=<app>/<agent>&text=… — a message is never sent without you.")
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
