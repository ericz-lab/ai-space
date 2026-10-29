using System.Net;
using System.Net.Http.Headers;
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
public sealed class SpaceApi
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
            r.Content = new StringContent(JsonSerializer.Serialize(json), Encoding.UTF8, "application/json");
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

    /// <summary>The answer's <c>Set-Cookie</c> headers as cookies for <paramref name="url"/> (a device sign-in's session).</summary>
    public static List<SetCookie> ResponseCookies(HttpResponseHeaders headers, Uri url, DateTimeOffset? now = null) =>
        headers.TryGetValues("Set-Cookie", out var values) ? values.Select(v => SetCookie.Parse(v, url, now ?? DateTimeOffset.UtcNow)).OfType<SetCookie>().ToList() : [];

    /// <summary>One <c>Cookie</c> header from a store's cookies for a URL; null when there are none.</summary>
    public static string? CookieHeader(IEnumerable<(string Name, string Value)> cookies)
    {
        var header = string.Join("; ", cookies.Select(c => $"{c.Name}={c.Value}"));
        return header.Length == 0 ? null : header;
    }

    public async Task<HttpResponseMessage> Post(Uri url, IReadOnlyDictionary<string, string> headers, CancellationToken ct = default)
    {
        var r = new HttpRequestMessage(HttpMethod.Post, url);
        foreach (var (k, v) in headers) r.Headers.TryAddWithoutValidation(k, v);
        try
        {
            return await _http.SendAsync(r, ct).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
        }
    }
}

/// <summary>
/// One <c>Set-Cookie</c> header (RFC 6265), as far as a cookie store needs it. <c>Max-Age</c> wins
/// over <c>Expires</c>; without either the cookie lasts until the app quits. A cookie for another
/// domain than the answer's host is refused.
/// </summary>
public sealed record SetCookie(string Name, string Value, string Domain, bool HostOnly, string Path, DateTimeOffset? Expires, bool HttpOnly, bool Secure, string? SameSite)
{
    public static SetCookie? Parse(string header, Uri url, DateTimeOffset now)
    {
        var parts = header.Split(';');
        var pair = parts[0];
        var eq = pair.IndexOf('=');
        if (eq <= 0) return null;
        var name = pair[..eq].Trim();
        var value = pair[(eq + 1)..].Trim();
        var host = url.Host.ToLowerInvariant();
        string domain = host, path = "/";
        bool hostOnly = true, httpOnly = false, secure = false;
        string? sameSite = null;
        DateTimeOffset? expires = null, maxAge = null;
        foreach (var raw in parts.Skip(1))
        {
            var a = raw.Trim();
            var i = a.IndexOf('=');
            var key = (i < 0 ? a : a[..i]).Trim().ToLowerInvariant();
            var v = i < 0 ? "" : a[(i + 1)..].Trim();
            switch (key)
            {
                case "expires":
                    if (DateTimeOffset.TryParse(v, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at)) expires = at;
                    break;
                case "max-age":
                    if (long.TryParse(v, out var seconds)) maxAge = seconds <= 0 ? DateTimeOffset.MinValue : now.AddSeconds(Math.Min(seconds, 400L * 24 * 3600));
                    break;
                case "domain":
                    var d = v.TrimStart('.').ToLowerInvariant();
                    if (d.Length == 0) break;
                    if (d != host && !host.EndsWith("." + d, StringComparison.Ordinal)) return null;
                    domain = d;
                    hostOnly = false;
                    break;
                case "path":
                    if (v.StartsWith('/')) path = v;
                    break;
                case "secure":
                    secure = true;
                    break;
                case "httponly":
                    httpOnly = true;
                    break;
                case "samesite":
                    sameSite = v;
                    break;
            }
        }
        return new SetCookie(name, value, domain, hostOnly, path, maxAge ?? expires, httpOnly, secure, sameSite);
    }
}
