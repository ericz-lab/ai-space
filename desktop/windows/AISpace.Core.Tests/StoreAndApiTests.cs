using System.Net;
using System.Text;
using AISpace.Core;

namespace AISpace.Core.Tests;

public sealed class TempDir : IDisposable
{
    public string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "aispace-tests-" + Guid.NewGuid().ToString("N"));

    public TempDir() => Directory.CreateDirectory(Path);

    public string File(string name) => System.IO.Path.Combine(Path, name);

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}

public class ConnectionStoreTests
{
    [Fact]
    public void TheFirstConnectionIsTheDefaultAndOneStaysDefault()
    {
        using var dir = new TempDir();
        var store = new ConnectionStore(dir.File("connections.json"));
        var a = store.Add("", new Uri("http://127.0.0.1:8700/"));
        var b = store.Add("Hub", new Uri("https://space.example.com/"));
        Assert.True(a.IsDefault);
        Assert.Equal("127.0.0.1", a.Name);
        Assert.Equal(a.Id, store.Default?.Id);
        store.SetDefault(b.Id);
        Assert.Equal(b.Id, store.Default?.Id);
        store.Remove(b.Id);
        Assert.Equal(a.Id, store.Default?.Id);
        Assert.True(store.Get(a.Id)!.IsDefault);

        var again = new ConnectionStore(dir.File("connections.json"));
        Assert.Single(again.Connections);
        Assert.Equal(a.Id, again.Default?.Id);
    }

    [Fact]
    public void MovingTheAddressDropsTheLocalMark()
    {
        using var dir = new TempDir();
        var store = new ConnectionStore(dir.File("connections.json"));
        var c = store.Add("This computer", new Uri("http://127.0.0.1:8700/"), managed: true);
        Assert.False(store.Update(c.Id, "Renamed", new Uri("http://127.0.0.1:8700/")));
        Assert.True(store.Get(c.Id)!.Managed);
        Assert.True(store.Update(c.Id, "Elsewhere", new Uri("https://space.example.com/")));
        Assert.False(store.Get(c.Id)!.Managed);
    }

    [Fact]
    public void AnUnreadableFileIsSetAsideNotOverwritten()
    {
        using var dir = new TempDir();
        File.WriteAllText(dir.File("connections.json"), "{ not json");
        var store = new ConnectionStore(dir.File("connections.json"));
        Assert.Empty(store.Connections);
        Assert.Equal(dir.File("connections.unreadable.json"), store.LoadError);
        Assert.Equal("{ not json", File.ReadAllText(dir.File("connections.unreadable.json")));
    }

    [Fact]
    public void AConnectionSavedBeforeTheLocalEditionIsNotManaged()
    {
        var list = ConnectionStore.Decode("""[{"id":"6F1C1B7E-3C39-4D55-9D1E-0C5C2A6B8F10","name":"Home","url":"http://127.0.0.1:8700/","isDefault":true}]""");
        Assert.False(list[0].Managed);
        Assert.Throws<System.Text.Json.JsonException>(() => ConnectionStore.Decode("""[{"name":"x"}]"""));
    }

    [Fact]
    public void TheLocalEditionClaimsTheSpaceSavedAtItsAddress()
    {
        var mine = new Connection { Name = "Here", Url = "http://127.0.0.1:8700/" };
        var hub = new Connection { Name = "Hub", Url = "https://space.example.com/" };
        Assert.Equal(mine.Id, ConnectionStore.LocalToClaim([hub, mine], "managed", "http://127.0.0.1:8700/"));
        Assert.Null(ConnectionStore.LocalToClaim([hub, mine], "foreign", "http://127.0.0.1:8700/"));
        mine.Managed = true;
        Assert.Null(ConnectionStore.LocalToClaim([hub, mine], "managed", "http://127.0.0.1:8700/"));
    }
}

/// <summary>Answers requests from a script and records what was asked.</summary>
public sealed class ScriptedHandler(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
{
    public List<HttpRequestMessage> Requests { get; } = [];
    public List<string?> Bodies { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        Bodies.Add(request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken));
        return answer(request);
    }

    public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
}

public class SpaceApiTests
{
    private static readonly Uri Base = new("https://space.example.com/panel/");

    [Fact]
    public void ResponsesMapToErrors()
    {
        SpaceApi.Check(200, "");
        Assert.Equal(SpaceApiFailure.AuthenticationRequired, Assert.Throws<SpaceApiException>(() => SpaceApi.Check(302, "")).Kind);
        Assert.Equal(SpaceApiFailure.AuthenticationRequired, Assert.Throws<SpaceApiException>(() => SpaceApi.Check(403, "")).Kind);
        var e = Assert.Throws<SpaceApiException>(() => SpaceApi.Check(400, """{"ok":false,"error":"bad agent"}"""));
        Assert.Equal((SpaceApiFailure.Http, 400, "bad agent"), (e.Kind, e.Status, e.Message));
        Assert.Equal("HTTP 500", Assert.Throws<SpaceApiException>(() => SpaceApi.Check(500, "<html>")).Message);
    }

    [Fact]
    public async Task ReadsCarryTheSessionAndWritesNameTheOrigin()
    {
        var handler = new ScriptedHandler(_ => ScriptedHandler.Json("""{"ok":true}"""));
        var asked = new List<Uri>();
        var api = new SpaceApi(Base, u => { asked.Add(u); return Task.FromResult<string?>("CF_Authorization=a; space_session=b"); }, handler);
        await api.Get("/api/apps");
        await api.Send(HttpMethod.Post, "/api/inbox/mark", new { threads = new[] { "t" }, read = true });
        Assert.Equal("https://space.example.com/api/apps", handler.Requests[0].RequestUri!.AbsoluteUri);
        Assert.Equal("CF_Authorization=a; space_session=b", string.Join("", handler.Requests[0].Headers.GetValues("Cookie")));
        Assert.False(handler.Requests[0].Headers.Contains("Origin"));
        Assert.Equal("https://space.example.com", string.Join("", handler.Requests[1].Headers.GetValues("Origin")));
        Assert.Equal("""{"threads":["t"],"read":true}""", handler.Bodies[1]);
        Assert.Equal(2, asked.Count);
    }

    [Fact]
    public async Task ARedirectIsASignInAndNeverFollowed()
    {
        var handler = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.Found) { Headers = { Location = new Uri("https://team.cloudflareaccess.com/login") } });
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        var e = await Assert.ThrowsAsync<SpaceApiException>(() => api.Get("/api/apps"));
        Assert.Equal(SpaceApiFailure.AuthenticationRequired, e.Kind);
        Assert.Single(handler.Requests);
        Assert.Equal(SpaceState.AuthenticationRequired, await api.CheckSpace());
    }

    [Fact]
    public async Task TheCheckWantsTheIdentityAndTheLayout()
    {
        var handler = new ScriptedHandler(r => r.RequestUri!.AbsolutePath switch
        {
            "/api/space" => ScriptedHandler.Json("""{"product":"ai-space","api":1,"version":"0.1.0","edition":"server"}"""),
            "/api/panel/layout" => ScriptedHandler.Json("""{"ok":true,"layout":{"screens":null}}"""),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        });
        Assert.Equal(SpaceState.Ready, await new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler).CheckSpace());
        var old = new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound));
        Assert.Equal(SpaceStateKind.Incompatible, (await new SpaceApi(Base, _ => Task.FromResult<string?>(null), old).CheckSpace()).Kind);
        var down = new ScriptedHandler(_ => throw new HttpRequestException("connection refused"));
        Assert.Equal(SpaceStateKind.Unreachable, (await new SpaceApi(Base, _ => Task.FromResult<string?>(null), down).CheckSpace()).Kind);
    }

    [Fact]
    public void TheDeviceSessionsCookieIsRead()
    {
        var url = new Uri("http://127.0.0.1:8700/");
        var response = new HttpResponseMessage(HttpStatusCode.OK);
        response.Headers.TryAddWithoutValidation("Set-Cookie", "space_session=t0k; Path=/; Max-Age=60; HttpOnly; SameSite=Lax");
        var now = DateTimeOffset.UtcNow;
        var cookie = Assert.Single(SpaceApi.ResponseCookies(response.Headers, url, now));
        Assert.Equal(("space_session", "t0k", "/", "127.0.0.1", true, true, "Lax"), (cookie.Name, cookie.Value, cookie.Path, cookie.Domain, cookie.HostOnly, cookie.HttpOnly, cookie.SameSite));
        Assert.Equal(now.AddSeconds(60), cookie.Expires);
        var space = new Uri("https://space.example.com/");
        var wide = SetCookie.Parse("CF_Authorization=x; Domain=.example.com; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure", space, now)!;
        Assert.Equal(("example.com", false, true), (wide.Domain, wide.HostOnly, wide.Secure));
        Assert.Equal(new DateTimeOffset(2037, 10, 21, 7, 28, 0, TimeSpan.Zero), wide.Expires);
        Assert.Null(SetCookie.Parse("x=1; Domain=evil.com", space, now));
        Assert.Null(SetCookie.Parse("garbage", space, now));
        Assert.Null(SetCookie.Parse("s=1", space, now)!.Expires);
        Assert.Equal("Bearer spd_abc", DeviceSession.Headers(url, "spd_abc")["Authorization"]);
        Assert.Equal("http://127.0.0.1:8700", DeviceSession.Headers(url, "spd_abc")["Origin"]);
        Assert.Null(SpaceApi.CookieHeader([]));
        Assert.Equal("a=1; b=2", SpaceApi.CookieHeader([("a", "1"), ("b", "2")]));
    }
}

public class SpaceLiveTests
{
    private sealed class MemorySeen : ISeenStore
    {
        public Dictionary<Guid, InboxSeen> Saved { get; } = [];
        public InboxSeen? Load(Guid connection) => Saved.GetValueOrDefault(connection);
        public void Save(Guid connection, InboxSeen seen) => Saved[connection] = seen;
        public void Forget(Guid connection) => Saved.Remove(connection);
    }

    private static string InboxJson(params (string Thread, string At)[] items) =>
        "{\"items\":[" + string.Join(",", items.Select(i => "{\"thread\":\"" + i.Thread + "\",\"app\":\"todo\",\"text\":\"x\",\"lastAt\":\"" + i.At + "\",\"unread\":true}"))
        + "],\"summary\":{\"unread\":" + items.Length + ",\"open\":" + items.Length + "}}";

    [Fact]
    public async Task OnlyNewUnreadThreadsAreAnnounced()
    {
        var inbox = InboxJson(("a", "1"));
        var appsAsked = 0;
        var handler = new ScriptedHandler(r => r.RequestUri!.AbsolutePath switch
        {
            "/api/apps" => ScriptedHandler.Json("{\"n\":" + ++appsAsked + ""","apps":[{"id":"todo","name":"todo","title":"Todo","url":"https://todo.example.com/"},{"id":"gone","name":"gone","title":"Gone","url":"/x","status":"archived"},{"name":"broken"}]}"""),
            "/api/agents" => ScriptedHandler.Json("""{"agents":[{"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant"}]}"""),
            "/api/panel/layout" => ScriptedHandler.Json("""{"ok":true,"layout":{"screens":[{"id":"home","name":"Home","items":["app:todo","agent:space/assistant"]}]}}"""),
            "/api/inbox" => ScriptedHandler.Json(inbox),
            "/api/agents/runs" => ScriptedHandler.Json("""{"runs":[{"id":"r1","agent":"space/assistant","message":"hi","status":"running"},{"id":"r0","agent":"space/assistant","message":"","status":"done"}]}"""),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        });
        var connection = new Connection { Name = "Hub", Url = "https://space.example.com/" };
        var seen = new MemorySeen();
        var live = new SpaceLive(connection, new SpaceApi(connection.Uri, _ => Task.FromResult<string?>(null), handler), seen);
        var announced = new List<string>();
        live.NewInbox += (_, items) => announced.AddRange(items.Select(i => i.Thread));

        await live.Refresh(catalogue: true);
        Assert.Equal(LiveStatus.Ok, live.Status);
        Assert.Equal(["todo"], live.Apps.Select(a => a.Name));
        Assert.Equal(["app:todo", "agent:space/assistant"], live.HomeItems);
        Assert.Equal("r1", Assert.Single(live.Running).Id);
        Assert.Equal("space/assistant", live.AgentId(live.Running[0]));
        Assert.Empty(announced);

        inbox = InboxJson(("a", "1"), ("b", "1"));
        await live.Refresh();
        Assert.Equal(["b"], announced);
        Assert.Equal(1, appsAsked);
        Assert.Equal(2, live.Summary.Unread);
        Assert.True(seen.Saved[connection.Id].Seeded);
    }

    [Fact]
    public async Task ASignInIsReportedAndAnOutageIsOffline()
    {
        var connection = new Connection { Name = "Hub", Url = "https://space.example.com/" };
        var signIn = new SpaceLive(connection, new SpaceApi(connection.Uri, _ => Task.FromResult<string?>(null), new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized))), new MemorySeen());
        await signIn.Refresh();
        Assert.Equal(LiveStatus.SignInNeeded, signIn.Status);
        var down = new SpaceLive(connection, new SpaceApi(connection.Uri, _ => Task.FromResult<string?>(null), new ScriptedHandler(_ => throw new HttpRequestException("refused"))), new MemorySeen());
        await down.Refresh();
        Assert.Equal(LiveStatus.Offline, down.Status);
        Assert.Contains("refused", down.StatusDetail);
    }
}
