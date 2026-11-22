import Foundation

/// The desktop app's first launch without a bundled service
/// (docs/macos-desktop.md#connections-and-first-launch): look for an AI Space on this Mac and
/// save it; when there is none, wait for the person to choose between installing the standard
/// one (the release's own installer, `Services/SpaceInstaller.swift`) and another machine's
/// address. Nothing is installed without that click.
@MainActor
final class FirstLaunch: ObservableObject {
    enum Phase: Equatable {
        /// Asking this Mac's ports.
        case looking
        /// No Space here: the two choices.
        case choose
        /// The installer is running; `lines` is what it printed.
        case installing
        /// The installer finished; waiting for the service to answer.
        case starting
        case failed(Failure)
    }

    enum Failure: Equatable {
        case download(String)
        case exit(Int32)
        /// Installed, but nothing answered as ai-space in time.
        case notAnswering
    }

    @Published private(set) var phase: Phase = .choose
    @Published private(set) var lines: [String] = []
    /// The address form for a Space on another machine is showing.
    @Published var connecting = false
    /// Called with the Space found on this Mac, to save and select it.
    var found: ((URL) -> Void)?

    private let probe: LocalSpaceProbe
    private let installer: SpaceInstaller

    init(probe: LocalSpaceProbe = .live(), installer: SpaceInstaller = SpaceInstaller()) {
        self.probe = probe
        self.installer = installer
    }

    var busy: Bool { phase == .looking || phase == .installing || phase == .starting }

    /// At launch with no saved Space: a Space already on this Mac is taken without a question.
    func look() async {
        guard !busy else { return }
        phase = .looking
        if let url = await probe.find() { adopt(url) } else { phase = .choose }
    }

    /// The primary choice. A Space that came up since the first look is used as it is: the app
    /// installs only where there is none, and never runs the installer over a running one.
    func install() async {
        guard !busy else { return }
        connecting = false
        lines = []
        phase = .looking
        if let url = await probe.find() { return adopt(url) }
        phase = .installing
        let outcome = await installer.install { [weak self] line in
            Task { @MainActor in self?.append(line) }
        }
        switch outcome {
        case .installed: await waitForSpace()
        case .downloadFailed(let why): phase = .failed(.download(why))
        case .failed(let code): phase = .failed(.exit(code))
        }
    }

    /// Retry after a failure: look again when the install itself went through, else install again.
    func retry() async {
        if phase == .failed(.notAnswering) { await waitForSpace() } else { await install() }
    }

    /// Leaves the failure screen for the choices (the address form), keeping nothing running.
    func dismissFailure() {
        if case .failed = phase { phase = .choose }
    }

    private func waitForSpace() async {
        phase = .starting
        if let url = await probe.wait() { adopt(url) } else { phase = .failed(.notAnswering) }
    }

    private func adopt(_ url: URL) {
        phase = .choose
        connecting = false
        found?(url)
    }

    private func append(_ line: String) {
        lines.append(line)
        if lines.count > 400 { lines.removeFirst(lines.count - 400) }
    }
}
