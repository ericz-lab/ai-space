using System.Text;
using System.Text.Json;

namespace AISpace.Core;

public enum SpaceApiFailure
{
    /// <summary>The access layer wants a sign-in, or the panel session has expired.</summary>
    AuthenticationRequired,
    Http,
    Network,
    InvalidResponse,
}

public sealed class SpaceApiException(SpaceApiFailure kind, string message, int status = 0) : Exception(message)
{
    public SpaceApiFailure Kind { get; } = kind;
    public int Status { get; } = status;
}

/// <summary>
/// Native calls to one Space's panel routes (the Mac's <c>SpaceAPI</c>). They carry the cookies of
/// the connection's own WebView2 profile, so an access layer the person signed in to on the panel
/// page lets them through; nothing is copied out of a browser and no operator token is used. A
/// redirect is never followed: it means a sign-in is needed. A write names the Space's origin, as
/// the panel's page does, because the routes that change the Space take writes from that origin
/// only (src/space/auth.ts).
/// </summary>
public sealed partial class SpaceApi
{
    private readonly HttpClient _http;
    private readonly Func<Uri, Task<string?>> _cookies;

    public SpaceApi(Uri baseUrl, Func<Uri, Task<string?>> cookies, HttpMessageHandler? handler = null, string? userAgent = null)
    {
        Base = ConnectionRules.Origin(baseUrl);
        _cookies = cookies;
        handler ??= new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(30) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent ?? "ai-space-windows");
    }

    public Uri Base { get; }

    public Uri Url(string path) => new(Base, path);

    public async Task<HttpRequestMessage> Request(HttpMethod method, string path, object? json = null, string accept = "application/json")
    {
        var target = Url(path);
        var r = new HttpRequestMessage(method, target);
        r.Headers.Accept.ParseAdd(accept);
        if (ConnectionRules.SameOrigin(target, Base) && await _cookies(target).ConfigureAwait(false) is { Length: > 0 } cookie)
        {
            r.Headers.TryAddWithoutValidation("Cookie", cookie);
        }
        if (json is not null)
        {
            r.Headers.TryAddWithoutValidation("Origin", ConnectionRules.OriginHeader(Base));
            r.Content = new StringContent(JsonSerializer.Serialize(json, Json), Encoding.UTF8, "application/json");
        }
        return r;
    }

    /// <summary>The bare answer, whatever its status; throws only when nothing answered.</summary>
    public async Task<(int Status, string ContentType, string Body)> Answer(HttpMethod method, string path, object? json = null, CancellationToken ct = default)
    {
        using var r = await Request(method, path, json).ConfigureAwait(false);
        try
        {
            using var response = await _http.SendAsync(r, ct).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return ((int)response.StatusCode, response.Content.Headers.ContentType?.ToString() ?? "", body);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
        }
    }

    public async Task<JsonElement> Get(string path, CancellationToken ct = default)
    {
        var (status, _, body) = await Answer(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
        Check(status, body);
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not the expected JSON", status);
        }
    }

    /// <summary>A file the Space serves (an app's icon), with its sign-in when it is the Space's own.</summary>
    public async Task<byte[]> Bytes(string path, CancellationToken ct = default)
    {
        using var r = await Request(HttpMethod.Get, path, accept: "*/*").ConfigureAwait(false);
        try
        {
            using var response = await _http.SendAsync(r, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new SpaceApiException(SpaceApiFailure.Http, $"HTTP {(int)response.StatusCode}", (int)response.StatusCode);
            return await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
        }
    }

    public async Task<string> Send(HttpMethod method, string path, object json, CancellationToken ct = default)
    {
        var (status, _, body) = await Answer(method, path, json, ct).ConfigureAwait(false);
        Check(status, body);
        return body;
    }

    // Generic JSON calls, for the native pages' own routes. Each area adds its methods in a file of
    // its own (SpaceApi.Home.cs, SpaceApi.Inbox.cs, SpaceApi.Settings.cs) on top of these.

    /// <summary>How the Space's JSON is read and written: camelCase names, case-insensitive on reading, nulls left out.</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// <c>GET</c> a route and read its answer as <typeparamref name="T"/> (with <see cref="Json"/>).
    /// Throws <see cref="SpaceApiException"/>: <see cref="SpaceApiFailure.AuthenticationRequired"/> on a
    /// redirect, 401 or 403, <see cref="SpaceApiFailure.Http"/> with the route's <c>error</c> text,
    /// <see cref="SpaceApiFailure.Network"/> when nothing answered, <see cref="SpaceApiFailure.InvalidResponse"/>
    /// when the body is not that JSON.
    /// </summary>
    public async Task<T> GetJson<T>(string path, CancellationToken ct = default)
    {
        var (status, _, body) = await Answer(HttpMethod.Get, path, null, ct).ConfigureAwait(false);
        Check(status, body);
        return Parse<T>(body, status);
    }

    /// <summary><c>POST</c> <paramref name="body"/> as JSON (with the Space's origin, as the panel's writes) and read the answer as <typeparamref name="T"/>.</summary>
    public Task<T> PostJson<T>(string path, object body, CancellationToken ct = default) => SendJson<T>(HttpMethod.Post, path, body, ct);

    /// <summary>Any method with a JSON body (<c>PUT</c>, <c>PATCH</c>, <c>DELETE</c>, …), its answer read as <typeparamref name="T"/>; <see cref="JsonElement"/> takes any answer.</summary>
    public async Task<T> SendJson<T>(HttpMethod method, string path, object body, CancellationToken ct = default)
    {
        var (status, _, text) = await Answer(method, path, body, ct).ConfigureAwait(false);
        Check(status, text);
        return Parse<T>(text.Length == 0 ? "{}" : text, status);
    }

    /// <summary><c>DELETE</c> a route with no body; the answer's text, which is often empty.</summary>
    public async Task<string> Delete(string path, CancellationToken ct = default)
    {
        var (status, _, body) = await Answer(HttpMethod.Delete, path, null, ct).ConfigureAwait(false);
        Check(status, body);
        return body;
    }

    private static T Parse<T>(string body, int status)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(body, Json) ?? throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "empty JSON", status);
        }
        catch (JsonException)
        {
            throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not the expected JSON", status);
        }
    }

    /// <summary>Maps an answer to an error, as the Mac's <c>SpaceAPI.check</c>.</summary>
    public static void Check(int status, string body)
    {
        if (status is >= 200 and < 300) return;
        if (status is >= 300 and < 400 or 401 or 403) throw new SpaceApiException(SpaceApiFailure.AuthenticationRequired, "sign in required", status);
        var message = $"HTTP {status}";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String && e.GetString() is { Length: > 0 } text) message = text;
        }
        catch (JsonException)
        {
        }
        throw new SpaceApiException(SpaceApiFailure.Http, message, status);
    }

    /// <summary>
    /// <c>GET /api/space</c>, then <c>GET /api/panel/layout</c> with the session's cookies: where the
    /// connection stands, as <see cref="SpaceCheck"/> classifies the answers.
    /// </summary>
    public async Task<SpaceState> CheckSpace(CancellationToken ct = default)
    {
        try
        {
            var (idStatus, _, idBody) = await Answer(HttpMethod.Get, SpaceCheck.IdentityPath, null, ct).ConfigureAwait(false);
            if (SpaceCheck.ClassifyIdentity(idStatus, idBody) is { } refused) return refused;
            var (status, type, body) = await Answer(HttpMethod.Get, SpaceCheck.LayoutPath, null, ct).ConfigureAwait(false);
            return SpaceCheck.ClassifyLayout(status, type, body);
        }
        catch (SpaceApiException e) when (e.Kind == SpaceApiFailure.Network)
        {
            return SpaceState.Unreachable(e.Message);
        }
    }

    /// <summary>One <c>Cookie</c> header from a store's cookies for a URL; null when there are none.</summary>
    public static string? CookieHeader(IEnumerable<(string Name, string Value)> cookies)
    {
        var header = string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}"));
        return header.Length == 0 ? null : header;
    }
}
