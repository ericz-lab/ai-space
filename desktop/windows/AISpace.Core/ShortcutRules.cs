using System.Globalization;

namespace AISpace.Core;

/// <summary>What an action's button does: a read shows its result, a write creates, a task runs.</summary>
public enum ShortcutSubmit
{
    Show,
    Create,
    Run,
}

/// <summary>
/// The Shortcuts page's rules (docs/shortcuts.md; the web's src/web/Shortcuts.tsx and ActionRunner.tsx,
/// the iPhone's <c>ShortcutExecution</c>): the catalogue's search and order, an action's form values,
/// what is sent, which buttons a run leaves, and how relative dates read before the run.
/// </summary>
public static class ShortcutRules
{
    public const string ActionsPath = "/api/shortcuts/actions";
    public const string RunsPath = "/api/shortcuts/runs";

    /// <summary>The recent runs the page lists, as the web panel.</summary>
    public const int RecentRuns = 30;

    /// <summary>A run in progress is read again this often (the web's <c>POLL_MS</c>).</summary>
    public static readonly TimeSpan FollowEvery = TimeSpan.FromSeconds(1.5);

    /// <summary>The recent runs are read again this often while the page is shown: often while one runs.</summary>
    public static TimeSpan RecentEvery(IEnumerable<ShortcutRun> runs) => runs.Any(r => r.Running) ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(15);

    /// <summary>The periods a <c>period</c> input offers (src/space/shortcuts/types.ts <c>PERIODS</c>).</summary>
    public static readonly IReadOnlyList<string> Periods = ["today", "tomorrow", "this-week", "next-week", "this-month", "last-7-days"];

    /// <summary>An action's text in <paramref name="lang"/>: the exact tag, then a tag with that primary subtag, then the base.</summary>
    public static ShortcutText? Translation(ShortcutAction a, string lang)
    {
        if (a.I18n.TryGetValue(lang, out var exact)) return exact;
        foreach (var (tag, text) in a.I18n)
        {
            if (tag.Split('-')[0] == lang) return text;
        }
        return null;
    }

    public static string Title(ShortcutAction a, string lang) => Translation(a, lang)?.Title is { Length: > 0 } t ? t : a.Title;

    public static string? Description(ShortcutAction a, string lang) => Translation(a, lang)?.Description is { Length: > 0 } d ? d : a.Description;

    public static string InputLabel(ShortcutAction a, ShortcutInput i, string lang) => Translation(a, lang)?.Inputs.TryGetValue(i.Name, out var l) == true && l.Length > 0 ? l : i.Label;

    public static string OptionLabel(ShortcutAction a, ShortcutOption o, string lang) => Translation(a, lang)?.Options.TryGetValue(o.Value, out var l) == true && l.Length > 0 ? l : o.Label;

    /// <summary>
    /// The catalogue under a search (case-insensitive, on the titles, descriptions, app and keywords in
    /// every language), the actions that can run first, each group in the catalogue's order.
    /// </summary>
    public static IReadOnlyList<ShortcutAction> Search(IEnumerable<ShortcutAction> actions, string query, string lang)
    {
        var needle = query.Trim();
        var list = actions.Where(a => needle.Length == 0 || Words(a, lang).Any(w => w.Contains(needle, StringComparison.CurrentCultureIgnoreCase))).ToList();
        return [.. list.Where(a => a.Available), .. list.Where(a => !a.Available)];
    }

    private static IEnumerable<string> Words(ShortcutAction a, string lang)
    {
        yield return Title(a, lang);
        if (Description(a, lang) is { } d) yield return d;
        yield return a.Title;
        yield return a.App;
        foreach (var k in a.Keywords) yield return k;
        foreach (var t in a.I18n.Values)
        {
            if (t.Title is { } title) yield return title;
            foreach (var k in t.Keywords) yield return k;
        }
    }

    /// <summary>The values a form opens with: the input's default, else the first option of a choice or task, else empty.</summary>
    public static Dictionary<string, string> InitialValues(ShortcutAction a)
    {
        var values = new Dictionary<string, string>();
        foreach (var i in a.Inputs) values[i.Name] = i.Default ?? (i.Type is "task" or "choice" && i.Options.Count > 0 ? i.Options[0].Value : "");
        return values;
    }

    /// <summary>The required inputs still empty.</summary>
    public static IReadOnlyList<ShortcutInput> Missing(ShortcutAction a, IReadOnlyDictionary<string, string> values) =>
        a.Inputs.Where(i => i.Required && (!values.TryGetValue(i.Name, out var v) || string.IsNullOrWhiteSpace(v))).ToList();

    /// <summary>
    /// The arguments sent: the filled inputs, a number as a number (its grouping commas dropped; a
    /// value that is not one goes as typed, for the server to refuse with its words).
    /// </summary>
    public static Dictionary<string, object> Payload(ShortcutAction a, IReadOnlyDictionary<string, string> values)
    {
        var args = new Dictionary<string, object>();
        foreach (var i in a.Inputs)
        {
            if (!values.TryGetValue(i.Name, out var v) || string.IsNullOrWhiteSpace(v)) continue;
            v = v.Trim();
            if (i.Type == "number" && double.TryParse(v.Replace(",", "", StringComparison.Ordinal), NumberStyles.Float, CultureInfo.InvariantCulture, out var n)) args[i.Name] = n;
            else args[i.Name] = v;
        }
        return args;
    }

    /// <summary>The body of <c>POST /api/shortcuts/runs</c>.</summary>
    public static Dictionary<string, object> RunBody(ShortcutAction a, IReadOnlyDictionary<string, string> values, string timezone, string requestId)
    {
        var body = new Dictionary<string, object> { ["action"] = a.Id, ["args"] = Payload(a, values), ["timezone"] = timezone, ["requestId"] = requestId };
        if (a.Peer is { Length: > 0 } peer) body["peer"] = peer;
        return body;
    }

    public static ShortcutSubmit SubmitKind(string effect) => effect switch
    {
        "write" => ShortcutSubmit.Create,
        "run" => ShortcutSubmit.Run,
        _ => ShortcutSubmit.Show,
    };

    /// <summary>Whether the form offers its button: a write or a task that went through is not offered again from the same form ("New" starts over).</summary>
    public static bool OffersSubmit(ShortcutRun? run, string effect) => !(run is not null && run.Status != "error" && effect != "read");

    /// <summary>Whether Retry is offered: a failed run that is not a task, or an unknown write to an idempotent provider.</summary>
    public static bool Retryable(ShortcutRun run, ShortcutAction? action) => run.Status switch
    {
        "error" => run.Effect != "run",
        "unknown" => action?.Idempotent == true,
        _ => false,
    };

    /// <summary>Whether the form mentions the time zone: an action with a date, time or period input.</summary>
    public static bool Zoned(ShortcutAction a) => a.Inputs.Any(i => i.Type is "date" or "time" or "period");

    /// <summary>The catalogue's action a run was of, here or on its peer.</summary>
    public static ShortcutAction? ActionOf(ShortcutRun run, IEnumerable<ShortcutAction> actions) =>
        actions.FirstOrDefault(a => a.Id == run.Action && (a.Peer ?? "") == (run.Peer ?? ""));

    /// <summary>A run's arguments on one line, as typed (a task run: its task).</summary>
    public static string Summary(ShortcutRun run)
    {
        if (run.Result is { Kind: "task", Task: { Length: > 0 } task }) return task;
        var line = string.Join(" · ", run.Args.Select(a => a.Value).Where(v => v.Length > 0));
        return line.Length > 80 ? line[..80] : line;
    }

    /// <summary>The value a value card copies.</summary>
    public static string CopyText(ShortcutResult r) => r.Value ?? r.Text ?? "";

    /// <summary>The operator's zone as an IANA name (the server never uses its own, docs/time.md); UTC when Windows' zone has none.</summary>
    public static string IanaZone(TimeZoneInfo? zone = null)
    {
        zone ??= TimeZoneInfo.Local;
        if (zone.HasIanaId) return zone.Id;
        return TimeZoneInfo.TryConvertWindowsIdToIanaId(zone.Id, out var iana) ? iana : "UTC";
    }

    /// <summary>
    /// How a relative date input reads on <paramref name="today"/> (the operator's date), shown before
    /// the run; null for a value that is already a date, empty, or not one (the server says why).
    /// </summary>
    public static string? ResolvedDate(string value, DateOnly today) => value.Trim() switch
    {
        "today" => Iso(today),
        "tomorrow" => Iso(today.AddDays(1)),
        "yesterday" => Iso(today.AddDays(-1)),
        _ => null,
    };

    /// <summary>A period's inclusive dates on <paramref name="today"/> (src/space/shortcuts/time.ts <c>resolvePeriod</c>; weeks start on Monday); null when it is not one.</summary>
    public static (DateOnly From, DateOnly To)? ResolvedPeriod(string value, DateOnly today)
    {
        var monday = today.AddDays(-(((int)today.DayOfWeek + 6) % 7));
        switch (value.Trim())
        {
            case "today": return (today, today);
            case "tomorrow": return (today.AddDays(1), today.AddDays(1));
            case "this-week": return (monday, monday.AddDays(6));
            case "next-week": return (monday.AddDays(7), monday.AddDays(13));
            case "this-month":
                var first = new DateOnly(today.Year, today.Month, 1);
                return (first, first.AddMonths(1).AddDays(-1));
            case "last-7-days": return (today.AddDays(-6), today);
        }
        var parts = value.Trim().Split("..");
        if (parts.Length == 2 && DateOnly.TryParseExact(parts[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from)
            && DateOnly.TryParseExact(parts[1], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to) && from <= to) return (from, to);
        return null;
    }

    /// <summary>The period's dates as the form shows them: one date, or <c>from – to</c>.</summary>
    public static string? ResolvedPeriodText(string value, DateOnly today) =>
        ResolvedPeriod(value, today) is { } p ? p.From == p.To ? Iso(p.From) : $"{Iso(p.From)} – {Iso(p.To)}" : null;

    /// <summary>Today in <paramref name="zone"/>.</summary>
    public static DateOnly Today(DateTimeOffset now, TimeZoneInfo zone) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);

    public static string Iso(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}
