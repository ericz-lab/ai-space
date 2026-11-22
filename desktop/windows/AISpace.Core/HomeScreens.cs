using System.Text.Json;

namespace AISpace.Core;

/// <summary>A screen of Home: entry keys in order (docs/panel.md#screens).</summary>
public sealed record HomeScreen(string Id, string Name, IReadOnlyList<string> Items);

/// <summary>This computer's screens of one Space: copied from the panel once (<see cref="Seeded"/>), then its own.</summary>
public sealed record ScreenRecord(IReadOnlyList<HomeScreen> Screens, bool Seeded);

/// <summary>
/// The screens of each saved Space as this computer lays them out (the Linux client's
/// <c>core/screens.ts</c>, the Mac's and iPhone's ScreenStore): the first catalogue of a Space
/// copies the panel's screens once, and from then on what is added, removed, moved or made here
/// stays here; nothing is written to the Space. The operations are the panel's own
/// (src/web/screens.ts). A key whose entry is gone keeps its place, so it comes back with the entry.
/// </summary>
public static class HomeScreens
{
    public const string Home = "home";

    /// <summary>As many as the panel allows (MAX_SCREENS in src/space/panel/layout.ts).</summary>
    public const int Limit = 20;

    /// <summary>The panel's own tiles, in the order the panel's library and a seeded home screen show them.</summary>
    public static readonly string[] PanelBuiltins = ["inbox", "shortcuts", "terminal", "settings"];

    /// <summary>
    /// The <c>builtin:</c> tiles this client draws: the panel's own. The web panel is no tile (it
    /// shows by itself for a sign-in, and Settings opens it for what has no native copy): a copy of
    /// the panel's screens leaves <c>builtin:panel</c> out, and a screen saved before that keeps the
    /// key in screens.json but no longer draws it.
    /// </summary>
    public static readonly string[] Builtins = PanelBuiltins;

    /// <summary>How many entries of each kind a first home screen takes (src/web/screens.ts <c>SEED</c>).</summary>
    private const int SeedApps = 8, SeedAgents = 4, SeedWidgets = 4;

    /// <summary>The home screen of a panel that has no screens yet: the first apps, its own tiles, the first agents and widgets.</summary>
    public static IReadOnlyList<HomeScreen> Seed(IEnumerable<string> apps, IEnumerable<string> agents, IEnumerable<string> widgets)
    {
        var items = apps.Take(SeedApps).Select(id => "app:" + id)
            .Concat(PanelBuiltins.Select(b => "builtin:" + b))
            .Concat(agents.Take(SeedAgents).Select(id => "agent:" + id))
            .Concat(widgets.Take(SeedWidgets).Select(id => "widget:" + id)).ToList();
        return [new HomeScreen(Home, "", items)];
    }

    private static HomeScreen EmptyHome() => new(Home, "", []);

    private static bool Keeps(string key) =>
        (HomeKeys.Parse(key) is { } k && k.Kind != HomeKind.Builtin) || Builtins.Any(b => key == "builtin:" + b);

    /// <summary>Home exists and comes first, ids are unique, there are no more screens than the limit, and no key twice on one screen.</summary>
    public static IReadOnlyList<HomeScreen> Normalize(IEnumerable<HomeScreen> screens)
    {
        var seen = new HashSet<string>();
        var output = screens.Where(s => seen.Add(s.Id)).Select(s => s with { Items = s.Items.Distinct().ToList() }).ToList();
        var i = output.FindIndex(s => s.Id == Home);
        if (i > 0)
        {
            var home = output[i];
            output.RemoveAt(i);
            output.Insert(0, home);
        }
        else if (i < 0)
        {
            output.Insert(0, EmptyHome());
        }
        return output.Take(Limit).ToList();
    }

    /// <summary>The panel's screens as this client keeps them: only entries of a kind it draws.</summary>
    public static IReadOnlyList<HomeScreen> CopyPanel(IEnumerable<HomeScreen> panel) =>
        Normalize(panel.Select(s => new HomeScreen(s.Id, s.Name ?? "", s.Items.Where(Keeps).ToList())));

    public static IReadOnlyList<HomeScreen> ScreensOf(IReadOnlyDictionary<string, ScreenRecord> file, string space) =>
        file.TryGetValue(space, out var r) ? r.Screens : [EmptyHome()];

    /// <summary>Takes the panel's screens as this computer's first layout, once per Space; null when nothing changes.</summary>
    public static Dictionary<string, ScreenRecord>? SeedFile(IReadOnlyDictionary<string, ScreenRecord> file, string space, IEnumerable<HomeScreen> panel)
    {
        if (file.TryGetValue(space, out var r) && r.Seeded) return null;
        var copy = CopyPanel(panel);
        // A panel with nothing pinned is not a layout yet: wait for a catalogue that has one.
        if (!copy.Any(s => s.Items.Count > 0)) return null;
        return new Dictionary<string, ScreenRecord>(file) { [space] = new ScreenRecord(copy, true) };
    }

    /// <summary>Replaces this computer's layout with the panel's as it is now, when the person asks for it.</summary>
    public static Dictionary<string, ScreenRecord> Reset(IReadOnlyDictionary<string, ScreenRecord> file, string space, IEnumerable<HomeScreen> panel) =>
        new(file) { [space] = new ScreenRecord(CopyPanel(panel), true) };

    /// <summary>A change made here; a layout made by hand is never overwritten by a later copy.</summary>
    public static Dictionary<string, ScreenRecord> Edit(IReadOnlyDictionary<string, ScreenRecord> file, string space, Func<IReadOnlyList<HomeScreen>, IEnumerable<HomeScreen>> change) =>
        new(file) { [space] = new ScreenRecord(Normalize(change(ScreensOf(file, space))), true) };

    public static Dictionary<string, ScreenRecord> Forget(IReadOnlyDictionary<string, ScreenRecord> file, string space)
    {
        var next = new Dictionary<string, ScreenRecord>(file);
        next.Remove(space);
        return next;
    }

    private static IReadOnlyList<HomeScreen> Map(IEnumerable<HomeScreen> screens, string id, Func<HomeScreen, HomeScreen> fn) => screens.Select(s => s.Id == id ? fn(s) : s).ToList();

    /// <summary>Adds the entry at the end of the screen; an entry already there stays where it is.</summary>
    public static IReadOnlyList<HomeScreen> Pin(IEnumerable<HomeScreen> screens, string screen, string key) =>
        Map(screens, screen, s => s.Items.Contains(key) ? s : s with { Items = [.. s.Items, key] });

    public static IReadOnlyList<HomeScreen> Unpin(IEnumerable<HomeScreen> screens, string screen, string key) =>
        Map(screens, screen, s => s with { Items = s.Items.Where(k => k != key).ToList() });

    /// <summary>
    /// Moves one entry of a group (the tiles, or the widgets, which a screen draws apart) to the
    /// place of another of the same group; entries outside the group keep their places.
    /// </summary>
    public static IReadOnlyList<HomeScreen> Move(IEnumerable<HomeScreen> screens, string screen, IReadOnlyList<string> group, int from, int to)
    {
        var list = screens.ToList();
        if (from == to || from < 0 || to < 0 || from >= group.Count || to >= group.Count) return list;
        var next = group.ToList();
        var x = next[from];
        next.RemoveAt(from);
        next.Insert(to, x);
        var inGroup = group.ToHashSet();
        return Map(list, screen, s =>
        {
            var i = 0;
            return s with { Items = s.Items.Select(k => inGroup.Contains(k) ? next[i++] : k).ToList() };
        });
    }

    /// <summary>A new empty screen at the end, with an id no other screen has; null at the limit.</summary>
    public static (IReadOnlyList<HomeScreen> Screens, string Id)? NewScreen(IReadOnlyList<HomeScreen> screens)
    {
        if (screens.Count >= Limit) return null;
        var n = screens.Count;
        while (screens.Any(s => s.Id == $"s{n}")) n++;
        var id = $"s{n}";
        return ([.. screens, new HomeScreen(id, "", [])], id);
    }

    /// <summary>The home screen cannot be deleted; deleting a screen leaves its entries in the library.</summary>
    public static IReadOnlyList<HomeScreen> Remove(IEnumerable<HomeScreen> screens, string id) => id == Home ? screens.ToList() : screens.Where(s => s.Id != id).ToList();

    public static IReadOnlyList<HomeScreen> Rename(IEnumerable<HomeScreen> screens, string id, string name)
    {
        var trimmed = name.Trim();
        return Map(screens, id, s => s with { Name = trimmed.Length > 60 ? trimmed[..60] : trimmed });
    }

    /// <summary>The name given the screen, else Main, Screen 2, Screen 3… by position (the Mac's titles).</summary>
    public static string Title(IReadOnlyList<HomeScreen> screens, int index, string main, Func<int, string> numbered) =>
        index >= 0 && index < screens.Count && screens[index].Name.Length > 0 ? screens[index].Name : index == 0 ? main : numbered(index + 1);

    /// <summary>How many screens the main window's bar shows as tabs; the rest are in its overflow menu.</summary>
    public const int InBar = 4;

    /// <summary>
    /// The screens the bar shows as tabs: the first <paramref name="max"/>, the shown one in the last
    /// place when it is not among them (as the web tabs, <see cref="OpenTabLayout"/>), so many screens
    /// never push the web tabs out of the bar.
    /// </summary>
    public static IReadOnlyList<string> BarTabs(IReadOnlyList<string> ids, string? shown, int max = InBar)
    {
        var tabs = ids.Take(Math.Max(1, max)).ToList();
        if (shown is not null && ids.Contains(shown) && !tabs.Contains(shown)) tabs[^1] = shown;
        return tabs;
    }

    /// <summary>Reads screens.json, skipping anything malformed.</summary>
    public static Dictionary<string, ScreenRecord> DecodeFile(string json)
    {
        var output = new Dictionary<string, ScreenRecord>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return output;
            foreach (var space in doc.RootElement.EnumerateObject())
            {
                var r = space.Value;
                if (r.ValueKind != JsonValueKind.Object || !r.TryGetProperty("screens", out var list) || list.ValueKind != JsonValueKind.Array) continue;
                var screens = new List<HomeScreen>();
                foreach (var s in list.EnumerateArray())
                {
                    if (s.ValueKind != JsonValueKind.Object || HomeJson.Str(s, "id") is not { } id || !s.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) continue;
                    screens.Add(new HomeScreen(id, HomeJson.Str(s, "name") ?? "", items.EnumerateArray().Where(k => k.ValueKind == JsonValueKind.String).Select(k => k.GetString()!).ToList()));
                }
                output[space.Name] = new ScreenRecord(Normalize(screens), HomeJson.Bool(r, "seeded"));
            }
        }
        catch (JsonException)
        {
        }
        return output;
    }

    public static string EncodeFile(IReadOnlyDictionary<string, ScreenRecord> file) =>
        JsonSerializer.Serialize(file, SpaceApi.Json) + "\n";
}

/// <summary>
/// This computer's screens of every saved Space, in <c>screens.json</c> beside the saved Spaces
/// (<see cref="HomeScreens"/> has the rules). One store per file, shared by the Spaces' Home pages;
/// nothing here is written to a Space.
/// </summary>
public sealed class ScreenStore
{
    private readonly string _file;
    private Dictionary<string, ScreenRecord> _screens;

    public ScreenStore(string file)
    {
        _file = file;
        string text;
        try
        {
            text = File.ReadAllText(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            text = "{}";
        }
        _screens = HomeScreens.DecodeFile(text);
    }

    public IReadOnlyList<HomeScreen> Screens(string space) => HomeScreens.ScreensOf(_screens, space);

    /// <summary>The panel's screens become this computer's, the first time a Space has some; whether that changed anything.</summary>
    public bool Seed(string space, IEnumerable<HomeScreen> panel)
    {
        if (HomeScreens.SeedFile(_screens, space, panel) is not { } next) return false;
        Write(next);
        return true;
    }

    public void Edit(string space, Func<IReadOnlyList<HomeScreen>, IEnumerable<HomeScreen>> change) => Write(HomeScreens.Edit(_screens, space, change));

    public void Reset(string space, IEnumerable<HomeScreen> panel) => Write(HomeScreens.Reset(_screens, space, panel));

    /// <summary>A removed Space's screens go with it.</summary>
    public void Forget(string space)
    {
        if (_screens.ContainsKey(space)) Write(HomeScreens.Forget(_screens, space));
    }

    private void Write(Dictionary<string, ScreenRecord> next)
    {
        _screens = next;
        try
        {
            Files.WriteAtomic(_file, HomeScreens.EncodeFile(next));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Kept for this run; the next change tries again.
        }
    }
}
