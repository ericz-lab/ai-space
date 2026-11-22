using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The sections of the Space's Settings page, in the order the list shows them: the web panel's
/// (src/web/SettingsNav.tsx), with its Status first as the Overview and its Automation and Usage
/// split into their pages, then This Computer, the app's own preferences.
/// </summary>
public enum SettingsSection
{
    Overview,
    Models,
    Tasks,
    Events,
    Usage,
    Activity,
    Packages,
    /// <summary>Fix this (随手改), the feature the Space's routes call feedback (docs/feedback.md).</summary>
    FixThis,
    Appearance,
    Account,
    ThisComputer,
}

/// <summary>A status dot's colour: the panel's <c>status</c> classes.</summary>
public enum StatusTone
{
    Ok,
    Down,
    Paused,
    Running,
    Off,
    Unknown,
}

/// <summary>What a status dot says. The app turns each into its words.</summary>
public enum StateWord
{
    Up,
    Down,
    Unknown,
    Paused,
    Archived,
    UnitProblem,
    Fresh,
    Stale,
    Retired,
    Ready,
    Unreachable,
    NotInstalled,
    NotSignedIn,
    Limited,
    ProbeTimedOut,
    Unchecked,
    SpeechOff,
    NotFound,
    TaskOrphaned,
    TaskOff,
    TaskRunning,
    TaskOk,
    TaskError,
    TaskSkipped,
    TaskNeverRan,
    DeliveryPending,
    DeliverySent,
    DeliveryOk,
    DeliveryDead,
    DeliverySkipped,
}

public sealed record StateOf(StatusTone StatusTone, StateWord Word, int Count = 0);

/// <summary>A model picker's entry: the empty choice, a saved value no longer offered, or an option.</summary>
public enum ChoiceKind
{
    Empty,
    Missing,
    Option,
}

/// <summary>One entry of a model picker; <see cref="Disabled"/> shows it greyed, not selectable.</summary>
public sealed record ModelChoice(ChoiceKind Kind, string Value, ModelOption? Option, bool ShowRuntime)
{
    public bool Disabled => Kind == ChoiceKind.Missing || Option?.Unavailable is not null;
}

/// <summary>What a duration reads as: the unit pair <c>fmtDuration</c> of src/web/api.ts picks.</summary>
public enum DurationUnit
{
    Milliseconds,
    Seconds,
    MinutesSeconds,
    Minutes,
    HoursMinutes,
    Hours,
    DaysHours,
    Days,
}

/// <summary>How far a time is from now: src/web/api.ts's <c>relTime</c> and <c>untilTime</c>.</summary>
public enum RelUnit
{
    JustNow,
    MinutesAgo,
    HoursAgo,
    DaysAgo,
    Now,
    InLessThanAMinute,
    InMinutes,
    InHours,
    InDays,
}

public enum PasswordOutcome
{
    Changed,
    WrongCurrent,
    Rejected,
    NotSignedIn,
    Failed,
}

/// <summary>
/// The rules behind the Settings page's rows, without WPF: the same as the web panel's components
/// (SettingsStatus, AppModels, Tasks, Events, Usage, Activity, Auth) and the Linux client's
/// <c>core/settings.ts</c>, so the three read a Space alike.
/// </summary>
public static class SettingsRules
{
    public static readonly IReadOnlyList<SettingsSection> Sections = Enum.GetValues<SettingsSection>();

    /// <summary>The sections the app draws itself; the others lead to the web panel's Settings.</summary>
    public static bool IsNative(SettingsSection s) => s is not SettingsSection.Appearance;

    /// <summary>Below this width (device-independent pixels) the section list shows its icons only.</summary>
    public const double CollapseBelow = 900;

    public static bool NavCollapsed(double width) => width > 0 && width < CollapseBelow;

    /// <summary>A section's name as it is kept; a name this version does not know is the Overview.</summary>
    public static string Key(SettingsSection s) => s.ToString().ToLowerInvariant();

    public static SettingsSection Parse(string? key) =>
        // "feedback" is what Fix this was called when the section was last remembered.
        key?.Trim() == "feedback" ? SettingsSection.FixThis
        : Sections.FirstOrDefault(s => string.Equals(Key(s), key?.Trim(), StringComparison.Ordinal), SettingsSection.Overview);

    // ------------------------------------------------------------------ Fix this

    /// <summary>What happens to a request: <c>auto</c> is Fix now, <c>later</c> is Fix later (MODES in src/space/feedback/types.ts).</summary>
    public static readonly IReadOnlyList<string> FixThisModes = ["auto", "later"];

    /// <summary>The Fix Engineer's effort levels (EFFORTS).</summary>
    public static readonly IReadOnlyList<string> FixThisEfforts = ["high", "xhigh", "max"];

    /// <summary>An app's own switch: <c>default</c> (it follows "Show on apps by default"), <c>on</c> or <c>off</c>.</summary>
    public static readonly IReadOnlyList<string> FixThisSwitches = ["default", "on", "off"];

    public static string FixThisSwitch(FixThisSettings s, string app) => s.Apps.TryGetValue(app, out var v) && v is "on" or "off" ? v : "default";

    /// <summary>Whether an app's pages show the button under these settings (<c>enabledFor</c> in src/space/feedback/service.ts).</summary>
    public static bool FixThisShows(FixThisSettings s, string app) => s.Enabled && FixThisSwitch(s, app) switch
    {
        "on" => true,
        "off" => false,
        _ => s.AppsDefault,
    };

    // ------------------------------------------------------------------ status

    /// <summary>A service's dot and word, and whether the Space runs it (so it can be started, stopped and restarted here).</summary>
    public static (StateOf State, bool Supervised) Service(ServiceRow s)
    {
        var supervised = s.Peer is null && s.Supervisor == "space" && s.Status == "active";
        if (s.SupervisionAction is "conflict" or "failed") return (new StateOf(StatusTone.Down, StateWord.UnitProblem), supervised);
        StateOf state = s.Status switch
        {
            "active" => s.Health switch
            {
                "ok" => new(StatusTone.Ok, StateWord.Up),
                "down" => new(StatusTone.Down, StateWord.Down),
                _ => new(StatusTone.Unknown, StateWord.Unknown),
            },
            "paused" => new(StatusTone.Paused, StateWord.Paused),
            _ => new(StatusTone.Off, StateWord.Archived),
        };
        return (state, supervised);
    }

    public static StateOf Peer(PeerRow p) => p.Health == "ok" ? new(StatusTone.Ok, StateWord.Up) : new(StatusTone.Down, StateWord.Down);

    public static StateOf Backup(BackupRow b) => b.Retired ? new(StatusTone.Off, StateWord.Retired) : b.Stale ? new(StatusTone.Down, StateWord.Stale) : new(StatusTone.Ok, StateWord.Fresh);

    /// <summary>A runtime cell's dot and word: red only for a used cell that cannot answer, amber while it rests, grey when unused (SettingsStatus.tsx's <c>runtimeState</c>).</summary>
    public static StateOf Runtime(RuntimeCell c)
    {
        var word = c.Reachable == false ? StateWord.Unreachable
            : c.Installed == false ? StateWord.NotInstalled
            : c.SignedIn == false ? StateWord.NotSignedIn
            : c.LimitedUntil is not null ? StateWord.Limited
            : c.ProbeTimedOut ? StateWord.ProbeTimedOut
            : c.CheckedAt is not null || c.LastOkAt is not null ? StateWord.Ready
            : StateWord.Unchecked;
        if (c.Problem is not null) return new(c.Problem == "limited" ? StatusTone.Paused : StatusTone.Down, word);
        return new(word == StateWord.Ready ? StatusTone.Ok : StatusTone.Off, word);
    }

    /// <summary>A speech provider's dot and word, read like a runtime's (SettingsStatus.tsx's <c>speechState</c>).</summary>
    public static StateOf Speech(SpeechCell c)
    {
        var word = c.Off is not null ? StateWord.SpeechOff
            : !c.Located ? StateWord.NotFound
            : c.Reachable == false ? StateWord.Unreachable
            : c.SignedIn == false ? StateWord.NotSignedIn
            : c.LimitedUntil is not null ? StateWord.Limited
            : StateWord.Ready;
        if (c.Problem is not null) return new(c.Problem == "limited" ? StatusTone.Paused : StatusTone.Down, word);
        return new(word == StateWord.Ready ? StatusTone.Ok : StatusTone.Off, word);
    }

    /// <summary>
    /// The problems the overview counts: down services that should be up, peers not answering,
    /// runtimes and speech providers in use that cannot answer, a speech configuration that does
    /// not load, and stale backups still running.
    /// </summary>
    public static int Problems(ServicesView? services, BackupsView? backups, ModelStatusView? models, SpeechView? speech) =>
        (services?.Services.Count(s => s.Status == "active" && s.Health == "down") ?? 0)
        + (services?.Peers.Count(p => p.Health != "ok") ?? 0)
        + (models?.Cells.Count(c => c.Problem is not null) ?? 0)
        + (speech?.Providers.Count(c => c.Problem is not null) ?? 0)
        + (speech?.ConfigError is not null ? 1 : 0)
        + (backups?.Backups.Count(b => b.Stale && !b.Retired) ?? 0);

    // ------------------------------------------------------------------ models

    /// <summary>
    /// The entries of a model picker as the panel's selects list them (src/web/model-choices.tsx):
    /// the empty choice first, the current value when no option has it (kept and marked, so nothing
    /// is rewritten behind the person's back), then the options runtime by runtime. The runtime is
    /// named when asked, or when there is more than one.
    /// </summary>
    public static IReadOnlyList<ModelChoice> ModelChoices(IReadOnlyList<ModelOption> options, string? current, bool withRuntime = true)
    {
        var runtimes = options.Select(o => o.Runtime).Distinct().ToList();
        var named = withRuntime || runtimes.Count > 1;
        var list = new List<ModelChoice> { new(ChoiceKind.Empty, "", null, named) };
        if (!string.IsNullOrEmpty(current) && options.All(o => o.Value != current)) list.Add(new ModelChoice(ChoiceKind.Missing, current, null, named));
        foreach (var r in runtimes) list.AddRange(options.Where(o => o.Runtime == r).Select(o => new ModelChoice(ChoiceKind.Option, o.Value, o, named)));
        return list;
    }

    /// <summary>Whether <paramref name="value"/> may be chosen: the empty choice, or an option that can answer.</summary>
    public static bool CanPick(IReadOnlyList<ModelOption> options, string value) => value.Length == 0 || options.Any(o => o.Value == value && o.Unavailable is null);

    /// <summary>The model a CLI cell reads as: unknown, missing, or found (with its version, sign-in and runtime).</summary>
    public static StateOf Cli(CliRow c)
    {
        if (c.Installed is null) return new(StatusTone.Unknown, StateWord.Unchecked);
        if (c.Installed == false) return new(StatusTone.Off, StateWord.NotInstalled);
        return c.SignedIn switch
        {
            false => new(StatusTone.Paused, StateWord.NotSignedIn),
            true => new(StatusTone.Ok, StateWord.Ready),
            _ => new(StatusTone.Unknown, StateWord.Unchecked),
        };
    }

    /// <summary>When the CLIs were last checked: the newest <c>checkedAt</c>.</summary>
    public static DateTimeOffset? LastChecked(IReadOnlyList<MachineClis> machines) => machines.SelectMany(m => m.Clis).Select(c => c.CheckedAt).Where(t => t is not null).Max();

    // ------------------------------------------------------------------ tasks and events

    /// <summary>A task's dot and word: the dot follows the last outcome; off and orphaned rows are muted (Tasks.tsx).</summary>
    public static StateOf Task(TaskRow t)
    {
        if (t.Orphaned) return new(StatusTone.Off, StateWord.TaskOrphaned);
        if (!t.Enabled) return new(StatusTone.Off, StateWord.TaskOff);
        if (t.State.RunningAt is not null) return new(StatusTone.Running, StateWord.TaskRunning);
        return t.State.LastStatus switch
        {
            "ok" => new(StatusTone.Ok, StateWord.TaskOk),
            "error" => new(StatusTone.Down, StateWord.TaskError, t.State.ConsecutiveErrors > 1 ? t.State.ConsecutiveErrors : 0),
            "skipped" => new(StatusTone.Paused, StateWord.TaskSkipped),
            _ => new(StatusTone.Unknown, StateWord.TaskNeverRan),
        };
    }

    public static StateOf Run(TaskRun r) => r.Status switch
    {
        "ok" => new(StatusTone.Ok, StateWord.TaskOk),
        "error" => new(StatusTone.Down, StateWord.TaskError),
        _ => new(StatusTone.Paused, StateWord.TaskSkipped),
    };

    public static (int Total, int Active, int Failing) TaskCounts(IReadOnlyList<TaskRow> tasks)
    {
        var live = tasks.Where(t => t.Enabled && !t.Orphaned).ToList();
        return (tasks.Count, live.Count, live.Count(t => t.State.LastStatus == "error"));
    }

    /// <summary>Rows grouped by app, the apps by their title in the reader's language, the rows by name.</summary>
    public static IReadOnlyList<(string App, string Title, IReadOnlyList<T> Rows)> ByApp<T>(IEnumerable<T> rows, Func<T, string> app, Func<string, string> title, Func<T, string> name)
    {
        var compare = StringComparer.Create(CultureInfo.CurrentCulture, CompareOptions.IgnoreCase);
        return rows.GroupBy(app)
            .Select(g => (g.Key, title(g.Key), (IReadOnlyList<T>)g.OrderBy(name, compare).ToList()))
            .OrderBy(g => g.Item2, compare)
            .ToList();
    }

    public static StateOf Delivery(DeliveryRow d) => d.Status switch
    {
        "sent" => new(StatusTone.Running, StateWord.DeliverySent),
        "ok" => new(StatusTone.Ok, StateWord.DeliveryOk),
        "dead" => new(StatusTone.Down, StateWord.DeliveryDead),
        "skipped" => new(StatusTone.Off, StateWord.DeliverySkipped),
        _ => new(StatusTone.Paused, StateWord.DeliveryPending),
    };

    /// <summary>The first four fields of an event's data on one line, at most 120 characters (Events.tsx).</summary>
    public static string PreviewData(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object) return "";
        var parts = data.EnumerateObject().Take(4).Select(p => $"{p.Name}: {(p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.GetRawText())}");
        var s = string.Join(" · ", parts);
        return s.Length > 120 ? s[..119] + "…" : s;
    }

    /// <summary>Apps that take part in the bus: they provide, publish or consume something.</summary>
    public static IReadOnlyList<CapabilityApp> CatalogueApps(IReadOnlyList<CapabilityApp> apps) => apps.Where(a => a.Provides.Count > 0 || a.Publishes.Count > 0 || a.Consumes.Count > 0).ToList();

    // ------------------------------------------------------------------ usage

    public static readonly IReadOnlyList<string> ModelWindows = ["5h", "24h", "7d", "30d"];

    public static readonly IReadOnlyList<string> ActivityWindows = ["7d", "30d", "90d", "all"];

    public static readonly IReadOnlyList<string> ActivityKinds = ["all", "app", "agent", "builtin"];

    /// <summary>1234 → 1.2K, 1234567 → 1.23M, 2689400000 → 2.69B; a missing figure is a dash (Usage.tsx).</summary>
    public static string Tokens(long? n)
    {
        if (n is not { } v) return "–";
        var c = CultureInfo.InvariantCulture;
        if (v >= 1_000_000_000) return (v / 1e9).ToString("0.00", c) + "B";
        if (v >= 1_000_000) return (v / 1e6).ToString(v >= 10_000_000 ? "0.0" : "0.00", c) + "M";
        if (v >= 1_000) return (v / 1e3).ToString(v >= 10_000 ? "0" : "0.0", c) + "K";
        return v.ToString(c);
    }

    /// <summary>$123, $1.23, $0.018 (Usage.tsx's <c>fmtCost</c>).</summary>
    public static string Cost(double? usd)
    {
        if (usd is not { } v) return "–";
        var c = CultureInfo.InvariantCulture;
        if (v >= 100) return "$" + v.ToString("0", c);
        if (v >= 1) return "$" + v.ToString("0.00", c);
        return "$" + v.ToString("0.000", c);
    }

    /// <summary>The model with the machine that ran it, when that is not the Space's own: <c>david:gpt-6-luna</c>.</summary>
    public static string ModelOn(string model, string? machine) => string.IsNullOrEmpty(machine) ? model : $"{machine}:{model}";

    public static (long Opens, long TimeMs, ActivityRow? Top) ActivityTotals(IReadOnlyList<ActivityRow> rows) =>
        (rows.Sum(r => r.Opens), rows.Sum(r => r.ActiveMs ?? 0), rows.Count > 0 ? rows[0] : null);

    /// <summary>A device as the panel names it: its client, then the end of its id (Activity.tsx).</summary>
    public static string DeviceLabel(DeviceRow d)
    {
        var client = d.Client switch
        {
            "web" => "Web",
            "ios" => "iOS",
            "macos" => "macOS",
            "android" => "Android",
            "linux" => "Linux",
            "windows" => "Windows",
            _ => d.Client,
        };
        return $"{client} · {(d.DeviceId.Length > 8 ? d.DeviceId[^8..] : d.DeviceId)}";
    }

    // ------------------------------------------------------------------ time

    /// <summary>The unit pair src/web/api.ts's <c>fmtDuration</c> reads a duration as, and its two numbers.</summary>
    public static (DurationUnit Unit, long A, long B) Duration(double ms)
    {
        if (ms < 1000) return (DurationUnit.Milliseconds, Math.Max(0, (long)Math.Round(ms)), 0);
        var s = (long)Math.Round(ms / 1000);
        if (s < 60) return (DurationUnit.Seconds, s, 0);
        var m = s / 60;
        if (m < 60) return s % 60 != 0 ? (DurationUnit.MinutesSeconds, m, s % 60) : (DurationUnit.Minutes, m, 0);
        var h = m / 60;
        if (h < 24) return m % 60 != 0 ? (DurationUnit.HoursMinutes, h, m % 60) : (DurationUnit.Hours, h, 0);
        var d = h / 24;
        return h % 24 != 0 ? (DurationUnit.DaysHours, d, h % 24) : (DurationUnit.Days, d, 0);
    }

    /// <summary>How long ago <paramref name="at"/> was (<c>relTime</c>), or how far ahead (<c>untilTime</c>).</summary>
    public static (RelUnit Unit, long N) Relative(DateTimeOffset at, DateTimeOffset now)
    {
        var ms = (at - now).TotalMilliseconds;
        if (ms > 0)
        {
            if (ms < 30_000) return (RelUnit.Now, 0);
            var mm = (long)Math.Round(ms / 60_000, MidpointRounding.AwayFromZero);
            if (mm < 1) return (RelUnit.InLessThanAMinute, 0);
            if (mm < 60) return (RelUnit.InMinutes, mm);
            var hh = (long)Math.Round(mm / 60.0, MidpointRounding.AwayFromZero);
            return hh < 24 ? (RelUnit.InHours, hh) : (RelUnit.InDays, (long)Math.Round(hh / 24.0, MidpointRounding.AwayFromZero));
        }
        var m = (long)Math.Round(-ms / 60_000, MidpointRounding.AwayFromZero);
        if (m < 1) return (RelUnit.JustNow, 0);
        if (m < 60) return (RelUnit.MinutesAgo, m);
        var h = (long)Math.Round(m / 60.0, MidpointRounding.AwayFromZero);
        return h < 24 ? (RelUnit.HoursAgo, h) : (RelUnit.DaysAgo, (long)Math.Round(h / 24.0, MidpointRounding.AwayFromZero));
    }

    // ------------------------------------------------------------------ account

    /// <summary>The Account section's password and sessions show only where the Space keeps its own password and this app is signed in to it (Auth.tsx).</summary>
    public static bool HasAccount(AuthState? a) => a is { Mode: "builtin", SignedIn: true };

    public const int MinPassword = 8;

    public static bool CanChangePassword(string current, string next) => current.Length > 0 && next.Length >= MinPassword;

    /// <summary>
    /// What <c>POST /api/auth/password</c> answered (src/space/auth/api.ts): 200 changed, 401 the
    /// current password was wrong, 400 the new one was refused (its reason), 403 the session may
    /// not change it, anything else failed. Read here rather than as an API error, since its 401
    /// and 403 do not mean the Space wants a sign-in.
    /// </summary>
    public static (PasswordOutcome Outcome, string Message) Password(int status, string body)
    {
        string message = "";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String) message = e.GetString() ?? "";
        }
        catch (JsonException)
        {
        }
        return status switch
        {
            >= 200 and < 300 => (PasswordOutcome.Changed, ""),
            401 => (PasswordOutcome.WrongCurrent, message),
            400 => (PasswordOutcome.Rejected, message),
            403 => (PasswordOutcome.NotSignedIn, message),
            _ => (PasswordOutcome.Failed, message.Length > 0 ? message : $"HTTP {status}"),
        };
    }
}

/// <summary>
/// The section the Settings page showed last, kept between launches in a small file of its own
/// (<c>space-settings.json</c> beside the preferences), the web panel's <c>settings-section</c>.
/// </summary>
public sealed class SettingsMemory(string file)
{
    public SettingsSection Load()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file));
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("section", out var s) && s.ValueKind == JsonValueKind.String
                ? SettingsRules.Parse(s.GetString())
                : SettingsSection.Overview;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return SettingsSection.Overview;
        }
    }

    public void Save(SettingsSection section)
    {
        try
        {
            Files.WriteAtomic(file, JsonSerializer.Serialize(new Dictionary<string, string> { ["section"] = SettingsRules.Key(section) }));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
