import SwiftUI

/// What the operator typed for a new Space, and why it cannot be used yet.
@MainActor
final class ConnectForm: ObservableObject {
    @Published var address = ""
    @Published var name = ""
    @Published var error: String?

    func url() -> URL? {
        do {
            let url = try ConnectionRules.normalize(address)
            error = nil
            return url
        } catch let e as ConnectionURLError {
            error = Self.message(e)
        } catch {
            self.error = String(localized: "This is not a valid address.")
        }
        return nil
    }

    static func message(_ e: ConnectionURLError) -> String {
        switch e {
        case .empty: return String(localized: "Enter the panel's address.")
        case .invalid: return String(localized: "This is not a valid address.")
        case .unsupportedScheme: return String(localized: "The address must start with https://.")
        case .credentials: return String(localized: "Leave user names and passwords out of the address; sign in after connecting.")
        case .insecureRemote: return String(localized: "A Space on another machine must use https://.")
        }
    }
}

/// Add a Space by the address of its panel. Nothing is installed or started; the app only
/// opens a Space that already runs.
struct ConnectView: View {
    @ObservedObject var model: AppModel
    let isFirst: Bool
    @StateObject private var form = ConnectForm()
    @FocusState private var addressFocused: Bool

    var body: some View {
        ZStack {
            Backdrop()
            ScrollView {
                VStack(spacing: 18) {
                    Logo(size: 84).padding(.top, isFirst ? 48 : 12)
                    Text("Connect to a Space").font(.title2.weight(.semibold))
                    Text("Enter the address you open your ai-space panel at. Sign-in, when your Space asks for one, happens after connecting.")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(spacing: 0) {
                        TextField("space.example.com", text: $form.address)
                            .textContentType(.URL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.go).focused($addressFocused).onSubmit(connect)
                            .padding(14)
                            .accessibilityLabel(Text("Panel address"))
                        Divider()
                        TextField("Name (optional)", text: $form.name)
                            .padding(14)
                    }
                    .glass()

                    if let error = form.error {
                        Label(error, systemImage: "exclamationmark.circle")
                            .font(.footnote).foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: connect) {
                        Text("Connect").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))

                    #if targetEnvironment(simulator) || targetEnvironment(macCatalyst)
                    Button("Use a Space on this Mac (\(ConnectionRules.localDefault))") {
                        form.address = ConnectionRules.localDefault
                    }
                    .font(.footnote)
                    #endif
                }
                .padding(.horizontal, 24)
                .frame(maxWidth: 480)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !isFirst {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { model.showingAdd = false }
                }
            }
        }
    }

    private func connect() {
        guard let url = form.url() else { return }
        if model.store.connections.contains(where: { ConnectionRules.sameOrigin($0.url, url) }) {
            form.error = String(localized: "This Space is already saved.")
            return
        }
        model.add(name: form.name, url: url)
    }
}
