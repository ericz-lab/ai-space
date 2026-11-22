using System.Text.Json.Nodes;

namespace AISpace.Core;

/// <summary>
/// The routes of the Space's Settings page: the same the web panel's Settings reads and writes
/// (src/web/SettingsStatus.tsx, AppModels.tsx, Tasks.tsx, Events.tsx, Usage.tsx, Activity.tsx,
/// Packages.tsx, Auth.tsx), with this app's sign-in. The only writes are the ones the person makes
/// on the page: the default model, an app's model, starting or stopping a service, re-checking the
/// agent CLIs, Fix this' settings, the password and the sessions.
/// </summary>
public sealed partial class SpaceApi
{
    private async Task<System.Text.Json.JsonElement> Read(string path, CancellationToken ct) => SettingsJson.Ok(await Get(path, ct).ConfigureAwait(false));

    public async Task<SpaceIdentity> Identity(CancellationToken ct = default) => SettingsJson.Identity(await Get("/api/space", ct).ConfigureAwait(false));

    public async Task<ServicesView> Services(CancellationToken ct = default) => SettingsJson.Services(await Read("/api/services", ct).ConfigureAwait(false));

    public async Task<BackupsView> Backups(CancellationToken ct = default) => SettingsJson.Backups(await Read("/api/backups", ct).ConfigureAwait(false));

    public async Task<ModelStatusView> ModelStatus(CancellationToken ct = default) => SettingsJson.ModelStatus(await Read("/api/model/status", ct).ConfigureAwait(false));

    /// <summary><c>GET /api/speech</c>; null from a Space that has no such route (an older one), as the panel leaves the group out then.</summary>
    public async Task<SpeechView?> Speech(CancellationToken ct = default)
    {
        try
        {
            return SettingsJson.Speech(await Read("/api/speech", ct).ConfigureAwait(false));
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
        {
            return null;
        }
    }

    /// <summary><c>POST /api/apps/:app/service</c>: start, stop or restart a unit the Space runs (docs/supervision.md).</summary>
    public Task<string> ControlService(string app, string action, CancellationToken ct = default) =>
        Send(HttpMethod.Post, $"/api/apps/{SpacePath.Escape(app)}/service", new JsonObject { ["action"] = action }, ct);

    public async Task<ModelPreferences> DefaultModel(CancellationToken ct = default) => SettingsJson.Preferences(await Read("/api/model/preferences", ct).ConfigureAwait(false));

    /// <summary><c>PUT /api/model/preferences</c>: the Space's default model, <c>null</c> for the environment's defaults. Answers the preferences as they now are.</summary>
    public async Task<ModelPreferences> SetDefaultModel(string? value, CancellationToken ct = default)
    {
        var body = await Send(HttpMethod.Put, "/api/model/preferences", new JsonObject { ["defaultModel"] = string.IsNullOrEmpty(value) ? null : value }, ct).ConfigureAwait(false);
        return SettingsJson.Preferences(SettingsJson.Ok(ParseBody(body)));
    }

    public async Task<AppModelsView> AppModelList(CancellationToken ct = default) => SettingsJson.AppModelList(await Read("/api/model/apps", ct).ConfigureAwait(false));

    /// <summary>
    /// <c>PATCH /api/panel/apps/:app/model</c>: the panel's override for the whole app (<paramref name="tag"/>
    /// null) or one purpose, <c>null</c> to drop it. Answers the app's rows again, each with the layer
    /// that now decides it.
    /// </summary>
    public async Task<AppModels?> SetAppModel(string app, string? tag, string? model, CancellationToken ct = default)
    {
        var json = new JsonObject();
        if (tag is not null) json["tag"] = tag;
        json["model"] = string.IsNullOrEmpty(model) ? null : model;
        var body = await Send(HttpMethod.Patch, $"/api/panel/apps/{SpacePath.Escape(app)}/model", json, ct).ConfigureAwait(false);
        return SettingsJson.AppModelsOf(SettingsJson.Ok(ParseBody(body)));
    }

    public async Task<IReadOnlyList<MachineClis>> Inventory(CancellationToken ct = default) => SettingsJson.Inventory(await Read("/api/model/inventory", ct).ConfigureAwait(false));

    /// <summary><c>POST /api/model/status/probe</c>: look at every machine's agent CLIs again; answers the inventory.</summary>
    public async Task<IReadOnlyList<MachineClis>> Recheck(CancellationToken ct = default) =>
        SettingsJson.Inventory(SettingsJson.Ok(ParseBody(await Send(HttpMethod.Post, "/api/model/status/probe", new JsonObject(), ct).ConfigureAwait(false))));

    public async Task<IReadOnlyList<TaskRow>> Tasks(CancellationToken ct = default) => SettingsJson.Tasks(await Read("/api/tasks", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<TaskRun>> TaskRuns(string id, int limit = 20, CancellationToken ct = default) =>
        SettingsJson.Runs(await Read($"/api/tasks/{SpacePath.Escape(id)}/runs?limit={limit}", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<EventRow>> Events(int limit = 100, CancellationToken ct = default) => SettingsJson.Events(await Read($"/api/events?limit={limit}", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<DeliveryRow>> Deliveries(long id, CancellationToken ct = default) => SettingsJson.Deliveries(await Read($"/api/events/{id}", ct).ConfigureAwait(false));

    /// <summary><c>GET /api/capabilities</c>; empty where the bus has no catalogue route, as Events.tsx reads it.</summary>
    public async Task<IReadOnlyList<CapabilityApp>> Capabilities(CancellationToken ct = default)
    {
        try
        {
            return SettingsJson.Capabilities(await Read("/api/capabilities", ct).ConfigureAwait(false));
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
        {
            return [];
        }
    }

    public async Task<UsageReport> Usage(string window, CancellationToken ct = default) => SettingsJson.Usage(await Read($"/api/model/usage?window={Uri.EscapeDataString(window)}", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<ModelCall>> Calls(int limit = 30, CancellationToken ct = default) => SettingsJson.Calls(await Read($"/api/model/calls?limit={limit}", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<ActivityRow>> Activity(string window, string kind, CancellationToken ct = default) =>
        SettingsJson.Activity(await Read($"/api/usage?window={Uri.EscapeDataString(window)}{(kind == "all" ? "" : "&kind=" + Uri.EscapeDataString(kind))}", ct).ConfigureAwait(false));

    /// <summary><c>GET /api/usage/devices</c>; null when it fails, which must not hide the apps' figures (Activity.tsx).</summary>
    public async Task<IReadOnlyList<DeviceRow>?> Devices(string window, CancellationToken ct = default)
    {
        try
        {
            return SettingsJson.Devices(await Read($"/api/usage/devices?window={Uri.EscapeDataString(window)}", ct).ConfigureAwait(false));
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
        {
            return null;
        }
    }

    public async Task<PackageCatalogue> Packages(CancellationToken ct = default) => SettingsJson.Packages(await Read("/api/panel/package-catalogue", ct).ConfigureAwait(false));

    public const string FixThisPath = "/api/panel/feedback/settings";

    /// <summary><c>GET /api/panel/feedback/settings</c>: Fix this' settings, as the web panel's Settings reads them.</summary>
    public async Task<FixThisView> FixThis(CancellationToken ct = default) => SettingsJson.FixThis(await Read(FixThisPath, ct).ConfigureAwait(false));

    /// <summary>
    /// <c>PUT /api/panel/feedback/settings</c> with one field (<c>enabled</c>, <c>appsDefault</c>,
    /// <c>errors</c>): the patch the web panel sends. Answers the settings as they now are.
    /// </summary>
    public Task<FixThisView> SetFixThis(string field, bool value, CancellationToken ct = default) => PatchFixThis(new JsonObject { [field] = value }, ct);

    /// <summary>The same for <c>mode</c> (<c>auto</c>, <c>later</c>), <c>machine</c> ("" this machine), <c>model</c> ("" the machine's default) and <c>effort</c>.</summary>
    public Task<FixThisView> SetFixThis(string field, string value, CancellationToken ct = default) => PatchFixThis(new JsonObject { [field] = value }, ct);

    /// <summary>One app's own switch: <c>default</c>, <c>on</c> or <c>off</c>.</summary>
    public Task<FixThisView> SetFixThisApp(string app, string value, CancellationToken ct = default) =>
        PatchFixThis(new JsonObject { ["apps"] = new JsonObject { [app] = value } }, ct);

    private async Task<FixThisView> PatchFixThis(JsonObject patch, CancellationToken ct) =>
        SettingsJson.FixThis(SettingsJson.Ok(ParseBody(await Send(HttpMethod.Put, FixThisPath, patch, ct).ConfigureAwait(false))));

    /// <summary><c>POST /api/panel/feedback/fix</c> with nothing named: hands every waiting request to the Fix Engineer; how many.</summary>
    public async Task<int> FixWaiting(CancellationToken ct = default)
    {
        var answer = SettingsJson.Ok(ParseBody(await Send(HttpMethod.Post, "/api/panel/feedback/fix", new JsonObject(), ct).ConfigureAwait(false)));
        return answer.ValueKind == System.Text.Json.JsonValueKind.Object && answer.TryGetProperty("queued", out var n) && n.ValueKind == System.Text.Json.JsonValueKind.Number && n.TryGetInt32(out var queued) ? queued : 0;
    }

    public async Task<AuthState> AuthSession(CancellationToken ct = default) => SettingsJson.Auth(await Read("/api/auth/session", ct).ConfigureAwait(false));

    public async Task<IReadOnlyList<AuthSessionRow>> AuthSessions(CancellationToken ct = default) => SettingsJson.Sessions(await Read("/api/auth/sessions", ct).ConfigureAwait(false));

    /// <summary><c>DELETE /api/auth/sessions/:id</c>: signs that session out (with the Space's origin, as the panel's writes).</summary>
    public Task<string> RevokeSession(string id, CancellationToken ct = default) => Send(HttpMethod.Delete, $"/api/auth/sessions/{SpacePath.Escape(id)}", new JsonObject(), ct);

    /// <summary><c>POST /api/auth/password</c>, read by <see cref="SettingsRules.Password"/>: its 401 and 403 are answers, not a sign-in.</summary>
    public async Task<(PasswordOutcome Outcome, string Message)> ChangePassword(string current, string next, CancellationToken ct = default)
    {
        var (status, _, body) = await Answer(HttpMethod.Post, "/api/auth/password", new JsonObject { ["current"] = current, ["next"] = next }, ct).ConfigureAwait(false);
        return SettingsRules.Password(status, body);
    }

    /// <summary><c>POST /api/auth/logout</c>: ends this app's session on the Space.</summary>
    public Task<string> SignOutOfSpace(CancellationToken ct = default) => Send(HttpMethod.Post, "/api/auth/logout", new JsonObject(), ct);

    private static System.Text.Json.JsonElement ParseBody(string body)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(body.Length == 0 ? "{}" : body);
            return doc.RootElement.Clone();
        }
        catch (System.Text.Json.JsonException)
        {
            throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not the expected JSON");
        }
    }
}
