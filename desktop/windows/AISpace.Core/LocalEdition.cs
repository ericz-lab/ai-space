using System.Text.Json;
using System.Text.Json.Serialization;

namespace AISpace.Core;

/// <summary>
/// The Local edition's service as <c>space local &lt;verb&gt; --json</c> reports it
/// (src/space/local.ts, docs/local.md; the Mac's <c>LocalEdition.swift</c>). On Windows the
/// service runs inside WSL 2 (see <see cref="Wsl"/>): the commands run there, with the Bun of the
/// release the app carries; the app never starts the service process itself, systemd does.
/// </summary>
public sealed record Release(
    [property: JsonPropertyName("product")] string? Product,
    [property: JsonPropertyName("edition")] string Edition,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("commit")] string Commit)
{
    /// <summary>The name of a release's directory, as src/space/local.ts <c>releaseDirName</c> writes it.</summary>
    [JsonIgnore] public string DirName => $"{Version}-{(Commit.Length > 12 ? Commit[..12] : Commit)}";
}

public sealed class LocalStatus
{
    [JsonPropertyName("state")] public string State { get; set; } = "absent";
    [JsonPropertyName("reason")] public string? Reason { get; set; }
    [JsonPropertyName("bundle")] public Release? Bundle { get; set; }
    [JsonPropertyName("installed")] public Release? Installed { get; set; }
    [JsonPropertyName("workspace")] public WorkspaceInfo Workspace { get; set; } = new();
    [JsonPropertyName("port")] public int Port { get; set; } = 8700;
    [JsonPropertyName("url")] public string Url { get; set; } = ConnectionRules.LocalDefault;
    [JsonPropertyName("running")] public RunningInfo? Running { get; set; }
    [JsonPropertyName("service")] public ServiceInfo Service { get; set; } = new();
    [JsonPropertyName("runtimes")] public RuntimesInfo Runtimes { get; set; } = new();
    /// <summary>Before the workspace is the app's: the default models it can start with.</summary>
    [JsonPropertyName("models")] public List<ModelOption>? Models { get; set; }

    public sealed class WorkspaceInfo
    {
        [JsonPropertyName("path")] public string Path { get; set; } = "";
        [JsonPropertyName("exists")] public bool Exists { get; set; }
        [JsonPropertyName("locked")] public bool Locked { get; set; }
    }

    public sealed class RunningInfo
    {
        [JsonPropertyName("version")] public string Version { get; set; } = "";
        [JsonPropertyName("edition")] public string Edition { get; set; } = "";
        [JsonPropertyName("installation")] public string? Installation { get; set; }
    }

    public sealed class ServiceInfo
    {
        [JsonPropertyName("label")] public string Label { get; set; } = "";
        [JsonPropertyName("file")] public string File { get; set; } = "";
        [JsonPropertyName("loaded")] public bool Loaded { get; set; }
        [JsonPropertyName("running")] public bool Running { get; set; }
        [JsonPropertyName("disabled")] public bool Disabled { get; set; }
        [JsonPropertyName("pid")] public int Pid { get; set; }
        [JsonPropertyName("detail")] public string Detail { get; set; } = "";
    }

    public sealed class RuntimesInfo
    {
        [JsonPropertyName("claude")] public string? Claude { get; set; }
        [JsonPropertyName("codex")] public string? Codex { get; set; }
        [JsonPropertyName("dsh")] public string? Dsh { get; set; }

        [JsonIgnore] public bool Any => Claude is not null || Codex is not null || Dsh is not null;
    }

    public sealed record ModelOption(
        [property: JsonPropertyName("value")] string Value,
        [property: JsonPropertyName("runtime")] string Runtime,
        [property: JsonPropertyName("tier")] string Tier,
        [property: JsonPropertyName("model")] string Model);

    [JsonIgnore] public bool IsManaged => State == "managed";

    /// <summary>
    /// A stored credential can outlive a deleted workspace: a fresh setup or takeover must create
    /// one in the new database even if an old token is still kept.
    /// </summary>
    public bool NeedsDeviceCredential(bool hasStoredToken) => !IsManaged || !Workspace.Exists || !hasStoredToken;

    /// <summary>Only a newer version is offered automatically; Repair reinstalls explicitly.</summary>
    [JsonIgnore] public bool UpdateAvailable => IsManaged && Bundle is not null && Installed is not null && LocalVersions.Newer(Bundle.Version, Installed.Version);

    /// <summary>Whether the running service is the one this app installed.</summary>
    [JsonIgnore] public bool OwnServiceRunning => Running?.Installation == "managed" && Running?.Edition == "local";
}

/// <summary><c>space local install --json</c>.</summary>
public sealed class LocalInstallResult
{
    [JsonPropertyName("version")] public string Version { get; set; } = "";
    [JsonPropertyName("url")] public string Url { get; set; } = ConnectionRules.LocalDefault;
    [JsonPropertyName("workspace")] public string Workspace { get; set; } = "";
    [JsonPropertyName("migrated")] public bool Migrated { get; set; }
    [JsonPropertyName("upgraded")] public bool Upgraded { get; set; }
    [JsonPropertyName("device")] public DeviceInfo? Device { get; set; }
    [JsonPropertyName("apps")] public List<BundledApp> Apps { get; set; } = [];

    public sealed record DeviceInfo([property: JsonPropertyName("id")] int Id, [property: JsonPropertyName("name")] string Name, [property: JsonPropertyName("token")] string Token);

    public sealed record BundledApp(
        [property: JsonPropertyName("file")] string File,
        [property: JsonPropertyName("app")] string? App,
        [property: JsonPropertyName("version")] string? Version,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("detail")] string? Detail);
}

/// <summary>What the running Space is doing (<c>GET /api/space/activity</c>): an update waits for it.</summary>
public sealed record SpaceActivity(
    [property: JsonPropertyName("busy")] bool Busy,
    [property: JsonPropertyName("items")] List<SpaceActivity.Item> Items)
{
    public sealed record Item([property: JsonPropertyName("kind")] string Kind, [property: JsonPropertyName("label")] string Label);

    [JsonIgnore] public string Summary => string.Join(", ", Items.Select(i => i.Label));
}

/// <summary>A refusal from <c>space local</c>: <c>{ ok: false, code, error, status?, activity? }</c>.</summary>
public sealed class LocalFailure(string code, string message, LocalStatus? status = null, SpaceActivity? activity = null) : Exception(message)
{
    public string Code { get; } = code;
    public LocalStatus? Status { get; } = status;
    /// <summary>For <c>busy</c>: the work an upgrade would cut off.</summary>
    public SpaceActivity? Activity { get; } = activity;
}

public static class LocalOutput
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = false };

    /// <summary>Decodes a command's JSON: the value on <c>ok: true</c>, the refusal thrown on <c>ok: false</c> or anything else.</summary>
    public static T Decode<T>(string text)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(text);
            root = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            var t = text.Trim();
            throw new LocalFailure("output", t.Length == 0 ? "space local printed nothing" : t[Math.Max(0, t.Length - 400)..]);
        }
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
        {
            return root.Deserialize<T>(Options) ?? throw new LocalFailure("output", "space local printed an empty answer");
        }
        string? Str(string key) => root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        LocalStatus? status = null;
        SpaceActivity? activity = null;
        if (root.ValueKind == JsonValueKind.Object)
        {
            if (root.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.Object) status = s.Deserialize<LocalStatus>(Options);
            if (root.TryGetProperty("activity", out var a) && a.ValueKind == JsonValueKind.Object) activity = a.Deserialize<SpaceActivity>(Options);
        }
        throw new LocalFailure(Str("code") ?? "error", Str("error") ?? "space local failed", status, activity);
    }
}

public static class LocalVersions
{
    /// <summary>Whether <paramref name="a"/> is newer than <paramref name="b"/> (x.y.z with an optional pre-release, which sorts before its release).</summary>
    public static bool Newer(string a, string b)
    {
        static (int[] Nums, string? Pre) Parse(string v)
        {
            var parts = v.Trim().TrimStart('v').Split('-', 2);
            var nums = parts[0].Split('.').Select(n => int.TryParse(n, out var x) ? x : 0).ToArray();
            return (nums, parts.Length > 1 ? parts[1] : null);
        }
        var x = Parse(a);
        var y = Parse(b);
        for (var i = 0; i < 3; i++)
        {
            var d = (i < x.Nums.Length ? x.Nums[i] : 0) - (i < y.Nums.Length ? y.Nums[i] : 0);
            if (d != 0) return d > 0;
        }
        if (x.Pre == y.Pre) return false;
        if (x.Pre is null) return true;
        if (y.Pre is null) return false;
        return string.CompareOrdinal(x.Pre, y.Pre) > 0;
    }

    /// <summary><c>--claude &lt;path&gt; --codex &lt;path&gt; --dsh &lt;path&gt;</c>: the agent CLIs the person chose, for every command.</summary>
    public static List<string> RuntimeArgs(IReadOnlyDictionary<string, string> chosen)
    {
        var args = new List<string>();
        foreach (var name in new[] { "claude", "codex", "dsh" })
        {
            if (chosen.TryGetValue(name, out var path) && path.Length > 0) args.AddRange([$"--{name}", path]);
        }
        return args;
    }

    /// <summary>Whether a stored cookie is the Space's session for that host (the Mac's <c>LocalManager.hasSession</c>).</summary>
    public static bool HasSession(IEnumerable<(string Name, string Domain, DateTimeOffset? Expires)> cookies, string host, DateTimeOffset now) =>
        cookies.Any(c => c.Name == "space_session" && (c.Domain == host || c.Domain == "." + host) && (c.Expires is null || c.Expires > now));
}

/// <summary>The cookie a device credential is exchanged for: <c>POST /api/auth/device/session</c>.</summary>
public static class DeviceSession
{
    public const string Path = "/api/auth/device/session";

    public static Dictionary<string, string> Headers(Uri space, string token) => new()
    {
        ["Authorization"] = $"Bearer {token}",
        ["Accept"] = "application/json",
        ["Origin"] = ConnectionRules.OriginHeader(space),
    };
}
