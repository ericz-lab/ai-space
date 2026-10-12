import SwiftUI

/// Settings > Connections: the Spaces this Mac knows. Every change here stays on this Mac.
struct ConnectionSettings: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: ConnectionStore
    @StateObject private var ui = SettingsUI()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let path = store.loadError {
                Text("The saved connections could not be read and were moved to \(path).")
                    .font(.callout).foregroundStyle(.orange)
            }
            List(selection: $ui.selection) {
                ForEach(store.connections) { c in
                    HStack {
                        Image(systemName: c.isLocal ? "desktopcomputer" : "globe")
                        VStack(alignment: .leading) {
                            Text(c.name)
                            Text(c.url.absoluteString).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if c.isDefault { Text("Default").font(.caption).foregroundStyle(.secondary) }
                    }
                    .tag(c.id)
                    .contextMenu { actions(for: c) }
                }
            }
            .frame(minHeight: 200)
            HStack {
                Button { ui.adding = true } label: { Image(systemName: "plus") }.help("Add Connection")
                Button { ui.removing = current } label: { Image(systemName: "minus") }
                    .help("Remove Connection").disabled(current == nil)
                Spacer()
                Button("Edit…") { ui.editing = current }.disabled(current == nil)
                Button("Make Default") { current.map { store.setDefault($0.id) } }
                    .disabled(current == nil || current?.isDefault == true)
            }
            Text("Removing a connection forgets it on this Mac only. The Space keeps running, and its agents, tasks and data are untouched.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 560)
        .sheet(isPresented: $ui.adding) {
            ConnectionForm(initial: nil) { name, url in
                model.add(name: name, url: url)
                ui.adding = false
            } cancel: { ui.adding = false }
                .padding(20).frame(width: 460)
        }
        .sheet(item: $ui.editing) { c in
            ConnectionForm(initial: c) { name, url in
                model.update(c.id, name: name, url: url)
                ui.editing = nil
            } cancel: { ui.editing = nil }
                .padding(20).frame(width: 460)
        }
        .sheet(item: $ui.removing) { c in
            VStack(alignment: .leading, spacing: 12) {
                Text("Remove \(c.name)?").font(.headline)
                Text("Unsent text on its page is lost. The Space itself is not changed.")
                    .font(.callout).foregroundStyle(.secondary)
                Toggle("Also remove its saved sign-in", isOn: $ui.clearSignIn)
                HStack {
                    Spacer()
                    Button("Cancel", role: .cancel) { ui.removing = nil }.keyboardShortcut(.cancelAction)
                    Button("Remove", role: .destructive) {
                        let clear = ui.clearSignIn
                        ui.removing = nil
                        Task { await model.remove(c.id, clearSignIn: clear) }
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20).frame(width: 400)
        }
    }

    private var current: Connection? { ui.selection.flatMap(store.connection) }

    @ViewBuilder
    private func actions(for c: Connection) -> some View {
        Button("Open") { model.select(c.id) }
        Button("Edit…") { ui.editing = c }
        Button("Make Default") { store.setDefault(c.id) }.disabled(c.isDefault)
        Divider()
        Button("Remove…") { ui.removing = c }
    }
}

/// View state lives in objects: the macOS 27 Command Line Tools declare `@State` as a macro
/// whose plugin only Xcode ships, and the app must build without Xcode.
@MainActor
final class SettingsUI: ObservableObject {
    @Published var selection: UUID?
    @Published var editing: Connection?
    @Published var adding = false
    @Published var removing: Connection?
    @Published var clearSignIn = true
}

@MainActor
final class FormState: ObservableObject {
    @Published var kind: ConnectionForm.Kind
    @Published var name: String
    @Published var address: String
    @Published var problem: LocalizedStringKey?

    init(_ initial: Connection?) {
        kind = initial?.isLocal ?? true ? .local : .remote
        name = initial?.name ?? ""
        address = initial?.url.absoluteString ?? ConnectionRules.localDefault
    }
}

/// Add or edit one connection. Validates the address before saving: HTTPS, or HTTP to this Mac only.
struct ConnectionForm: View {
    enum Kind: Hashable { case local, remote }

    let initial: Connection?
    let save: (String, URL) -> Void
    var cancel: (() -> Void)?
    @StateObject private var form: FormState

    init(initial: Connection?, save: @escaping (String, URL) -> Void, cancel: (() -> Void)? = nil) {
        self.initial = initial
        self.save = save
        self.cancel = cancel
        _form = StateObject(wrappedValue: FormState(initial))
    }

    var body: some View {
        Form {
            if initial == nil {
                Picker("Space", selection: $form.kind) {
                    Text("On this Mac").tag(Kind.local)
                    Text("Remote (HTTPS)").tag(Kind.remote)
                }
                .pickerStyle(.segmented)
                .onChange(of: form.kind) { _, k in
                    form.address = k == .local ? ConnectionRules.localDefault : ""
                    form.problem = nil
                }
            }
            TextField("Name", text: $form.name, prompt: Text(form.kind == .local ? "This Mac" : "Seoul"))
            TextField("Panel address", text: $form.address, prompt: Text("https://space.example.com"))
                .textContentType(.URL)
                .onSubmit(submit)
            if let problem = form.problem {
                Text(problem).font(.callout).foregroundStyle(.red)
            } else if form.kind == .remote {
                Text("Sign-in to the server's access layer happens in the window after connecting.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if initial != nil {
                Text("Changing the address reloads the page; unsent text on it is lost.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                if let cancel { Button("Cancel", action: cancel).keyboardShortcut(.cancelAction) }
                Button(initial == nil ? "Connect" : "Save", action: submit).keyboardShortcut(.defaultAction)
            }
        }
        .formStyle(.columns)
    }

    private func submit() {
        do {
            let url = try ConnectionRules.normalize(form.address)
            form.problem = nil
            save(form.name, url)
        } catch let e as ConnectionURLError {
            form.problem = Self.message(e)
        } catch {
            form.problem = "This is not a valid address."
        }
    }

    static func message(_ e: ConnectionURLError) -> LocalizedStringKey {
        switch e {
        case .empty: return "Enter the panel's address."
        case .invalid: return "This is not a valid address."
        case .unsupportedScheme: return "Use an http:// or https:// address."
        case .credentials: return "Do not put a user name or password in the address."
        case .insecureRemote: return "A remote Space needs HTTPS. Plain HTTP is allowed only for this Mac (127.0.0.1 or localhost)."
        }
    }
}
