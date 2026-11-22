using AISpace.Core;

namespace AISpace.Core.Tests;

public class DesktopTests
{
    [Fact]
    public void LaunchArguments()
    {
        var a = LaunchArgs.Parse(["--background"]);
        Assert.True(a.Background);
        Assert.False(a.ShowsWindow);
        var link = LaunchArgs.Parse(["aispace://chat?agent=x"]);
        Assert.Equal(["aispace://chat?agent=x"], link.Links);
        Assert.False(link.ShowsWindow);
        Assert.True(LaunchArgs.Parse([]).ShowsWindow);
        Assert.True(LaunchArgs.Parse(["-ToastActivated"]).ToastActivated);
        Assert.True(LaunchArgs.Parse(["--quick-chat"]).QuickChat);
    }

    [Fact]
    public void RegisteredCommandsStartThisProgram()
    {
        const string exe = @"C:\Users\u\AppData\Local\Programs\AI Space\AISpace.exe";
        Assert.Equal("\"" + exe + "\" \"%1\"", Install.ProtocolCommand(exe));
        Assert.Equal("\"" + exe + "\" --background", Install.RunCommand(exe));
        Assert.True(Install.Points(Install.RunCommand(exe), exe));
        Assert.True(Install.Points(Install.RunCommand(exe.ToLowerInvariant()), exe));
        Assert.False(Install.Points("\"C:\\Old\\AISpace.exe\" --background", exe));
        Assert.False(Install.Points(null, exe));
        Assert.Equal(@"C:\L\Programs\AI Space", Install.Directory(@"C:\L").Replace('/', '\\'));
    }

    [Fact]
    public void InstallingPlacesOnlyTheProgramFileUnderItsOwnName()
    {
        using var dir = new TempDir();
        var downloads = dir.File("Downloads");
        Directory.CreateDirectory(downloads);
        var download = Path.Combine(downloads, "ai-space-desktop-1.2.3-windows-x64.exe");
        File.WriteAllText(download, "new");
        File.WriteAllText(Path.Combine(downloads, "holiday.jpg"), "not ours");
        var dest = Install.Directory(dir.File("Local"));

        Assert.Null(Install.Place(download, dest));
        Assert.Equal(new[] { Install.ExeName }, Directory.GetFileSystemEntries(dest).Select(p => Path.GetFileName(p)!));
        Assert.Equal("new", File.ReadAllText(Path.Combine(dest, Install.ExeName)));
        Assert.True(Install.IsInstalled(Path.Combine(dest, Install.ExeName), dest));
        Assert.False(Install.IsInstalled(download, dest));
        Assert.True(File.Exists(download));
    }

    [Fact]
    public void AnUpdateReplacesAFolderInstallationWhole()
    {
        using var dir = new TempDir();
        var dest = Install.Directory(dir.File("Local"));
        Directory.CreateDirectory(Path.Combine(dest, "runtimes"));
        File.WriteAllText(Path.Combine(dest, Install.ExeName), "old");
        File.WriteAllText(Path.Combine(dest, "AISpace.dll"), "old");
        File.WriteAllText(Path.Combine(dest, "runtimes", "WebView2Loader.dll"), "old");
        Directory.CreateDirectory(dest + ".new");
        File.WriteAllText(Path.Combine(dest + ".new", "left.txt"), "an interrupted install");
        var exe = dir.File("AISpace-new.exe");
        File.WriteAllText(exe, "new");

        Assert.Null(Install.Place(exe, dest));
        Assert.Equal(new[] { Install.ExeName }, Directory.GetFileSystemEntries(dest).Select(p => Path.GetFileName(p)!));
        Assert.Equal("new", File.ReadAllText(Path.Combine(dest, Install.ExeName)));
        Assert.False(Directory.Exists(dest + ".new"));
        Assert.False(Directory.Exists(dest + ".old"));
    }

    [Fact]
    public void PreferencesRoundTripAndSurviveAMissingFile()
    {
        using var dir = new TempDir();
        var file = dir.File("preferences.json");
        Assert.Equal(QuickChatShortcut.CtrlAltSpace, Preferences.Load(file).QuickChat);
        var p = new Preferences { Notifications = false, QuickChat = QuickChatShortcut.Off };
        p.Save(file);
        var again = Preferences.Load(file);
        Assert.False(again.Notifications);
        Assert.Equal(QuickChatShortcut.Off, again.QuickChat);
        // What the retired Local edition kept there is passed over.
        File.WriteAllText(file, """{"notifications":false,"wslDistro":"Debian","chosenRuntimes":{"claude":"/opt/claude"}}""");
        Assert.False(Preferences.Load(file).Notifications);
        File.WriteAllText(file, "garbage");
        Assert.True(Preferences.Load(file).Notifications);
    }

    [Theory]
    [InlineData("0.2.0", "0.1.9", true)]
    [InlineData("0.1.0", "0.1.0", false)]
    [InlineData("0.1.0", "0.1.0-rc.1", true)]
    [InlineData("0.1.0-rc.2", "0.1.0-rc.1", true)]
    [InlineData("0.1.0-rc.1", "0.1.0", false)]
    [InlineData("v1.0.0", "0.9.9", true)]
    public void ANewerCopyIsToldFromTheInstalledOne(string a, string b, bool newer) => Assert.Equal(newer, Versions.Newer(a, b));

    [Fact]
    public void TheAppsDataIsOutsideAISpacesProgramDirectory()
    {
        // release/install.ps1 puts the program in %LOCALAPPDATA%\ai-space, and `space uninstall` deletes that directory whole.
        var program = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ai-space");
        var paths = AppPaths.ForUser();
        Assert.NotEqual(program, paths.Data);
        Assert.False(paths.Data.StartsWith(program + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        foreach (var mine in new[] { paths.WebData, paths.InboxSeen, paths.Logs }) Assert.StartsWith(paths.Data + Path.DirectorySeparatorChar, mine);
    }

    [Fact]
    public void ShortcutsAvoidTheWindowMenu()
    {
        Assert.Null(Shortcuts.Keys(QuickChatShortcut.Off));
        Assert.Equal((Shortcuts.ModControl | Shortcuts.ModAlt | Shortcuts.ModNoRepeat, Shortcuts.VkSpace), Shortcuts.Keys(QuickChatShortcut.CtrlAltSpace));
        foreach (var s in Enum.GetValues<QuickChatShortcut>())
        {
            if (Shortcuts.Keys(s) is { } k) Assert.NotEqual(Shortcuts.ModAlt | Shortcuts.ModNoRepeat, k.Modifiers);
        }
    }
}
