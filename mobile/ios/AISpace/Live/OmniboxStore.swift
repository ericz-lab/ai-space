import Foundation
import Combine

/// Kept per Space by AppModel; closing a sheet does not abandon an accepted execution.
@MainActor
final class OmniboxStore: ObservableObject {
    let api: SpaceAPI
    @Published private(set) var resolution: ShortcutResolution?
    @Published private(set) var resolvedText = ""
    @Published private(set) var resolving = false
    @Published private(set) var preview: ShortcutResult?
    @Published private(set) var runs: [ShortcutRun] = []
    @Published var error: String?
    private let send: (String, [String: Any]) async throws -> Data
    private var generation = 0
    private var previews: [String: (Date, ShortcutResult)] = [:]
    init(api: SpaceAPI, send: ((String, [String: Any]) async throws -> Data)? = nil) {
        self.api = api
        self.send = send ?? { path, body in try await api.send("POST", path, json: body) }
    }

    func clear() {
        generation += 1
        resolution = nil; resolvedText = ""; preview = nil; runs = []; error = nil; resolving = false
        previews.removeAll()
    }

    func resolve(_ text: String) async {
        generation += 1
        let generation = generation
        resolution = nil; preview = nil; resolvedText = ""; error = nil
        resolving = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        guard resolving else { return }
        defer { if generation == self.generation { resolving = false } }
        do {
            try await Task.sleep(nanoseconds: 180_000_000)
            let data = try await send("/api/shortcuts/resolve", ["text": text, "timezone": TimeZone.current.identifier])
            let result = try Hub.decode(ShortcutResolution.self, from: data)
            guard !Task.isCancelled, generation == self.generation else { return }
            resolution = result; resolvedText = text
            guard let intent = result.intents.first, intent.kind == "calc" || intent.kind == "convert" else { return }
            if let cached = previews[text], Date().timeIntervalSince(cached.0) < 60 { preview = cached.1; return }
            let action = intent.action
            var body: [String: Any] = ["action": action?.id ?? "space/calc", "timezone": TimeZone.current.identifier]
            if intent.kind == "calc" { body["args"] = ["expression": intent.expression ?? text] }
            else if let action { body["args"] = action.payload(action.initial(intent.args ?? [:])) }
            if let peer = action?.peer { body["peer"] = peer }
            struct Answer: Decodable { var result: ShortcutResult }
            let answer = try Hub.decode(Answer.self, from: try await send("/api/shortcuts/preview", body))
            guard !Task.isCancelled, generation == self.generation else { return }
            preview = answer.result
            if previews.count >= 64 { previews.removeAll() }
            previews[text] = (Date(), answer.result)
        } catch {
            if !Task.isCancelled, generation == self.generation { self.error = HubStore.message(error) }
        }
    }

    func refreshRuns() async {
        let generation = generation
        do {
            let fresh = try Hub.rows(ShortcutRun.self, "runs", from: try await api.data("/api/shortcuts/runs?limit=20"))
            guard !Task.isCancelled, generation == self.generation else { return }
            runs = fresh
        } catch { if !Task.isCancelled, generation == self.generation { self.error = HubStore.message(error) } }
    }
}

@MainActor
final class ShortcutExecution: ObservableObject {
    let api: SpaceAPI
    let action: ShortcutAction?
    let timezone = TimeZone.current.identifier
    @Published var values: [String: String]
    @Published private(set) var run: ShortcutRun?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private let send: (String, [String: Any]) async throws -> Data
    private let requestID = UUID().uuidString
    private var submittedBody: [String: Any]?
    private var work: Task<Void, Never>?

    init(api: SpaceAPI, action: ShortcutAction?, args: [String: JSONValue] = [:], run: ShortcutRun? = nil, send: ((String, [String: Any]) async throws -> Data)? = nil) {
        self.api = api; self.action = action; self.values = action?.initial(args) ?? [:]; self.run = run
        self.send = send ?? { path, body in try await api.send("POST", path, json: body) }
    }
    var canSubmit: Bool { !busy && run == nil && action?.available == true && action?.valid(values) == true }
    var canRetry: Bool {
        guard let run, !busy, run.effect != "run" else { return false }
        return run.status == "error" || (run.status == "unknown" && action?.idempotent == true)
    }
    /// Retain the exact body and request ID after transport failure: Retry cannot duplicate a write.
    func submit() {
        guard canSubmit, let action else { return }
        if submittedBody == nil {
            var body: [String: Any] = ["action": action.id, "args": action.payload(values), "timezone": timezone, "requestId": requestID]
            if let peer = action.peer { body["peer"] = peer }
            submittedBody = body
        }
        perform(path: "/api/shortcuts/runs", body: submittedBody!)
    }
    var hasSubmitted: Bool { submittedBody != nil }
    func retry() {
        guard canRetry, let run else { return }
        perform(path: "/api/shortcuts/runs/\(run.id)/retry", body: [:])
    }
    private func perform(path: String, body: [String: Any]) {
        busy = true; error = nil
        work = Task {
            defer { busy = false }
            do {
                struct Answer: Decodable { var run: ShortcutRun }
                run = try Hub.decode(Answer.self, from: try await send(path, body)).run
                await follow()
            } catch {
                // A rejected input did not create a run; allow correcting the form.
                if case SpaceAPIError.http(400, _) = error, run == nil { submittedBody = nil }
                self.error = HubStore.message(error)
            }
        }
    }
    func follow() async {
        do {
            while let current = run, current.status == "running", !Task.isCancelled {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                struct Answer: Decodable { var run: ShortcutRun }
                run = try await api.get("/api/shortcuts/runs/\(current.id)", as: Answer.self).run
            }
        } catch { if !Task.isCancelled { self.error = HubStore.message(error) } }
    }
}
