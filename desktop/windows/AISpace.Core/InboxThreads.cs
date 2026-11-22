using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The inbox page's rules (docs/notify.md#inbox; the web's src/web/Inbox.tsx, the Mac's
/// <c>InboxPage</c>, the Linux client's <c>app/inbox.ts</c>): every app's notifications as threads,
/// one per app and key (the server groups them: a task that failed 300 times is one thread with a
/// count), newest first, read or unread, open or done. Opening a thread marks it read; Done closes it
/// until a newer notification arrives in it. <c>alert</c> and <c>warn</c> ask for something to be done.
/// </summary>
public enum InboxFilter
{
    All,
    Unread,
    /// <summary>Open threads at a level that asks for something (<c>alert</c>, <c>warn</c>).</summary>
    Handle,
    Done,
}

/// <summary>One thread as <c>GET /api/inbox</c> lists it (src/space/notify/inbox.ts).</summary>
public sealed record InboxThread(
    string Thread,
    string App,
    string Level,
    string? Title,
    string Text,
    string? Url,
    int Count,
    DateTimeOffset? FirstAt,
    DateTimeOffset? LastAt,
    bool Action,
    bool Unread,
    bool Done)
{
    /// <summary>The thread's name in the list: its title, else the first line of its text.</summary>
    public string Heading => string.IsNullOrWhiteSpace(Title) ? InboxRules.FirstLine(Text) : Title!;

    /// <summary>Asks for something and is not done yet.</summary>
    public bool NeedsAction => Action && !Done;
}

/// <summary>How a thread's level is drawn: a dot of the theme's critical, caution or success colour, or none.</summary>
public enum InboxTone
{
    None,
    Critical,
    Caution,
    Success,
}

/// <summary>A time as the list says it: just now, n minutes/hours/days ago (or ahead), else a date.</summary>
public enum RelativeUnit
{
    JustNow,
    Minutes,
    Hours,
    Days,
    Date,
}

public static class InboxRules
{
    /// <summary>The page asks for at most this many threads, as the web panel does.</summary>
    public const int Limit = 200;

    /// <summary>The route for a filter and an optional app (the web's <c>QUERY</c>).</summary>
    public static string Path(InboxFilter filter, string? app = null, int limit = Limit)
    {
        var query = filter switch
        {
            InboxFilter.Unread => "filter=unread",
            InboxFilter.Handle => "filter=open&action=1",
            InboxFilter.Done => "filter=done",
            _ => "filter=all",
        };
        var path = $"/api/inbox?{query}&limit={limit.ToString(CultureInfo.InvariantCulture)}";
        return string.IsNullOrEmpty(app) ? path : $"{path}&app={Uri.EscapeDataString(app)}";
    }

    /// <summary>The route's answer: its threads (a malformed one skipped) and the summary (counted from the threads when missing).</summary>
    public static (IReadOnlyList<InboxThread> Items, InboxSummary Summary) Decode(JsonElement root)
    {
        var items = new List<InboxThread>();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("items", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var r in list.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object) continue;
                var thread = Str(r, "thread");
                var app = Str(r, "app");
                var text = Str(r, "text");
                if (thread is null || app is null || text is null) continue;
                var count = r.TryGetProperty("count", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetInt32(out var n) ? Math.Max(1, n) : 1;
                var level = Str(r, "level") ?? "info";
                var action = r.TryGetProperty("action", out var a) ? a.ValueKind == JsonValueKind.True : level is "alert" or "warn";
                items.Add(new InboxThread(thread, app, level, Str(r, "title"), text, Str(r, "url"), count, Time(r, "firstAt"), Time(r, "lastAt"), action, Bool(r, "unread"), Bool(r, "done")));
            }
        }
        return (items, Summary(root, items));
    }

    /// <summary>The <c>summary</c> of an answer (the list's, or a mark's), else counted from <paramref name="items"/>.</summary>
    public static InboxSummary Summary(JsonElement root, IReadOnlyList<InboxThread>? items = null)
    {
        int? Num(string key) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty("summary", out var s) && s.ValueKind == JsonValueKind.Object && s.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;
        items ??= [];
        return new InboxSummary(Num("unread") ?? items.Count(i => i.Unread), Num("open") ?? items.Count(i => i.NeedsAction));
    }

    /// <summary>
    /// A thread after a mark, as the server sets it (src/space/notify/inbox.ts <c>mark</c>): done implies
    /// read; reopening leaves it read. Shown at once, before the list is fetched again.
    /// </summary>
    public static InboxThread Marked(InboxThread t, bool? read = null, bool? done = null)
    {
        var unread = t.Unread;
        var isDone = t.Done;
        if (read is { } r) unread = !r;
        if (done == true)
        {
            isDone = true;
            unread = false;
        }
        else if (done == false)
        {
            isDone = false;
        }
        return t with { Unread = unread, Done = isDone };
    }

    /// <summary>Whether a thread belongs under the filter (after a mark, a thread may leave it).</summary>
    public static bool Matches(InboxThread t, InboxFilter filter) => filter switch
    {
        InboxFilter.Unread => t.Unread,
        InboxFilter.Handle => t.NeedsAction,
        InboxFilter.Done => t.Done,
        _ => true,
    };

    /// <summary>The apps the filter offers: every app seen so far, so narrowing the list never empties it (the web's app menu).</summary>
    public static IReadOnlyList<string> Apps(IEnumerable<string> known, IEnumerable<InboxThread> items) =>
        known.Concat(items.Select(i => i.App)).Where(a => a.Length > 0).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList();

    /// <summary>What the list shows of each thread: the same key means nothing to draw again.</summary>
    public static string Key(IEnumerable<InboxThread> items) =>
        string.Join("\n", items.Select(i => $"{i.Thread}\u001f{i.LastAt?.ToUnixTimeMilliseconds()}\u001f{i.Unread}\u001f{i.Done}\u001f{i.Count}"));

    public static InboxTone Tone(string level) => level switch
    {
        "alert" => InboxTone.Critical,
        "warn" => InboxTone.Caution,
        "success" => InboxTone.Success,
        _ => InboxTone.None,
    };

    /// <summary>The first line of a text, at most 140 characters (the web's <c>firstLine</c>).</summary>
    public static string FirstLine(string text)
    {
        var line = text.Split('\n', 2)[0].TrimEnd('\r');
        return line.Length > 140 ? line[..139] + "…" : line;
    }

    /// <summary>How long ago (or ahead) <paramref name="at"/> is, as the Linux client's <c>relativeTime</c>: under 45 s just now, then minutes, hours and days, a date from a week on.</summary>
    public static (RelativeUnit Unit, int Count) Relative(DateTimeOffset at, DateTimeOffset now)
    {
        var diff = (now - at).TotalSeconds;
        var abs = Math.Abs(diff);
        if (abs < 45) return (RelativeUnit.JustNow, 0);
        if (abs < 3600) return (RelativeUnit.Minutes, Math.Max(1, (int)Math.Round(abs / 60)));
        if (abs < 86400) return (RelativeUnit.Hours, Math.Max(1, (int)Math.Round(abs / 3600)));
        if (abs < 7 * 86400) return (RelativeUnit.Days, Math.Max(1, (int)Math.Round(abs / 86400)));
        return (RelativeUnit.Date, 0);
    }

    private static string? Str(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Bool(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static DateTimeOffset? Time(JsonElement o, string key) =>
        Str(o, key) is { } s && DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
}
