using System.Text.Json;
using AISpace.Core;
using static AISpace.Core.WidgetInteract;

namespace AISpace.Core.Tests;

/// <summary>A card's interactions: the cases of src/web/widget-interact.test.ts, and the payload's views, copy and actions.</summary>
public class WidgetInteractTests
{
    private static JsonElement J(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public void NearestIndexIsTheSlotUnderThePointerClampedAndOnePointOwnsTheFirstSlot()
    {
        Assert.Equal(0, NearestIndex(0, 200, 10));
        Assert.Equal(0, NearestIndex(19.9, 200, 10));
        Assert.Equal(1, NearestIndex(20, 200, 10));
        Assert.Equal(9, NearestIndex(199, 200, 10));
        Assert.Equal(9, NearestIndex(260, 200, 10));
        Assert.Equal(0, NearestIndex(-5, 200, 10));
        Assert.Equal(0, NearestIndex(150, 200, 1));
        Assert.Equal(-1, NearestIndex(10, 0, 5));
        Assert.Equal(-1, NearestIndex(10, 100, 0));
    }

    [Fact]
    public void PagesOfIsOnePageWhenTheRowsFitElsePagesOfPer()
    {
        Assert.Equal([[1, 2]], PagesOf([1, 2], 2));
        Assert.Equal([[]], PagesOf(Array.Empty<int>(), 2));
        Assert.Equal([[1, 2], [3, 4], [5]], PagesOf([1, 2, 3, 4, 5], 2));
        Assert.Equal([10, 1], PagesOf(Enumerable.Range(0, 11).ToList(), 10).Select(p => p.Count));
    }

    [Fact]
    public void AClearHorizontalSwipeMovesOnePageWithinBounds()
    {
        Assert.Equal(1, SwipePage(0, 3, -80, 5));
        Assert.Equal(0, SwipePage(1, 3, 80, 5));
        Assert.Equal(2, SwipePage(2, 3, -80, 0));
        Assert.Equal(0, SwipePage(0, 3, -20, 0));
        Assert.Equal(0, SwipePage(0, 3, -60, 60));
        Assert.Equal(1, ScrollPage(0, 3, 1));
        Assert.Equal(0, ScrollPage(0, 3, -1));
        Assert.Equal(2, ScrollPage(2, 3, 4));
    }

    private static MetricBlock M(string label, double? value) => new(new BlockText(label), value, new NumberStyle());
    private static StatusBlock S(string label, string value) => new(new BlockText(label), new BlockText(value));
    private static TrendBlock Tr(params double?[] v) => new(new BlockText("t"), v.Select((x, i) => new TrendPoint($"2026-11-0{i + 1}", x)).ToList(), new NumberStyle());

    [Fact]
    public void BlockChangesAreNumbersUpOrDownTextChangedMatchedByPlaceTypeAndLabel()
    {
        Assert.Equal([null], BlockChanges(null, [M("a", 1)]));
        Assert.Equal([Change.Up, Change.Down, Change.Text, null, null],
            BlockChanges([M("a", 1), M("b", 5), S("c", "up"), M("d", 1), Tr(1, 2)], [M("a", 2), M("b", 4), S("c", "down"), M("other", 9), Tr(1, 2, null)]));
        Assert.Equal([Change.Text], BlockChanges([M("a", null)], [M("a", 3)]));
        Assert.Equal([null], BlockChanges([M("a", 3)], [M("a", 3)]));
        Assert.Equal([Change.Down], BlockChanges([Tr(1, 2)], [Tr(1, 2, 1)]));
        // A block that moved to another place is a different thing there: no flash.
        Assert.Equal([null, null], BlockChanges([M("a", 1), M("b", 2)], [M("b", 3), M("a", 1)]));
        // The same label by language is the same thing.
        var zh = new Dictionary<string, string> { ["en"] = "Spend", ["zh"] = "花费" };
        Assert.Equal([Change.Up], BlockChanges([new MetricBlock(new BlockText(null, zh), 1, new NumberStyle())], [new MetricBlock(new BlockText(null, new Dictionary<string, string>(zh)), 2, new NumberStyle())]));
    }

    [Fact]
    public void TheChosenViewIsKeptPerWidgetAndFallsBackToTheFirstWhenGone()
    {
        var dir = Path.Combine(Path.GetTempPath(), "aispace-views-" + Guid.NewGuid().ToString("N"));
        var file = Path.Combine(dir, "widget-views.json");
        try
        {
            var store = new ViewStore(file);
            Assert.Equal("today", store.Load("usage/spend", ["today", "7d"]));
            store.Save("usage/spend", "7d");
            store.Save("other/w", "b");
            Assert.Equal("7d", store.Load("usage/spend", ["today", "7d"]));
            Assert.Equal("today", store.Load("usage/spend", ["today", "30d"]));
            // Kept across starts.
            Assert.Equal("7d", new ViewStore(file).Load("usage/spend", ["today", "7d"]));
            using (var doc = JsonDocument.Parse(File.ReadAllText(file)))
            {
                Assert.Equal("7d", doc.RootElement.GetProperty("usage/spend").GetString());
                Assert.Equal("b", doc.RootElement.GetProperty("other/w").GetString());
            }
            File.WriteAllText(file, "not json");
            Assert.Equal("today", new ViewStore(file).Load("usage/spend", ["today", "7d"]));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }

    [Fact]
    public void WithoutAFileTheFirstViewIsUsedAndSavingDoesNotThrow()
    {
        var store = new ViewStore(null);
        Assert.Equal("today", store.Load("usage/spend", ["today", "7d"]));
        store.Save("usage/spend", "7d");
        Assert.Equal("7d", store.Load("usage/spend", ["today", "7d"]));
        Assert.Null(store.Load("x", []));
    }

    [Fact]
    public void APointsDateHasItsTimeWhenTheSeriesIsFinerThanADay()
    {
        Assert.False(Timed("2026-11-03"));
        Assert.False(Timed("2026-11-03T00:00:00Z"));
        Assert.False(Timed("2026-11-03T00:00+00:00"));
        Assert.True(Timed("2026-11-03T14:00:00Z"));
        // A bare date is that date in any zone.
        Assert.Equal("11/3/2026", PointDate("2026-11-03", "en"));
        Assert.Equal("2026/11/3", PointDate("2026-11-03", "zh"));
        var local = DateTimeOffset.Parse("2026-11-03T14:05:00Z", System.Globalization.CultureInfo.InvariantCulture).ToLocalTime();
        Assert.Equal($"{local.Month}月{local.Day}日 {local:HH:mm}", PointDate("2026-11-03T14:05:00Z", "zh"));
        Assert.Equal(local.ToString("MMM d, hh:mm tt", System.Globalization.CultureInfo.InvariantCulture), PointDate("2026-11-03T14:05:00Z", "en"));
        Assert.Equal("$1.50", PointValue(new TrendBlock(new BlockText("t"), [], new NumberStyle("currency")), new TrendPoint("2026-11-03", 1.5), "en"));
        Assert.Null(PointValue(Tr(), new TrendPoint("2026-11-03", null), "en"));
    }

    private const string Payload = """
        {"id":"todo/today","app":"todo","name":"today","title":"Today","size":"1x1","kind":"items","ok":true,"items":[],
         "frame":{"w":0.5,"h":320},
         "blocks":[
           {"type":"status","label":"Buy milk","value":"today","copy":"milk","action":{"id":"done:42","kind":"check","label":{"en":"Mark done","zh":"标记完成"}}},
           {"type":"metric","label":"Open","value":3,"action":{"id":"done:42","kind":"check","label":"again"}},
           {"type":"metric","label":"Bad","value":1,"copy":"","action":{"id":"bad id!","kind":"check","label":"x"}},
           {"type":"metric","label":"Odd","value":1,"action":{"id":"odd","kind":"toggle","label":"x"}},
           {"type":"metric","label":"Clash","value":1,"action":{"id":"add","kind":"button","label":"x"}}
         ],
         "views":[
           {"id":"today","label":{"en":"Today","zh":"今日"},"blocks":[{"type":"status","label":"Buy milk","value":"today","action":{"id":"done:42","kind":"check","label":"Mark done"}}]},
           {"id":"7d","label":"7 days","blocks":[{"type":"metric","label":"Done","value":9,"action":{"id":"done:42","kind":"button","label":"other kind"}}]},
           {"id":"Bad","label":"x","blocks":[{"type":"metric","label":"a","value":1}]},
           {"id":"empty","label":"x","blocks":[{"type":"nope"}]},
           {"id":"today","label":"dup","blocks":[{"type":"metric","label":"a","value":1}]}
         ],
         "actions":[
           {"id":"add","kind":"input","label":"Add","placeholder":{"en":"Add a task…","zh":"添加待办…"}},
           {"id":"add2","kind":"input","label":"Second input"},
           {"id":"add","kind":"button","label":"Same id"},
           {"id":"rerun","kind":"button","label":"Run now","confirm":"Run it now?"},
           {"id":"x","kind":"weird","label":"x"},
           {"id":"more","kind":"button","label":"More"},
           {"id":"fourth","kind":"button","label":"Fourth"}
         ]}
        """;

    [Fact]
    public void ViewsCopyAndActionsAreDecodedWithTheServersChecks()
    {
        var w = HomeWidget.Decode(J(Payload))!;
        Assert.Equal(new Frame(0.5, 320), w.Frame);
        Assert.Equal(["today", "7d"], w.Views!.Select(v => v.Id));
        Assert.Equal("今日", w.Views![0].Label.Pick("zh"));
        Assert.Equal(["add", "rerun", "more"], w.Actions!.Select(a => a.Id));
        Assert.Equal("Add a task…", BlockText.Of(w.Actions![0].Placeholder, "en"));
        Assert.Null(w.Actions![1].Placeholder);
        Assert.Equal("Run it now?", BlockText.Of(w.Actions![1].Confirm, "en"));
        var blocks = w.Blocks!;
        Assert.Equal("milk", blocks[0].Copy);
        Assert.Equal("done:42", blocks[0].Action!.Id);
        Assert.Equal("check", blocks[0].Action!.Kind);
        // A repeat in the same list, a malformed id or kind, an empty copy, and an id the card uses: dropped.
        Assert.Null(blocks[1].Action);
        Assert.Null(blocks[2].Action);
        Assert.Null(blocks[2].Copy);
        Assert.Null(blocks[3].Action);
        Assert.Null(blocks[4].Action);
        // The same id in another list keeps its action when it is the same kind, not with another.
        Assert.Equal("done:42", w.Views![0].Blocks[0].Action!.Id);
        Assert.Null(w.Views![1].Blocks[0].Action);
        Assert.Equal(new Dictionary<string, string> { ["add"] = "input", ["rerun"] = "button", ["more"] = "button", ["done:42"] = "check" }, WidgetActions.Declared(w));
        // The view chosen draws its blocks; an unknown one the first.
        Assert.Equal("Done", BlockText.Of(BlocksOf(w, "7d")![0].Label, "en"));
        Assert.Equal("Buy milk", BlockText.Of(BlocksOf(w, "gone")![0].Label, "en"));
    }

    [Fact]
    public void AnOlderSpacesWidgetHasNoneOfItAndAMalformedFrameIsNone()
    {
        var w = HomeWidget.Decode(J("""{"id":"a/b","app":"a","name":"b","title":"B","size":"2x1","ok":true,"items":[],"blocks":[{"type":"metric","label":"x","value":1}],"frame":{"w":0.05,"h":300},"views":[{"id":"one","label":"One","blocks":[{"type":"metric","label":"x","value":1}]}],"actions":"no"}"""))!;
        Assert.Null(w.Frame);
        Assert.Null(w.Views);
        Assert.Null(w.Actions);
        Assert.Null(w.Blocks![0].Copy);
        Assert.Null(w.Blocks![0].Action);
        Assert.Equal(w.Blocks, BlocksOf(w, null));
        // The content does not change with the size or the frame; the state does.
        var resized = HomeWidget.Decode(J("""{"id":"a/b","app":"a","name":"b","title":"B","size":"1x1","ok":true,"items":[],"blocks":[{"type":"metric","label":"x","value":1}],"frame":{"w":0.5,"h":300},"views":[{"id":"one","label":"One","blocks":[{"type":"metric","label":"x","value":1}]}],"actions":"no"}"""))!;
        Assert.Equal(w.Content, resized.Content);
        Assert.NotEqual(w.State, resized.State);
    }

    [Fact]
    public void TheLayoutSaysWhetherTheSpaceHasTheSteplessLayout()
    {
        var apps = J("""{"apps":[]}""");
        var agents = J("""{"agents":[]}""");
        var widgets = J("""{"widgets":[{"id":"a/b","app":"a","name":"b","title":"B","size":"1x1","ok":true,"items":[]},{"id":"a/c","app":"a","name":"c","title":"C","size":"2x1","ok":true,"items":[],"frame":{"w":0.5,"h":300}}]}""");
        var old = HomeCatalogue.Decode(apps, agents, widgets, null, J("""{"ok":true,"layout":{"screens":null}}"""));
        Assert.Null(old.WidgetAlign);
        Assert.False(old.Stepless);
        Assert.False(old.WidgetWrites);
        var now = HomeCatalogue.Decode(apps, agents, widgets, null, J("""{"ok":true,"layout":{"screens":null,"frames":{},"widgetAlign":"center"}}"""));
        Assert.Equal(WidgetAlign.Center, now.WidgetAlign);
        Assert.True(now.WidgetWrites);
        var newer = HomeCatalogue.Decode(apps, agents, widgets, null, J("""{"ok":true,"layout":{"widgetAlign":"justify"}}"""));
        Assert.Equal(WidgetAlign.Start, newer.WidgetAlign);

        // A write as the server stores it: frames, sizes (a size alone drops the frame), the alignment.
        var applied = now.ApplyLayout(new LayoutWrite { Frames = new() { ["a/b"] = new Frame(0.4, 200) }, Sizes = new() { ["a/b"] = "1x1", ["a/c"] = "1x2" }, Align = WidgetAlign.Start });
        Assert.Equal(new Frame(0.4, 200), applied.Widget("a/b")!.Frame);
        Assert.Null(applied.Widget("a/c")!.Frame);
        Assert.Equal("1x2", applied.Widget("a/c")!.Size);
        Assert.Equal(WidgetAlign.Start, applied.WidgetAlign);
        Assert.Equal([new LayoutCard("a/b", "1x1", new Frame(0.4, 200)), new LayoutCard("a/c", "1x2")], HomeCatalogue.LayoutCards(applied.Widgets));

        // A card an action answered with keeps the size and frame shown.
        var fresh = HomeWidget.Decode(J("""{"id":"a/c","app":"a","name":"c","title":"C v2","size":"1x1","ok":true,"items":[]}"""))!;
        var replaced = now.ReplaceWidget(fresh).Widget("a/c")!;
        Assert.Equal("C v2", replaced.Title);
        Assert.Equal("2x1", replaced.Size);
        Assert.Equal(new Frame(0.5, 300), replaced.Frame);
    }

    [Fact]
    public void TheAnswersOfAnActionAreTheFreshCardOrWhyNot()
    {
        var ok = WidgetAnswer.Decode(200, """{"ok":true,"message":{"en":"Done","zh":"完成"},"widget":{"id":"a/b","app":"a","name":"b","title":"B","ok":true,"items":[]}}""");
        Assert.True(ok.Ok);
        Assert.Equal("完成", ok.MessageText("zh"));
        Assert.Equal("", WidgetAnswer.Decode(200, """{"ok":true,"widget":{"id":"a/b","app":"a","name":"b","title":"B"}}""").MessageText("en"));
        Assert.Equal(new string('x', 200), new WidgetAnswer(ok.Widget, new BlockText(new string('x', 300))).MessageText("en"));
        var failed = WidgetAnswer.Decode(502, """{"ok":false,"error":"unknown action"}""");
        Assert.False(failed.Ok);
        Assert.Equal("unknown action", failed.Error);
        Assert.Equal("HTTP 404", WidgetAnswer.Decode(404, "<html>not found</html>").Error);
        Assert.Equal("HTTP 200", WidgetAnswer.Decode(200, """{"ok":true}""").Error);

        var w = HomeWidget.Decode(J("""{"id":"a b/c","app":"a b","name":"c/d","title":"B"}"""))!;
        Assert.Equal("/api/widgets/a%20b/c%2Fd/action", WidgetActions.Path(w, "action"));
        Assert.Equal("""{"action":"done:42"}""", WidgetActions.Request("done:42", null)!.ToJsonString());
        Assert.Equal("""{"action":"add","value":"milk"}""", WidgetActions.Request("add", "  milk ")!.ToJsonString());
        Assert.Null(WidgetActions.Request("add", "   "));
        Assert.Null(WidgetActions.Request("add", new string('x', 2001)));
    }
}
