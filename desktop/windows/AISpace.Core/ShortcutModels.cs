using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// Shortcuts' shapes as the client reads them (docs/shortcuts.md#model, src/space/shortcuts/types.ts;
/// the iPhone's <c>OmniboxModels.swift</c>). Read leniently: a field the page can live without is
/// optional, and a malformed action or run is skipped.
/// </summary>
public sealed record ShortcutOption(string Value, string Label);

/// <summary>One input of an action's form: <c>text</c>, <c>number</c>, <c>date</c>, <c>time</c>, <c>period</c>, <c>choice</c> or <c>task</c>.</summary>
public sealed record ShortcutInput(string Name, string Type, string Label, bool Required, string? Default, IReadOnlyList<ShortcutOption> Options, double? Min, double? Max, bool Query);

/// <summary>An action's text in another language: its title, description, keywords, inputs' and options' labels.</summary>
public sealed record ShortcutText(string? Title, string? Description, IReadOnlyList<string> Keywords, IReadOnlyDictionary<string, string> Inputs, IReadOnlyDictionary<string, string> Options);

/// <summary>One entry of <c>GET /api/shortcuts/actions</c>.</summary>
public sealed record ShortcutAction(
    string Id,
    string? Peer,
    string App,
    string Title,
    string? Description,
    IReadOnlyList<string> Keywords,
    string Effect,
    string Result,
    bool Idempotent,
    IReadOnlyList<ShortcutInput> Inputs,
    IReadOnlyDictionary<string, ShortcutText> I18n,
    bool Builtin,
    bool Available,
    string? Reason)
{
    /// <summary>Tells the same action here and on a peer apart (src/space/shortcuts/resolve.ts <c>actionKey</c>).</summary>
    public string Key => Peer is { Length: > 0 } p ? $"{p}:{Id}" : Id;
}

public sealed record ShortcutListItem(string Title, string? Url, string? Source, DateTimeOffset? At, string? Date, string? Time, string? Timezone, string? Detail, string? Tag);

public sealed record ShortcutReceiptItem(string Id, string Title, string? Url, string? Detail);

/// <summary>A run's result: <see cref="Kind"/> says which fields are set (<c>list</c>, <c>receipt</c>, <c>value</c>, <c>task</c>).</summary>
public sealed record ShortcutResult(
    string Kind,
    IReadOnlyList<ShortcutListItem> Items,
    IReadOnlyList<ShortcutReceiptItem> Receipt,
    DateTimeOffset? AsOf,
    // value
    string? Value,
    string? Text,
    string? Detail,
    string? Source,
    bool Stale,
    // task
    string? Task,
    DateTimeOffset? StartedAt,
    int? RunId,
    string? TaskStatus,
    string? Error,
    string? Output);

/// <summary>One run of <c>/api/shortcuts/runs</c>.</summary>
public sealed record ShortcutRun(
    long Id,
    string Action,
    string? Peer,
    string Title,
    string Effect,
    IReadOnlyList<KeyValuePair<string, string>> Args,
    string? Timezone,
    string Status,
    ShortcutResult? Result,
    string? Error,
    int Attempts,
    DateTimeOffset? CreatedAt)
{
    public bool Running => Status == "running";
}

public static class ShortcutJson
{
    public static IReadOnlyList<ShortcutAction> Actions(JsonElement root)
    {
        var list = new List<ShortcutAction>();
        foreach (var a in Array(root, "actions"))
        {
            if (Action(a) is { } action) list.Add(action);
        }
        return list;
    }

    public static ShortcutAction? Action(JsonElement a)
    {
        if (a.ValueKind != JsonValueKind.Object || Str(a, "id") is not { Length: > 0 } id) return null;
        var inputs = new List<ShortcutInput>();
        foreach (var i in Array(a, "inputs"))
        {
            if (i.ValueKind != JsonValueKind.Object || Str(i, "name") is not { Length: > 0 } name) continue;
            var options = new List<ShortcutOption>();
            foreach (var o in Array(i, "options"))
            {
                if (o.ValueKind == JsonValueKind.String && o.GetString() is { } v) options.Add(new ShortcutOption(v, v));
                else if (o.ValueKind == JsonValueKind.Object && Scalar(o, "value") is { } value) options.Add(new ShortcutOption(value, Str(o, "label") ?? value));
            }
            inputs.Add(new ShortcutInput(name, Str(i, "type") ?? "text", Str(i, "label") ?? name, Bool(i, "required"), Scalar(i, "default"), options, Num(i, "min"), Num(i, "max"), Bool(i, "query")));
        }
        var i18n = new Dictionary<string, ShortcutText>();
        if (a.TryGetProperty("i18n", out var tr) && tr.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in tr.EnumerateObject())
            {
                if (p.Value.ValueKind != JsonValueKind.Object) continue;
                i18n[p.Name] = new ShortcutText(Str(p.Value, "title"), Str(p.Value, "description"), Strings(p.Value, "keywords"), Map(p.Value, "inputs"), Map(p.Value, "options"));
            }
        }
        var app = Str(a, "app") ?? id.Split('/')[0];
        return new ShortcutAction(id, Str(a, "peer"), app, Str(a, "title") ?? id, Str(a, "description"), Strings(a, "keywords"), Str(a, "effect") ?? "read", Str(a, "result") ?? "value",
            Bool(a, "idempotent"), inputs, i18n, Bool(a, "builtin"), !a.TryGetProperty("available", out var av) || av.ValueKind != JsonValueKind.False, Str(a, "reason"));
    }

    public static IReadOnlyList<ShortcutRun> Runs(JsonElement root)
    {
        var list = new List<ShortcutRun>();
        foreach (var r in Array(root, "runs"))
        {
            if (Run(r) is { } run) list.Add(run);
        }
        return list;
    }

    /// <summary>A run, or the <c>run</c> of an answer that carries one (<c>{ run, duplicate }</c>).</summary>
    public static ShortcutRun? Run(JsonElement r)
    {
        if (r.ValueKind == JsonValueKind.Object && r.TryGetProperty("run", out var inner) && inner.ValueKind == JsonValueKind.Object) r = inner;
        if (r.ValueKind != JsonValueKind.Object || !r.TryGetProperty("id", out var idv) || idv.ValueKind != JsonValueKind.Number || !idv.TryGetInt64(out var id)) return null;
        if (Str(r, "action") is not { } action) return null;
        var args = new List<KeyValuePair<string, string>>();
        if (r.TryGetProperty("args", out var a) && a.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in a.EnumerateObject())
            {
                if (ScalarOf(p.Value) is { } v) args.Add(new(p.Name, v));
            }
        }
        var attempts = r.TryGetProperty("attempts", out var at) && at.ValueKind == JsonValueKind.Number && at.TryGetInt32(out var n) ? n : 1;
        return new ShortcutRun(id, action, Str(r, "peer"), Str(r, "title") ?? action, Str(r, "effect") ?? "read", args, Str(r, "timezone"), Str(r, "status") ?? "unknown",
            r.TryGetProperty("result", out var res) ? Result(res) : null, Str(r, "error"), attempts, Time(r, "createdAt"));
    }

    public static ShortcutResult? Result(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object || Str(r, "kind") is not { } kind) return null;
        var items = new List<ShortcutListItem>();
        var receipt = new List<ShortcutReceiptItem>();
        foreach (var i in Array(r, "items"))
        {
            if (i.ValueKind != JsonValueKind.Object || Str(i, "title") is not { } title) continue;
            if (kind == "receipt") receipt.Add(new ShortcutReceiptItem(Scalar(i, "id") ?? "", title, Str(i, "url"), Str(i, "detail")));
            else items.Add(new ShortcutListItem(title, Str(i, "url"), Str(i, "source"), Time(i, "at"), Str(i, "date"), Str(i, "time"), Str(i, "timezone"), Str(i, "detail"), Str(i, "tag")));
        }
        int? runId = r.TryGetProperty("runId", out var ri) && ri.ValueKind == JsonValueKind.Number && ri.TryGetInt32(out var rn) ? rn : null;
        return new ShortcutResult(kind, items, receipt, Time(r, "asOf"), Scalar(r, "value"), Str(r, "text"), Str(r, "detail"), Str(r, "source"), Bool(r, "stale"),
            Str(r, "task"), Time(r, "startedAt"), runId, Str(r, "status"), Str(r, "error"), Str(r, "output"));
    }

    private static IEnumerable<JsonElement> Array(JsonElement o, string key) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];

    private static string? Str(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static double? Num(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    /// <summary>A string or a number as text (a default of 100, a value of 440).</summary>
    private static string? Scalar(JsonElement o, string key) => o.TryGetProperty(key, out var v) ? ScalarOf(v) : null;

    private static string? ScalarOf(JsonElement v) => v.ValueKind switch
    {
        JsonValueKind.String => v.GetString(),
        JsonValueKind.Number => v.GetDouble().ToString("0.##########", CultureInfo.InvariantCulture),
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => null,
    };

    private static List<string> Strings(JsonElement o, string key) => Array(o, key).Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()!).ToList();

    private static Dictionary<string, string> Map(JsonElement o, string key)
    {
        var d = new Dictionary<string, string>();
        if (o.TryGetProperty(key, out var m) && m.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in m.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String) d[p.Name] = p.Value.GetString()!;
            }
        }
        return d;
    }

    private static DateTimeOffset? Time(JsonElement o, string key) =>
        Str(o, key) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
}
