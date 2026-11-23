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
/// (docs/editions.md#the-install-progress-bar). The installer prints no percentages, so the bar
/// moves by the lines it prints at each step (the same in release/get.ps1 and release/get.sh). In a
/// step it goes in a straight line, from where it stood when the step began toward the step's
/// ceiling, over the step's usual length; only a step that runs over slows down near its ceiling,
/// so a long download never looks stuck. A step that ends early makes no jump: the next one starts
/// where the bar is and goes a little faster. The Mac's InstallProgress and the Linux client's are
/// the same.
/// </summary>
public sealed class InstallProgress
{
    /// <summary>
    /// The ceiling the bar heads for in a step, and the step's usual length in seconds (from a real
    /// install). In its usual length a step covers 0.8 of the way to its ceiling; the ceilings are set
    /// so that the bar then stands at 0.95 times the share of the usual lengths gone by: steps that
    /// take their usual length move it at one pace, to 95 % when the installer ends.
    /// </summary>
    public static (double To, double Seconds) Span(InstallStage stage) => stage switch
    {
        InstallStage.Fetching => (0.094, 3),
        InstallStage.Looking => (0.1375, 2),
        InstallStage.Downloading => (0.5, 12),
        InstallStage.Placing => (0.8, 12),
        InstallStage.Apps => (0.881, 5),
        _ => (0.975, 4),
    };

    /// <summary>
    /// How far toward its ceiling the bar is after <paramref name="x"/> times a step's usual length:
    /// a straight line to 0.8 at the usual length, then easing toward 1 without reaching it.
    /// </summary>
    public static double Along(double x) => x <= 1 ? 0.8 * Math.Max(0, x) : 0.8 + 0.2 * (1 - Math.Exp(-4 * (x - 1)));

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
    private double _from;

    public InstallProgress(DateTimeOffset now, InstallStage stage = InstallStage.Fetching)
    {
        Stage = stage;
        _since = now;
    }

    /// <summary>Moves to <paramref name="next"/> when it is a later step, from where the bar stands; an earlier or the same one changes nothing.</summary>
    public void Enter(InstallStage next, DateTimeOffset now)
    {
        if (next <= Stage) return;
        _from = Value(now);
        Stage = next;
        _since = now;
    }

    public void Read(string? line, DateTimeOffset now)
    {
        if (StageOf(line) is { } next) Enter(next, now);
    }

    /// <summary>The bar's value, 0 to below 1 (1 only once the Space answers, which is not a step here).</summary>
    public double Value(DateTimeOffset now)
    {
        var (to, seconds) = Span(Stage);
        var elapsed = Math.Max(0, (now - _since).TotalSeconds);
        return _from + Math.Max(0, to - _from) * Along(elapsed / seconds);
    }
}
