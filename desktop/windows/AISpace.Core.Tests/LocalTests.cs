using System.Text;
using AISpace.Core;

namespace AISpace.Core.Tests;

/// <summary>The Local edition's contract with <c>space local --json</c> (src/space/local.ts), as the Mac's LocalEditionTests.</summary>
public class LocalEditionTests
{
    private const string StatusJson = """
        {"ok":true,"state":"managed","bundle":{"product":"ai-space","edition":"local","version":"0.2.0","commit":"bbbbbbbbbbbbbbbb"},
         "installed":{"product":"ai-space","edition":"local","version":"0.1.0","commit":"aaaaaaaaaaaaaaaa","path":"/x"},
         "ownership":{"managedBy":"ai-space-local"},"workspace":{"path":"/home/u/.ai-space","exists":true,"locked":true},
         "port":8700,"url":"http://127.0.0.1:8700/","running":{"product":"ai-space","api":1,"version":"0.1.0","edition":"local","installation":"managed"},
         "service":{"label":"ai-space-local.service","plist":true,"file":"/home/u/.config/systemd/user/ai-space-local.service","loaded":true,"running":true,"disabled":false,"pid":42,"detail":"loaded/active/running"},
         "runtimes":{"claude":"/home/u/.local/bin/claude","codex":null}}
        """;

    [Fact]
    public void DecodesStatusAndSeesAnUpdate()
    {
        var s = LocalOutput.Decode<LocalStatus>(StatusJson);
        Assert.True(s.IsManaged);
        Assert.True(s.UpdateAvailable);
        Assert.True(s.OwnServiceRunning);
        Assert.Equal(42, s.Service.Pid);
        Assert.Equal("/home/u/.local/bin/claude", s.Runtimes.Claude);
        Assert.Null(s.Runtimes.Codex);
        Assert.Null(s.Runtimes.Dsh);
        Assert.True(s.Runtimes.Any);
        Assert.Equal("0.2.0-bbbbbbbbbbbb", s.Bundle!.DirName);
    }

    [Fact]
    public void FreshSetupDoesNotReuseADeletedWorkspacesToken()
    {
        var s = LocalOutput.Decode<LocalStatus>(StatusJson);
        Assert.False(s.NeedsDeviceCredential(hasStoredToken: true));
        Assert.True(s.NeedsDeviceCredential(hasStoredToken: false));
        s.State = "absent";
        s.Workspace.Exists = false;
        Assert.True(s.NeedsDeviceCredential(hasStoredToken: true));
        s.State = "foreign";
        s.Workspace.Exists = true;
        Assert.True(s.NeedsDeviceCredential(hasStoredToken: true));
    }

    [Fact]
    public void ARefusalBecomesAnErrorWithItsStatus()
    {
        var status = StatusJson.Replace("\"managed\",\"bundle\"", "\"foreign\",\"bundle\"").Replace("{\"ok\":true,", "{");
        var json = """{"ok":false,"code":"foreign","error":"/home/u/.ai-space exists and was not made by this app","status":""" + status + "}";
        var f = Assert.Throws<LocalFailure>(() => LocalOutput.Decode<LocalStatus>(json));
        Assert.Equal("foreign", f.Code);
        Assert.Equal("foreign", f.Status?.State);
        Assert.Contains("was not made", f.Message);
    }

    [Fact]
    public void ABusySpaceSaysWhatItIsDoing()
    {
        var f = Assert.Throws<LocalFailure>(() => LocalOutput.Decode<LocalInstallResult>("""{"ok":false,"code":"busy","error":"busy","activity":{"busy":true,"items":[{"kind":"chat","label":"a chat with Space Assistant"},{"kind":"task","label":"nightly"}]}}"""));
        Assert.Equal("busy", f.Code);
        Assert.Equal("a chat with Space Assistant, nightly", f.Activity?.Summary);
    }

    [Fact]
    public void OutputThatIsNotJsonIsReported()
    {
        Assert.Equal("output", Assert.Throws<LocalFailure>(() => LocalOutput.Decode<LocalStatus>("Segmentation fault")).Code);
        Assert.Equal("space local printed nothing", Assert.Throws<LocalFailure>(() => LocalOutput.Decode<LocalStatus>("  ")).Message);
    }

    [Fact]
    public void DecodesAnInstallWithItsDeviceAndApps()
    {
        var r = LocalOutput.Decode<LocalInstallResult>("""{"ok":true,"apps":[{"file":"hello.spaceapp","app":"hello","version":"1.0.0","status":"installed"}],"version":"0.1.0","release":"/r","workspace":"/w","url":"http://127.0.0.1:8700/","migrated":false,"upgraded":false,"device":{"id":1,"name":"PC","token":"spd_x"}}""");
        Assert.Equal("spd_x", r.Device?.Token);
        Assert.Equal("installed", r.Apps[0].Status);
    }

    [Theory]
    [InlineData("0.2.0", "0.1.9", true)]
    [InlineData("0.1.0", "0.1.0", false)]
    [InlineData("0.1.0", "0.1.0-rc.1", true)]
    [InlineData("0.1.0-rc.2", "0.1.0-rc.1", true)]
    [InlineData("0.1.0-rc.1", "0.1.0", false)]
    [InlineData("v1.0.0", "0.9.9", true)]
    public void Versions(string a, string b, bool newer) => Assert.Equal(newer, LocalVersions.Newer(a, b));

    [Fact]
    public void ChosenCliesGoWithEveryCommand()
    {
        Assert.Equal(["--claude", "/opt/claude", "--dsh", "/opt/dsh"], LocalVersions.RuntimeArgs(new Dictionary<string, string> { ["dsh"] = "/opt/dsh", ["claude"] = "/opt/claude", ["codex"] = "" }));
    }

    [Fact]
    public void TheSessionCookieIsTheSpacesOwn()
    {
        var now = DateTimeOffset.Now;
        Assert.True(LocalVersions.HasSession([("space_session", "127.0.0.1", null)], "127.0.0.1", now));
        Assert.False(LocalVersions.HasSession([("space_session", "127.0.0.1", now.AddMinutes(-1))], "127.0.0.1", now));
        Assert.False(LocalVersions.HasSession([("other", "127.0.0.1", null), ("space_session", "example.com", null)], "127.0.0.1", now));
    }
}

public class WslTests
{
    [Fact]
    public void ListsDistributionsInAnyLanguage()
    {
        const string english = "  NAME            STATE           VERSION\n* Ubuntu-24.04    Running         2\n  docker-desktop  Stopped         2\n  Legacy          Stopped         1\n";
        var list = Wsl.ParseList(english);
        Assert.Equal(3, list.Count);
        Assert.Equal(new WslDistro("Ubuntu-24.04", "Running", 2, true), list[0]);
        Assert.Equal("Ubuntu-24.04", Wsl.Pick(list, null)?.Name);
        Assert.Null(Wsl.Pick([list[1], list[2]], null));

        const string chinese = "  名称            状态           版本\n  Debian          已停止          2\n* Ubuntu          正在运行        2\n";
        var zh = Wsl.ParseList(chinese);
        Assert.Equal(["Debian", "Ubuntu"], zh.Select(d => d.Name));
        Assert.Equal("Ubuntu", Wsl.Pick(zh, null)?.Name);
        Assert.Equal("Debian", Wsl.Pick(zh, "Debian")?.Name);
        Assert.Equal("Ubuntu", Wsl.Pick(zh, "Gone")?.Name);

        Assert.Single(Wsl.ParseList("  NAME   STATE   VERSION\n* Ubuntu Wird ausgeführt 2\n"));
        Assert.Empty(Wsl.ParseList("Windows Subsystem for Linux has no installed distributions.\n"));
    }

    [Fact]
    public void ReadsWslOwnUtf16Output()
    {
        var text = "  NAME      STATE      VERSION\r\n* Ubuntu    Running    2\r\n";
        Assert.Equal("Ubuntu", Wsl.ParseList(Wsl.DecodeOutput(Encoding.Unicode.GetBytes(text)))[0].Name);
        Assert.Equal("Ubuntu", Wsl.ParseList(Wsl.DecodeOutput(Encoding.UTF8.GetBytes(text)))[0].Name);
        Assert.Equal("systemd\n", Wsl.DecodeOutput(Encoding.UTF8.GetBytes("systemd\n")));
    }

    [Fact]
    public void PathsCrossBetweenWindowsAndTheDistribution()
    {
        Assert.Equal("/mnt/c/Users/A B/AppData/Local/Programs/AI Space/space/space.tar.gz", Wsl.ToWslPath(@"C:\Users\A B\AppData\Local\Programs\AI Space\space\space.tar.gz"));
        Assert.Equal(@"\\wsl.localhost\Ubuntu\home\u\.ai-space\logs\space.log", Wsl.ToWindowsPath("Ubuntu", "/home/u/.ai-space/logs/space.log"));
        Assert.Equal(@"D:\work\x", Wsl.ToWindowsPath("Ubuntu", "/mnt/d/work/x"));
        Assert.Equal(@"\\wsl.localhost\Ubuntu\mnt\data", Wsl.ToWindowsPath("Ubuntu", "/mnt/data"));
    }

    [Fact]
    public void SystemdIsTurnedOnKeepingTheRestOfWslConf()
    {
        Assert.False(Wsl.SystemdConfigured(null));
        Assert.Equal("[boot]\nsystemd=true\n", Wsl.RenderWslConf(null));
        Assert.Equal("[user]\ndefault=u\n\n[boot]\nsystemd=true\n", Wsl.RenderWslConf("[user]\ndefault=u\n"));
        Assert.Equal("[boot]\nsystemd=true\ncommand=echo hi\n[network]\nhostname=x\n", Wsl.RenderWslConf("[boot]\ncommand=echo hi\n[network]\nhostname=x\n"));
        Assert.Equal("[Boot]\n# off for now\nsystemd=true\n", Wsl.RenderWslConf("[Boot]\n# off for now\nsystemd = false\n"));
        Assert.True(Wsl.SystemdConfigured(Wsl.RenderWslConf("[network]\n[boot]\nsystemd=false\n")));
        Assert.True(Wsl.SystemdConfigured("[boot]\nsystemd = \"true\" # on\n"));
        Assert.False(Wsl.SystemdConfigured("[network]\nsystemd=true\n"));
    }

    [Fact]
    public void SpaceLocalRunsWithAPlainEnvironment()
    {
        var cmd = Wsl.SpaceLocal("Ubuntu", "/home/u/.local/share/ai-space/windows/bundle/0.1.0-abc", ["install", "--device", "My PC"]);
        Assert.Equal(["-d", "Ubuntu", "--cd", "~", "--exec", "/bin/sh", "-s", "--"], cmd.Args[..8]);
        Assert.Equal(["/home/u/.local/share/ai-space/windows/bundle/0.1.0-abc/runtime/bun", "/home/u/.local/share/ai-space/windows/bundle/0.1.0-abc/src/index.ts", "local", "install", "--device", "My PC", "--json"], cmd.Args[8..]);
        Assert.Contains("env -i", cmd.Input);
        Assert.Contains("\"$@\"", cmd.Input);
        var stage = Wsl.Stage("Ubuntu", "/mnt/c/Users/u/AppData/Local/Programs/AI Space/local/bundle.tar.gz", "0.1.0-abc");
        Assert.Equal(["/mnt/c/Users/u/AppData/Local/Programs/AI Space/local/bundle.tar.gz", "0.1.0-abc"], stage.Args[8..]);
        Assert.Equal(Wsl.StageScript, stage.Input);
        var conf = Wsl.WriteWslConf("Ubuntu", "[boot]\nsystemd=true\n");
        Assert.Equal(["-d", "Ubuntu", "-u", "root", "--exec", "/bin/sh", "-c"], conf.Args[..7]);
        Assert.Equal("[boot]\nsystemd=true\n", conf.Input);
        Assert.Equal(["-d", "Ubuntu", "--exec", "/bin/sleep", "infinity"], Wsl.KeepAlive("Ubuntu"));
        Assert.Equal(["-d", "Ubuntu", "-u", "root", "--exec", "loginctl", "enable-linger", "u"], Wsl.AsRoot("Ubuntu", "loginctl", "enable-linger", "u"));
        Assert.Equal(["--install", "-d", "Ubuntu-24.04"], Wsl.Install());
        Assert.True(Wsl.IsInternal("docker-desktop-data"));
    }
}

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
    public void PreferencesRoundTripAndSurviveAMissingFile()
    {
        using var dir = new TempDir();
        var file = dir.File("preferences.json");
        Assert.Equal(QuickChatShortcut.CtrlAltSpace, Preferences.Load(file).QuickChat);
        var p = new Preferences { Notifications = false, QuickChat = QuickChatShortcut.Off, WslDistro = "Debian", ChosenRuntimes = { ["claude"] = "/opt/claude" } };
        p.Save(file);
        var again = Preferences.Load(file);
        Assert.False(again.Notifications);
        Assert.Equal(QuickChatShortcut.Off, again.QuickChat);
        Assert.Equal("Debian", again.WslDistro);
        Assert.Equal("/opt/claude", again.ChosenRuntimes["claude"]);
        File.WriteAllText(file, "garbage");
        Assert.True(Preferences.Load(file).Notifications);
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
