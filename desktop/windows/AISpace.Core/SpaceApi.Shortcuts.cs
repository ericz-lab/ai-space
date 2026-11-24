using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>The Shortcuts page's routes (docs/shortcuts.md#api, src/space/shortcuts/api.ts).</summary>
public sealed partial class SpaceApi
{
    /// <summary><c>GET /api/shortcuts/actions</c>: the catalogue, each action with whether it can run now.</summary>
    public async Task<IReadOnlyList<ShortcutAction>> ShortcutActions(CancellationToken ct = default) =>
        ShortcutJson.Actions(await GetJson<JsonElement>(ShortcutRules.ActionsPath, ct).ConfigureAwait(false));

    /// <summary><c>GET /api/shortcuts/runs?limit</c>: the recent runs, newest first.</summary>
    public async Task<IReadOnlyList<ShortcutRun>> ShortcutRuns(int limit = ShortcutRules.RecentRuns, CancellationToken ct = default) =>
        ShortcutJson.Runs(await GetJson<JsonElement>($"{ShortcutRules.RunsPath}?limit={limit.ToString(CultureInfo.InvariantCulture)}", ct).ConfigureAwait(false));

    /// <summary><c>GET /api/shortcuts/runs/:id</c>: one run, as it stands now.</summary>
    public async Task<ShortcutRun> GetShortcutRun(long id, CancellationToken ct = default) =>
        ShortcutJson.Run(await GetJson<JsonElement>($"{ShortcutRules.RunsPath}/{id.ToString(CultureInfo.InvariantCulture)}", ct).ConfigureAwait(false))
        ?? throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not a run");

    /// <summary><c>POST /api/shortcuts/runs</c> with a body of <see cref="ShortcutRules.RunBody"/>: the run, ended or still running after a few seconds.</summary>
    public async Task<ShortcutRun> StartShortcut(IReadOnlyDictionary<string, object> body, CancellationToken ct = default) =>
        ShortcutJson.Run(await PostJson<JsonElement>(ShortcutRules.RunsPath, body, ct).ConfigureAwait(false))
        ?? throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not a run");

    /// <summary><c>POST /api/shortcuts/resolve</c>: what the typed text can run, read by the Space (nothing runs, no model is called).</summary>
    public async Task<ShortcutResolution> ResolveShortcut(string text, string timezone, CancellationToken ct = default) =>
        ShortcutJson.Resolution(await PostJson<JsonElement>(ShortcutRules.ResolvePath, new Dictionary<string, object> { ["text"] = text, ["timezone"] = timezone }, ct).ConfigureAwait(false));

    /// <summary><c>POST /api/shortcuts/runs/:id/retry</c>: a failed run again (an unknown write only for an idempotent provider).</summary>
    public async Task<ShortcutRun> RetryShortcut(long id, CancellationToken ct = default) =>
        ShortcutJson.Run(await PostJson<JsonElement>($"{ShortcutRules.RunsPath}/{id.ToString(CultureInfo.InvariantCulture)}/retry", new Dictionary<string, object>(), ct).ConfigureAwait(false))
        ?? throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not a run");
}
