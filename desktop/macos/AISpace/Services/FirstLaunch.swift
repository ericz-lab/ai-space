import Foundation

/// The desktop app's first launch without a bundled service
/// (docs/macos-desktop.md#connections-and-first-launch). Two entries: connect to the AI Space on
/// this Mac, or to one on another machine. The app looks at this Mac once at launch, so the first
/// entry can say whether one is here. Choosing it connects straight to the one found; with none,
/// it installs the standard one first (the release's own installer, `Services/SpaceInstaller.swift`)
/// behind a single progress bar, then connects. Nothing is installed without that click.
@MainActor
final class FirstLaunch: ObservableObject {
    enum Phase: Equatable {
        /// The two entries.
        case choose
        /// Looking at this Mac's ports after the click.
        case looking
        /// The installer is running.
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

    /// What the look at launch found on this Mac.
    enum Here: Equatable {
        case unknown
        case found(URL)
        case none
    }

    @Published private(set) var phase: Phase = .choose
    @Published private(set) var here: Here = .unknown
    /// The progress bar while installing, 0 to 1.
    @Published private(set) var progress: Double = 0
    /// What the installer printed, kept for the failure's details; not shown while it runs.
    @Published private(set) var lines: [String] = []
    /// The address form for a Space on another machine is showing.
    @Published var connecting = false
    /// Called with the Space found on this Mac, to save and select it.
    var found: ((URL) -> Void)?

    private let probe: LocalSpaceProbe
    private let installer: SpaceInstaller
    private var meter = InstallProgress()
    private var ticker: Task<Void, Never>?

    init(probe: LocalSpaceProbe = .live(), installer: SpaceInstaller = SpaceInstaller()) {
        self.probe = probe
        self.installer = installer
    }

    var busy: Bool { phase == .looking || phase == .installing || phase == .starting }

    /// At launch with no saved Space: whether one is on this Mac, for the first entry's line.
    /// It saves nothing; the person picks an entry.
    func look() async {
        if let url = await probe.find() { here = .found(url) } else { here = .none }
    }

    /// "Connect to Local AI Space". The one on this Mac is used as it is, looked for again at the
    /// click; the installer runs only when there is none, never over a running one.
    func connectLocal() async {
        guard !busy else { return }
        connecting = false
        lines = []
        phase = .looking
        if let url = await probe.find() { return adopt(url) }
        here = .none
        startMeter()
        phase = .installing
        let outcome = await installer.install { [weak self] line in
            Task { @MainActor in self?.append(line) }
        }
        switch outcome {
        case .installed: await waitForSpace()
        case .downloadFailed(let why): stop(.failed(.download(why)))
        case .failed(let code): stop(.failed(.exit(code)))
        }
    }

    /// Retry after a failure: look again when the install itself went through, else install again.
    func retry() async {
        if phase == .failed(.notAnswering) {
            startMeter(at: .starting)
            await waitForSpace()
        } else {
            await connectLocal()
        }
    }

    /// Leaves the failure screen for the entries.
    func dismissFailure() {
        if case .failed = phase { phase = .choose }
    }

    private func waitForSpace() async {
        meter.enter(.starting)
        phase = .starting
        if let url = await probe.wait() {
            progress = 1
            adopt(url)
        } else {
            stop(.failed(.notAnswering))
        }
    }

    private func adopt(_ url: URL) {
        ticker?.cancel()
        ticker = nil
        here = .found(url)
        phase = .choose
        connecting = false
        found?(url)
    }

    private func stop(_ next: Phase) {
        ticker?.cancel()
        ticker = nil
        phase = next
    }

    /// The bar follows the installer's steps and creeps on within one, four times a second.
    private func startMeter(at stage: InstallProgress.Stage = .fetching) {
        meter = InstallProgress()
        meter.enter(stage)
        progress = meter.value()
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard let self, !Task.isCancelled else { return }
                self.progress = max(self.progress, self.meter.value())
            }
        }
    }

    private func append(_ line: String) {
        meter.read(line)
        progress = max(progress, meter.value())
        lines.append(line)
        if lines.count > 400 { lines.removeFirst(lines.count - 400) }
    }
}
