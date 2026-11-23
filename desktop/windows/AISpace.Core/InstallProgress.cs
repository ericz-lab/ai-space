using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>The steps of an installation the progress bar follows, in order.</summary>
public enum InstallStage
{
    /// <summary>The app fetches the installer itself.</summary>
    Fetching,
    /// <summary>"ai-space: looking for the latest release …"</summary>
    Looking,
    /// <summary>"ai-space: downloading ai-space-&lt;version&gt;-windows-x64.tar.gz"</summary>
    Downloading,
    /// <summary>"ai-space &lt;version&gt; (&lt;commit&gt;) in &lt;dir&gt;": the program is in place, the service starts.</summary>
    Placing,
    /// <summary>"ai-space core: installed, answering …"</summary>
    Apps,
    /// <summary>The installer ended well ("ai-space is running"); the app waits for the Space.</summary>
    Starting,
}

/// <summary>
/// The one progress bar the first launch shows while AI Space is installed
/// (docs/editions.md#ai-space-client). The installer prints no percentages, so the bar moves by the
/// lines it prints at each step (the same in release/get.ps1 and release/get.sh) and creeps on
/// within a step, slowing as it nears the step's ceiling, so a long download never looks stuck.
/// Each step starts above the ceiling of the one before: the bar only goes forward. The Mac's
/// InstallProgress and the Linux client's are the same.
/// </summary>
public sealed class InstallProgress
{
    /// <summary>Where the bar starts in a step, the ceiling it creeps toward, and the step's usual length.</summary>
    public static (double From, double To, double Seconds) Span(InstallStage stage) => stage switch
    {
        InstallStage.Fetching => (0.00, 0.05, 4),
        InstallStage.Looking => (0.05, 0.10, 4),
        InstallStage.Downloading => (0.10, 0.55, 45),
        InstallStage.Placing => (0.60, 0.80, 20),
        InstallStage.Apps => (0.85, 0.95, 40),
        _ => (0.95, 0.99, 8),
    };

    private static readonly Regex PlacedLine = new(@"^ai-space \S+ \(\S+\) in ", RegexOptions.CultureInvariant);

    /// <summary>The step a line of the installer's output begins, if it begins one.</summary>
    public static InstallStage? StageOf(string? line)
    {
        var l = (line ?? "").Trim();
        if (l.StartsWith("ai-space: looking for", StringComparison.Ordinal)) return InstallStage.Looking;
        if (l.StartsWith("ai-space: downloading ", StringComparison.Ordinal)) return InstallStage.Downloading;
        if (l.StartsWith("ai-space core: installed", StringComparison.Ordinal)) return InstallStage.Apps;
        if (l.StartsWith("ai-space is running", StringComparison.Ordinal)) return InstallStage.Starting;
        if (PlacedLine.IsMatch(l)) return InstallStage.Placing;
        return null;
    }

    public InstallStage Stage { get; private set; }
    private DateTimeOffset _since;

    public InstallProgress(DateTimeOffset now, InstallStage stage = InstallStage.Fetching)
    {
        Stage = stage;
        _since = now;
    }

    /// <summary>Moves to <paramref name="next"/> when it is a later step; an earlier or the same one changes nothing.</summary>
    public void Enter(InstallStage next, DateTimeOffset now)
    {
        if (next <= Stage) return;
        Stage = next;
        _since = now;
    }

    public void Read(string? line, DateTimeOffset now)
    {
        if (StageOf(line) is { } next) Enter(next, now);
    }

    /// <summary>The bar's value, 0 to 1 (1 only once the Space answers, which is not a step here).</summary>
    public double Value(DateTimeOffset now)
    {
        var (from, to, seconds) = Span(Stage);
        var elapsed = Math.Max(0, (now - _since).TotalSeconds);
        return from + (to - from) * (1 - Math.Exp(-elapsed / seconds));
    }
}
