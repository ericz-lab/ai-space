using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

public class HomeTests
{
    private static JsonElement J(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    // The shapes a real Space answers with (trimmed), and what an older or odd one may send.
    private const string Apps = """
        {"ok":true,"apps":[
          {"id":"ai-todo","name":"ai-todo","title":"Todo","description":"A todo list","i18n":{"zh":{"title":"AI 待办","description":"待办清单"}},"icon":"/api/apps/ai-todo/icon","url":"/_space/apps/ai-todo","status":"active","hidden":false},
          {"id":"keep","name":"keep","title":"Keep","url":"/_space/apps/keep","status":"paused"},
          {"id":"web","name":"web","title":"Web Studio","url":"https://web.example.com/{lang}/","service":{"health":"down"}},
          {"id":"up","name":"up","title":"Up","url":"/up","service":{"health":"ok"}},
          {"id":"far","name":"far","title":"Far","url":"/far","peer":"seoul"},
          {"id":"gone","name":"gone","title":"Gone","url":"/gone","status":"archived"},
          {"id":"secret","name":"secret","title":"Secret","url":"/s","hidden":true},
          {"id":"nopage","name":"nopage","title":"No page"},
          "junk"
        ],"builtins":{"inbox":"/inbox.svg","terminal":"/terminal.svg","bad":3}}
        """;

    private const string Agents = """
        {"ok":true,"agents":[
          {"id":"ai-todo/planner","app":"ai-todo","name":"planner","title":"Todo Planner","i18n":{"zh":{"title":"规划师"}},"avatar":"/api/agents/ai-todo/planner/avatar"},
          {"id":"seoul/space/assistant","app":"space","name":"assistant","title":"Space Assistant","peer":"seoul"},
          {"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant","description":"The workspace assistant","avatar":"/assistant.svg"},
          {"id":"seoul/x/y","app":"x","name":"y","title":"Far Agent","peer":"seoul"},
          {"id":"broken"}
        ]}
        """;

    private const string Widgets = """
        {"ok":true,"widgets":[
          {"id":"ai-todo/next","app":"ai-todo","name":"next","title":"Todo · Up Next","i18n":{"zh":{"title":"待办 · 接下来"}},"icon":"/api/apps/ai-todo/icon","link":"/_space/apps/ai-todo?path=%2F","kind":"items","size":"2x1","ok":true,
           "items":[{"text":"开发卡片功能 · 2026-11-22","url":"","time":"2026-11-21T14:49:16.350Z"}],
           "blocks":[
             {"type":"metric","label":{"en":"Due by today","zh":"今天到期"},"caption":{"en":"1 open","zh":"未完成 1"},"tone":"neutral","value":0,"url":"/_space/apps/ai-todo?path=%2F"},
             {"type":"status","label":"开发卡片功能","tone":"neutral","value":{"en":"Tomorrow","zh":"明天"}},
             {"type":"trend","label":{"en":"Done, last 7 days"},"style":"bar","points":[{"t":"2026-11-15","v":0},{"t":"2026-11-16","v":2},{"t":"bad","v":1}]},
             {"type":"metric","label":"no value"},
             {"type":"gauge","label":"bad range","value":1,"min":5,"max":5}
           ],"asOf":"2026-11-22T03:42:12.491Z","staleAfterMs":600000},
          {"id":"a/embed","app":"a","name":"embed","title":"Embed","kind":"embed","size":"2x2"},
          {"id":"c/w","app":"c","name":"w","title":"Down","ok":false,"error":"down"},
          {"id":"seoul/d/w","app":"d","name":"w","title":"D","peer":"seoul","stale":true}
        ]}
        """;

    private const string Peers = """{"ok":true,"peers":[{"name":"seoul","health":"down"}]}""";

    private const string Layout = """
        {"ok":true,"layout":{"screens":[{"id":"home","name":"","items":["builtin:inbox","agent:space/assistant","builtin:pet",3]},{"id":"s1","name":"Work","items":["app:ai-todo"]},{"bad":true}]}}
        """;

    private static HomeCatalogue Catalogue() => HomeCatalogue.Decode(J(Apps), J(Agents), J(Widgets), J(Peers), J(Layout));

    [Fact]
    public void DecodesTheCatalogueAsTheOtherClients()
    {
        var c = Catalogue();
        Assert.Equal(["ai-todo", "keep", "web", "up", "far"], c.Apps.Select(a => a.Ref));
        Assert.Equal([Reach.Link, Reach.Paused, Reach.Down, Reach.Up, Reach.PeerOffline], c.Apps.Select(a => a.Reach));
        Assert.Equal("AI 待办", c.Apps[0].DisplayTitle("zh"));
        Assert.Equal("待办清单", c.Apps[0].DisplayDetail("zh"));
        Assert.Equal("A todo list", c.Apps[0].DisplayDetail("en"));
        Assert.True(c.AppInfos.ContainsKey("ai-todo"));
        Assert.Equal(new Dictionary<string, string> { ["inbox"] = "/inbox.svg", ["terminal"] = "/terminal.svg" }, c.BuiltinIcons);

        // One entry per agent: the local variant stands for the assistant on both machines.
        Assert.Equal(["ai-todo/planner", "space/assistant", "seoul/x/y"], c.Agents.Select(a => a.Ref));
        Assert.Equal(["", "seoul"], c.Agents[1].Machines!);
        Assert.Equal(Reach.PeerOffline, c.Agents[2].Reach);
        Assert.Equal("agent:space/assistant", c.ByKey()["agent:seoul/space/assistant"].Key);

        Assert.Equal(["ai-todo/next", "a/embed", "c/w", "seoul/d/w"], c.Widgets.Select(w => w.Id));
        Assert.Equal([CardBody.Blocks, CardBody.Embed, CardBody.Error, CardBody.Empty], c.Widgets.Select(WidgetBlocks.BodyOf));
        Assert.Equal([Reach.Unknown, Reach.Unknown, Reach.Down, Reach.PeerOffline], c.Widgets.Select(w => HomeCatalogue.WidgetEntry(w).Reach));
        var w = c.Widgets[0];
        Assert.Equal(3, w.Blocks!.Count);
        Assert.Null(w.Items![0].Url);
        Assert.Equal(600000, w.StaleAfterMs);
        Assert.True(w.Wide);
        Assert.Equal(2, ((TrendBlock)w.Blocks[2]).Points.Count);

        Assert.Equal(["home", "s1"], c.Screens!.Select(s => s.Id));
        Assert.Equal(["builtin:inbox", "agent:space/assistant", "builtin:pet"], c.Screens![0].Items);
        Assert.Equal(new[] { "app", "agent", "widget" }.Length, c.All.Select(e => e.Kind).Distinct().Count());
    }

    [Fact]
    public void AnOlderSpaceStillDecodes()
    {
        var c = HomeCatalogue.Decode(J("""{"apps":[{"id":"a","title":"A","url":"/a"}]}"""), J("{}"));
        Assert.Single(c.Apps);
        Assert.Empty(c.Agents);
        Assert.Empty(c.Widgets);
        Assert.Null(c.Screens);
        // Without stored screens, the panel's seeded home: the first apps, its own tiles, then agents and widgets.
        Assert.Equal(["app:a", "builtin:inbox", "builtin:shortcuts", "builtin:terminal", "builtin:settings"], c.PanelScreens()[0].Items);
        // A widget state that only changes its time draws the same card.
        var a = HomeWidget.Decode(J("""{"id":"x/y","app":"x","name":"y","title":"T","items":[{"text":"a"}],"asOf":"2026-01-01T00:00:00Z"}"""))!;
        var b = HomeWidget.Decode(J("""{"id":"x/y","app":"x","name":"y","title":"T","items":[{"text":"a"}],"asOf":"2026-01-02T00:00:00Z"}"""))!;
        Assert.Equal(a.State, b.State);
    }

    [Fact]
    public void PagesFillTheirLanguage()
    {
        var space = new Uri("http://127.0.0.1:8700/");
        Assert.Equal("https://web.example.com/zh/", HomeCatalogue.PageUrl("https://web.example.com/{lang}/", space, "zh")!.ToString());
        Assert.Equal("http://127.0.0.1:8700/_space/apps/x?accent=", HomeCatalogue.PageUrl("/_space/apps/x?accent={accent}", space, "en")!.ToString());
        Assert.Null(HomeCatalogue.PageUrl("javascript:alert(1)", space));
        Assert.Null(HomeCatalogue.PageUrl("", space));
    }

    [Fact]
    public void TheCommandBoxRanksNamesFirst()
    {
        var entries = new[]
        {
            new HomeEntry(HomeKind.App, "notes", "Meeting Notes") { Detail = "Write todo lists" },
            new HomeEntry(HomeKind.App, "ai-todo", "Todo") { I18n = new Dictionary<string, LocalizedText> { ["zh"] = new("AI 待办", null) } },
            new HomeEntry(HomeKind.Agent, "ai-todo/planner", "Todo Planner"),
            new HomeEntry(HomeKind.App, "cafe", "Café"),
            new HomeEntry(HomeKind.App, "remote", "Remote") { Peer = "Seoul" },
        };
        Assert.Equal(["ai-todo", "ai-todo/planner", "notes"], HomeSearch.Rank("todo", entries).Select(e => e.Ref));
        Assert.Equal(HomeSearch.Exact, HomeSearch.Score("TODO", entries[1]));
        Assert.Equal(HomeSearch.Prefix, HomeSearch.Score("todo p", entries[2]));
        Assert.Equal(HomeSearch.Word, HomeSearch.Score("plan", entries[2]));
        Assert.Equal(HomeSearch.Inside, HomeSearch.Score("odo", entries[1]));
        Assert.Equal(HomeSearch.Text, HomeSearch.Score("lists", entries[0]));
        Assert.Equal(HomeSearch.Exact, HomeSearch.Score("cafe", entries[3]));
        Assert.Equal(HomeSearch.Prefix, HomeSearch.Score("ai 待", entries[1]));
        Assert.Equal(0, HomeSearch.Score("nothing", entries[0]));
        Assert.True(HomeSearch.Matches("remote seoul", entries[4]));
        Assert.Empty(HomeSearch.Rank("  ", entries));

        // Enter opens a name the person typed; a sentence is a question for the assistant.
        Assert.True(HomeSearch.OpensByDefault("todo", HomeSearch.Rank("todo", entries).FirstOrDefault()));
        Assert.False(HomeSearch.OpensByDefault("lists", HomeSearch.Rank("lists", entries).FirstOrDefault()));
        Assert.False(HomeSearch.OpensByDefault("what is due today", HomeSearch.Rank("what is due today", entries).FirstOrDefault()));

        var counts = HomeSearch.Counts([.. entries, new HomeEntry(HomeKind.Builtin, "inbox", "Inbox")]);
        Assert.Equal(6, counts[LibraryFilter.All]);
        Assert.Equal(5, counts[LibraryFilter.Apps]);
        Assert.Equal(1, counts[LibraryFilter.Agents]);
        Assert.Equal(0, counts[LibraryFilter.Widgets]);
    }

    [Theory]
    // Expected values are what WidgetBlocks.tsx's fmt (Intl.NumberFormat) writes for en and zh-CN.
    [InlineData(1234.567, null, null, null, false, "1,234.57", "1,234.57")]
    [InlineData(0.5, null, null, 3, false, "0.500", "0.500")]
    [InlineData(42.3, "percent", null, null, false, "42.3%", "42.3%")]
    [InlineData(5, "percent", null, null, true, "+5%", "+5%")]
    [InlineData(12.5, "currency", "EUR", null, false, "€12.50", "€12.50")]
    [InlineData(250000, "currency", null, null, false, "$250.00K", "$25.00万")]
    [InlineData(1500000, "currency", "CNY", null, false, "¥1.50M", "¥150.00万")]
    [InlineData(-1234.5, "currency", "GBP", null, false, "-£1,234.50", "-£1,234.50")]
    [InlineData(7.5, "currency", "JPY", 0, false, "¥8", "¥8")]
    [InlineData(1234567, "compact", null, null, true, "+1.2M", "+123.5万")]
    [InlineData(999999, "compact", null, null, false, "1M", "100万")]
    [InlineData(12345, "compact", null, null, false, "12.3K", "1.2万")]
    [InlineData(123456789, "compact", null, null, false, "123.5M", "1.2亿")]
    [InlineData(1234, "compact", null, null, false, "1.2K", "1234")]
    [InlineData(-5.5, null, null, null, false, "-5.5", "-5.5")]
    [InlineData(0, null, null, null, true, "0", "0")]
    [InlineData(3.14159, null, null, 2, true, "+3.14", "+3.14")]
    public void NumbersReadAsThePanelWritesThem(double v, string? format, string? currency, int? decimals, bool signed, string en, string zh)
    {
        var style = new NumberStyle(format, currency, decimals);
        Assert.Equal(en, NumberText.Format(v, style, "en", signed));
        Assert.Equal(zh, NumberText.Format(v, style, "zh", signed));
    }

    [Fact]
    public void BlockTextsAndUnits()
    {
        var unit = new BlockText(null, new Dictionary<string, string> { ["en"] = "items", ["zh"] = "项" });
        Assert.Equal("-3 items", NumberText.Format(-3, new NumberStyle(Unit: unit), "en", true));
        Assert.Equal("-3 项", NumberText.Format(-3, new NumberStyle(Unit: unit), "zh", true));
        Assert.Equal("简体", new BlockText(null, new Dictionary<string, string> { ["zh-CN"] = "简体" }).Pick("zh"));
        Assert.Equal("Salut", new BlockText(null, new Dictionary<string, string> { ["fr"] = "Salut" }).Pick("en"));
        Assert.Equal("Hi", new BlockText(null, new Dictionary<string, string> { ["fr"] = "Salut", ["en"] = "Hi" }).Pick("zh"));
        Assert.Equal("plain", new BlockText("plain").Pick("zh"));
    }

    private static WidgetBlock Block(string json) => WidgetBlocks.Decode(J(json))!;

    [Fact]
    public void BlockValuesTonesAndShapes()
    {
        var metric = Block("""{"type":"metric","label":"Revenue","value":1200,"format":"currency","currency":"USD","delta":{"value":-5,"format":"percent","label":"vs last week","tone":"negative"}}""");
        Assert.Equal("$1,200.00", WidgetBlocks.Shown(metric, "en"));
        Assert.Equal(("▼ 5% vs last week", (Tone?)Tone.Negative), WidgetBlocks.DeltaText(metric, "en", true));
        Assert.Equal("▼ 5%", WidgetBlocks.DeltaText(metric, "en", false)!.Value.Text);
        Assert.Null(WidgetBlocks.Shown(Block("""{"type":"metric","label":"x","value":null}"""), "en"));
        Assert.Null(WidgetBlocks.Decode(J("""{"type":"metric","label":"x"}""")));
        Assert.Null(WidgetBlocks.Decode(J("""{"type":"metric","value":1}""")));
        Assert.Null(WidgetBlocks.Decode(J("""{"type":"chart","label":"x"}""")));
        Assert.Equal("All good", WidgetBlocks.Shown(Block("""{"type":"status","label":"s","value":{"en":"All good"}}"""), "en"));
        Assert.Equal(0.75, WidgetBlocks.Fraction((ProgressBlock)Block("""{"type":"progress","label":"p","value":3,"max":4}""")));
        Assert.Equal(1, WidgetBlocks.Fraction((ProgressBlock)Block("""{"type":"progress","label":"p","value":9,"max":4}""")));

        var gauge = (GaugeBlock)Block("""{"type":"gauge","label":"g","value":70,"min":0,"max":100,"zones":[{"to":80,"tone":"warning"},{"to":50,"tone":"positive"},{"to":100,"tone":"negative"},{"to":1,"tone":"pink"}]}""");
        Assert.Equal(Tone.Warning, WidgetBlocks.ToneOf(gauge));
        Assert.Equal(0.7, WidgetBlocks.Position(gauge, 70));
        Assert.Equal([(0, 0.5, Tone.Positive), (0.5, 0.8, Tone.Warning), (0.8, 1, Tone.Negative)], WidgetBlocks.GaugeSegments(gauge));

        var tanks = (TanksBlock)Block("""{"type":"tanks","label":"Nearest 10 GB","tanks":[{"label":"a","value":7.5,"max":10,"display":"7.5 GB"},{"label":"b","value":12,"max":10},{"label":"c","value":null,"max":10},{"label":"d","value":1,"max":10}]}""");
        Assert.Null(WidgetBlocks.Shown(tanks, "en"));
        Assert.Equal(["7.5 GB", "120%", null], tanks.Tanks.Select(k => WidgetBlocks.TankValue(k, "en")));
        Assert.Equal([0.75, 1.2, 0], tanks.Tanks.Select(WidgetBlocks.TankLevel));

        var line = (TrendBlock)Block("""{"type":"trend","label":"t","style":"line","points":[{"t":"2026-01-01","v":1},{"t":"2026-01-02","v":null},{"t":"2026-01-03","v":3},{"t":"2026-01-04","v":2}]}""");
        Assert.Equal("2", WidgetBlocks.Shown(line, "en"));
        var s = WidgetBlocks.SparkOf(line)!;
        Assert.False(s.Bars);
        Assert.Equal([1, 2], s.Runs.Select(r => r.Count));
        Assert.Equal(0, s.Runs[1][0].Y);

        var bars = WidgetBlocks.SparkOf((TrendBlock)Block("""{"type":"trend","label":"t","style":"bar","signed":true,"points":[{"t":"2026-01-01","v":-2},{"t":"2026-01-02","v":2},{"t":"2026-01-03","v":null}]}"""))!;
        Assert.True(bars.Bars);
        Assert.Equal(0.5, bars.Zero);
        Assert.Equal([(true, false), (false, true)], bars.BarList.Select(b => (b.Negative, b.Latest)));
        Assert.Null(WidgetBlocks.SparkOf((TrendBlock)Block("""{"type":"trend","label":"t","points":[{"t":"2026-01-01","v":null}]}""")));

        Assert.Equal([2, 10, 2, 8, 4], new[] { WidgetBlocks.RowsFor("1x1"), WidgetBlocks.RowsFor("2x2"), WidgetBlocks.RowsFor(null), WidgetBlocks.ItemsFor("1x2"), WidgetBlocks.ItemsFor("2x1") });
        var now = DateTimeOffset.Parse("2026-01-01T00:02:00Z");
        Assert.True(WidgetBlocks.IsOutdated("2026-01-01T00:00:00Z", 60_000, now));
        Assert.False(WidgetBlocks.IsOutdated("2026-01-01T00:01:30Z", 60_000, now));
        Assert.False(WidgetBlocks.IsOutdated(null, 60_000, now));
    }

    [Fact]
    public void AgesInTheClientsSteps()
    {
        var now = DateTimeOffset.Parse("2026-11-21T12:00:00Z");
        Assert.Equal((AgoUnit.Now, 0), HomeTime.Ago(now.AddSeconds(-30), now));
        Assert.Equal((AgoUnit.Minutes, -5), HomeTime.Ago(now.AddMinutes(-5), now));
        Assert.Equal((AgoUnit.Hours, -3), HomeTime.Ago(now.AddHours(-3), now));
        Assert.Equal((AgoUnit.Days, -1), HomeTime.Ago(now.AddHours(-30), now));
        Assert.Equal((AgoUnit.Minutes, 5), HomeTime.Ago(now.AddMinutes(5), now));
        Assert.Equal((AgoUnit.Date, 0), HomeTime.Ago(now.AddDays(-9), now));
        Assert.Equal("2026年11月1日", HomeTime.DateText(new DateTimeOffset(2026, 11, 1, 12, 0, 0, TimeZoneInfo.Local.GetUtcOffset(new DateTime(2026, 11, 1))), "zh"));
        Assert.Null(HomeTime.Parse("soon"));
    }

    [Fact]
    public void ScreensCopiedFromThePanelOnceThenThisComputersOwn()
    {
        var panel = new[]
        {
            new HomeScreen("s1", "Work", ["app:x", "builtin:pet", "app:x", "widget:a/w"]),
            new HomeScreen("home", "", ["app:a", "builtin:inbox", "agent:a/b"]),
        };
        var copy = HomeScreens.CopyPanel(panel);
        Assert.Equal(["home", "s1"], copy.Select(s => s.Id));
        Assert.Equal(["app:x", "widget:a/w"], copy[1].Items);

        var empty = new Dictionary<string, ScreenRecord>();
        Assert.Equal(["home"], HomeScreens.ScreensOf(empty, "c").Select(s => s.Id));
        Assert.Null(HomeScreens.SeedFile(empty, "c", [new HomeScreen("home", "", [])]));
        var f1 = HomeScreens.SeedFile(empty, "c", panel)!;
        Assert.True(f1["c"].Seeded);
        Assert.Null(HomeScreens.SeedFile(f1, "c", [new HomeScreen("home", "", ["app:z"])]));

        var f2 = HomeScreens.Edit(f1, "c", s => HomeScreens.Unpin(HomeScreens.Pin(s, "home", "app:new"), "home", "app:a"));
        Assert.Equal(["builtin:inbox", "agent:a/b", "app:new"], HomeScreens.ScreensOf(f2, "c")[0].Items);
        var tiles = HomeScreens.ScreensOf(f2, "c")[0].Items;
        Assert.Equal(["agent:a/b", "app:new", "builtin:inbox"], HomeScreens.ScreensOf(HomeScreens.Edit(f2, "c", s => HomeScreens.Move(s, "home", tiles, 0, 2)), "c")[0].Items);

        var added = HomeScreens.NewScreen(HomeScreens.ScreensOf(f2, "c"))!.Value;
        Assert.Equal(3, added.Screens.Count);
        Assert.Equal("Mine", HomeScreens.Title(HomeScreens.Rename(added.Screens, added.Id, "  Mine "), 2, "Main", n => $"Screen {n}"));
        Assert.Equal("Screen 3", HomeScreens.Title(added.Screens, 2, "Main", n => $"Screen {n}"));
        Assert.Equal("Main", HomeScreens.Title(added.Screens, 0, "Main", n => $"Screen {n}"));
        Assert.Equal(["home", "s1"], HomeScreens.Remove(added.Screens, added.Id).Select(s => s.Id));
        Assert.Equal(3, HomeScreens.Remove(added.Screens, "home").Count);
        Assert.Equal(copy, HomeScreens.ScreensOf(HomeScreens.Reset(f2, "c", panel), "c"), new ScreenComparer());
        Assert.Empty(HomeScreens.Forget(f2, "c"));

        var decoded = HomeScreens.DecodeFile("""{"c":{"screens":[{"id":"x","items":["app:a",3]},"bad"],"seeded":true},"d":"bad"}""");
        Assert.Equal(["c"], decoded.Keys);
        Assert.Equal(["home", "x"], decoded["c"].Screens.Select(s => s.Id));
        Assert.Equal(["app:a"], decoded["c"].Screens[1].Items);
        Assert.Empty(HomeScreens.DecodeFile("not json"));

        // A screen pinned with one machine's variant of an agent shows the agent once.
        var groups = AgentGroups.Group([new HomeAgent("seoul/a/b", "a", "b", "B") { Peer = "seoul" }, new HomeAgent("a/b", "a", "b", "B")]);
        Assert.Equal(["agent:a/b", "app:x"], AgentGroups.CanonicalItems(["agent:seoul/a/b", "agent:a/b", "app:x"], groups));
    }

    [Fact]
    public void TheBarShowsAFewScreensAndTheOneShown()
    {
        string[] ids = ["home", "s1", "s2", "s3", "s4", "s5"];
        Assert.Equal(["home", "s1", "s2", "s3"], HomeScreens.BarTabs(ids, "s1"));
        Assert.Equal(["home", "s1", "s2", "s5"], HomeScreens.BarTabs(ids, "s5"));
        // The Library (not a screen) and a screen that is gone change nothing.
        Assert.Equal(["home", "s1", "s2", "s3"], HomeScreens.BarTabs(ids, "library"));
        Assert.Equal(["home", "s1", "s2", "s3"], HomeScreens.BarTabs(ids, "gone"));
        Assert.Equal(["home"], HomeScreens.BarTabs(["home"], "home"));
    }

    [Fact]
    public void TheScreenStoreKeepsItsFile()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ai-space-home-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(dir, "screens.json");
        try
        {
            var store = new ScreenStore(file);
            Assert.Equal(["home"], store.Screens("c").Select(s => s.Id));
            Assert.True(store.Seed("c", [new HomeScreen("home", "", ["app:a"])]));
            Assert.False(store.Seed("c", [new HomeScreen("home", "", ["app:b"])]));
            store.Edit("c", s => HomeScreens.Pin(s, "home", "widget:w/x"));
            var again = new ScreenStore(file);
            Assert.Equal(["app:a", "widget:w/x"], again.Screens("c")[0].Items);
            again.Forget("c");
            Assert.Equal(["home"], new ScreenStore(file).Screens("c").Select(s => s.Id));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    private sealed class ScreenComparer : IEqualityComparer<HomeScreen>
    {
        public bool Equals(HomeScreen? x, HomeScreen? y) => x is not null && y is not null && x.Id == y.Id && x.Name == y.Name && x.Items.SequenceEqual(y.Items);

        public int GetHashCode(HomeScreen obj) => obj.Id.GetHashCode(StringComparison.Ordinal);
    }
}
