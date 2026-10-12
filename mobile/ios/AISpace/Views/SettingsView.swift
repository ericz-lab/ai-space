import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel
    let connection: Connection
    @ObservedObject var loader: CatalogueLoader

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.store.connections) { c in
                        Button { model.select(c.id) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: c.name).foregroundStyle(Theme.text)
                                    Text(verbatim: c.url.absoluteString).font(.footnote).foregroundStyle(Color.secondary).lineLimit(1)
                                }
                                Spacer()
                                if c.id == connection.id { Image(systemName: "checkmark").foregroundStyle(Theme.accent).accessibilityLabel(Text("Selected")) }
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) { model.remove(c.id) } label: { Label("Remove", systemImage: "trash") }
                        }
                    }
                    Button { model.showingAdd = true } label: { Label("Add a Space", systemImage: "plus") }
                } header: {
                    Text("Spaces")
                } footer: {
                    Text("Removing a Space here forgets its address, sign-in and favorites on this iPhone. Nothing changes on the server.")
                }

                Section {
                    LabeledContent("Status") { Text(statusText) }
                    Button(role: .destructive) { model.confirmingSignOut = true } label: { Text("Sign Out") }
                        .confirmationDialog(Text("Sign out of \(connection.name)?"), isPresented: $model.confirmingSignOut, titleVisibility: .visible) {
                            Button("Sign Out", role: .destructive) { model.signOut(connection) }
                        } message: {
                            Text("This clears the Space's cookies and saved pages from this iPhone.")
                        }
                } header: {
                    Text("Session")
                } footer: {
                    Text("The sign-in belongs to whatever stands in front of your Space (for example Cloudflare Access). The app stores no password or token; the session lives in this Space's own web data, apart from Safari.")
                }

                Section {
                    LabeledContent("Version") { Text(verbatim: Bundle.main.shortVersion) }
                    Text("Chat, the inbox, tasks and the Space's own settings are on the Panel tab.")
                        .font(.footnote).foregroundStyle(.secondary)
                } header: {
                    Text("About")
                }
            }
            .navigationTitle("Settings")
        }
    }

    private var statusText: String {
        switch loader.status {
        case .ok: return String(localized: "Connected")
        case .loading: return String(localized: "Connecting…")
        case .signInNeeded: return String(localized: "Signed out")
        case .unreachable: return String(localized: "Cannot reach this Space")
        case .incompatible: return String(localized: "Not an ai-space panel")
        }
    }
}
