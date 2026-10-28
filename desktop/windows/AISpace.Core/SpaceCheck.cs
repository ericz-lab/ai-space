using System.Text.Json;

namespace AISpace.Core;

public enum SpaceStateKind
{
    Connecting,
    Ready,
    AuthenticationRequired,
    Unreachable,
    Incompatible,
}

/// <summary>Where a connection stands (the Mac's <c>SpaceState</c>).</summary>
public sealed record SpaceState(SpaceStateKind Kind, string Detail = "")
{
    public static readonly SpaceState Connecting = new(SpaceStateKind.Connecting);
    public static readonly SpaceState Ready = new(SpaceStateKind.Ready);
    public static readonly SpaceState AuthenticationRequired = new(SpaceStateKind.AuthenticationRequired);
    public static SpaceState Unreachable(string detail) => new(SpaceStateKind.Unreachable, detail);
    public static SpaceState Incompatible(string detail) => new(SpaceStateKind.Incompatible, detail);

    public bool IsFailure => Kind is SpaceStateKind.Unreachable or SpaceStateKind.Incompatible;
}

/// <summary>
/// A reachable port alone is not <c>ready</c>: the Space must say it is ai-space
/// (<c>GET /api/space</c>, public, docs/editions.md#service-identity) and its panel routes must
/// answer this client's session (<c>GET /api/panel/layout</c>), as the Mac's <c>SpaceCheck</c>
/// classifies them. Both answers are read natively with the connection's own web cookies.
/// </summary>
public static class SpaceCheck
{
    public const string IdentityPath = "/api/space";
    public const string LayoutPath = "/api/panel/layout";

    /// <summary>The highest API level of <c>GET /api/space</c> this client speaks (<c>API_LEVEL</c> in src/space/identity.ts).</summary>
    public const int SupportedApi = 1;

    /// <summary><c>GET /api/space</c>: null when this client can talk to the Space, else why not.</summary>
    public static SpaceState? ClassifyIdentity(int status, string body)
    {
        if (status == 404) return SpaceState.Incompatible("no /api/space: an ai-space older than this client, or not an ai-space");
        if (status is 401 or 403 || status is >= 300 and < 400) return SpaceState.AuthenticationRequired;
        if (status is < 200 or >= 300) return SpaceState.Incompatible($"HTTP {status}");
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("product", out var product) || product.ValueKind != JsonValueKind.String || product.GetString() != "ai-space"
                || !root.TryGetProperty("api", out var api) || api.ValueKind != JsonValueKind.Number)
            {
                return SpaceState.Incompatible("not an ai-space response");
            }
            if (api.GetDouble() > SupportedApi) return SpaceState.Incompatible($"this Space speaks API {api.GetDouble()}; update the app");
            return null;
        }
        catch (JsonException)
        {
            return SpaceState.Incompatible("not an ai-space response");
        }
    }

    /// <summary><c>GET /api/panel/layout</c> with the session's cookies: ready, or a sign-in.</summary>
    public static SpaceState ClassifyLayout(int status, string contentType, string body)
    {
        // A redirect away from the API, typically to an access layer's login page.
        if (status == 0 || status is >= 300 and < 400 || status is 401 or 403) return SpaceState.AuthenticationRequired;
        if (status != 200) return SpaceState.Incompatible($"HTTP {status}");
        if (!contentType.Contains("json", StringComparison.OrdinalIgnoreCase)) return SpaceState.Incompatible("not an ai-space response");
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True
                && root.TryGetProperty("layout", out var layout) && layout.ValueKind == JsonValueKind.Object)
            {
                return SpaceState.Ready;
            }
        }
        catch (JsonException)
        {
        }
        return SpaceState.Incompatible("not an ai-space response");
    }

    /// <summary>
    /// A failed navigation by WebView2's <c>CoreWebView2WebErrorStatus</c> name, or null when the
    /// failure is not the connection's fault (a cancelled load: a new navigation, a download).
    /// </summary>
    public static SpaceState? ClassifyNavigationError(string webErrorStatus) => webErrorStatus switch
    {
        "OperationCanceled" => null,
        "ValidAuthenticationCredentialsRequired" or "ValidProxyAuthenticationCredentialsRequired" => SpaceState.AuthenticationRequired,
        _ => SpaceState.Unreachable(webErrorStatus),
    };
}
