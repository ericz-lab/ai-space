using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The Space API's shapes as the client reads them (src/web/api.ts has the full ones; the Mac's
/// <c>SpaceModels.swift</c>). Every field the app can live without is optional and a malformed
/// row is skipped, so a newer or older server still decodes.
/// </summary>
public sealed record LocalizedText(string? Title, string? Description);

public static class Lang
{
    /// <summary>The interface language's primary tag: <c>zh</c> or <c>en</c> in practice.</summary>
    public static string Current => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.ToLowerInvariant();

    /// <summary>Manifest text in a language: the exact tag, then its primary subtag, then the base.</summary>
    public static string Pick(string baseText, IReadOnlyDictionary<string, LocalizedText>? i18n, bool title, string? lang = null)
    {
        if (i18n is null) return baseText;
        lang ??= Current;
        string? Of(LocalizedText t) => title ? t.Title : t.Description;
        if (i18n.TryGetValue(lang, out var exact) && !string.IsNullOrEmpty(Of(exact))) return Of(exact)!;
        foreach (var (tag, text) in i18n)
        {
            if (tag.Split('-')[0] == lang && !string.IsNullOrEmpty(Of(text))) return Of(text)!;
        }
        return baseText;
    }
}

public sealed record AgentInfo(string Id, string App, string Name, string Title, string? Peer, string? Description, IReadOnlyDictionary<string, LocalizedText>? I18n, string? Avatar, bool Stale)
{
    public string DisplayTitle(string? lang = null) => Lang.Pick(Title, I18n, true, lang);
}

public sealed record AppInfo(string Id, string Name, string Title, string? Peer, string? Description, IReadOnlyDictionary<string, LocalizedText>? I18n, string? Icon, string? Url, string? Status, bool Hidden)
{
    public string DisplayTitle(string? lang = null) => Lang.Pick(Title, I18n, true, lang);

    /// <summary>The app's page with <c>{lang}</c> filled in, resolved against the Space when it is a path.</summary>
    public Uri? PageUrl(Uri space, string? lang = null)
    {
        if (string.IsNullOrEmpty(Url)) return null;
        var filled = Url.Replace("{lang}", lang ?? Lang.Current, StringComparison.Ordinal);
        return Uri.TryCreate(space, filled, out var u) && ConnectionRules.IsWeb(u) ? u : null;
    }

    /// <summary>The apps the panel offers: shown, with a page, and not archived (the Mac's <c>SpaceLive</c> filter).</summary>
    public bool Opens => !Hidden && !string.IsNullOrEmpty(Url) && Status != "archived";
}

public sealed record InboxItem(string Thread, string App, string Level, string? Title, string Text, string? Url, int Count, string LastAt, bool Unread, bool Done)
{
    public string Heading => string.IsNullOrEmpty(Title) ? App : Title;
}

public sealed record InboxSummary(int Unread, int Open);

public sealed record ChatRun(string Id, string Agent, string Message, string Status);

public sealed record Inbox(IReadOnlyList<InboxItem> Items, InboxSummary Summary);

public static class SpaceJson
{
    public static IReadOnlyList<AppInfo> Apps(JsonElement root) => Rows(root, "apps", r =>
    {
        var id = Str(r, "id");
        var name = Str(r, "name") ?? id;
        if (id is null || name is null) return null;
        return new AppInfo(id, name, Str(r, "title") ?? name, Str(r, "peer"), Str(r, "description"), I18n(r), Str(r, "icon"), Str(r, "url"), Str(r, "status"), Bool(r, "hidden"));
    });

    public static IReadOnlyList<AgentInfo> Agents(JsonElement root) => Rows(root, "agents", r =>
    {
        var id = Str(r, "id");
        var app = Str(r, "app");
        var name = Str(r, "name");
        if (id is null || app is null || name is null) return null;
        return new AgentInfo(id, app, name, Str(r, "title") ?? name, Str(r, "peer"), Str(r, "description"), I18n(r), Str(r, "avatar"), Bool(r, "stale"));
    });

    public static Inbox Inbox(JsonElement root)
    {
        var items = Rows(root, "items", r =>
        {
            var thread = Str(r, "thread");
            var app = Str(r, "app");
            var text = Str(r, "text");
            var lastAt = Str(r, "lastAt");
            if (thread is null || app is null || text is null || lastAt is null) return null;
            var count = r.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt32() : 1;
            return new InboxItem(thread, app, Str(r, "level") ?? "info", Str(r, "title"), text, Str(r, "url"), count, lastAt, Bool(r, "unread"), Bool(r, "done"));
        });
        int? Num(string key) => root.TryGetProperty("summary", out var s) && s.ValueKind == JsonValueKind.Object && s.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : null;
        var unread = Num("unread") ?? items.Count(i => i.Unread && !i.Done);
        var open = Num("open") ?? items.Count(i => !i.Done);
        return new Inbox(items, new InboxSummary(unread, open));
    }

    public static IReadOnlyList<ChatRun> Runs(JsonElement root) => Rows(root, "runs", r =>
    {
        var id = Str(r, "id");
        var agent = Str(r, "agent");
        var status = Str(r, "status");
        return id is null || agent is null || status is null ? null : new ChatRun(id, agent, Str(r, "message") ?? "", status);
    });

    /// <summary>The panel's first screen (<c>GET /api/panel/layout</c>): its tiles' keys, <c>app:&lt;id&gt;</c>, <c>agent:&lt;id&gt;</c>, ….</summary>
    public static IReadOnlyList<string> HomeItems(JsonElement root)
    {
        if (!root.TryGetProperty("layout", out var layout) || layout.ValueKind != JsonValueKind.Object) return [];
        if (!layout.TryGetProperty("screens", out var screens) || screens.ValueKind != JsonValueKind.Array) return [];
        foreach (var screen in screens.EnumerateArray())
        {
            if (screen.ValueKind != JsonValueKind.Object || !screen.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) continue;
            return items.EnumerateArray().Where(i => i.ValueKind == JsonValueKind.String).Select(i => i.GetString()!).ToList();
        }
        return [];
    }

    private static List<T> Rows<T>(JsonElement root, string key, Func<JsonElement, T?> map) where T : class
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(key, out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var rows = new List<T>();
        foreach (var r in list.EnumerateArray())
        {
            if (r.ValueKind == JsonValueKind.Object && map(r) is { } row) rows.Add(row);
        }
        return rows;
    }

    private static string? Str(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static Dictionary<string, LocalizedText>? I18n(JsonElement o)
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

public static class SpacePath
{
    /// <summary>One path segment, escaped as the Mac's <c>SpacePath.escape</c>: letters, digits and <c>-._~</c> stay.</summary>
    public static string Escape(string s) => Uri.EscapeDataString(s);
}
