using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>How a block's value changed between two payloads: a number up or down, anything else <c>Text</c>.</summary>
public enum Change
{
    Up,
    Down,
    Text,
}

/// <summary>
/// What a widget card does when it is touched (src/web/widget-interact.ts,
/// docs/app-spec.md#views-copy-and-actions), the rules without WPF.
/// </summary>
public static class WidgetInteract
{
    /// <summary>The point of a spark under the pointer: each point owns a slot of equal width, as the chart draws it; -1 with nothing to point at.</summary>
    public static int NearestIndex(double x, double width, int n)
    {
        if (n <= 0 || width <= 0) return -1;
        // The chart is at least two slots wide (one point alone sits in the first slot).
        var slots = Math.Max(n, 2);
        return Math.Max(0, Math.Min(n - 1, (int)Math.Floor(x / width * slots)));
    }

    /// <summary>Rows split into pages of <paramref name="per"/>; a single page when they fit.</summary>
    public static List<List<T>> PagesOf<T>(IReadOnlyList<T> rows, int per)
    {
        if (per <= 0 || rows.Count <= per) return [rows.ToList()];
        var output = new List<List<T>>();
        for (var i = 0; i < rows.Count; i += per) output.Add(rows.Skip(i).Take(per).ToList());
        return output;
    }

    /// <summary>The page to show after a horizontal swipe of <paramref name="dx"/> (<paramref name="dy"/> vertical), or the same page.</summary>
    public static int SwipePage(int page, int pages, double dx, double dy)
    {
        if (Math.Abs(dx) < 40 || Math.Abs(dx) < Math.Abs(dy) * 1.5) return page;
        return Math.Max(0, Math.Min(pages - 1, page + (dx < 0 ? 1 : -1)));
    }

    /// <summary>The page after a horizontal scroll (a touchpad's two-finger swipe, a tilted wheel): one page per notch, within bounds.</summary>
    public static int ScrollPage(int page, int pages, int notches) => Math.Max(0, Math.Min(pages - 1, page + Math.Sign(notches)));

    /// <summary>A label as text that compares equal for the same label (the web's <c>JSON.stringify</c>).</summary>
    private static string Key(BlockText t) => t.Plain is { } p ? "s:" + p : "m:" + string.Join("\u0001", t.ByLang!.Select(kv => kv.Key + "=" + kv.Value));

    /// <summary>The value a block's change is measured on: a number, else its text (status); <c>Has</c> false for a block that has none (tanks).</summary>
    private static (bool Has, double? Num, string? Text) ValueOf(WidgetBlock b) => b switch
    {
        MetricBlock m => (true, m.Value, null),
        ProgressBlock p => (true, p.Value, null),
        GaugeBlock g => (true, g.Value, null),
        TrendBlock t => (true, t.Points.LastOrDefault(p => p.V is not null)?.V, null),
        StatusBlock s => (true, null, Key(s.Value)),
        _ => (false, null, null),
    };

    /// <summary>
    /// How each block of <paramref name="next"/> changed from the block at the same place in
    /// <paramref name="prev"/>, when both have the same type and label (the same thing measured): up
    /// or down for a number, <see cref="Change.Text"/> for anything else; null where it did not.
    /// </summary>
    public static Change?[] BlockChanges(IReadOnlyList<WidgetBlock>? prev, IReadOnlyList<WidgetBlock> next)
    {
        var output = new Change?[next.Count];
        for (var i = 0; i < next.Count; i++)
        {
            var b = next[i];
            if (prev is null || i >= prev.Count) continue;
            var a = prev[i];
            if (a.GetType() != b.GetType() || Key(a.Label) != Key(b.Label)) continue;
            var x = ValueOf(a);
            var y = ValueOf(b);
            if (!x.Has || !y.Has || x.Num == y.Num && x.Text == y.Text) continue;
            output[i] = x.Num is { } xn && y.Num is { } yn ? (yn > xn ? Change.Up : Change.Down) : Change.Text;
        }
        return output;
    }

    private static readonly Regex Midnight = new(@"T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$");

    /// <summary>Whether a point's time is finer than a day: it has a time of day other than midnight.</summary>
    public static bool Timed(string t) => t.Length > 10 && !Midnight.IsMatch(t);

    /// <summary>
    /// A point's date as the trend's readout writes it, in the reader's zone: "Nov 3, 02:00 PM" or
    /// "11月3日 14:00" when the series is finer than a day, else "11/3/2026" or "2026/11/3"
    /// (the web's <c>toLocaleString</c> in <c>en-US</c> and <c>zh-CN</c>). A bare date is that date,
    /// not moved by the zone.
    /// </summary>
    public static string PointDate(string t, string lang)
    {
        var zh = lang == "zh";
        if (t.Length <= 10 && DateTime.TryParseExact(t, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var day))
        {
            return zh ? $"{day.Year}/{day.Month}/{day.Day}" : $"{day.Month}/{day.Day}/{day.Year}";
        }
        if (HomeTime.Parse(t) is not { } when) return t;
        var local = when.ToLocalTime();
        if (!Timed(t)) return zh ? $"{local.Year}/{local.Month}/{local.Day}" : $"{local.Month}/{local.Day}/{local.Year}";
        return zh
            ? $"{local.Month}月{local.Day}日 {local:HH:mm}"
            : local.ToString("MMM d, hh:mm tt", CultureInfo.InvariantCulture);
    }

    /// <summary>The value a trend's readout shows for one point: its value as the block writes values, or null when the app had none.</summary>
    public static string? PointValue(TrendBlock b, TrendPoint p, string lang) => p.V is { } v ? NumberText.Format(v, b.Style, lang, b.Signed) : null;

    /// <summary>The blocks a card shows: the chosen view's, else the payload's own.</summary>
    public static IReadOnlyList<WidgetBlock>? BlocksOf(HomeWidget w, string? view) =>
        w.Views is { Count: > 1 } views ? (views.FirstOrDefault(v => v.Id == view) ?? views[0]).Blocks : w.Blocks;
}

/// <summary>
/// The view the reader chose on each widget, on this computer (the web keeps it in the browser's
/// <c>localStorage</c>): <c>widget-views.json</c> beside the saved Spaces, by widget id. A widget
/// that no longer has the saved view shows its first.
/// </summary>
public sealed class ViewStore
{
    private readonly string? _file;
    private Dictionary<string, string> _views;

    public ViewStore(string? file)
    {
        _file = file;
        _views = Read(file);
    }

    private static Dictionary<string, string> Read(string? file)
    {
        if (file is null) return [];
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return [];
            return doc.RootElement.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.String).ToDictionary(p => p.Name, p => p.Value.GetString()!);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return [];
        }
    }

    /// <summary>The view last chosen on this widget, when it still has it; else its first.</summary>
    public string? Load(string widgetId, IReadOnlyList<string> ids) =>
        _views.TryGetValue(widgetId, out var saved) && ids.Contains(saved) ? saved : ids.FirstOrDefault();

    public void Save(string widgetId, string viewId)
    {
        _views = new Dictionary<string, string>(_views) { [widgetId] = viewId };
        if (_file is null) return;
        try
        {
            var o = new JsonObject();
            foreach (var (k, v) in _views) o[k] = v;
            Files.WriteAtomic(_file, o.ToJsonString());
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Kept for this run: the first view on the next start.
        }
    }
}

/// <summary>What the Space answered an action or a refresh: the fresh card and the app's message, or why it failed.</summary>
public sealed record WidgetAnswer(HomeWidget? Widget, BlockText? Message = null, string? Error = null)
{
    public bool Ok => Widget is not null;

    /// <summary>
    /// The answer as the panel reads it (widget-interact.ts <c>postWidget</c>): <c>{ ok: true, widget,
    /// message? }</c>, anything else a failure with the answer's <c>error</c> or its HTTP status.
    /// </summary>
    public static WidgetAnswer Decode(int status, string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var r = doc.RootElement;
            if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True
                && r.TryGetProperty("widget", out var w) && w.ValueKind == JsonValueKind.Object && HomeWidget.Decode(w) is { } widget)
            {
                return new WidgetAnswer(widget, BlockText.Decode(r, "message"));
            }
            if (r.ValueKind == JsonValueKind.Object && HomeJson.Str(r, "error") is { Length: > 0 } error) return new WidgetAnswer(null, Error: error);
        }
        catch (JsonException)
        {
        }
        return new WidgetAnswer(null, Error: $"HTTP {status}");
    }

    /// <summary>The app's message in a language, at most 200 characters; empty without one.</summary>
    public string MessageText(string lang)
    {
        var m = BlockText.Of(Message, lang);
        return m.Length > 200 ? m[..200] : m;
    }
}

/// <summary>The action ids of a payload: which ones the card may send, and the same rules as the server for repeats.</summary>
public static class WidgetActions
{
    /// <summary>
    /// Every action id the payload declares, with its kind (src/space/panel/blocks.ts
    /// <c>declaredActions</c>): a card only ever sends one of these.
    /// </summary>
    public static Dictionary<string, string> Declared(HomeWidget w)
    {
        var output = new Dictionary<string, string>();
        foreach (var a in w.Actions ?? []) output.TryAdd(a.Id, a.Kind);
        foreach (var list in new[] { w.Blocks ?? [] }.Concat((w.Views ?? []).Select(v => v.Blocks)))
        {
            foreach (var b in list)
            {
                if (b.Action is { } a) output.TryAdd(a.Id, a.Kind);
            }
        }
        return output;
    }

    /// <summary>
    /// Action ids made unique across a payload (blocks.ts <c>dedupeActionIds</c>): the same id may stand
    /// for the same action in several block lists (the top-level blocks repeat the default view's), so
    /// a repeat is kept when it has the same kind in another list; a repeat in the same list, with
    /// another kind, or between the card and a block, loses its action (the later one).
    /// </summary>
    public static (List<WidgetBlock>? Blocks, List<WidgetView>? Views, List<CardAction>? Actions) Dedupe(List<WidgetBlock>? blocks, List<WidgetView>? views, List<CardAction>? actions)
    {
        var kinds = new Dictionary<string, (string Kind, int List)>();
        foreach (var a in actions ?? []) kinds[a.Id] = (a.Kind, -1);
        List<WidgetBlock> Clean(List<WidgetBlock> list, int li)
        {
            var here = new HashSet<string>();
            var output = new List<WidgetBlock>(list.Count);
            foreach (var b in list)
            {
                if (b.Action is not { } a)
                {
                    output.Add(b);
                    continue;
                }
                var known = kinds.TryGetValue(a.Id, out var prev);
                if (here.Contains(a.Id) || known && (prev.List == -1 || prev.Kind != a.Kind))
                {
                    output.Add(b with { Action = null });
                    continue;
                }
                here.Add(a.Id);
                if (!known) kinds[a.Id] = (a.Kind, li);
                output.Add(b);
            }
            return output;
        }
        var cleanBlocks = blocks is null ? null : Clean(blocks, 0);
        var cleanViews = views?.Select((v, i) => v with { Blocks = Clean(v.Blocks.ToList(), i + 1) }).ToList();
        return (cleanBlocks, cleanViews, actions);
    }

    /// <summary>The body of <c>POST /api/widgets/:app/:name/action</c>: the id, and for an <c>input</c> the trimmed text (1 to 2000 characters).</summary>
    public static JsonObject? Request(string id, string? value)
    {
        var o = new JsonObject { ["action"] = id };
        if (value is null) return o;
        var v = value.Trim();
        if (v.Length is 0 or > WidgetBlocks.MaxActionValue) return null;
        o["value"] = v;
        return o;
    }

    /// <summary>The route of a widget's write: <c>action</c> or <c>refresh</c>.</summary>
    public static string Path(HomeWidget w, string what) => $"/api/widgets/{Uri.EscapeDataString(w.App)}/{Uri.EscapeDataString(w.Name)}/{what}";
}
