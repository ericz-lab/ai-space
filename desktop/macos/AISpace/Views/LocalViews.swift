import SwiftUI

/// The Local edition's first launch (docs/local.md): set up the Space this app carries, or, when
/// this Mac already has an ai-space the app did not install, connect to it or migrate it. Nothing
/// is adopted, stopped or upgraded without one of these buttons.
struct LocalSetupView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var local: LocalManager
    @State private var confirmingMigrate = false
    @State private var showingRemote = false

    var body: some View {
        VStack(spacing: 18) {
            Logo(size: 96)
            content
            if let failure = local.failure {
                Text(failure.error).font(.callout).foregroundStyle(.red).multilineTextAlignment(.center).frame(maxWidth: 460)
            }
            DisclosureGroup("Connect to a Space elsewhere", isExpanded: $showingRemote) {
                ConnectionForm(initial: nil) { name, url in model.add(name: name, url: url) }.padding(.top, 8)
            }
            .frame(width: 440)
            .foregroundStyle(.secondary)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { if local.status == nil { await local.refresh() } }
    }

    @ViewBuilder private var content: some View {
        if let busy = local.busy {
            ProgressView(busy).controlSize(.large).padding(.vertical, 24)
        } else if let status = local.status {
            switch status.state {
            case .absent:
                Text("Set up AI Space on this Mac").font(.largeTitle)
                Text("Your apps, agents and their data stay on this Mac. AI Space runs in the background, also while this window is closed.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                LocalRuntimesCheck(local: local, runtimes: status.runtimes).frame(width: 460)
                Button("Set Up") { Task { await local.install(into: model) } }
                    .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
                    .disabled(!status.runtimes.any)
                    .help(status.runtimes.any ? "" : "Install Claude Code or Codex first, or choose where it is.")
            case .managed:
                Text("AI Space is installed on this Mac").font(.largeTitle)
                Text(status.ownServiceRunning ? "It is running. Open it to continue." : "It is not running. Opening it starts it again.")
                    .foregroundStyle(.secondary)
                Button("Open") { Task { await local.install(into: model) } }
                    .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
            case .foreign:
                Text("This Mac already has an AI Space").font(.largeTitle)
                Text(status.reason ?? "It was installed another way.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                Text("Connect to it as it is, or let this app take it over. Taking over keeps its apps, data and settings; stop the running one first.")
                    .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                LocalRuntimesCheck(local: local, runtimes: status.runtimes).frame(width: 460)
                HStack {
                    Button("Connect to It") {
                        if let url = URL(string: status.url) { model.add(name: "This Mac", url: url) }
                    }
                    .disabled(status.running == nil)
                    .help(status.running == nil ? "It is not running: start it, or take it over." : "")
                    Button("Take It Over…") { confirmingMigrate = true }
                        .disabled(status.running != nil || status.workspace.locked == true)
                        .help(status.running != nil ? "Stop the running ai-space first." : "")
                }
                .controlSize(.large)
                .confirmationDialog("Take over \(status.workspace.path)?", isPresented: $confirmingMigrate) {
                    Button("Take It Over") { Task { await local.install(migrate: true, into: model) } }
                } message: {
                    Text("This app will run that workspace from now on, with its apps, data and settings as they are.")
                }
                Button("Check Again") { Task { await local.refresh() } }.buttonStyle(.link)
            }
        } else {
            ProgressView("Checking this Mac…").padding(.vertical, 24)
        }
    }
}

/// The agent CLIs this Mac has, before anything is installed: AI Space runs its agents and model
/// calls through Claude Code or Codex, so setting up needs at least one. Each is found where
/// installers put it, or chosen by hand when it lives elsewhere.
struct LocalRuntimesCheck: View {
    @ObservedObject var local: LocalManager
    let runtimes: LocalStatus.Runtimes

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Agents on this Mac").font(.headline)
            runtime("claude", "Claude Code", path: runtimes.claude, how: "curl -fsSL https://claude.ai/install.sh | bash\nclaude")
            runtime("codex", "Codex", path: runtimes.codex, how: "brew install --cask codex\ncodex")
            if !runtimes.any {
                Text("Install at least one and sign in to it in Terminal, then check again.")
                    .font(.callout).foregroundStyle(Theme.warning)
            }
            Button("Check Again") { Task { await local.refresh() } }
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private func runtime(_ name: String, _ title: String, path: String?, how: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Label(title, systemImage: path == nil ? "xmark.circle" : "checkmark.circle.fill")
                    .foregroundStyle(path == nil ? Color.secondary : Color.green)
                Spacer()
                if local.chosenRuntimes[name] != nil {
                    Button("Search Again") { Task { await local.forgetRuntimeChoice(name) } }.buttonStyle(.link)
                }
                Button("Choose…") { Task { await local.chooseRuntime(name) } }.buttonStyle(.link)
            }
            if let path {
                Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            } else {
                if let chosen = local.chosenRuntimes[name] {
                    Text("\(chosen) is not a program that can run.").font(.caption).foregroundStyle(.red)
                }
                Text(verbatim: how).font(.caption.monospaced()).textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

/// The first run's last step: which model the Space's agents and apps use when nothing chooses one
/// for them. The same setting as Settings → Models → Default model, with every tier of every agent
/// CLI the Space has. It cannot be skipped; it can be changed later in Settings.
struct LocalModelChoice: View {
    @ObservedObject var model: AppModel
    @ObservedObject var settings: SettingsLoader
    @State private var choice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Choose the default model").font(.title2.bold())
            Text("Space Assistant, other agents and apps use it when nothing chooses a model for them. You can change it later in Settings.")
                .foregroundStyle(.secondary)
            if let m = settings.settings?.models {
                Picker("Default model", selection: $choice) {
                    ForEach(m.options) { Text(verbatim: $0.label).tag(Optional($0.value)) }
                }
                .pickerStyle(.radioGroup)
                .labelsHidden()
                .onAppear { if choice == nil { choice = m.options.first(where: { $0.tier == "intermediate" })?.value } }
            } else {
                ProgressView().controlSize(.small)
            }
            if let reason = settings.saveError {
                Text("The choice was not saved: \(reason)").font(.callout).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Continue") {
                    Task {
                        await settings.setDefaultModel(choice)
                        if settings.saveError == nil { model.local.needsModelChoice = false }
                    }
                }
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                .disabled(choice == nil || settings.isSaving)
            }
        }
        .padding(24)
        .frame(width: 480)
        .interactiveDismissDisabled()
        .task { if settings.settings?.models == nil { await settings.refresh() } }
    }
}

/// Settings: the Space this app runs on this Mac, its background service and its updates.
struct LocalSettingsSection: View {
    @ObservedObject var model: AppModel
    @ObservedObject var local: LocalManager
    @State private var confirmingRemove = false
    @State private var confirmingUpdate = false

    var body: some View {
        Section {
            if let s = local.status {
                LabeledContent("State") { Text(stateText(s)) }
                if let installed = s.installed {
                    LabeledContent("Installed") { Text(verbatim: "\(installed.version) (\(installed.commit.prefix(7)))") }
                }
                if let bundle = local.bundle {
                    LabeledContent("In this app") { Text(verbatim: "\(bundle.version) (\(bundle.commit.prefix(7)))") }
                }
                LabeledContent("Workspace") { Text(s.workspace.path).textSelection(.enabled) }
                LabeledContent("Agents") { Text(runtimesText(s.runtimes)) }
                if let busy = local.busy {
                    ProgressView(busy).controlSize(.small)
                } else {
                    actions(s)
                }
            } else {
                ProgressView().controlSize(.small)
            }
            if let waiting = local.updateWaitingFor ?? local.failure?.activity {
                Text("Waiting for: \(waiting.summary)").font(.callout).foregroundStyle(.secondary)
            }
            if let failure = local.failure {
                Text(failure.error).font(.callout).foregroundStyle(.red)
            }
            LocalAppUpdateView(updater: model.updater)
                .disabled(local.busy != nil)
        } header: {
            Text("AI Space on This Mac")
        } footer: {
            Text("It runs in the background: closing or quitting this app leaves it running. Before deleting the app, remove the background service here; your workspace stays.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .task { await local.refresh() }
    }

    @ViewBuilder private func actions(_ s: LocalStatus) -> some View {
        switch s.state {
        case .absent:
            Button("Set Up AI Space on This Mac") { Task { await local.install(into: model) } }
        case .foreign:
            Text(s.reason ?? "This Mac has an ai-space this app did not install.").font(.callout).foregroundStyle(.secondary)
            Button("Take It Over…") { Task { await local.install(migrate: true, into: model) } }
                .disabled(s.running != nil || s.workspace.locked == true)
        case .managed:
            HStack {
                if s.updateAvailable {
                    Button("Update when idle") { Task { await local.install(whenBusy: .wait, into: model) } }
                        .buttonStyle(.borderedProminent)
                    Button("Update now…") { confirmingUpdate = true }
                        .confirmationDialog("Update the background service now?", isPresented: $confirmingUpdate) {
                            Button("Update Now") { Task { await local.install(whenBusy: .now, into: model) } }
                        } message: {
                            Text("Running work has up to 30 seconds to finish before the service restarts. Unfinished work may be interrupted.")
                        }
                }
                if s.service.running {
                    Button("Stop") { Task { await local.stop() } }
                    Button("Restart") { Task { await local.restart() } }
                } else if s.installed != nil {
                    Button("Start") { Task { await local.start() } }
                }
                Button(s.installed == nil ? "Install Again" : "Repair") { Task { await local.install(into: model) } }
                Spacer()
                Button("Open Log") { local.openLog() }
            }
            if s.installed != nil {
                Button("Remove Background Service…", role: .destructive) { confirmingRemove = true }
                    .confirmationDialog("Remove the background service?", isPresented: $confirmingRemove) {
                        Button("Remove", role: .destructive) { Task { await local.removeService(model: model) } }
                    } message: {
                        Text("AI Space stops and no longer starts at login. Your apps, data and settings stay in \(s.workspace.path).")
                    }
            }
        }
    }

    private func stateText(_ s: LocalStatus) -> String {
        switch s.state {
        case .absent: return "Not set up"
        case .foreign: return "Installed another way"
        case .managed:
            if s.installed == nil { return "Background service removed" }
            if s.service.running { return s.ownServiceRunning ? "Running" : "Starting…" }
            if s.service.disabled { return "Stopped" }
            return "Not running (\(s.service.detail))"
        }
    }

    private func runtimesText(_ r: LocalStatus.Runtimes) -> String {
        let found = [r.claude.map { _ in "Claude Code" }, r.codex.map { _ in "Codex" }].compactMap { $0 }
        return found.isEmpty ? "None found" : found.joined(separator: ", ")
    }
}


/// The app download is separate from updating the service it carries.
private struct LocalAppUpdateView: View {
    @ObservedObject var updater: AppUpdater

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch updater.phase {
            case .idle:
                checkButton
            case .checking:
                ProgressView("Checking for updates…").controlSize(.small)
            case .upToDate:
                Text("No newer Local release is available.").foregroundStyle(.secondary)
                checkButton
            case .available(let update):
                Text("AI Space \(update.version) is available.")
                HStack {
                    Button("Install and relaunch") { Task { await updater.install(update) } }
                        .buttonStyle(.borderedProminent)
                    Link("Release notes", destination: update.page)
                }
            case .installing(_, let message):
                ProgressView(message).controlSize(.small)
            case .failed(let message, let page):
                Text(message).font(.callout).foregroundStyle(.red)
                if let page { Link("Download from the release page", destination: page) }
                checkButton
            }
        }
        .task { await updater.check() }
    }

    private var checkButton: some View {
        Button("Check for app updates") { Task { await updater.check(force: true) } }
    }
}
