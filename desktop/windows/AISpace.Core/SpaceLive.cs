using System.Text.Json;

namespace AISpace.Core;

public enum LiveStatus
{
    Unknown,
    Ok,
    SignInNeeded,
    Offline,
}

/// <summary>
/// What the native interface knows about one connection: its apps and agents, the inbox, the agent
/// runs in progress and the panel's first screen, refreshed in the background from the Space's own
/// routes (the Mac's <c>SpaceLive</c>). Started on the UI thread, its continuations come back there,
/// so the UI reads its fields and receives its events without locking.
/// </summary>
public sealed class SpaceLive
{
    public static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CatalogueAge = TimeSpan.FromMinutes(5);

    private readonly ISeenStore _seenStore;
    private readonly Func<DateTimeOffset> _now;
    private InboxSeen _seen;
    private DateTimeOffset? _catalogueAt;
    private bool _refreshing;
    private CancellationTokenSource? _loop;

    public SpaceLive(Connection connection, SpaceApi api, ISeenStore seenStore, Func<DateTimeOffset>? now = null)
    {
        Connection = connection;
        Api = api;
        _seenStore = seenStore;
        _now = now ?? (() => DateTimeOffset.Now);
        _seen = seenStore.Load(connection.Id) ?? new InboxSeen();
    }

    public Connection Connection { get; }
    public SpaceApi Api { get; }
    public LiveStatus Status { get; private set; } = LiveStatus.Unknown;
    public string StatusDetail { get; private set; } = "";
    public IReadOnlyList<AppInfo> Apps { get; private set; } = [];
    public IReadOnlyList<AgentInfo> Agents { get; private set; } = [];
    public IReadOnlyList<InboxItem> Inbox { get; private set; } = [];
    public InboxSummary Summary { get; private set; } = new(0, 0);
    public IReadOnlyList<ChatRun> Running { get; private set; } = [];
    /// <summary>The keys of the panel's first screen, for the jump list.</summary>
    public IReadOnlyList<string> HomeItems { get; private set; } = [];
    public DateTimeOffset? LastRefresh { get; private set; }

    /// <summary>Threads that became unread since the last look.</summary>
    public event Action<SpaceLive, IReadOnlyList<InboxItem>>? NewInbox;

    /// <summary>After every refresh, for the tray, the taskbar badge and the jump list.</summary>
    public event Action<SpaceLive>? Refreshed;

    public void Start()
    {
        Stop();
        var cts = new CancellationTokenSource();
        _loop = cts;
        _ = Run(cts.Token);
    }

    public void Stop()
    {
        _loop?.Cancel();
        _loop = null;
    }

    private async Task Run(CancellationToken ct)
    {
        await Refresh(catalogue: true, ct);
        using var timer = new PeriodicTimer(Interval);
        try
        {
            while (await timer.WaitForNextTickAsync(ct)) await Refresh(catalogue: false, ct);
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>Inbox and runs every time; apps, agents and the first screen when asked or every five minutes.</summary>
    public async Task Refresh(bool catalogue = false, CancellationToken ct = default)
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            if (catalogue || Apps.Count == 0 || _catalogueAt is null || _now() - _catalogueAt > CatalogueAge)
            {
                var apps = SpaceJson.Apps(await Api.Get("/api/apps", ct));
                var agents = SpaceJson.Agents(await Api.Get("/api/agents", ct));
                Apps = apps.Where(a => a.Opens).ToList();
                Agents = agents;
                try
                {
                    HomeItems = SpaceJson.HomeItems(await Api.Get(SpaceCheck.LayoutPath, ct));
                }
                catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
                {
                }
                _catalogueAt = _now();
            }
            var box = SpaceJson.Inbox(await Api.Get("/api/inbox?filter=open&limit=100", ct));
            Inbox = box.Items;
            Summary = box.Summary;
            var fresh = _seen.Fresh(box.Items);
            _seenStore.Save(Connection.Id, _seen);
            if (fresh.Count > 0) NewInbox?.Invoke(this, fresh);
            try
            {
                // A peer without the runs route still counts as reachable.
                Running = SpaceJson.Runs(await Api.Get("/api/agents/runs?recent=0", ct)).Where(r => r.Status == "running").ToList();
            }
            catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
            {
                Running = [];
            }
            Status = LiveStatus.Ok;
            StatusDetail = "";
        }
        catch (SpaceApiException e) when (e.Kind == SpaceApiFailure.AuthenticationRequired)
        {
            Status = LiveStatus.SignInNeeded;
            StatusDetail = "";
        }
        catch (SpaceApiException e)
        {
            Status = LiveStatus.Offline;
            StatusDetail = e.Message;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            return;
        }
        finally
        {
            _refreshing = false;
        }
        LastRefresh = _now();
        Refreshed?.Invoke(this);
    }

    /// <summary><c>POST /api/inbox/mark</c>, then a fresh look.</summary>
    public async Task Mark(IReadOnlyList<string> threads, bool? read = null, bool? done = null)
    {
        var body = new Dictionary<string, object> { ["threads"] = threads };
        if (read is { } r) body["read"] = r;
        if (done is { } d) body["done"] = d;
        try
        {
            await Api.Send(HttpMethod.Post, "/api/inbox/mark", body);
        }
        catch (SpaceApiException)
        {
        }
        await Refresh();
    }

    public AgentInfo? Agent(string id) => Agents.FirstOrDefault(a => a.Id == id);

    public AppInfo? App(string name) => Apps.FirstOrDefault(a => a.Name == name || a.Id == name);

    /// <summary>Runs name their agent <c>&lt;app&gt;/&lt;name&gt;</c>, which is the local agent's id as <c>/api/agents</c> lists it.</summary>
    public string AgentId(ChatRun run) => Agents.FirstOrDefault(a => $"{a.App}/{a.Name}" == run.Agent && a.Peer is null)?.Id ?? run.Agent;
}

/// <summary>Where each connection's <see cref="InboxSeen"/> is kept between launches.</summary>
public interface ISeenStore
{
    InboxSeen? Load(Guid connection);
    void Save(Guid connection, InboxSeen seen);
    void Forget(Guid connection);
}

/// <summary>One small JSON file per connection.</summary>
public sealed class FileSeenStore(string directory) : ISeenStore
{
    private string FileOf(Guid id) => Path.Combine(directory, $"{id:N}.json");

    public InboxSeen? Load(Guid connection)
    {
        try
        {
            return JsonSerializer.Deserialize<InboxSeen>(File.ReadAllText(FileOf(connection)));
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Save(Guid connection, InboxSeen seen)
    {
        try
        {
            Files.WriteAtomic(FileOf(connection), JsonSerializer.Serialize(seen));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    public void Forget(Guid connection)
    {
        try
        {
            File.Delete(FileOf(connection));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
