import Foundation

/// The Space's own settings as the Settings tab shows them, read with the Space's session.
/// Nothing is kept: they are a claim about now, asked again each time the tab comes up.
@MainActor
final class SettingsLoader: ObservableObject {
    @Published private(set) var settings: SpaceSettings?
    @Published private(set) var isLoading = false
    @Published private(set) var isSaving = false
    /// Why the last change was not taken, until the next one is.
    @Published private(set) var saveError: String?
    private let api: SpaceAPI

    init(api: SpaceAPI) {
        self.api = api
    }

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        async let services = try? api.data("/api/services")
        async let backups = try? api.data("/api/backups")
        async let models = try? api.data("/api/model/preferences")
        let (s, b, m) = (await services, await backups, await models)
        isLoading = false
        // No route answered (signed out, offline): what was shown is no longer known.
        settings = s == nil && b == nil && m == nil ? nil : SpaceSettings.decode(services: s, backups: b, models: m)
    }

    /// Sets the Space's default model, or returns it to the environment's defaults with nil.
    /// This changes the Space for every client, as the same menu on the panel does.
    func setDefaultModel(_ value: String?) async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let answer = try await api.send("PUT", "/api/model/preferences", json: ["defaultModel": value ?? NSNull()])
            if let fresh = try? JSONDecoder().decode(ModelPreferences.self, from: answer) { settings?.models = fresh }
            saveError = nil
        } catch {
            saveError = (error as? SpaceAPIError).map { String(describing: $0) } ?? error.localizedDescription
        }
    }

    func forget() {
        saveError = nil
        settings = nil
    }
}
