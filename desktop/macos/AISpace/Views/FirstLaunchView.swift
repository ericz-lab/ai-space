import SwiftUI

/// The window with no saved Space. The Local edition sets up the service it carries
/// (LocalViews.swift); the desktop app looks for an AI Space on this Mac and, finding none,
/// offers to install it or to connect to another machine's (Services/FirstLaunch.swift).
struct FirstLaunchView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        if model.local.available {
            LocalSetupView(model: model, local: model.local)
        } else {
            WelcomeView(model: model, first: model.firstLaunch)
        }
    }
}

struct WelcomeView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var first: FirstLaunch

    var body: some View {
        VStack(spacing: 20) {
            Logo(size: 96)
            switch first.phase {
            case .looking:
                ProgressView("Looking for AI Space on this Mac…").padding(.vertical, 24)
            case .choose:
                if first.connecting { connect } else { choices }
            case .installing:
                Text("Installing AI Space…").font(.largeTitle)
                Text("This downloads AI Space and starts it in the background. It can take a few minutes.")
                    .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
                InstallerOutput(lines: first.lines)
                ProgressView().controlSize(.small)
            case .starting:
                Text("Installing AI Space…").font(.largeTitle)
                InstallerOutput(lines: first.lines)
                ProgressView("Waiting for AI Space to start…")
            case .failed(let failure):
                failed(failure)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder
    private var choices: some View {
        Text("Welcome to AI Space").font(.largeTitle)
        Text("No AI Space was found on this Mac. Install it here, or connect to one that runs on another machine.")
            .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
        Button("Install AI Space on This Mac") { Task { await first.install() } }
            .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
        Text("Runs the official one-command installer for your user account, with no administrator password. AI Space then runs in the background on its own: this app does not update or remove it, and deleting the app leaves it in place (`space uninstall` removes it).")
            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
        Button("Connect to an AI Space on Another Machine…") { first.connecting = true }
            .controlSize(.large)
    }

    @ViewBuilder
    private var connect: some View {
        Text("Connect to a Space").font(.largeTitle)
        Text("Enter the address of an AI Space that is already running on another machine.")
            .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
        ConnectionForm(initial: nil, kind: .remote) { name, url in
            first.connecting = false
            model.add(name: name, url: url)
        } cancel: { first.connecting = false }
            .frame(width: 440)
    }

    @ViewBuilder
    private func failed(_ failure: FirstLaunch.Failure) -> some View {
        Text(failure == .notAnswering ? "AI Space did not start" : "AI Space was not installed").font(.largeTitle)
        Text(reason(failure)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 460)
        if !first.lines.isEmpty { InstallerOutput(lines: SpaceInstaller.tail(first.lines)) }
        HStack {
            Button("Retry") { Task { await first.retry() } }
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            Button("Connect to an AI Space on Another Machine…") {
                first.connecting = true
                first.dismissFailure()
            }
        }
        .controlSize(.large)
    }

    private func reason(_ failure: FirstLaunch.Failure) -> String {
        switch failure {
        case .download(let why): return String(localized: "The installer could not be downloaded: \(why)")
        case .exit(let code): return String(localized: "The installer stopped with exit code \(Int(code)). Its last lines are below.")
        case .notAnswering: return String(localized: "The installer finished, but AI Space is not answering on this Mac yet. Retry looks for it again.")
        }
    }
}

/// What the installer printed, newest line in view.
struct InstallerOutput: View {
    let lines: [String]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(verbatim: lines.joined(separator: "\n"))
                    .font(.caption.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                Color.clear.frame(height: 1).id("end")
            }
            .onChange(of: lines.count, initial: true) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
        }
        .frame(width: 520, height: 150)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(Text("Installer output"))
    }
}
