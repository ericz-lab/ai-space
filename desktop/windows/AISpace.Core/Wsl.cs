using System.Text;

namespace AISpace.Core;

/// <summary>One Linux distribution as <c>wsl.exe --list --verbose</c> lists it.</summary>
public sealed record WslDistro(string Name, string State, int Version, bool IsDefault);

/// <summary>Arguments for <c>wsl.exe</c>, and what to write to its standard input, if anything.</summary>
public sealed record WslCommand(List<string> Args, string? Input = null);

/// <summary>
/// The Local edition on Windows runs the Space's Linux release inside WSL 2 (docs/local.md#on-windows):
/// the same <c>space local … --json</c> commands as on Linux, run in a distribution with systemd,
/// whose user service <c>ai-space-local.service</c> runs the Space. WSL forwards
/// <c>127.0.0.1:&lt;port&gt;</c> from Windows into the distribution, so the client reaches it at the
/// same address as on a Mac. These are the rules; the app runs <c>wsl.exe</c> with them.
/// </summary>
public static class Wsl
{
    /// <summary>The distribution offered when there is none: Ubuntu's current long-term release.</summary>
    public const string SuggestedDistro = "Ubuntu-24.04";

    /// <summary>Under the WSL user's home: the release the app carries, unpacked, where <c>space local</c> runs from.</summary>
    public const string BundleHome = ".local/share/ai-space/windows/bundle";

    /// <summary>
    /// <c>wsl.exe</c>'s own messages are UTF-16LE unless <c>WSL_UTF8=1</c> is honoured (older
    /// WSL ignores it); a Linux program's output through <c>--exec</c> is its own bytes, UTF-8.
    /// </summary>
    public static string DecodeOutput(byte[] bytes)
    {
        var utf16 = bytes.Length >= 2 && (bytes[0] == 0xFF && bytes[1] == 0xFE || LooksUtf16(bytes));
        var text = utf16 ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
        return text.TrimStart('\uFEFF').Replace("\0", "", StringComparison.Ordinal).Replace("\r", "", StringComparison.Ordinal);
    }

    private static bool LooksUtf16(byte[] b)
    {
        if (b.Length < 4) return false;
        int zeros = 0, pairs = Math.Min(b.Length / 2, 64);
        for (var i = 0; i < pairs; i++) if (b[2 * i + 1] == 0) zeros++;
        return zeros * 4 >= pairs * 3;
    }

    /// <summary>
    /// The rows of <c>wsl.exe --list --verbose</c>. The header and the states are in the system's
    /// language, so a row is told by its last word, the WSL version: the name is the first word
    /// (names have no spaces), the state is what lies between.
    /// </summary>
    public static List<WslDistro> ParseList(string output)
    {
        var distros = new List<WslDistro>();
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            var isDefault = line.StartsWith('*');
            if (isDefault) line = line[1..].Trim();
            var words = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (words.Length < 3 || !int.TryParse(words[^1], out var version)) continue;
            distros.Add(new WslDistro(words[0], string.Join(' ', words[1..^1]), version, isDefault));
        }
        return distros;
    }

    /// <summary>The distribution to use: the one chosen before, else the default, else the first; WSL 2 only.</summary>
    public static WslDistro? Pick(IReadOnlyList<WslDistro> distros, string? preferred)
    {
        var two = distros.Where(d => d.Version == 2 && !IsInternal(d.Name)).ToList();
        return two.FirstOrDefault(d => d.Name == preferred) ?? two.FirstOrDefault(d => d.IsDefault) ?? two.FirstOrDefault();
    }

    /// <summary>Distributions other programs run for themselves, never a place for the Space.</summary>
    public static bool IsInternal(string name) => name.StartsWith("docker-desktop", StringComparison.OrdinalIgnoreCase) || name.StartsWith("rancher-desktop", StringComparison.OrdinalIgnoreCase);

    /// <summary><c>C:\Users\a b\x</c> as WSL mounts it by default: <c>/mnt/c/Users/a b/x</c>.</summary>
    public static string ToWslPath(string windowsPath)
    {
        var p = windowsPath.Replace('\\', '/');
        if (p.Length >= 2 && char.IsAsciiLetter(p[0]) && p[1] == ':') return $"/mnt/{char.ToLowerInvariant(p[0])}{p[2..]}";
        return p;
    }

    /// <summary>A path inside the distribution as Windows reaches it: <c>\\wsl.localhost\&lt;distro&gt;\home\…</c>, or the drive behind <c>/mnt/&lt;x&gt;</c>.</summary>
    public static string ToWindowsPath(string distro, string linuxPath)
    {
        if (linuxPath.Length >= 6 && linuxPath.StartsWith("/mnt/", StringComparison.Ordinal) && char.IsAsciiLetter(linuxPath[5]) && (linuxPath.Length == 6 || linuxPath[6] == '/'))
        {
            return $"{char.ToUpperInvariant(linuxPath[5])}:{(linuxPath.Length == 6 ? "\\" : linuxPath[6..].Replace('/', '\\'))}";
        }
        return $"\\\\wsl.localhost\\{distro}{linuxPath.Replace('/', '\\')}";
    }

    /// <summary>Whether <c>/etc/wsl.conf</c> turns systemd on (<c>[boot] systemd=true</c>).</summary>
    public static bool SystemdConfigured(string? wslConf)
    {
        var section = "";
        foreach (var raw in (wslConf ?? "").Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith('[') && line.EndsWith(']')) section = line[1..^1].Trim().ToLowerInvariant();
            else if (section == "boot" && KeyOf(line) == "systemd") return ValueOf(line).Equals("true", StringComparison.OrdinalIgnoreCase);
        }
        return false;
    }

    /// <summary><c>/etc/wsl.conf</c> with <c>[boot] systemd=true</c>, every other line kept as it was.</summary>
    public static string RenderWslConf(string? existing)
    {
        var lines = (existing ?? "").Replace("\r", "", StringComparison.Ordinal).Split('\n').ToList();
        if (lines.Count > 0 && lines[^1].Length == 0) lines.RemoveAt(lines.Count - 1);
        var boot = lines.FindIndex(l => l.Trim().Equals("[boot]", StringComparison.OrdinalIgnoreCase));
        if (boot < 0)
        {
            if (lines.Count > 0 && lines[^1].Trim().Length > 0) lines.Add("");
            lines.AddRange(["[boot]", "systemd=true"]);
            return string.Join('\n', lines) + "\n";
        }
        for (var i = boot + 1; i < lines.Count; i++)
        {
            var line = lines[i].Trim();
            if (line.StartsWith('[') && line.EndsWith(']')) break;
            if (KeyOf(line) == "systemd")
            {
                lines[i] = "systemd=true";
                return string.Join('\n', lines) + "\n";
            }
        }
        lines.Insert(boot + 1, "systemd=true");
        return string.Join('\n', lines) + "\n";
    }

    private static string KeyOf(string line) => line.StartsWith('#') || !line.Contains('=') ? "" : line[..line.IndexOf('=')].Trim().ToLowerInvariant();

    private static string ValueOf(string line)
    {
        var v = line[(line.IndexOf('=') + 1)..];
        var hash = v.IndexOf('#');
        return (hash >= 0 ? v[..hash] : v).Trim().Trim('"');
    }

    // The argument lists for wsl.exe.

    /// <summary>A program in the distribution as its default user, in that user's home, without a shell in between.</summary>
    public static List<string> Exec(string distro, params string[] argv) => ["-d", distro, "--cd", "~", "--exec", .. argv];

    /// <summary>A program as root (WSL needs no password for it): writing <c>/etc/wsl.conf</c>, turning on lingering.</summary>
    public static List<string> AsRoot(string distro, params string[] argv) => ["-d", distro, "-u", "root", "--exec", .. argv];

    /// <summary>
    /// A command with a plain, known environment, as the Linux app runs <c>space local</c>: the
    /// Windows PATH WSL appends would otherwise let Windows programs pass for the agent CLIs, and
    /// <c>systemctl --user</c> needs the user's runtime directory and bus.
    /// </summary>
    public const string CleanEnv = """
        user=$(id -un); uid=$(id -u); home=${HOME:-$(getent passwd "$user" | cut -d: -f6)}
        exec env -i HOME="$home" USER="$user" LOGNAME="$user" PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin LANG=C.UTF-8 XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@"
        """;

    /// <summary><c>space local &lt;args&gt; --json</c> with the Bun of the unpacked release at <paramref name="bundle"/>.</summary>
    public static WslCommand SpaceLocal(string distro, string bundle, IEnumerable<string> args) =>
        Script(distro, CleanEnv, [$"{bundle}/runtime/bun", $"{bundle}/src/index.ts", "local", .. args, "--json"]);

    /// <summary>
    /// A shell script read from standard input (<c>sh -s</c>), its arguments as <c>$1</c>…: a script
    /// never passes through the Windows command line, whose quoting rules are not the shell's.
    /// </summary>
    public static WslCommand Script(string distro, string script, IEnumerable<string> args) =>
        new(Exec(distro, ["/bin/sh", "-s", "--", .. args]), script);

    /// <summary>Replaces <c>/etc/wsl.conf</c> as root with <paramref name="content"/>, written beside and moved in.</summary>
    public static WslCommand WriteWslConf(string distro, string content) =>
        new(AsRoot(distro, "/bin/sh", "-c", "cat > /etc/wsl.conf.ai-space && mv /etc/wsl.conf.ai-space /etc/wsl.conf"), content);

    /// <summary>
    /// Unpacks the release the app carries (<paramref name="tarball"/>, a path in the distribution)
    /// into <see cref="BundleHome"/>/<paramref name="dirName"/> once, removes older ones, and prints
    /// the directory. A half-unpacked copy is never used: it is unpacked beside and moved in.
    /// </summary>
    public const string StageScript = """
        set -eu
        base="$HOME/.local/share/ai-space/windows/bundle"
        dest="$base/$2"
        if [ ! -f "$dest/RELEASE.json" ]; then
          rm -rf "$dest.part"
          mkdir -p "$dest.part"
          tar -xzf "$1" -C "$dest.part"
          rm -rf "$dest"
          mv "$dest.part" "$dest"
        fi
        for d in "$base"/*; do
          [ "$d" = "$dest" ] || rm -rf "$d"
        done
        printf '%s\n' "$dest"
        """;

    public static WslCommand Stage(string distro, string tarball, string dirName) => Script(distro, StageScript, [tarball, dirName]);

    /// <summary>
    /// WSL stops a distribution a few seconds after its last <c>wsl.exe</c> session ends, systemd
    /// services and all. While this runs (hidden, started at sign-in by the app), the Space keeps running.
    /// </summary>
    public static List<string> KeepAlive(string distro) => ["-d", distro, "--exec", "/bin/sleep", "infinity"];

    /// <summary>Installs WSL and a distribution in one step; Windows asks for administrator approval, and the distribution then asks for a Linux user name and password.</summary>
    public static List<string> Install(string distro = SuggestedDistro) => ["--install", "-d", distro];
}
