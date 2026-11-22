using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// An AI Space on this computer (docs/windows-desktop.md#this-computer): where the app looks for
/// one when it starts with no saved Space. AI Space is its own installation (the one-command
/// installer, <see cref="ServiceInstaller"/>); the app only finds it, as it would any other Space.
/// </summary>
public static class ThisComputer
{
    /// <summary>The default <c>SPACE_PORT</c> in src/space/config.ts.</summary>
    public const int DefaultPort = 8700;

    /// <summary>How long one port may take to answer.</summary>
    public static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(2);

    /// <summary>The workspace's <c>.env</c>: under <c>SPACE_HOME</c> when that is set, else <c>.ai-space</c> in the user's folder.</summary>
    public static string EnvFile(string? spaceHome, string userProfile) =>
        Path.Combine(string.IsNullOrWhiteSpace(spaceHome) ? Path.Combine(userProfile, ".ai-space") : spaceHome.Trim(), ".env");

    /// <summary><c>SPACE_PORT</c> in a workspace's <c>.env</c>, read as release/install.ps1 reads it; null when it names no port.</summary>
    public static int? PortFromEnv(string? text)
    {
        if (text is null) return null;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (!line.StartsWith("SPACE_PORT=", StringComparison.Ordinal)) continue;
            var value = line["SPACE_PORT=".Length..].Trim(' ', '\t', '"', '\'');
            return int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var port) && port is > 0 and <= 65535 ? port : null;
        }
        return null;
    }

    /// <summary>The ports to ask, in order: the workspace's own, then the default.</summary>
    public static IReadOnlyList<int> CandidatePorts(string? envText)
    {
        if (PortFromEnv(envText) is { } port && port != DefaultPort) return [port, DefaultPort];
        return [DefaultPort];
    }

    public static Uri Address(int port) => new($"http://127.0.0.1:{port.ToString(CultureInfo.InvariantCulture)}/");

    /// <summary>Whether an answer to <c>GET /api/space</c> is an AI Space's (docs/editions.md#service-identity).</summary>
    public static bool IsAISpace(int status, string body)
    {
        if (status is < 200 or >= 300) return false;
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("product", out var product) && product.ValueKind == JsonValueKind.String && product.GetString() == "ai-space";
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// The first port where an AI Space answers, as its address; null when none does. A port that
    /// refuses, fails or takes longer than <paramref name="timeout"/> is not one.
    /// </summary>
    public static async Task<Uri?> Find(IReadOnlyList<int> ports, Func<Uri, CancellationToken, Task<(int Status, string Body)>> get, TimeSpan? timeout = null, CancellationToken ct = default)
    {
        foreach (var port in ports)
        {
            var address = Address(port);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(timeout ?? ProbeTimeout);
            try
            {
                var (status, body) = await get(new Uri(address, SpaceCheck.IdentityPath), limit.Token).ConfigureAwait(false);
                if (IsAISpace(status, body)) return address;
            }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or IOException)
            {
                ct.ThrowIfCancellationRequested();
            }
        }
        return null;
    }

    /// <summary>Looks up to <paramref name="attempts"/> times with a pause between: a service just installed takes a moment to answer.</summary>
    public static async Task<Uri?> WaitFor(Func<Task<Uri?>> look, int attempts, Func<Task> pause)
    {
        for (var i = 0; i < attempts; i++)
        {
            if (i > 0) await pause().ConfigureAwait(false);
            if (await look().ConfigureAwait(false) is { } found) return found;
        }
        return null;
    }

    /// <summary>A plain GET for <see cref="Find"/>: no cookies, no redirects.</summary>
    public static async Task<(int Status, string Body)> Get(HttpClient http, Uri url, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await http.SendAsync(request, ct).ConfigureAwait(false);
        return ((int)response.StatusCode, await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false));
    }
}

/// <summary>
/// AI Space's own one-command installer (release/get.ps1, published with every release as
/// <c>install.ps1</c>; docs/release.md#one-command-install). The app carries no copy of it and no
/// service: it fetches the release's installer and runs it as the person would in a terminal.
/// </summary>
public static class ServiceInstaller
{
    public const string ScriptName = "install.ps1";
    public const string LatestBase = "https://github.com/ericz-lab/ai-space/releases/latest/download";
    /// <summary>Where the release's files are instead (a mirror, or a directory in tests); the installer honours the same variable.</summary>
    public const string DownloadVariable = "AI_SPACE_DOWNLOAD";

    /// <summary>What the installer runs with on top of the app's own environment: the app shows the Space itself, so no browser opens.</summary>
    public static readonly IReadOnlyDictionary<string, string> Variables = new Dictionary<string, string> { ["AI_SPACE_NO_OPEN"] = "1" };

    /// <summary>Where the installer comes from: an address, or a file when the download base is a directory.</summary>
    public static string ScriptSource(string? downloadBase)
    {
        var b = downloadBase?.Trim().TrimEnd('/', '\\');
        if (string.IsNullOrEmpty(b)) return $"{LatestBase}/{ScriptName}";
        if (IsRemote(b)) return $"{b}/{ScriptName}";
        if (b.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) b = b["file:".Length..].TrimStart('/');
        return Path.Combine(b, ScriptName);
    }

    public static bool IsRemote(string source) =>
        source.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || source.StartsWith("http://", StringComparison.OrdinalIgnoreCase);

    /// <summary>Windows PowerShell, which every Windows has, by its full path.</summary>
    public static string PowerShell(string? systemRoot) =>
        string.Join('\\', (string.IsNullOrWhiteSpace(systemRoot) ? @"C:\Windows" : systemRoot.Trim().TrimEnd('\\')), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

    public static IReadOnlyList<string> Arguments(string file) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file];

    /// <summary>The end of what the installer printed, for when it fails.</summary>
    public static string Tail(IEnumerable<string> lines, int count = 12) =>
        string.Join("\n", lines.Select(l => l.TrimEnd()).Where(l => l.Length > 0).TakeLast(count));
}
