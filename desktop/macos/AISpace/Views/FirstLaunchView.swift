import SwiftUI

/// The window with no saved Space. The Local edition sets up the service it carries
/// (LocalViews.swift); the desktop app offers two entries, the AI Space on this Mac (installed
/// first when there is none, behind one progress bar) or one on another machine
/// (Services/FirstLaunch.swift).
struct FirstLaunchView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Group {
            if model.local.available {
                LocalSetupView(model: model, local: model.local)
            } else {
                WelcomeView(model: model, first: model.firstLaunch)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The window's ground: a range of mountains in faint binary digits along the bottom.
        .background(alignment: .bottom) { RidgeView().frame(height: 200) }
    }
}

/// `RidgeArt` at whatever width the window has, in a monospaced font and the primary colour
/// faded far back, so it reads as ground in light and dark alike.
struct RidgeView: View {
    private static let glyph: CGFloat = 11, line: CGFloat = 12

    var body: some View {
        Canvas { context, size in
            let font = NSFont.monospacedSystemFont(ofSize: Self.glyph, weight: .regular)
            let cell = ("0" as NSString).size(withAttributes: [.font: font]).width
            guard cell > 0 else { return }
            let rows = Int(size.height / Self.line)
            let lines = RidgeArt.lines(cols: Int((size.width / cell).rounded(.up)), rows: rows, cellAspect: cell / Self.line)
            let top = size.height - CGFloat(rows) * Self.line
            for (y, text) in lines.enumerated() where text.contains(where: { $0 != " " }) {
                context.draw(Text(verbatim: text).font(Font(font)).foregroundStyle(.primary.opacity(0.16)),
                             at: CGPoint(x: 0, y: top + CGFloat(y) * Self.line), anchor: .topLeading)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct WelcomeView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var first: FirstLaunch

    var body: some View {
        VStack(spacing: 20) {
            Logo(size: 96)
            switch first.phase {
            case .choose:
                if first.connecting { connect } else { choices }
            case .looking:
                Text("Connecting to AI Space…").font(.largeTitle)
                ProgressView().controlSize(.small)
            case .installing, .starting:
                Text("Installing AI Space…").font(.largeTitle)
                ProgressView(value: first.progress)
                    .frame(width: 360)
                    .accessibilityLabel(Text("Installing AI Space…"))
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
        VStack(spacing: 6) {
            Button("Connect to Local AI Space") { Task { await first.connectLocal() } }
                .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
                .frame(minWidth: 320)
            Text(hereNote).font(.callout).foregroundStyle(.secondary)
        }
        Button("Connect to a Remote AI Space…") { first.connecting = true }
            .controlSize(.large)
    }

    /// One line under the first entry: what the click will do.
    private var hereNote: LocalizedStringKey {
        switch first.here {
        case .unknown: return "Looking for AI Space on this Mac…"
        case .found: return "Found on this Mac"
        case .none: return "Not on this Mac yet: it is downloaded and installed first"
        }
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
        HStack {
            Button("Retry") { Task { await first.retry() } }
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            Button("Connect to a Remote AI Space…") {
                first.connecting = true
                first.dismissFailure()
            }
        }
        .controlSize(.large)
        // What the installer printed stays out of sight unless asked for.
        if !first.lines.isEmpty {
            DisclosureGroup("Details") { InstallerOutput(lines: SpaceInstaller.tail(first.lines)) }
                .frame(width: 520)
        }
    }

    private func reason(_ failure: FirstLaunch.Failure) -> String {
        switch failure {
        case .download(let why): return String(localized: "The installer could not be downloaded: \(why)")
        case .exit(let code): return String(localized: "The installer stopped with exit code \(Int(code)).")
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
