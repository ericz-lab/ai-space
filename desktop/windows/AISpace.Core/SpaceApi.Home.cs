using System.Text.Json;

namespace AISpace.Core;

/// <summary>Home's routes: the catalogue with the widgets' state, read the way the Linux and Mac clients read it.</summary>
public sealed partial class SpaceApi
{
    public const string AppsPath = "/api/apps", AgentsPath = "/api/agents", WidgetsPath = "/api/widgets", PeersPath = "/api/peers";

    /// <summary>
    /// <c>GET /api/apps</c> and <c>/api/agents</c> (which must answer), with <c>/api/widgets</c>,
    /// <c>/api/peers</c> and <c>/api/panel/layout</c> (which a Space may lack: Home goes on without
    /// them), all at once, as one <see cref="HomeCatalogue"/>.
    /// </summary>
    public async Task<HomeCatalogue> GetHome(CancellationToken ct = default)
    {
        var apps = Get(AppsPath, ct);
        var agents = Get(AgentsPath, ct);
        var widgets = Optional(WidgetsPath, ct);
        var peers = Optional(PeersPath, ct);
        var layout = Optional(SpaceCheck.LayoutPath, ct);
        await Task.WhenAll(apps, agents, widgets, peers, layout).ConfigureAwait(false);
        return HomeCatalogue.Decode(await apps.ConfigureAwait(false), await agents.ConfigureAwait(false), await widgets.ConfigureAwait(false), await peers.ConfigureAwait(false), await layout.ConfigureAwait(false));
    }

    public const string CatalogPath = "/api/app-catalog";

    /// <summary>
    /// How many apps the App Store offers a Space that has none of them yet
    /// (<see cref="HomeCatalogue.CatalogOffers"/>); 0 from a Space without the route.
    /// </summary>
    public async Task<int> CatalogOffers(CancellationToken ct = default) =>
        await Optional(CatalogPath, ct).ConfigureAwait(false) is { } catalog ? HomeCatalogue.CatalogOffers(catalog) : 0;

    private async Task<JsonElement?> Optional(string path, CancellationToken ct)
    {
        try
        {
            return await Get(path, ct).ConfigureAwait(false);
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
        {
            return null;
        }
    }
}
