using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>A Space answered 401, 403 or a sign-in redirect: the device token is missing, wrong or revoked.</summary>
public sealed class SignInException() : Exception("The Space asks for a sign-in: check the device token in Settings.");

/// <summary>
/// The Space API as this client uses it. It signs in with a device credential (<c>space auth
/// device-add &lt;name&gt;</c>, docs/auth.md#device-credentials) sent as a bearer token, which the
/// Space lets through as its owner; writes name the Space's origin as the panel's pages do.
/// </summary>
public sealed class SpaceClient : IDisposable
{
    readonly HttpClient http;
    public Uri Base { get; }

    public SpaceClient(string address, string? token, HttpMessageHandler? handler = null)
    {
        Base = NormalizeAddress(address);
        http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }) { BaseAddress = Base, Timeout = Timeout.InfiniteTimeSpan };
        if (!string.IsNullOrWhiteSpace(token)) http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Trim());
        http.DefaultRequestHeaders.UserAgent.ParseAdd("AISpaceWindows/0.1");
    }

    /// <summary>
    /// A typed address as a Space URL: https unless the host is this computer (plain http is for
    /// loopback only, as on the other clients), no path, query or credentials.
    /// </summary>
    public static Uri NormalizeAddress(string address)
    {
        var text = address.Trim();
        if (text.Length == 0) throw new FormatException("Type the Space's address.");
        if (!text.Contains("://", StringComparison.Ordinal)) text = (IsLoopbackHost(text.Split('/', ':')[0].Trim('[', ']')) || text.StartsWith('[') ? "http://" : "https://") + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || (uri.Scheme != "http" && uri.Scheme != "https"))
            throw new FormatException("The address should start with https://.");
        if (uri.UserInfo.Length > 0) throw new FormatException("Leave the user name and password out of the address.");
        if (uri.Scheme == "http" && !IsLoopbackHost(uri.IdnHost.Trim('[', ']'))) throw new FormatException("A Space on another computer needs https://.");
        return new Uri($"{uri.Scheme}://{uri.Authority}/");
    }

    static bool IsLoopbackHost(string host) =>
        host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || (IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip));

    HttpRequestMessage Request(HttpMethod method, string path, object? body = null)
    {
        var req = new HttpRequestMessage(method, path.TrimStart('/'));
        req.Headers.Accept.ParseAdd(path.EndsWith("/chat", StringComparison.Ordinal) || path.Contains("/events", StringComparison.Ordinal) ? "text/event-stream" : "application/json");
        if (method != HttpMethod.Get) req.Headers.TryAddWithoutValidation("Origin", Base.GetLeftPart(UriPartial.Authority));
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return req;
    }

    static void Check(HttpResponseMessage res)
    {
        var code = (int)res.StatusCode;
        if (code is 401 or 403 || (code is >= 300 and < 400)) throw new SignInException();
        if (!res.IsSuccessStatusCode) throw new HttpRequestException($"The Space answered {code} {res.ReasonPhrase}.");
    }

    public async Task<string> GetText(string path, CancellationToken ct = default)
    {
        using var res = await http.SendAsync(Request(HttpMethod.Get, path), ct);
        Check(res);
        return await res.Content.ReadAsStringAsync(ct);
    }

    public async Task<byte[]> GetBytes(string pathOrUrl, CancellationToken ct = default)
    {
        using var res = await http.SendAsync(Request(HttpMethod.Get, pathOrUrl), ct);
        Check(res);
        return await res.Content.ReadAsByteArrayAsync(ct);
    }

    public async Task Post(string path, object body, CancellationToken ct = default)
    {
        using var res = await http.SendAsync(Request(HttpMethod.Post, path, body), ct);
        Check(res);
    }

    public async Task<Catalogue> LoadCatalogue(CancellationToken ct = default)
    {
        var apps = GetText("/api/apps", ct);
        var agents = GetText("/api/agents", ct);
        return Catalogue.Decode(await apps, await agents);
    }

    /// <summary>
    /// Sends a message and yields the run's events (<c>data:</c> lines) as they come. A turn is a
    /// background run on the Space, so a dropped stream does not stop it; <c>onRun</c> gets the
    /// run's id from <c>x-run-id</c>, for Stop and the approvals.
    /// </summary>
    public async IAsyncEnumerable<string> Chat(AgentInfo agent, Dictionary<string, object> body, Action<string> onRun, [EnumeratorCancellation] CancellationToken ct = default)
    {
        using var res = await http.SendAsync(Request(HttpMethod.Post, agent.Base + "/chat", body), HttpCompletionOption.ResponseHeadersRead, ct);
        Check(res);
        if (res.Headers.TryGetValues("x-run-id", out var ids) && ids.FirstOrDefault() is { } run) onRun(run);
        using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var parser = new SseParser();
        while (await reader.ReadLineAsync(ct) is { } line)
            if (parser.Feed(line) is { } message) yield return message.Data;
    }

    public Task Stop(AgentInfo agent, string runId) => Post($"{agent.Base}/runs/{Uri.EscapeDataString(runId)}/stop", new { });

    public Task Answer(AgentInfo agent, string runId, string requestId, bool allow) =>
        Post($"{agent.Base}/runs/{Uri.EscapeDataString(runId)}/approvals/{Uri.EscapeDataString(requestId)}", new { decision = allow ? "allow" : "deny" });

    public void Dispose() => http.Dispose();
}
