using System.Globalization;
using System.Text;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>A string, or the same text by language tag (the blocks contract's <c>BlockText</c>).</summary>
public sealed record BlockText(string? Plain, IReadOnlyDictionary<string, string>? ByLang = null)
{
    /// <summary>The text in a language: the exact tag, then a tag with the same primary subtag, then English, then any (WidgetBlocks.tsx <c>txt</c>).</summary>
    public string Pick(string lang)
    {
        if (Plain is not null) return Plain;
        if (ByLang is null || ByLang.Count == 0) return "";
        if (ByLang.TryGetValue(lang, out var exact)) return exact;
        foreach (var (tag, text) in ByLang)
        {
            if (tag.Split('-')[0] == lang) return text;
        }
        return ByLang.TryGetValue("en", out var en) ? en : ByLang.First().Value;
    }

    public static string Of(BlockText? t, string lang) => t?.Pick(lang) ?? "";

    internal static BlockText? Decode(JsonElement o, string key)
    {
        if (!o.TryGetProperty(key, out var v)) return null;
        if (v.ValueKind == JsonValueKind.String) return v.GetString() is { } s && s.Trim().Length > 0 ? new BlockText(s) : null;
        if (v.ValueKind != JsonValueKind.Object) return null;
        var d = new Dictionary<string, string>();
        foreach (var p in v.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.String && p.Value.GetString() is { } s && s.Trim().Length > 0) d[p.Name] = s;
        }
        return d.Count > 0 ? new BlockText(null, d) : null;
    }
}

public enum Tone
{
    Positive,
    Negative,
    Warning,
    Neutral,
}

/// <summary>How a number reads: <c>number</c>, <c>compact</c>, <c>currency</c> or <c>percent</c>, its decimals and unit.</summary>
public sealed record NumberStyle(string? Format = null, string? Currency = null, int? Decimals = null, BlockText? Unit = null)
{
    internal static NumberStyle Decode(JsonElement o)
    {
        var format = HomeJson.Str(o, "format") is { } f && f is "number" or "compact" or "currency" or "percent" ? f : null;
        var currency = HomeJson.Str(o, "currency") is { Length: 3 } c && c.All(char.IsAsciiLetterUpper) ? c : null;
        var decimals = HomeJson.Num(o, "decimals") is { } d && d is >= 0 and <= 8 ? (int)Math.Round(d) : (int?)null;
        return new NumberStyle(format, currency, decimals, BlockText.Decode(o, "unit"));
    }
}

public sealed record BlockDelta(double Value, NumberStyle Style, BlockText? Label, Tone? Tone);

public sealed record TrendPoint(string T, double? V);

public sealed record GaugeZone(double To, Tone Tone, BlockText? Label);

public sealed record Tank(BlockText Label, double? Value, double Max, BlockText? Display = null, Tone? Tone = null, string? Url = null);

/// <summary>
/// A widget block (src/space/panel/blocks.ts, docs/app-spec.md#blocks-a-state-card-instead-of-a-list):
/// a structured value an <c>items</c> widget sends next to its list. Decoded with the contract's
/// checks; a malformed block is skipped.
/// </summary>
public abstract record WidgetBlock(BlockText Label)
{
    public BlockText? Caption { get; init; }
    public string? Url { get; init; }
    public Tone? Tone { get; init; }
    /// <summary>Text the block's copy control puts on the clipboard (docs/app-spec.md#views-copy-and-actions).</summary>
    public string? Copy { get; init; }
    /// <summary>The block's write-back control, a <c>check</c> or a <c>button</c>; drawn only on a local widget.</summary>
    public BlockAction? Action { get; init; }
}

/// <summary>A write-back control on one block: <c>check</c> (a round tick in place of the status dot) or <c>button</c> (a pill at its end).</summary>
public sealed record BlockAction(string Id, string Kind, BlockText Label, BlockText? Confirm = null);

/// <summary>A control in the card's footer: <c>input</c> (one text field with its send button, at most one) or <c>button</c>.</summary>
public sealed record CardAction(string Id, string Kind, BlockText Label, BlockText? Placeholder = null, BlockText? Confirm = null);

/// <summary>A read-only switch inside a card: its label and its own blocks, the same rules as the top-level ones.</summary>
public sealed record WidgetView(string Id, BlockText Label, IReadOnlyList<WidgetBlock> Blocks);

public sealed record MetricBlock(BlockText Label, double? Value, NumberStyle Style) : WidgetBlock(Label)
{
    public BlockText? Display { get; init; }
    public BlockDelta? Delta { get; init; }
}

public sealed record TrendBlock(BlockText Label, IReadOnlyList<TrendPoint> Points, NumberStyle Style, bool Bars = false, bool Signed = false) : WidgetBlock(Label);

public sealed record ProgressBlock(BlockText Label, double? Value, double Max, NumberStyle Style) : WidgetBlock(Label)
{
    public BlockText? Display { get; init; }
}

public sealed record GaugeBlock(BlockText Label, double? Value, double Min, double Max) : WidgetBlock(Label)
{
    public BlockText? Display { get; init; }
    public IReadOnlyList<GaugeZone> Zones { get; init; } = [];
}

public sealed record StatusBlock(BlockText Label, BlockText Value) : WidgetBlock(Label)
{
    public string? Time { get; init; }
}

public sealed record TanksBlock(BlockText Label, IReadOnlyList<Tank> Tanks, NumberStyle Style) : WidgetBlock(Label);

public sealed record WidgetItem(string Text, string? Url, string? Time);

/// <summary>What a widget card's body is.</summary>
public enum CardBody
{
    Error,
    Embed,
    Blocks,
    Items,
    Empty,
}

/// <summary>A widget of the Space as <c>GET /api/widgets</c> reads it: its manifest and its latest state.</summary>
public sealed record HomeWidget(string Id, string App, string Name, string Title)
{
    public IReadOnlyDictionary<string, LocalizedText>? I18n { get; init; }
    public string? Icon { get; init; }
    public string? Link { get; init; }
    public string? Peer { get; init; }
    public bool Stale { get; init; }
    /// <summary><c>1x1</c>, <c>2x1</c>, <c>1x2</c> or <c>2x2</c>.</summary>
    public string? Size { get; init; }
    /// <summary><c>items</c> (a list, maybe blocks) or <c>embed</c> (the app's own page).</summary>
    public string? Kind { get; init; }
    public bool? Ok { get; init; }
    public IReadOnlyList<WidgetItem>? Items { get; init; }
    public IReadOnlyList<WidgetBlock>? Blocks { get; init; }
    public string? AsOf { get; init; }
    public double? StaleAfterMs { get; init; }
    public string? Error { get; init; }
    /// <summary>The read-only views of the card (2 to 4), the first the default; null without them (an older Space, or none declared).</summary>
    public IReadOnlyList<WidgetView>? Views { get; init; }
    /// <summary>The card's own controls (at most 3, one <c>input</c>); null without them.</summary>
    public IReadOnlyList<CardAction>? Actions { get; init; }
    /// <summary>The stepless layout's frame the operator gave the card; null: drawn from <see cref="Size"/>.</summary>
    public Frame? Frame { get; init; }
    /// <summary>What the card shows, as the Space sent it, without the time it was read: two reads that draw the same card are equal.</summary>
    public string State { get; init; } = "";
    /// <summary><see cref="State"/> without the size and the frame: what the card's content depends on when the layout draws its box.</summary>
    public string Content { get; init; } = "";

    public string DisplayTitle(string? lang = null) => Lang.Pick(Title, I18n, true, lang);

    public bool Wide => Size is "2x1" or "2x2";
    public bool Tall => Size is "1x2" or "2x2";

    /// <summary>A stored frame within the server's bounds (src/space/panel/layout.ts <c>isFrame</c>); anything else is none.</summary>
    private static Frame? FrameOf(JsonElement w)
    {
        if (!w.TryGetProperty("frame", out var f) || f.ValueKind != JsonValueKind.Object) return null;
        return HomeJson.Num(f, "w") is { } fw && HomeJson.Num(f, "h") is { } fh && fw is >= WidgetLayout.MinFrac and <= 1 && fh is >= WidgetLayout.MinH and <= WidgetLayout.MaxH
            ? new Frame(fw, fh) : null;
    }

    public static HomeWidget? Decode(JsonElement w)
    {
        var id = HomeJson.Str(w, "id");
        var app = HomeJson.Str(w, "app");
        var name = HomeJson.Str(w, "name");
        var title = HomeJson.Str(w, "title");
        if (id is null || app is null || name is null || title is null) return null;
        List<WidgetItem>? items = null;
        if (w.TryGetProperty("items", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            items = list.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.Object && HomeJson.Str(i, "text") is not null)
                .Select(i => new WidgetItem(HomeJson.Str(i, "text")!, HomeJson.Str(i, "url") is { Length: > 0 } u ? u : null, HomeJson.Str(i, "time"))).ToList();
        }
        var blocks = WidgetBlocks.DecodeList(w, "blocks");
        var views = WidgetBlocks.DecodeViews(w);
        var actions = WidgetBlocks.DecodeActions(w);
        if (blocks is not null || views is not null || actions is not null)
        {
            (blocks, views, actions) = WidgetActions.Dedupe(blocks, views, actions);
        }
        var content = new StringBuilder();
        foreach (var key in new[] { "ok", "error", "stale", "items", "blocks", "kind", "views", "actions" })
        {
            if (w.TryGetProperty(key, out var v)) content.Append(key).Append('=').Append(v.GetRawText()).Append('\n');
        }
        var state = new StringBuilder(content.ToString());
        foreach (var key in new[] { "size", "frame" })
        {
            if (w.TryGetProperty(key, out var v)) state.Append(key).Append('=').Append(v.GetRawText()).Append('\n');
        }
        return new HomeWidget(id, app, name, title)
        {
            I18n = HomeJson.I18n(w),
            Icon = HomeJson.Str(w, "icon"),
            Link = HomeJson.Str(w, "link"),
            Peer = HomeJson.Str(w, "peer"),
            Stale = HomeJson.Bool(w, "stale"),
            Size = HomeJson.Str(w, "size"),
            Kind = HomeJson.Str(w, "kind") is "items" or "embed" ? HomeJson.Str(w, "kind") : null,
            Ok = HomeJson.OptBool(w, "ok"),
            Items = items,
            Blocks = blocks,
            AsOf = HomeJson.Str(w, "asOf"),
            StaleAfterMs = HomeJson.Num(w, "staleAfterMs"),
            Error = HomeJson.Str(w, "error"),
            Views = views,
            Actions = actions,
            Frame = FrameOf(w),
            State = state.ToString(),
            Content = content.ToString(),
        };
    }
}

/// <summary>
/// A widget card as the panel draws it (src/web/WidgetBlocks.tsx, docs/panel.md#widgets), the
/// Mac (<c>WidgetBlocksView.swift</c>) and Linux (<c>core/widgets.ts</c>) do: the first block is the
/// hero, the rest compact rows, as many as the card's size holds; a card without blocks is its
/// list; an <c>embed</c> widget is the app's own page. The numbers read as the panel writes them.
/// </summary>
public static class WidgetBlocks
{
    public const int MaxBlocks = 12;
    private const int MaxPoints = 90, MaxZones = 8, MaxTanks = 3;

    /// <summary>Compact rows beside the hero, per card size (WidgetBlocks.tsx <c>ROWS</c>).</summary>
    public static int RowsFor(string? size) => size switch { "1x1" => 2, "2x1" => 4, "1x2" => 6, "2x2" => 10, _ => 2 };

    /// <summary>List rows a card without blocks shows: more on a tall card.</summary>
    public static int ItemsFor(string? size) => size is "1x2" or "2x2" ? 8 : 4;

    public static CardBody BodyOf(HomeWidget w)
    {
        if (w.Ok == false) return CardBody.Error;
        if (w.Kind == "embed") return CardBody.Embed;
        if (w.Blocks is { Count: > 0 }) return CardBody.Blocks;
        if (w.Items is { Count: > 0 }) return CardBody.Items;
        return CardBody.Empty;
    }

    /// <summary>A block card whose <c>asOf</c> is older than its <c>staleAfter</c> says so (WidgetBlocks.tsx <c>isOutdated</c>).</summary>
    public static bool IsOutdated(string? asOf, double? staleAfterMs, DateTimeOffset now) =>
        asOf is not null && staleAfterMs is > 0 && HomeTime.Parse(asOf) is { } t && (now - t).TotalMilliseconds > staleAfterMs;

    // Decoding, with the checks of src/space/panel/blocks.ts.

    private static Tone? ToneOf(JsonElement o, string key = "tone") => HomeJson.Str(o, key) switch
    {
        "positive" => Core.Tone.Positive,
        "negative" => Core.Tone.Negative,
        "warning" => Core.Tone.Warning,
        "neutral" => Core.Tone.Neutral,
        _ => null,
    };

    private static string? UrlOf(JsonElement o) => HomeJson.Str(o, "url") is { Length: > 0 and <= 2048 } u ? u : null;

    private static bool IsTime(string? s) => s is { Length: <= 40 } && HomeTime.Parse(s) is not null;

    public static WidgetBlock? Decode(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object || BlockText.Decode(r, "label") is not { } label) return null;
        WidgetBlock? block = null;
        switch (HomeJson.Str(r, "type"))
        {
            case "metric":
            {
                var (value, valid) = HomeJson.NumOrNull(r, "value");
                if (!valid) return null;
                BlockDelta? delta = null;
                if (r.TryGetProperty("delta", out var d) && d.ValueKind == JsonValueKind.Object && HomeJson.Num(d, "value") is { } dv)
                {
                    delta = new BlockDelta(dv, NumberStyle.Decode(d), BlockText.Decode(d, "label"), ToneOf(d));
                }
                block = new MetricBlock(label, value, NumberStyle.Decode(r)) { Display = BlockText.Decode(r, "display"), Delta = delta };
                break;
            }
            case "trend":
            {
                if (!r.TryGetProperty("points", out var pts) || pts.ValueKind != JsonValueKind.Array) return null;
                var points = new List<TrendPoint>();
                foreach (var p in pts.EnumerateArray())
                {
                    if (p.ValueKind != JsonValueKind.Object || HomeJson.Str(p, "t") is not { } t || !IsTime(t)) continue;
                    points.Add(new TrendPoint(t, HomeJson.NumOrNull(p, "v").Value));
                }
                if (points.Count > MaxPoints) points = points.GetRange(points.Count - MaxPoints, MaxPoints);
                block = new TrendBlock(label, points, NumberStyle.Decode(r), HomeJson.Str(r, "style") == "bar", HomeJson.Bool(r, "signed"));
                break;
            }
            case "progress":
            {
                var (value, valid) = HomeJson.NumOrNull(r, "value");
                var max = HomeJson.Num(r, "max") ?? 100;
                if (!valid || max <= 0) return null;
                block = new ProgressBlock(label, value, max, NumberStyle.Decode(r)) { Display = BlockText.Decode(r, "display") };
                break;
            }
            case "gauge":
            {
                var (value, valid) = HomeJson.NumOrNull(r, "value");
                var min = HomeJson.Num(r, "min") ?? 0;
                var max = HomeJson.Num(r, "max") ?? 100;
                if (!valid || max <= min) return null;
                var zones = new List<GaugeZone>();
                if (r.TryGetProperty("zones", out var zs) && zs.ValueKind == JsonValueKind.Array)
                {
                    foreach (var z in zs.EnumerateArray().Take(MaxZones))
                    {
                        if (z.ValueKind == JsonValueKind.Object && HomeJson.Num(z, "to") is { } to && ToneOf(z) is { } tone) zones.Add(new GaugeZone(to, tone, BlockText.Decode(z, "label")));
                    }
                }
                block = new GaugeBlock(label, value, min, max) { Display = BlockText.Decode(r, "display"), Zones = zones.OrderBy(z => z.To).ToList() };
                break;
            }
            case "tanks":
            {
                if (!r.TryGetProperty("tanks", out var ts) || ts.ValueKind != JsonValueKind.Array) return null;
                var tanks = new List<Tank>();
                foreach (var k in ts.EnumerateArray())
                {
                    if (k.ValueKind != JsonValueKind.Object || BlockText.Decode(k, "label") is not { } kl) continue;
                    var (value, valid) = HomeJson.NumOrNull(k, "value");
                    var max = HomeJson.Num(k, "max") ?? 100;
                    if (!valid || max <= 0) continue;
                    tanks.Add(new Tank(kl, value, max, BlockText.Decode(k, "display"), ToneOf(k), UrlOf(k)));
                    if (tanks.Count >= MaxTanks) break;
                }
                if (tanks.Count == 0) return null;
                block = new TanksBlock(label, tanks, NumberStyle.Decode(r));
                break;
            }
            case "status":
            {
                if (BlockText.Decode(r, "value") is not { } value) return null;
                block = new StatusBlock(label, value) { Time = HomeJson.Str(r, "time") is { } t && IsTime(t) ? t : null };
                break;
            }
        }
        return block is null ? null : block with
        {
            Caption = BlockText.Decode(r, "caption"),
            Url = UrlOf(r),
            Tone = ToneOf(r),
            Copy = HomeJson.Str(r, "copy") is { Length: >= 1 and <= MaxCopy } copy ? copy : null,
            Action = BlockActionOf(r),
        };
    }

    public const int MaxCopy = 8000, MinViews = 2, MaxViews = 4, MaxCardActions = 3, MaxActionValue = 2000;
    private static readonly System.Text.RegularExpressions.Regex ViewId = new("^[a-z0-9][a-z0-9_-]{0,31}$");
    private static readonly System.Text.RegularExpressions.Regex ActionId = new("^[A-Za-z0-9._:-]{1,128}$");

    private static BlockAction? BlockActionOf(JsonElement r)
    {
        if (!r.TryGetProperty("action", out var a) || a.ValueKind != JsonValueKind.Object) return null;
        if (HomeJson.Str(a, "id") is not { } id || !ActionId.IsMatch(id) || HomeJson.Str(a, "kind") is not ("check" or "button") || BlockText.Decode(a, "label") is not { } label) return null;
        return new BlockAction(id, HomeJson.Str(a, "kind")!, label, BlockText.Decode(a, "confirm"));
    }

    /// <summary>The blocks of a list, valid ones only, at most <see cref="MaxBlocks"/>; null when it is not a list.</summary>
    internal static List<WidgetBlock>? DecodeList(JsonElement o, string key)
    {
        if (!o.TryGetProperty(key, out var bl) || bl.ValueKind != JsonValueKind.Array) return null;
        var blocks = new List<WidgetBlock>();
        foreach (var b in bl.EnumerateArray())
        {
            if (Decode(b) is { } block) blocks.Add(block);
            if (blocks.Count >= MaxBlocks) break;
        }
        return blocks;
    }

    /// <summary>
    /// The views of a payload (src/space/panel/blocks.ts <c>sanitizeViews</c>): 2 to 4 with a valid,
    /// unique id, a label and at least one valid block; null when fewer than two remain.
    /// </summary>
    public static List<WidgetView>? DecodeViews(JsonElement w)
    {
        if (!w.TryGetProperty("views", out var vs) || vs.ValueKind != JsonValueKind.Array) return null;
        var output = new List<WidgetView>();
        foreach (var v in vs.EnumerateArray())
        {
            if (output.Count >= MaxViews) break;
            if (v.ValueKind != JsonValueKind.Object || HomeJson.Str(v, "id") is not { } id || !ViewId.IsMatch(id) || output.Any(x => x.Id == id)) continue;
            if (BlockText.Decode(v, "label") is not { } label || DecodeList(v, "blocks") is not { Count: > 0 } blocks) continue;
            output.Add(new WidgetView(id, label, blocks));
        }
        return output.Count >= MinViews ? output : null;
    }

    /// <summary>
    /// The card-level actions (src/space/panel/blocks.ts <c>sanitizeActions</c>): valid ones only, at
    /// most 3, one <c>input</c> (a second is dropped), ids unique; null when none is valid.
    /// </summary>
    public static List<CardAction>? DecodeActions(JsonElement w)
    {
        if (!w.TryGetProperty("actions", out var list) || list.ValueKind != JsonValueKind.Array) return null;
        var output = new List<CardAction>();
        foreach (var a in list.EnumerateArray())
        {
            if (output.Count >= MaxCardActions) break;
            if (a.ValueKind != JsonValueKind.Object || HomeJson.Str(a, "id") is not { } id || !ActionId.IsMatch(id) || output.Any(x => x.Id == id)) continue;
            var kind = HomeJson.Str(a, "kind");
            if (kind is not ("input" or "button") || kind == "input" && output.Any(x => x.Kind == "input")) continue;
            if (BlockText.Decode(a, "label") is not { } label) continue;
            output.Add(new CardAction(id, kind, label, kind == "input" ? BlockText.Decode(a, "placeholder") : null, BlockText.Decode(a, "confirm")));
        }
        return output.Count > 0 ? output : null;
    }

    // Values.

    /// <summary>The value a block leads with, or null when the app could not obtain it.</summary>
    public static string? Shown(WidgetBlock b, string lang) => b switch
    {
        MetricBlock m => m.Display is { } d ? d.Pick(lang) : m.Value is { } v ? NumberText.Format(v, m.Style, lang) : null,
        ProgressBlock p => p.Display is { } d ? d.Pick(lang) : p.Value is { } v ? NumberText.Format(v, p.Style, lang) : null,
        GaugeBlock g => g.Display is { } d ? d.Pick(lang) : g.Value is { } v ? NumberText.Format(v, new NumberStyle(), lang) : null,
        TrendBlock t => t.Points.LastOrDefault(p => p.V is not null)?.V is { } last ? NumberText.Format(last, t.Style, lang, t.Signed) : null,
        StatusBlock s => s.Value.Pick(lang),
        _ => null,
    };

    /// <summary>A tank's short value: the app's own text, else its share of <c>max</c> in percent.</summary>
    public static string? TankValue(Tank k, string lang) =>
        k.Display is { } d ? d.Pick(lang) : k.Value is { } v ? NumberText.Format(v / k.Max * 100, new NumberStyle("percent", Decimals: 0), lang) : null;

    /// <summary>How full a tank is, 0 and up; above 1 it spills over.</summary>
    public static double TankLevel(Tank k) => k.Value is not { } v || !(k.Max > 0) ? 0 : Math.Max(0, v / k.Max);

    /// <summary>A metric's change, arrow first; toned only when the app says whether it is good or bad.</summary>
    public static (string Text, Tone? Tone)? DeltaText(WidgetBlock b, string lang, bool withLabel)
    {
        if (b is not MetricBlock { Delta: { } d }) return null;
        var arrow = d.Value > 0 ? "▲ " : d.Value < 0 ? "▼ " : "";
        var label = withLabel ? BlockText.Of(d.Label, lang) : "";
        return (arrow + NumberText.Format(Math.Abs(d.Value), d.Style, lang) + (label.Length > 0 ? " " + label : ""), d.Tone);
    }

    /// <summary>The tone a value is drawn in: the block's own, or for a gauge the zone its value is in.</summary>
    public static Tone? ToneOf(WidgetBlock b)
    {
        if (b.Tone is { } t) return t;
        if (b is not GaugeBlock { Value: { } v } g) return null;
        return g.Zones.FirstOrDefault(z => v <= z.To)?.Tone;
    }

    /// <summary>A progress as a share of its bar, 0…1.</summary>
    public static double Fraction(ProgressBlock b) => b.Value is not { } v || !(b.Max > 0) ? 0 : Math.Clamp(v / b.Max, 0, 1);

    /// <summary>Where a value sits on a gauge's scale, 0…1.</summary>
    public static double Position(GaugeBlock b, double v) => b.Max > b.Min ? Math.Clamp((v - b.Min) / (b.Max - b.Min), 0, 1) : 0;

    /// <summary>A gauge's zones as stretches of its scale, 0…1.</summary>
    public static IReadOnlyList<(double Start, double End, Tone Tone)> GaugeSegments(GaugeBlock b)
    {
        var from = b.Min;
        var output = new List<(double, double, Tone)>();
        foreach (var z in b.Zones)
        {
            output.Add((Position(b, from), Position(b, Math.Min(z.To, b.Max)), z.Tone));
            from = z.To;
        }
        return output;
    }

    /// <summary>
    /// A trend in a unit square (x right, y down, 0…1): a line as runs broken at missing points, or
    /// bars from the zero line, the latest one marked so it can be drawn at full strength. Null with no value.
    /// </summary>
    public static Spark? SparkOf(TrendBlock b)
    {
        var values = b.Points.Where(p => p.V is not null).Select(p => p.V!.Value).ToList();
        if (values.Count == 0) return null;
        var fromZero = b.Signed || b.Bars;
        var lo = fromZero ? Math.Min(0, values.Min()) : values.Min();
        var hi = fromZero ? Math.Max(0, values.Max()) : values.Max();
        var span = hi - lo is var s && s != 0 ? s : 1;
        var n = Math.Max(b.Points.Count, 2);
        var step = 1.0 / n;
        double Y(double v) => 1 - (v - lo) / span;
        if (b.Bars)
        {
            var last = -1;
            for (var i = 0; i < b.Points.Count; i++)
            {
                if (b.Points[i].V is not null) last = i;
            }
            var zero = Y(0);
            var bars = new List<SparkBar>();
            for (var i = 0; i < b.Points.Count; i++)
            {
                if (b.Points[i].V is not { } v) continue;
                var top = Math.Min(Y(v), zero);
                var bottom = Math.Max(Y(v), zero);
                bars.Add(new SparkBar(i * step + step * 0.15, step * 0.7, top, Math.Max(bottom, top + 0.01), b.Signed && v < 0, i == last) { Index = i });
            }
            return new Spark(true, zero, [], bars);
        }
        var runs = new List<IReadOnlyList<(double X, double Y)>>();
        var run = new List<(double X, double Y)>();
        for (var i = 0; i < b.Points.Count; i++)
        {
            if (b.Points[i].V is not { } v)
            {
                if (run.Count > 0) runs.Add(run);
                run = [];
                continue;
            }
            run.Add((i * step + step / 2, Y(v)));
        }
        if (run.Count > 0) runs.Add(run);
        return new Spark(false, Y(0), runs, []);
    }
}

public sealed record SparkBar(double X, double Width, double Top, double Bottom, bool Negative, bool Latest)
{
    /// <summary>The point the bar stands for, so the one under the pointer can be drawn at full strength.</summary>
    public int Index { get; init; }
}

/// <summary>A trend drawn in a unit square: <see cref="Runs"/> of a line, or <see cref="BarList"/> from <see cref="Zero"/>.</summary>
public sealed record Spark(bool Bars, double Zero, IReadOnlyList<IReadOnlyList<(double X, double Y)>> Runs, IReadOnlyList<SparkBar> BarList);

/// <summary>
/// Numbers in the reader's language as the panel writes them (WidgetBlocks.tsx <c>fmt</c>, which
/// uses <c>Intl.NumberFormat</c> for <c>en</c> or <c>zh-CN</c>): grouped digits, <c>percent</c> of
/// a value given in percent, <c>currency</c> with its narrow symbol (compact from 100,000), and
/// <c>compact</c> as K/M/B/T or 万/亿.
/// </summary>
public static class NumberText
{
    public static string Format(double v, NumberStyle n, string lang, bool signed = false)
    {
        var zh = lang == "zh";
        var d = n.Decimals;
        string s;
        switch (n.Format)
        {
            case "percent":
                s = Signed(v, signed, Fixed(Math.Abs(v), d ?? 0, d ?? 1) + "%");
                break;
            case "currency":
            {
                var code = n.Currency ?? "USD";
                var digits = code is "JPY" or "KRW" ? 0 : 2;
                var symbol = Symbol(code);
                var body = Math.Abs(v) >= 100_000
                    ? Compact(Math.Abs(v), Math.Min(digits, d ?? 2), d ?? 2, zh)
                    : Fixed(Math.Abs(v), d ?? digits, d ?? digits);
                s = Signed(v, signed, symbol + body);
                break;
            }
            case "compact":
                s = Signed(v, signed, Compact(Math.Abs(v), 0, d ?? 1, zh));
                break;
            default:
                s = Signed(v, signed, Fixed(Math.Abs(v), d ?? 0, d ?? 2));
                break;
        }
        var unit = BlockText.Of(n.Unit, lang);
        return unit.Length > 0 ? $"{s} {unit}" : s;
    }

    /// <summary>A minus before a negative value that does not round to zero; a plus too when <paramref name="signed"/> and it is above zero.</summary>
    private static string Signed(double v, bool signed, string body)
    {
        var isZero = body.All(c => !char.IsAsciiDigit(c) || c == '0');
        if (isZero) return body;
        if (v < 0) return "-" + body;
        return signed && v > 0 ? "+" + body : body;
    }

    private static string Symbol(string code) => code switch
    {
        "USD" or "AUD" or "CAD" or "HKD" or "NZD" or "SGD" or "MXN" or "TWD" => "$",
        "EUR" => "€",
        "GBP" => "£",
        "JPY" or "CNY" => "¥",
        "KRW" => "₩",
        "INR" => "₹",
        "RUB" => "₽",
        "ILS" => "₪",
        "VND" => "₫",
        "PHP" => "₱",
        "UAH" => "₴",
        "NGN" => "₦",
        "TRY" => "₺",
        _ => code + " ",
    };

    /// <summary>A non-negative number with grouping and between <paramref name="min"/> and <paramref name="max"/> decimals.</summary>
    public static string Fixed(double v, int min, int max, bool group = true)
    {
        max = Math.Max(max, min);
        var rounded = Math.Round(v, Math.Min(max, 15), MidpointRounding.AwayFromZero);
        var pattern = (group ? "#,##0" : "0") + (max > 0 ? "." + new string('0', min) + new string('#', max - min) : "");
        return rounded.ToString(pattern, CultureInfo.InvariantCulture);
    }

    private static readonly (double Size, string Suffix)[] English = [(1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")];
    private static readonly (double Size, string Suffix)[] Chinese = [(1e12, "万亿"), (1e8, "亿"), (1e4, "万")];

    /// <summary>A non-negative number in compact notation: 1.2K, 3.4M; 1.2万, 3.4亿; below the first step as it is (in Chinese without grouping).</summary>
    public static string Compact(double v, int min, int max, bool zh)
    {
        var steps = zh ? Chinese : English;
        // The largest step the value reaches (the steps go from the largest down).
        var index = Array.FindIndex(steps, s => v >= s.Size);
        if (index < 0)
        {
            // 999.96 rounds up into the first step.
            if (Math.Round(v, max, MidpointRounding.AwayFromZero) < steps[^1].Size) return Fixed(v, min, max, group: !zh);
            index = steps.Length - 1;
        }
        var scaled = Math.Round(v / steps[index].Size, max, MidpointRounding.AwayFromZero);
        // 999.96K rounds to 1000K, which is 1M.
        if (index > 0 && scaled * steps[index].Size >= steps[index - 1].Size)
        {
            index--;
            scaled = Math.Round(v / steps[index].Size, max, MidpointRounding.AwayFromZero);
        }
        return Fixed(scaled, min, max) + steps[index].Suffix;
    }
}

/// <summary>How long ago a time was, in the steps the clients write it ("just now", "5 minutes ago", "yesterday", else the date).</summary>
public enum AgoUnit
{
    Now,
    Minutes,
    Hours,
    Days,
    Date,
}

public static class HomeTime
{
    /// <summary>An ISO 8601 time (docs/time.md); null when it is not one.</summary>
    public static DateTimeOffset? Parse(string? s) =>
        s is not null && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;

    /// <summary>
    /// The step and the count, negative for the past (Intl.RelativeTimeFormat's sign): under 45
    /// seconds now, then minutes, hours, and days up to a week; beyond that the date.
    /// </summary>
    public static (AgoUnit Unit, int Count) Ago(DateTimeOffset then, DateTimeOffset now)
    {
        var diff = (then - now).TotalSeconds;
        var abs = Math.Abs(diff);
        if (abs < 45) return (AgoUnit.Now, 0);
        if (abs < 3600) return (AgoUnit.Minutes, (int)Math.Round(diff / 60, MidpointRounding.AwayFromZero));
        if (abs < 86400) return (AgoUnit.Hours, (int)Math.Round(diff / 3600, MidpointRounding.AwayFromZero));
        if (abs < 7 * 86400) return (AgoUnit.Days, (int)Math.Round(diff / 86400, MidpointRounding.AwayFromZero));
        return (AgoUnit.Date, 0);
    }

    /// <summary>A date as the clients write one beyond a week: "Nov 1, 2026", "2026年11月1日", in the reader's zone.</summary>
    public static string DateText(DateTimeOffset t, string lang)
    {
        var local = t.ToLocalTime();
        return lang == "zh" ? $"{local.Year}年{local.Month}月{local.Day}日" : local.ToString("MMM d, yyyy", CultureInfo.InvariantCulture);
    }
}
