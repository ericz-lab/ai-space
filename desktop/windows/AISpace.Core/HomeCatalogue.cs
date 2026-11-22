using System.Text.Json;

namespace AISpace.Core;

/// <summary>What a Home tile stands for: an app, an agent, a widget, or one of the panel's own pages.</summary>
public enum HomeKind
{
    App,
    Agent,
    Widget,
    Builtin,
}

/// <summary>
/// Whether an entry can be expected to answer (the iPhone's and Mac's <c>Reach</c>, the Linux
/// client's <c>core/catalogue.ts</c>): its service says so, it is only a link, its machine is
/// offline, or it is paused.
/// </summary>
public enum Reach
{
    Unknown,
    Up,
    Down,
    Link,
    PeerOffline,
    Paused,
}

/// <summary>
/// One app, agent, widget or built-in page of Home, keyed as the panel keys it
/// (<c>app:&lt;id&gt;</c>, <c>agent:&lt;id&gt;</c>, <c>widget:&lt;id&gt;</c>, <c>builtin:&lt;name&gt;</c>).
/// </summary>
public sealed record HomeEntry(HomeKind Kind, string Ref, string Title)
{
    public string? Detail { get; init; }
    public IReadOnlyDictionary<string, LocalizedText>? I18n { get; init; }
    /// <summary>An emoji, an http(s) URL, or a path on the Space.</summary>
    public string? Icon { get; init; }
    public string? Peer { get; init; }
    /// <summary>An agent on several machines: every machine's name ("" for this one), the entry standing for them all.</summary>
    public IReadOnlyList<string>? Machines { get; init; }
    /// <summary>The page to open: the app's <c>url</c> or the widget's <c>link</c>, <c>{lang}</c> and <c>{accent}</c> not filled in yet.</summary>
    public string? Link { get; init; }
    public Reach Reach { get; init; } = Reach.Unknown;

    public string Key => HomeKeys.Of(Kind, Ref);

    public string DisplayTitle(string? lang = null) => Lang.Pick(Title, I18n, true, lang);

    public string DisplayDetail(string? lang = null) => Lang.Pick(Detail ?? "", I18n, false, lang);
}

public static class HomeKeys
{
    public static string Of(HomeKind kind, string id) => kind switch
    {
        HomeKind.App => "app:",
        HomeKind.Agent => "agent:",
        HomeKind.Widget => "widget:",
        _ => "builtin:",
    } + id;

    /// <summary>A key's kind and id; null for a key of a kind the client does not know (<c>builtin:pet</c> is a builtin, whether drawn or not).</summary>
    public static (HomeKind Kind, string Id)? Parse(string key)
    {
        var i = key.IndexOf(':', StringComparison.Ordinal);
        if (i <= 0 || i == key.Length - 1) return null;
        HomeKind? kind = key[..i] switch
        {
            "app" => HomeKind.App,
            "agent" => HomeKind.Agent,
            "widget" => HomeKind.Widget,
            "builtin" => HomeKind.Builtin,
            _ => null,
        };
        return kind is { } k ? (k, key[(i + 1)..]) : null;
    }
}

/// <summary>A peer machine of the Space (<c>GET /api/peers</c>).</summary>
public sealed record HomePeer(string Name, string? Health, bool Stale)
{
    public bool Offline => Stale || (Health is not null && Health != "ok");
}

/// <summary>An agent as <c>/api/agents</c> lists it, once per machine.</summary>
public sealed record HomeAgent(string Id, string App, string Name, string Title)
{
    public string? Description { get; init; }
    public IReadOnlyDictionary<string, LocalizedText>? I18n { get; init; }
    public string? Avatar { get; init; }
    public string? Peer { get; init; }
    public bool Stale { get; init; }
}

/// <summary>
/// One agent across machines (src/web/agent-groups.ts, the Linux client's <c>core/agents.ts</c>):
/// the local variant, else the first peer that answers, stands for the group.
/// </summary>
public sealed record AgentGroup(string Key, HomeAgent Primary, IReadOnlyList<HomeAgent> Machines);

public static class AgentGroups
{
    /// <summary>Groups in the order their first variant has in the catalogue; within a group the local variant comes first.</summary>
    public static IReadOnlyList<AgentGroup> Group(IEnumerable<HomeAgent> agents)
    {
        var order = new List<string>();
        var groups = new Dictionary<string, (HomeAgent Primary, List<HomeAgent> Machines)>();
        foreach (var a in agents)
        {
            var key = $"{a.App}/{a.Name}";
            if (!groups.TryGetValue(key, out var g))
            {
                order.Add(key);
                groups[key] = (a, [a]);
            }
            else if (a.Peer is null && g.Primary.Peer is not null)
            {
                g.Machines.Insert(0, a);
                groups[key] = (a, g.Machines);
            }
            else
            {
                g.Machines.Add(a);
                // An offline peer does not stand for the group while another peer answers.
                if (g.Primary.Peer is not null && g.Primary.Stale && !a.Stale) groups[key] = (a, g.Machines);
            }
        }
        return order.Select(k => new AgentGroup(k, groups[k].Primary, groups[k].Machines)).ToList();
    }

    /// <summary>The agent ids every variant stands for: a variant's id maps to its group's primary.</summary>
    public static Dictionary<string, string> PrimaryIds(IEnumerable<AgentGroup> groups)
    {
        var map = new Dictionary<string, string>();
        foreach (var g in groups)
        {
            foreach (var m in g.Machines) map[m.Id] = g.Primary.Id;
        }
        return map;
    }

    /// <summary>Screen items with every agent key pointed at its group's primary and repeats dropped, so a screen pinned with one machine's variant shows one tile.</summary>
    public static List<string> CanonicalItems(IEnumerable<string> items, IEnumerable<AgentGroup> groups)
    {
        var primary = PrimaryIds(groups);
        var output = new List<string>();
        foreach (var key in items)
        {
            var next = key.StartsWith("agent:", StringComparison.Ordinal) && primary.TryGetValue(key["agent:".Length..], out var p) ? "agent:" + p : key;
            if (!output.Contains(next)) output.Add(next);
        }
        return output;
    }
}

/// <summary>
/// The Space's catalogue as Home reads it: <c>GET /api/apps</c>, <c>/api/agents</c>,
/// <c>/api/widgets</c>, <c>/api/peers</c> and <c>/api/panel/layout</c>, decoded as the Linux
/// (<c>core/catalogue.ts</c>), Mac and iPhone clients do. Every field Home can live without is
/// optional and a malformed row is skipped, so an older or newer server still decodes.
/// </summary>
public sealed class HomeCatalogue
{
    public IReadOnlyList<HomeEntry> Apps { get; init; } = [];
    /// <summary>The apps as the window opens them (<see cref="AppInfo"/>), by id.</summary>
    public IReadOnlyDictionary<string, AppInfo> AppInfos { get; init; } = new Dictionary<string, AppInfo>();
    /// <summary>One entry per agent group.</summary>
    public IReadOnlyList<HomeEntry> Agents { get; init; } = [];
    public IReadOnlyList<AgentGroup> AgentGroups { get; init; } = [];
    public IReadOnlyList<HomeWidget> Widgets { get; init; } = [];
    public IReadOnlyList<HomePeer> Peers { get; init; } = [];
    /// <summary>The panel's screens, home first; null while the Space has stored none.</summary>
    public IReadOnlyList<HomeScreen>? Screens { get; init; }
    /// <summary>Icons of the panel's own tiles (inbox, terminal, settings, …), as <c>/api/apps</c> names them.</summary>
    public IReadOnlyDictionary<string, string> BuiltinIcons { get; init; } = new Dictionary<string, string>();

    public static HomeCatalogue Decode(JsonElement apps, JsonElement agents, JsonElement? widgets = null, JsonElement? peers = null, JsonElement? layout = null)
    {
        var peerList = new List<HomePeer>();
        foreach (var p in HomeJson.Rows(peers, "peers"))
        {
            if (HomeJson.Str(p, "name") is { } name) peerList.Add(new HomePeer(name, HomeJson.Str(p, "health"), HomeJson.Bool(p, "stale")));
        }
        var offline = peerList.Where(p => p.Offline).Select(p => p.Name).ToHashSet();

        var appEntries = new List<HomeEntry>();
        foreach (var a in HomeJson.Rows(apps, "apps"))
        {
            var id = HomeJson.Str(a, "id");
            var title = HomeJson.Str(a, "title");
            var url = HomeJson.Str(a, "url");
            if (id is null || title is null || HomeJson.Bool(a, "hidden") || HomeJson.Str(a, "status") == "archived" || string.IsNullOrEmpty(url)) continue;
            var peer = HomeJson.Str(a, "peer");
            var service = a.TryGetProperty("service", out var s) && s.ValueKind == JsonValueKind.Object ? s : (JsonElement?)null;
            var reach = HomeJson.Bool(a, "stale") || (peer is not null && offline.Contains(peer)) ? Reach.PeerOffline
                : HomeJson.Str(a, "status") == "paused" ? Reach.Paused
                : service is { } svc ? HomeJson.Str(svc, "health") switch { "ok" => Reach.Up, "down" => Reach.Down, _ => Reach.Unknown }
                : Reach.Link;
            appEntries.Add(new HomeEntry(HomeKind.App, id, title) { Detail = HomeJson.Str(a, "description"), I18n = HomeJson.I18n(a), Icon = HomeJson.Str(a, "icon"), Peer = peer, Link = url, Reach = reach });
        }
        var infos = new Dictionary<string, AppInfo>();
        if (apps.ValueKind == JsonValueKind.Object)
        {
            foreach (var info in SpaceJson.Apps(apps)) infos.TryAdd(info.Id, info);
        }

        var agentInfo = new List<HomeAgent>();
        foreach (var a in HomeJson.Rows(agents, "agents"))
        {
            var id = HomeJson.Str(a, "id");
            var app = HomeJson.Str(a, "app");
            var name = HomeJson.Str(a, "name");
            var title = HomeJson.Str(a, "title");
            if (id is null || app is null || name is null || title is null) continue;
            var peer = HomeJson.Str(a, "peer");
            agentInfo.Add(new HomeAgent(id, app, name, title)
            {
                Description = HomeJson.Str(a, "description"),
                I18n = HomeJson.I18n(a),
                Avatar = HomeJson.Str(a, "avatar"),
                Peer = peer,
                Stale = HomeJson.Bool(a, "stale") || (peer is not null && offline.Contains(peer)),
            });
        }
        var groups = Core.AgentGroups.Group(agentInfo);
        var agentEntries = groups.Select(g => new HomeEntry(HomeKind.Agent, g.Primary.Id, g.Primary.Title)
        {
            Detail = g.Primary.Description,
            I18n = g.Primary.I18n,
            Icon = g.Primary.Avatar,
            Peer = g.Primary.Peer,
            Machines = g.Machines.Count > 1 ? g.Machines.Select(m => m.Peer ?? "").ToList() : null,
            Reach = g.Primary.Stale ? Reach.PeerOffline : Reach.Unknown,
        }).ToList();

        var widgetList = new List<HomeWidget>();
        foreach (var w in HomeJson.Rows(widgets, "widgets"))
        {
            if (HomeWidget.Decode(w) is { } widget) widgetList.Add(widget);
        }

        List<HomeScreen>? screens = null;
        if (layout is { ValueKind: JsonValueKind.Object } l && l.TryGetProperty("layout", out var inner) && inner.ValueKind == JsonValueKind.Object
            && inner.TryGetProperty("screens", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            screens = [];
            foreach (var sc in list.EnumerateArray())
            {
                if (sc.ValueKind != JsonValueKind.Object || HomeJson.Str(sc, "id") is not { } sid || HomeJson.Str(sc, "name") is not { } sname
                    || !sc.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) continue;
                screens.Add(new HomeScreen(sid, sname, items.EnumerateArray().Where(k => k.ValueKind == JsonValueKind.String).Select(k => k.GetString()!).ToList()));
            }
        }

        var builtins = new Dictionary<string, string>();
        if (apps.ValueKind == JsonValueKind.Object && apps.TryGetProperty("builtins", out var b) && b.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in b.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String) builtins[p.Name] = p.Value.GetString()!;
            }
        }

        return new HomeCatalogue
        {
            Apps = appEntries,
            AppInfos = infos,
            Agents = agentEntries,
            AgentGroups = groups,
            Widgets = widgetList,
            Peers = peerList,
            Screens = screens,
            BuiltinIcons = builtins,
        };
    }

    public static HomeEntry WidgetEntry(HomeWidget w) => new(HomeKind.Widget, w.Id, w.Title)
    {
        I18n = w.I18n,
        Icon = w.Icon,
        Peer = w.Peer,
        Link = w.Link,
        Reach = w.Stale ? Reach.PeerOffline : w.Ok == false ? Reach.Down : Reach.Unknown,
    };

    /// <summary>Every app, agent and widget, in the library's order.</summary>
    public IEnumerable<HomeEntry> All => Apps.Concat(Agents).Concat(Widgets.Select(WidgetEntry));

    /// <summary>Every entry by its key, an agent also under each of its machines' keys, so a screen pinned with one machine's variant shows the agent's single entry.</summary>
    public Dictionary<string, HomeEntry> ByKey()
    {
        var byKey = new Dictionary<string, HomeEntry>();
        foreach (var e in All) byKey.TryAdd(e.Key, e);
        foreach (var (variant, primary) in Core.AgentGroups.PrimaryIds(AgentGroups))
        {
            if (variant != primary && byKey.TryGetValue("agent:" + primary, out var e)) byKey.TryAdd("agent:" + variant, e);
        }
        return byKey;
    }

    public HomeWidget? Widget(string id) => Widgets.FirstOrDefault(w => w.Id == id);

    /// <summary>
    /// Whether a screen's key has something to show now: one of the built-in tiles this client
    /// draws, or an app, agent or widget the Space has. A key whose entry is gone keeps its place
    /// on the screen and shows nothing.
    /// </summary>
    public Func<string, bool> Draws()
    {
        var byKey = ByKey();
        return key => key.StartsWith("builtin:", StringComparison.Ordinal) ? Array.IndexOf(HomeScreens.Builtins, key["builtin:".Length..]) >= 0 : byKey.ContainsKey(key);
    }

    /// <summary>
    /// How many apps the App Store offers a Space that has none of its apps yet (<c>GET /api/app-catalog</c>,
    /// <c>catalogOffers</c> in src/web/AppCatalog.tsx): the home screen's first-use card shows while
    /// there are some. A Space with any catalog app, or an old deployment of one, has chosen already: 0.
    /// </summary>
    public static int CatalogOffers(JsonElement catalog)
    {
        if (!HomeJson.Bool(catalog, "ok")) return 0;
        var offers = 0;
        foreach (var a in HomeJson.Rows(catalog, "apps"))
        {
            var state = HomeJson.Str(a, "state");
            var installed = a.TryGetProperty("installed", out var i) && i.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined or JsonValueKind.False);
            if (installed || state == "legacy") return 0;
            if (state == "available") offers++;
        }
        return offers;
    }

    /// <summary>The panel's screens as a browser shows them: the stored ones, or the home screen it would seed.</summary>
    public IReadOnlyList<HomeScreen> PanelScreens() => Screens ?? HomeScreens.Seed(Apps.Select(a => a.Ref), Agents.Select(a => a.Ref), Widgets.Select(w => w.Id));

    /// <summary>
    /// The page of an app or widget with <c>{lang}</c> filled in, resolved against the Space; http(s)
    /// only. <c>{accent}</c> is filled with nothing, as <see cref="AppInfo.PageUrl"/> does.
    /// </summary>
    public static Uri? PageUrl(string? link, Uri space, string? lang = null)
    {
        if (string.IsNullOrEmpty(link)) return null;
        var filled = FillLink(link, lang);
        return Uri.TryCreate(space, filled, out var u) && ConnectionRules.IsWeb(u) ? u : null;
    }

    /// <summary>A link with <c>{lang}</c> filled in and <c>{accent}</c> left empty, still relative when it was.</summary>
    public static string FillLink(string link, string? lang = null) => link.Replace("{lang}", lang ?? Lang.Current, StringComparison.Ordinal)
        .Replace("{accent}", "", StringComparison.Ordinal).Replace("%7Baccent%7D", "", StringComparison.Ordinal);
}

/// <summary>The few JSON readers Home's decoding shares.</summary>
internal static class HomeJson
{
    public static IEnumerable<JsonElement> Rows(JsonElement? root, string key)
    {
        if (root is not { ValueKind: JsonValueKind.Object } r || !r.TryGetProperty(key, out var list) || list.ValueKind != JsonValueKind.Array) yield break;
        foreach (var row in list.EnumerateArray())
        {
            if (row.ValueKind == JsonValueKind.Object) yield return row;
        }
    }

    public static string? Str(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static bool Bool(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    public static bool? OptBool(JsonElement o, string key) => o.TryGetProperty(key, out var v) ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => null } : null;

    /// <summary>A finite number; null when absent or not a number.</summary>
    public static double? Num(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? d : null;

    /// <summary>A number, or <c>null</c> for a value the app could not obtain (<see cref="NumOrNull"/>'s second part true); absent or neither: not valid.</summary>
    public static (double? Value, bool Valid) NumOrNull(JsonElement o, string key)
    {
        if (!o.TryGetProperty(key, out var v)) return (null, false);
        if (v.ValueKind == JsonValueKind.Null) return (null, true);
        return v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) && double.IsFinite(d) ? (d, true) : (null, false);
    }

    public static Dictionary<string, LocalizedText>? I18n(JsonElement o)
    {
        if (!o.TryGetProperty("i18n", out var v) || v.ValueKind != JsonValueKind.Object) return null;
        var d = new Dictionary<string, LocalizedText>();
        foreach (var p in v.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Object) d[p.Name] = new LocalizedText(Str(p.Value, "title"), Str(p.Value, "description"));
        }
        return d;
    }
}
