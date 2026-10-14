import Foundation

/// The Space's terminal on this phone: where a shell can open, the sessions open here with
/// their tabs, and the passphrases typed for them. Kept while the app runs, so leaving the page
/// keeps the sessions and their scrollback; nothing of it is written down.
@MainActor
final class TerminalStore: HubStore {
    /// A machine waiting for its passphrase, with what the Space said about the last one.
    struct Ask: Identifiable {
        let machine: TerminalMachine
        var message: String?
        var id: String { machine.id }
    }

    @Published private(set) var status: TerminalStatus?
    @Published private(set) var tabs: [TerminalTab] = []
    @Published var current: UUID?
    @Published var asking: Ask?
    /// What is being typed for it; view state lives here, as on the other pages (no `@State`).
    @Published var passphraseDraft = ""
    @Published var showingRecent = false
    var openLink: (URL) -> Void = { _ in }

    /// By machine, in memory only, as the panel's page keeps it for a page load.
    private var passphrases: [String: String] = [:]
    private var counters: [String: Int] = [:]

    var machines: [TerminalMachine] { status?.machines ?? [] }
    var currentTab: TerminalTab? { tabs.first { $0.id == current } }

    override func load() async throws {
        status = try await api.get(TerminalRoute.status, as: TerminalStatus.self)
    }

    /// A new shell on that machine, after its passphrase when the Space says it wants one.
    func open(on machine: TerminalMachine) {
        if machine.peer == nil, status?.passphrase == true, passphrases[machine.id] == nil {
            asking = Ask(machine: machine)
            return
        }
        counters[machine.id, default: 0] += 1
        let session = TerminalSession(api: api, machine: machine)
        let tab = TerminalTab(title: "\(machine.name) #\(counters[machine.id] ?? 1)", session: session,
                              passphrase: passphrases[machine.id], openLink: openLink)
        session.onPassphrase = { [weak self, weak tab] message in
            guard let self else { return }
            self.passphrases[machine.id] = nil
            // The tab never had a shell; the next try is a new one.
            if let tab { self.remove(tab) }
            self.asking = Ask(machine: machine, message: message)
        }
        session.onClosed = { [weak self] in Task { await self?.refresh() } }
        tabs.append(tab)
        current = tab.id
    }

    func submit(for machine: TerminalMachine) {
        let passphrase = passphraseDraft
        passphraseDraft = ""
        asking = nil
        guard !passphrase.isEmpty else { return }
        passphrases[machine.id] = passphrase
        open(on: machine)
    }

    /// Closes the tab; its shell is hung up by the Space.
    func close(_ tab: TerminalTab) {
        tab.session.close()
        remove(tab)
    }

    /// Every session of this Space ends: it was signed out of, or removed.
    func closeAll() {
        for tab in tabs { tab.session.close() }
        tabs = []
        current = nil
        passphrases = [:]
        asking = nil
    }

    private func remove(_ tab: TerminalTab) {
        guard let i = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        tabs.remove(at: i)
        if current == tab.id { current = tabs.indices.contains(i) ? tabs[i].id : tabs.last?.id }
    }
}
