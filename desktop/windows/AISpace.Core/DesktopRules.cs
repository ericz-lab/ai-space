using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>
/// Which inbox threads deserve a desktop notification: unread ones that are new or changed since
/// the last look. The first look at a connection only records what is there, so connecting never
/// floods the screen with old messages (the Mac's <c>InboxSeen</c>).
/// </summary>
public sealed class InboxSeen
{
    [JsonPropertyName("lastAt")] public Dictionary<string, string> LastAt { get; set; } = [];
    [JsonPropertyName("seeded")] public bool Seeded { get; set; }

    public List<InboxItem> Fresh(IReadOnlyList<InboxItem> items)
    {
        var fresh = new List<InboxItem>();
        foreach (var item in items)
        {
            if (Seeded && item.Unread && !item.Done && (!LastAt.TryGetValue(item.Thread, out var at) || at != item.LastAt)) fresh.Add(item);
            LastAt[item.Thread] = item.LastAt;
        }
        Seeded = true;
        // Forget threads that are gone so the record does not grow without bound.
        if (LastAt.Count > 2000)
        {
            var present = items.Select(i => i.Thread).ToHashSet();
            foreach (var key in LastAt.Keys.Where(k => !present.Contains(k)).ToList()) LastAt.Remove(key);
        }
        return fresh;
    }
}

/// <summary>Which app, if any, a link belongs to: such links open in that app's tab (the Mac's <c>AppRoutes</c>).</summary>
public static class AppRoutes
{
    public static AppInfo? AppFor(Uri url, IEnumerable<AppInfo> apps, Uri space, string? lang = null)
    {
        if (!ConnectionRules.IsWeb(url)) return null;
        AppInfo? best = null;
        var bestLength = -1;
        foreach (var app in apps)
        {
            var page = app.PageUrl(space, lang);
            if (page is null || !ConnectionRules.SameOrigin(page, url)) continue;
            var length = 0;
            if (ConnectionRules.SameOrigin(page, space))
            {
                // An app served from the panel's own origin owns its path, never the panel's root.
                var prefix = page.AbsolutePath.TrimEnd('/');
                if (prefix.Length == 0 || !(url.AbsolutePath == prefix || url.AbsolutePath.StartsWith(prefix + "/", StringComparison.Ordinal))) continue;
                length = prefix.Length;
            }
            if (length > bestLength)
            {
                best = app;
                bestLength = length;
            }
        }
        return best;
    }
}

/// <summary>Keep the active app visible without moving the other shortcuts out of opening order (the Mac's <c>OpenTabLayout</c>).</summary>
public static class OpenTabLayout
{
    public const int Shown = 5;

    public static List<string> Visible(IReadOnlyList<string> ids, string? selected)
    {
        var result = ids.Take(Shown).ToList();
        if (selected is not null && ids.Contains(selected) && !result.Contains(selected)) result[^1] = selected;
        return result;
    }
}

/// <summary>
/// <c>aispace://</c> links, for scripts, shortcuts and other apps. A link may fill in a message but
/// never sends it: any web page can open such a link, so sending always waits for the person
/// (the Mac's <c>DeepLink</c>).
/// </summary>
public abstract record DeepLink
{
    public const string Scheme = "aispace";

    public sealed record Chat(string? Agent, string? Text) : DeepLink;
    public sealed record Open(string App) : DeepLink;
    public sealed record ShowInbox : DeepLink;
    public sealed record Show : DeepLink;

    private static readonly Regex Head = new(@"^aispace:(?://)?([^/?#]*)", RegexOptions.IgnoreCase);

    public static DeepLink? Parse(string link)
    {
        var m = Head.Match(link.Trim());
        if (!m.Success) return null;
        var q = Query.Parse(link);
        string? Value(string k) => q.TryGetValue(k, out var v) && v.Length > 0 ? v : null;
        switch (m.Groups[1].Value.ToLowerInvariant())
        {
            case "chat":
                var text = Value("text");
                return new Chat(Value("agent"), text is null ? null : text[..Math.Min(text.Length, 20_000)]);
            case "open":
                return Value("app") is { } app ? new Open(app) : null;
            case "inbox":
                return new ShowInbox();
            case "":
            case "show":
                return new Show();
            default:
                return null;
        }
    }
}

/// <summary>
/// The web panel's own windows, opened from its address (src/web/panel-link.ts): <c>#inbox</c>,
/// <c>#terminal</c>, <c>#settings</c>, <c>#shortcuts</c>, and <c>#chat=&lt;agent&gt;&amp;text=…</c>,
/// whose text fills the message field and is not sent.
/// </summary>
public static class PanelLink
{
    public static Uri Inbox(Uri panel) => With(panel, "inbox");

    public static Uri Terminal(Uri panel) => With(panel, "terminal");

    public static Uri Settings(Uri panel) => With(panel, "settings");

    public static Uri Chat(Uri panel, string? agent, string? text = null)
    {
        var parts = new List<string> { "chat" + (agent is null ? "" : "=" + Uri.EscapeDataString(agent)) };
        if (!string.IsNullOrEmpty(text)) parts.Add("text=" + Uri.EscapeDataString(text));
        return With(panel, string.Join("&", parts));
    }

    private static Uri With(Uri panel, string fragment) => new(ConnectionRules.Origin(panel), panel.AbsolutePath + "#" + fragment);
}

public static class Query
{
    /// <summary>The query of a URL as pairs, decoded; <c>+</c> is a space as in a form; the first of a repeated key wins.</summary>
    public static Dictionary<string, string> Parse(string url)
    {
        var i = url.IndexOf('?');
        var q = i < 0 ? "" : url[(i + 1)..].Split('#')[0];
        var result = new Dictionary<string, string>();
        foreach (var part in q.Split('&'))
        {
            if (part.Length == 0) continue;
            var eq = part.IndexOf('=');
            var key = Decode(eq < 0 ? part : part[..eq]);
            result.TryAdd(key, Decode(eq < 0 ? "" : part[(eq + 1)..]));
        }
        return result;
    }

    private static string Decode(string s)
    {
        try
        {
            return Uri.UnescapeDataString(s.Replace('+', ' '));
        }
        catch (UriFormatException)
        {
            return s;
        }
    }
}
