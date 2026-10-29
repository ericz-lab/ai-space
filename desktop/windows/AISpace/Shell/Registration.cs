using System.Diagnostics;
using AISpace.Core;
using Microsoft.Win32;

namespace AISpace.Shell;

/// <summary>
/// The per-user installation (docs/windows-desktop.md#installing): the program under
/// <c>%LOCALAPPDATA%\Programs\AI Space</c>, a Start menu shortcut, the <c>aispace:</c> link handler,
/// start at sign-in and an entry in Installed apps, all in the user's own registry hive, so no
/// administrator is needed. A copy run from elsewhere (just unpacked) offers to install itself.
/// </summary>
internal static class Registration
{
    public static string Exe => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, Install.ExeName);

    private static string LocalAppData => Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

    public static string InstallDirectory => Install.Directory(LocalAppData);

    public static string InstalledExe => Path.Combine(InstallDirectory, Install.ExeName);

    public static string Shortcut => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Install.DisplayName + ".lnk");

    public static bool IsInstalled => string.Equals(Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\'), Path.GetFullPath(InstallDirectory).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    /// <summary>The installed copy's version, when there is one.</summary>
    public static string? InstalledVersion()
    {
        if (!File.Exists(InstalledExe)) return null;
        var v = FileVersionInfo.GetVersionInfo(InstalledExe);
        return v.FileMajorPart + "." + v.FileMinorPart + "." + v.FileBuildPart;
    }

    private static string? Read(string key, string? name = "")
    {
        using var k = Registry.CurrentUser.OpenSubKey(key);
        return k?.GetValue(name) as string;
    }

    /// <summary>
    /// At every start: <c>aispace:</c> links open this copy when it is the installed one, or when no
    /// working copy has them. A copy only being tried out never takes them from the installed one.
    /// </summary>
    public static void RegisterLinks()
    {
        try
        {
            var current = Read(Install.ProtocolKey + @"\shell\open\command");
            if (Install.Points(current, Exe)) return;
            var other = current is not null && File.Exists(InstalledExe) && Install.Points(current, InstalledExe);
            if (other && !IsInstalled) return;
            using (var k = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey))
            {
                k.SetValue("", "URL:AI Space");
                k.SetValue("URL Protocol", "");
            }
            using (var icon = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey + @"\DefaultIcon")) icon.SetValue("", $"\"{Exe}\",0");
            using (var cmd = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey + @"\shell\open\command")) cmd.SetValue("", Install.ProtocolCommand(Exe));
            Native.AssociationsChanged();
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            Log.Write($"link handler: {e.Message}");
        }
    }

    public static bool StartsAtSignIn() => Install.Points(Read(Install.RunKey, Install.RunValue), Exe);

    public static void SetStartAtSignIn(bool on)
    {
        try
        {
            using var k = Registry.CurrentUser.CreateSubKey(Install.RunKey);
            if (on) k.SetValue(Install.RunValue, Install.RunCommand(Exe));
            else k.DeleteValue(Install.RunValue, false);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            Log.Write($"start at sign-in: {e.Message}");
        }
    }

    /// <summary>Copies this program into the installation folder and registers it there; returns the installed program.</summary>
    public static string InstallCopy()
    {
        var source = Path.GetFullPath(AppContext.BaseDirectory);
        var dest = InstallDirectory;
        // A newer copy replaces the files of the older one; files it no longer has go.
        var part = dest + ".new";
        if (Directory.Exists(part)) Directory.Delete(part, true);
        CopyTree(source, part);
        if (Directory.Exists(dest))
        {
            var old = dest + ".old";
            if (Directory.Exists(old)) Directory.Delete(old, true);
            Directory.Move(dest, old);
            Directory.Move(part, dest);
            try
            {
                Directory.Delete(old, true);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Log.Write($"install: could not remove the old copy: {e.Message}");
            }
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            Directory.Move(part, dest);
        }
        var exe = InstalledExe;
        Native.CreateShortcut(Shortcut, exe, "AI Space");
        using (var k = Registry.CurrentUser.CreateSubKey(Install.UninstallKey))
        {
            k.SetValue("DisplayName", Install.DisplayName);
            k.SetValue("DisplayVersion", AppModel.Version);
            k.SetValue("Publisher", "ai-space");
            k.SetValue("DisplayIcon", $"\"{exe}\",0");
            k.SetValue("InstallLocation", dest);
            k.SetValue("UninstallString", Install.UninstallCommand(exe));
            k.SetValue("QuietUninstallString", Install.UninstallCommand(exe) + " --quiet");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            k.SetValue("EstimatedSize", (int)(Size(dest) / 1024), RegistryValueKind.DWord);
        }
        // Links and start at sign-in follow the installed copy.
        using (var cmd = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey + @"\shell\open\command")) cmd.SetValue("", Install.ProtocolCommand(exe));
        using (var k = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey))
        {
            k.SetValue("", "URL:AI Space");
            k.SetValue("URL Protocol", "");
        }
        using (var icon = Registry.CurrentUser.CreateSubKey(Install.ProtocolKey + @"\DefaultIcon")) icon.SetValue("", $"\"{exe}\",0");
        using (var run = Registry.CurrentUser.CreateSubKey(Install.RunKey)) run.SetValue(Install.RunValue, Install.RunCommand(exe));
        Native.AssociationsChanged();
        return exe;
    }

    /// <summary>Takes out everything <see cref="InstallCopy"/> put in; the program folder goes once this process has exited.</summary>
    public static void Uninstall(bool removeData)
    {
        void Try(Action a)
        {
            try
            {
                a();
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException)
            {
                Log.Write($"uninstall: {e.Message}");
            }
        }
        Try(() =>
        {
            using var run = Registry.CurrentUser.OpenSubKey(Install.RunKey, true);
            run?.DeleteValue(Install.RunValue, false);
        });
        Try(() => Registry.CurrentUser.DeleteSubKeyTree(Install.ProtocolKey, false));
        Try(() => Registry.CurrentUser.DeleteSubKeyTree(Install.UninstallKey, false));
        Try(() => File.Delete(Shortcut));
        Try(Microsoft.Toolkit.Uwp.Notifications.ToastNotificationManagerCompat.Uninstall);
        Native.AssociationsChanged();
        if (removeData)
        {
            var paths = AppPaths.ForUser();
            Try(() => Directory.Delete(paths.Config, true));
            Try(() => Directory.Delete(paths.Data, true));
        }
        var dir = InstallDirectory;
        if (!Directory.Exists(dir)) return;
        // The running program cannot delete itself: a hidden shell does, a moment after it exits.
        Try(() => Process.Start(new ProcessStartInfo("cmd.exe", $"/d /c timeout /t 3 /nobreak >nul & rmdir /s /q \"{dir}\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden }));
    }

    private static void CopyTree(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.EnumerateFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)), true);
        foreach (var dir in Directory.EnumerateDirectories(from)) CopyTree(dir, Path.Combine(to, Path.GetFileName(dir)));
    }

    private static long Size(string dir) => new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
}
