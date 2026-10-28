using System.Text.Json;
using System.Text.Json.Serialization;

namespace AISpace.Core;

/// <summary>Where the client keeps its own files, apart from any Space workspace.</summary>
public sealed record AppPaths(string Config, string Data)
{
    /// <summary><c>%APPDATA%\ai-space</c> for what is small and the person's (saved Spaces, preferences); <c>%LOCALAPPDATA%\ai-space</c> for the rest.</summary>
    public static AppPaths ForUser() => new(
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ai-space"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ai-space"));

    public string Connections => Path.Combine(Config, "connections.json");
    public string Preferences => Path.Combine(Config, "preferences.json");
    public string InboxSeen => Path.Combine(Data, "inbox-seen");
    /// <summary>WebView2's data: one browser process for the app, one profile in it per saved Space.</summary>
    public string WebData => Path.Combine(Data, "web");
    /// <summary>
    /// A saved Space's WebView2 profile, which holds its cookies (its sign-in), storage and cache
    /// apart from every other Space's, as the Mac keeps one website data store per connection.
    /// </summary>
    public static string WebProfile(Guid connection) => connection.ToString("N");
    public string Logs => Path.Combine(Data, "logs");
    /// <summary>
    /// The process that keeps the Local edition's WSL distribution up (WSL stops a distribution
    /// with no Windows process attached). It outlives the app, as a Mac's launchd service does.
    /// </summary>
    public string KeepAlivePid => Path.Combine(Data, "wsl-keepalive.pid");
}

/// <summary>The Quick Chat shortcut: one system-wide key through <c>RegisterHotKey</c>.</summary>
public enum QuickChatShortcut
{
    Off,
    CtrlAltSpace,
    CtrlShiftSpace,
    AltShiftSpace,
}

public static class Shortcuts
{
    // RegisterHotKey's modifiers and the space bar's virtual key.
    public const uint ModAlt = 0x1, ModControl = 0x2, ModShift = 0x4, ModNoRepeat = 0x4000, VkSpace = 0x20;

    /// <summary>Alt+Space is the window menu of every Windows program, so it is not offered as on the Mac.</summary>
    public static (uint Modifiers, uint Key)? Keys(QuickChatShortcut s) => s switch
    {
        QuickChatShortcut.CtrlAltSpace => (ModControl | ModAlt | ModNoRepeat, VkSpace),
        QuickChatShortcut.CtrlShiftSpace => (ModControl | ModShift | ModNoRepeat, VkSpace),
        QuickChatShortcut.AltShiftSpace => (ModAlt | ModShift | ModNoRepeat, VkSpace),
        _ => null,
    };

    public static string Label(QuickChatShortcut s) => s switch
    {
        QuickChatShortcut.CtrlAltSpace => "Ctrl+Alt+Space",
        QuickChatShortcut.CtrlShiftSpace => "Ctrl+Shift+Space",
        QuickChatShortcut.AltShiftSpace => "Alt+Shift+Space",
        _ => "",
    };
}

/// <summary>Desktop settings, in <c>preferences.json</c> (the Mac keeps them in user defaults).</summary>
public sealed class Preferences
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };

    [JsonPropertyName("notifications")] public bool Notifications { get; set; } = true;
    /// <summary>Closing the main window keeps the app in the notification area, as the Mac keeps it in the menu bar.</summary>
    [JsonPropertyName("keepRunning")] public bool KeepRunning { get; set; } = true;
    [JsonPropertyName("quickChat")] public QuickChatShortcut QuickChat { get; set; } = QuickChatShortcut.CtrlAltSpace;
    /// <summary>The agent Quick Chat last talked to, as <c>&lt;connection id&gt; &lt;agent id&gt;</c>.</summary>
    [JsonPropertyName("quickChatAgent")] public string? QuickChatAgent { get; set; }
    [JsonPropertyName("selected")] public Guid? Selected { get; set; }
    /// <summary>The WSL distribution the Local edition runs in.</summary>
    [JsonPropertyName("wslDistro")] public string? WslDistro { get; set; }
    /// <summary>Agent CLIs the person pointed the Local edition at, by name (<c>claude</c>, <c>codex</c>, <c>dsh</c>), as paths in WSL.</summary>
    [JsonPropertyName("chosenRuntimes")] public Dictionary<string, string> ChosenRuntimes { get; set; } = [];
    /// <summary>The note that closing the window leaves the app in the notification area was shown.</summary>
    [JsonPropertyName("trayHintShown")] public bool TrayHintShown { get; set; }
    /// <summary>The person chose to run the program from where it is rather than install it.</summary>
    [JsonPropertyName("installDeclined")] public bool InstallDeclined { get; set; }
    [JsonPropertyName("window")] public WindowPlace? Window { get; set; }
    /// <summary>The floating ball over every app (the Mac's and Linux's); off until turned on in Settings › General.</summary>
    [JsonPropertyName("floatingBall")] public bool FloatingBall { get; set; }
    /// <summary>The ball's four sections for each Space (connection id → entry keys: top, right, bottom, left; "" the default, "-" none).</summary>
    [JsonPropertyName("floatingBallSlots")] public Dictionary<string, List<string>> BallSlots { get; set; } = [];
    /// <summary>Where the ball last stood (its top-left corner, in device-independent pixels); unset until it was moved.</summary>
    [JsonPropertyName("floatingBallOrigin")] public double[]? FloatingBallOrigin { get; set; }

    [JsonIgnore]
    public ScreenPoint? BallOrigin
    {
        get => FloatingBallOrigin is [var x, var y] ? new ScreenPoint(x, y) : null;
        set => FloatingBallOrigin = value is { } p ? [Math.Round(p.X), Math.Round(p.Y)] : null;
    }

    public sealed record WindowPlace(double Left, double Top, double Width, double Height, bool Maximized);

    public static Preferences Load(string file)
    {
        try
        {
            return JsonSerializer.Deserialize<Preferences>(File.ReadAllText(file), Json) ?? new Preferences();
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException or NotSupportedException)
        {
            return new Preferences();
        }
    }

    public void Save(string file)
    {
        try
        {
            Files.WriteAtomic(file, JsonSerializer.Serialize(this, Json) + "\n");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>What the program was started with. A second start hands its arguments to the first and exits.</summary>
public sealed record LaunchArgs(bool Background, bool QuickChat, IReadOnlyList<string> Links, bool Install, bool Uninstall, bool ToastActivated)
{
    public static LaunchArgs Parse(IReadOnlyList<string> args)
    {
        var links = args.Where(a => a.StartsWith(DeepLink.Scheme + ":", StringComparison.OrdinalIgnoreCase)).ToList();
        bool Has(string flag) => args.Any(a => a.Equals(flag, StringComparison.OrdinalIgnoreCase));
        return new LaunchArgs(Has("--background"), Has("--quick-chat"), links, Has("--install"), Has("--uninstall"), Has("-ToastActivated"));
    }

    /// <summary>Whether a start with these arguments shows the main window: not at sign-in, and not for Quick Chat alone.</summary>
    public bool ShowsWindow => !Background && !QuickChat && Links.Count == 0 && !ToastActivated;
}

/// <summary>
/// The per-user installation (docs/windows-desktop.md#installing): the program under
/// <c>%LOCALAPPDATA%\Programs\AI Space</c>, a Start menu shortcut, the <c>aispace:</c> link handler
/// and an entry in Installed apps, all under the user's own registry hive, so no administrator is needed.
/// </summary>
public static class Install
{
    public const string DisplayName = "AI Space";
    public const string ExeName = "AISpace.exe";
    public const string ProtocolKey = @"Software\Classes\aispace";
    public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string RunValue = "AI Space";
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\dev.ai-space.windows";

    public static string Directory(string localAppData) => Path.Combine(localAppData, "Programs", DisplayName);

    public static string ProtocolCommand(string exe) => $"\"{exe}\" \"%1\"";

    /// <summary>Start at sign-in: in the background, the window stays closed.</summary>
    public static string RunCommand(string exe) => $"\"{exe}\" --background";

    public static string UninstallCommand(string exe) => $"\"{exe}\" --uninstall";

    /// <summary>Whether a registered command still starts this program (it was moved, or another copy registered itself).</summary>
    public static bool Points(string? command, string exe) =>
        command is not null && command.TrimStart().StartsWith($"\"{exe}\"", StringComparison.OrdinalIgnoreCase);
}
