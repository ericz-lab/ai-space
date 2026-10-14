import Foundation

/// One shell on one machine, over the Space's terminal routes (docs/terminal.md): a request for a
/// one-time ticket, then a socket. Binary frames are bytes each way; text frames are the Space's
/// control messages and this side's resizes. A socket that drops is not picked up again: the
/// Space hangs the shell up when its client leaves.
@MainActor
final class TerminalSession: ObservableObject {
    enum State: Equatable { case connecting, open, closed }

    let machine: TerminalMachine
    @Published private(set) var state = State.connecting
    /// Bytes from the shell, and the lines this side writes about the session.
    var onOutput: (ArraySlice<UInt8>) -> Void = { _ in }
    /// The machine asked for its passphrase, or refused the one given.
    var onPassphrase: (String) -> Void = { _ in }
    var onClosed: () -> Void = {}

    private let api: SpaceAPI
    private var task: URLSessionWebSocketTask?
    private var reader: Task<Void, Never>?
    private var size: (cols: Int, rows: Int)?
    private var started = false

    init(api: SpaceAPI, machine: TerminalMachine) {
        self.api = api
        self.machine = machine
    }

    /// Opens the shell at this window size. Once: a session that ended stays ended.
    func start(cols: Int, rows: Int, passphrase: String?) {
        guard !started else { return }
        started = true
        size = (cols, rows)
        reader = Task { [weak self] in await self?.run(passphrase: passphrase) }
    }

    func send(_ bytes: ArraySlice<UInt8>) {
        guard state == .open, let task else { return }
        task.send(.data(Data(bytes))) { _ in }
    }

    func resize(cols: Int, rows: Int) {
        guard size?.cols != cols || size?.rows != rows else { return }
        size = (cols, rows)
        guard state == .open, let task else { return }
        task.send(.string(TerminalRoute.resize(cols: cols, rows: rows))) { _ in }
    }

    /// Leaves the session; the Space hangs the shell up.
    func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        reader?.cancel()
        finish()
    }

    private func run(passphrase: String?) async {
        let size = self.size ?? (80, 24)
        let ticket: String
        do {
            let headers = passphrase.map { [TerminalRoute.passphraseHeader: $0] } ?? [:]
            let answer = try await api.answer("POST", TerminalRoute.sessions(machine), json: ["cols": size.0, "rows": size.1], headers: headers)
            switch TerminalTicket.read(status: answer.status, data: answer.data) {
            case .ticket(let t): ticket = t
            case .passphrase(let message):
                onPassphrase(message)
                return fail(message)
            case .signIn: return fail(HubStore.message(SpaceAPIError.authenticationRequired))
            case .refused(let message): return fail(message)
            }
        } catch {
            return fail(HubStore.message(error))
        }
        guard !Task.isCancelled, state == .connecting, let url = TerminalRoute.socket(machine, ticket: ticket, space: api.base) else { return finish() }
        let task = await api.socket(url)
        self.task = task
        task.resume()
        // The first frame is the Space's `ready`; until it comes the socket may still be refused.
        var opened = false
        while !Task.isCancelled {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await task.receive()
            } catch {
                if state != .closed { ended(task, opened: opened, error: error) }
                return
            }
            if !opened {
                opened = true
                state = .open
                // The window may have changed while the ticket was on its way.
                if let now = self.size { task.send(.string(TerminalRoute.resize(cols: now.cols, rows: now.rows))) { _ in } }
            }
            switch message {
            case .data(let data): onOutput(ArraySlice(data))
            case .string(let text): control(text)
            @unknown default: break
            }
        }
    }

    private func control(_ text: String) {
        switch TerminalControl.read(text) {
        case .exit(let code, let detail):
            let how = code.map { String(localized: "shell exited with code \($0)") } ?? String(localized: "shell ended by a signal")
            write(TerminalNotice.dim(how) + (detail.map(TerminalNotice.red) ?? ""))
        case .error(let message): write(TerminalNotice.red(message))
        case .closed(let reason):
            switch reason {
            case "idle": write(TerminalNotice.dim(String(localized: "closed: no input for the idle limit")))
            case "killed": write(TerminalNotice.dim(String(localized: "closed from another panel")))
            case "shutdown": write(TerminalNotice.dim(String(localized: "closed: ai-space stopped")))
            default: write(TerminalNotice.dim(String(localized: "closed")))
            }
        case .ready, nil: break
        }
    }

    /// The socket is gone: say why when the Space did not already.
    private func ended(_ task: URLSessionWebSocketTask, opened: Bool, error: Error) {
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        if task.closeCode == .invalid {
            write(opened ? TerminalNotice.dim(String(localized: "connection lost")) : TerminalNotice.red(error.localizedDescription))
        } else if task.closeCode != .normalClosure, !reason.isEmpty, !TerminalNotice.knownReasons.contains(reason) {
            write(TerminalNotice.dim(reason))
        }
        finish()
    }

    private func fail(_ message: String) {
        write(TerminalNotice.red(message))
        finish()
    }

    private func finish() {
        guard state != .closed else { return }
        state = .closed
        task = nil
        onClosed()
    }

    private func write(_ text: String) {
        onOutput(ArraySlice(Array(text.utf8)))
    }
}
