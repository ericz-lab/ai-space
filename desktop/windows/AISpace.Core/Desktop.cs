using System.Text.Json;
using System.Text.Json.Serialization;

namespace AISpace.Core;

/// <summary>Where the client keeps its own files, apart from any Space workspace.</summary>
public sealed record AppPaths(string Config, string Data)
{
    /// <summary>
    /// <c>%APPDATA%\ai-space</c> for what is small and the person's (saved Spaces, preferences);
    /// <c>%LOCALAPPDATA%\ai-space-desktop</c> for the rest. Not <c>%LOCALAPPDATA%\ai-space</c>: that
    /// is AI Space's own program directory (release/install.ps1), which <c>space uninstall</c>
    /// deletes whole, and which removing the app's data must never touch.
    /// </summary>
    public static AppPaths ForUser() => new(
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ai-space"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), DataName));

    public const string DataName = "ai-space-desktop";

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
    /// <summary>The Claude desk pet walking along the bottom of Home; on until hidden from its menu or Settings › General.</summary>
    [JsonPropertyName("deskPet")] public bool DeskPet { get; set; } = true;
    /// <summary>Hold a key to talk in any app (the Mac's Hold fn to talk); off until turned on in Settings › General.</summary>
    [JsonPropertyName("voiceInput")] public bool VoiceInput { get; set; }
    /// <summary>The key held to talk.</summary>
    [JsonPropertyName("voiceInputKey")] public HoldToTalkKey VoiceInputKey { get; set; } = HoldToTalkKey.RightCtrl;
    /// <summary>The saved Space holding the key transcribes with (Transcribe with); unset: the selected Space.</summary>
    [JsonPropertyName("voiceInputSpace")] public Guid? VoiceInputSpace { get; set; }
    /// <summary>The language spoken (<see cref="Core.VoiceLanguage"/>): "" Same as AI Space, "auto" Detect automatically, or a code.</summary>
    [JsonPropertyName("voiceLanguage")] public string VoiceLanguage { get; set; } = Core.VoiceLanguage.SameAsApp;
    /// <summary>The chat's permission for new messages, as sent (<see cref="ChatPermissions.Wire"/>): "" Ask before changes.</summary>
    [JsonPropertyName("chatPermission")] public string ChatPermission { get; set; } = "";
    /// <summary>The model picked for each agent's chat, by <c>&lt;connection id&gt; &lt;agent id&gt;</c>; missing: the agent's default.</summary>
    [JsonPropertyName("chatModels")] public Dictionary<string, string> ChatModels { get; set; } = [];

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

    /// <summary>Whether <paramref name="exe"/> is the installed program, not a copy run from elsewhere.</summary>
    public static bool IsInstalled(string exe, string directory) =>
        string.Equals(Path.GetFullPath(exe), Path.GetFullPath(Path.Combine(directory, ExeName)), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Puts the one-file program <paramref name="exe"/> (however the download is named) into
    /// <paramref name="directory"/> as <see cref="ExeName"/>. A new folder replaces the old one whole,
    /// so the files of an older installation (a folder of libraries) go too; when the swap fails the
    /// old folder is put back. Returns why the old folder could not be removed afterwards, or null.
    /// </summary>
    public static string? Place(string exe, string directory)
    {
        var part = directory + ".new";
        if (System.IO.Directory.Exists(part)) System.IO.Directory.Delete(part, true);
        System.IO.Directory.CreateDirectory(part);
        File.Copy(exe, Path.Combine(part, ExeName));
        if (!System.IO.Directory.Exists(directory))
        {
            System.IO.Directory.Move(part, directory);
            return null;
        }
        var old = directory + ".old";
        if (System.IO.Directory.Exists(old)) System.IO.Directory.Delete(old, true);
        System.IO.Directory.Move(directory, old);
        try
        {
            System.IO.Directory.Move(part, directory);
        }
        catch
        {
            System.IO.Directory.Move(old, directory);
            throw;
        }
        try
        {
            System.IO.Directory.Delete(old, true);
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return e.Message;
        }
    }

    public static string ProtocolCommand(string exe) => $"\"{exe}\" \"%1\"";

    /// <summary>Start at sign-in: in the background, the window stays closed.</summary>
    public static string RunCommand(string exe) => $"\"{exe}\" --background";

    public static string UninstallCommand(string exe) => $"\"{exe}\" --uninstall";

    /// <summary>Whether a registered command still starts this program (it was moved, or another copy registered itself).</summary>
    public static bool Points(string? command, string exe) =>
        command is not null && command.TrimStart().StartsWith($"\"{exe}\"", StringComparison.OrdinalIgnoreCase);
}
