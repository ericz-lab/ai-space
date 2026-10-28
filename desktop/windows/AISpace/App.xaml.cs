using System.Diagnostics;
using System.Windows;
using System.Windows.Shell;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;
using AISpace.Views;
using AISpace.Web;

namespace AISpace;

/// <summary>
/// The app (the Mac's <c>AppDelegate</c>): one copy per Windows session, which owns the main
/// window, Quick Chat, the notification area icon, the shortcut, notifications and what reaches
/// it from outside (links, the jump list, a second start). Quitting closes the interface only; a
/// Space and its agents keep running wherever they run.
/// </summary>
public partial class App
{
    private SingleInstance? _instance;
    private AppModel? _model;
    private MainWindow? _main;
    private QuickChatWindow? _quick;
    private SettingsWindow? _settings;
    private Tray? _tray;
    private HotKey? _hotKey;
    private Notifier? _notifier;

    public static bool Quitting { get; private set; }

    /// <summary>Whether the Quick Chat shortcut is held by this app (false: another program has it).</summary>
    public bool ShortcutRegistered { get; private set; } = true;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandled;
        var args = LaunchArgs.Parse(e.Args);
        if (args.Uninstall)
        {
            Uninstall(e.Args.Contains("--quiet", StringComparer.OrdinalIgnoreCase));
            return;
        }

        _instance = new SingleInstance();
        if (!_instance.IsFirst)
        {
            if (!OfferUpdate())
            {
                // Started again (Start menu, a link, the jump list): the running copy takes it from here.
                SingleInstance.Send(e.Args.Length == 0 ? ["--show"] : e.Args);
                Shutdown();
                return;
            }
        }

        ThemeMode = ThemeMode.System;
        Forms.Application.EnableVisualStyles();
        if (WebProfiles.RuntimeVersion() is null) AskForWebView2();

        var model = _model = new AppModel(Dispatcher, AppPaths.ForUser());
        _notifier = new Notifier(model)
        {
            OnOpen = (id, url) => model.OpenInboxItem(id, url),
            OnMark = (id, thread, done) =>
            {
                if (model.Lives.TryGetValue(id, out var live)) _ = live.Mark([thread], read: true, done: done ? true : null);
            },
        };
        _notifier.SetUp(Dispatcher);
        model.PostNotifications = _notifier.Post;

        _main = new MainWindow(model, () => Quitting, () => OpenSettings(), () => SettingsWindow.AddSpace(_main, model), () => WelcomeView.Create(model));
        _main.HiddenByClose += OnMainHidden;
        model.ShowWindowRequested += () => _main.Bring();
        model.EditRequested += id => SettingsWindow.EditSpace(_main, model, id);
        _tray = new Tray(model, this);
        _hotKey = new HotKey(() => QuickChat().Toggle());
        ApplyShortcut();
        Registration.RegisterLinks();
        SetJumpList();
        SessionEnding += (_, _) => Quit();
        _instance.Listen(a => Dispatcher.BeginInvoke(() => Handle(a)));

        model.Start();
        if (args.ShowsWindow) _main.Bring();
        Handle(e.Args);
        if (!args.Background && !args.ToastActivated && !Registration.IsInstalled && !model.Prefs.InstallDeclined) Dispatcher.BeginInvoke(OfferInstall, DispatcherPriority.ApplicationIdle);
    }

    /// <summary>What a start brought: links, Quick Chat, or just "show the window".</summary>
    private void Handle(IReadOnlyList<string> raw)
    {
        if (_model is null || _main is null) return;
        if (raw.Contains("--quit", StringComparer.OrdinalIgnoreCase))
        {
            Quit();
            return;
        }
        var args = LaunchArgs.Parse(raw);
        foreach (var link in args.Links)
        {
            if (DeepLink.Parse(link) is { } l) _model.Handle(l, ShowQuickChat);
        }
        if (args.QuickChat) ShowQuickChat(null, null);
        if (raw.Contains("--show", StringComparer.OrdinalIgnoreCase)) ShowMain();
    }

    public void ShowMain() => _main?.Bring();

    public void ShowQuickChat(string? agent, string? text) => QuickChat().Present(agent, text);

    private QuickChatWindow QuickChat() => _quick ??= new QuickChatWindow(_model!);

    public void OpenSettings(int tab = 0)
    {
        if (_model is null) return;
        if (_settings is { IsLoaded: true })
        {
            _settings.ShowTab(tab);
            _settings.Activate();
            return;
        }
        _settings = new SettingsWindow(_model, this, tab) { Owner = _main is { IsVisible: true } ? _main : null };
        _settings.Closed += (_, _) => _settings = null;
        _settings.Show();
        _settings.Activate();
    }

    /// <summary>(Re)registers the Quick Chat shortcut from the preferences.</summary>
    public bool ApplyShortcut()
    {
        if (_hotKey is null || _model is null) return false;
        ShortcutRegistered = _hotKey.Register(_model.Prefs.QuickChat);
        if (!ShortcutRegistered) Log.Write($"the Quick Chat shortcut {Shortcuts.Label(_model.Prefs.QuickChat)} is taken by another program");
        return ShortcutRegistered;
    }

    private void OnMainHidden()
    {
        if (_model is null) return;
        if (!_model.Prefs.KeepRunning)
        {
            Quit();
            return;
        }
        if (_model.Prefs.TrayHintShown) return;
        _model.Prefs.TrayHintShown = true;
        _model.SavePrefs();
        _tray?.Hint();
    }

    /// <summary>The jump list of the taskbar button and the Start menu entry.</summary>
    private static void SetJumpList()
    {
        var exe = Registration.Exe;
        var list = new JumpList { ShowFrequentCategory = false, ShowRecentCategory = false };
        list.JumpItems.Add(new JumpTask { Title = L.T("Quick Chat"), Arguments = "--quick-chat", ApplicationPath = exe, IconResourcePath = exe });
        list.JumpItems.Add(new JumpTask { Title = L.T("Inbox"), Arguments = "aispace://inbox", ApplicationPath = exe, IconResourcePath = exe });
        JumpList.SetJumpList(Current, list);
        list.Apply();
    }

    public void Quit()
    {
        if (Quitting) return;
        Quitting = true;
        _model?.SavePrefs();
        _model?.Stop();
        _tray?.Dispose();
        _hotKey?.Dispose();
        _instance?.Dispose();
        _instance = null;
        foreach (Window w in Windows) w.Close();
        Shutdown();
    }

    // Installing and updating

    private void OfferInstall()
    {
        if (_model is null) return;
        var answer = MessageBox.Show(
            L.T("Install AI Space for this user? It is copied under your user folder and added to the Start menu and Installed apps; no administrator is needed.\n\nChoose No to keep running it from here."),
            L.T("Install AI Space"), MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (answer == MessageBoxResult.Yes)
        {
            InstallAndRestart();
            return;
        }
        _model.Prefs.InstallDeclined = true;
        _model.SavePrefs();
    }

    /// <summary>Copies this program into place, then starts the installed copy and quits this one.</summary>
    public void InstallAndRestart()
    {
        string exe;
        try
        {
            exe = Registration.InstallCopy();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"install: {e}");
            MessageBox.Show(L.F("AI Space could not be installed: {0}", e.Message), L.T("Install AI Space"), MessageBoxButton.OK, MessageBoxImage.Error);
            return;
        }
        Quit();
        Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! });
    }

    /// <summary>
    /// This copy is newer than the installed one, which is running: offer to replace it. The running
    /// copy quits, this one installs itself and starts the new installed copy.
    /// </summary>
    private bool OfferUpdate()
    {
        if (Registration.IsInstalled || Registration.InstalledVersion() is not { } installed || !LocalVersions.Newer(AppModel.Version, installed)) return false;
        var answer = MessageBox.Show(L.F("Update the installed AI Space from {0} to {1}? It closes and starts again; Spaces and their agents keep running.", installed, AppModel.Version), L.T("Update AI Space"), MessageBoxButton.YesNo, MessageBoxImage.Question);
        if (answer != MessageBoxResult.Yes) return false;
        SingleInstance.Send(["--quit"]);
        _instance?.Dispose();
        _instance = null;
        for (var i = 0; i < 40; i++)
        {
            var s = new SingleInstance();
            if (s.IsFirst)
            {
                _instance = s;
                break;
            }
            s.Dispose();
            Thread.Sleep(500);
        }
        if (_instance is null)
        {
            MessageBox.Show(L.T("The running AI Space did not close. Quit it from its icon in the notification area, then try again."), L.T("Update AI Space"), MessageBoxButton.OK, MessageBoxImage.Warning);
            Shutdown();
            return true;
        }
        string exe;
        try
        {
            exe = Registration.InstallCopy();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"update: {e}");
            MessageBox.Show(L.F("AI Space could not be updated: {0}", e.Message), L.T("Update AI Space"), MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown();
            return true;
        }
        _instance.Dispose();
        _instance = null;
        Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! });
        Shutdown();
        return true;
    }

    /// <summary>From Installed apps: the running copy quits, then everything the installation added goes.</summary>
    private void Uninstall(bool quiet)
    {
        var removeData = false;
        if (!quiet)
        {
            var answer = MessageBox.Show(L.T("Uninstall AI Space from this computer? Spaces and their agents keep running wherever they run."), L.T("Uninstall AI Space"), MessageBoxButton.OKCancel, MessageBoxImage.Question);
            if (answer != MessageBoxResult.OK)
            {
                Shutdown();
                return;
            }
            removeData = MessageBox.Show(L.T("Also remove the saved Spaces, their sign-ins and the app's settings from this computer?"), L.T("Uninstall AI Space"), MessageBoxButton.YesNo, MessageBoxImage.Question) == MessageBoxResult.Yes;
        }
        SingleInstance.Send(["--quit"]);
        Thread.Sleep(1500);
        // The Local edition's distribution may stop once nothing keeps it up; its workspace stays.
        try
        {
            var pidFile = AppPaths.ForUser().KeepAlivePid;
            if (File.Exists(pidFile) && int.TryParse(File.ReadAllText(pidFile).Trim(), out var pid))
            {
                var p = Process.GetProcessById(pid);
                if (p.ProcessName.Equals("wsl", StringComparison.OrdinalIgnoreCase)) p.Kill();
            }
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or IOException or System.ComponentModel.Win32Exception)
        {
            Log.Write($"uninstall: {e.Message}");
        }
        Notifier.ClearAll();
        Registration.Uninstall(removeData);
        if (!quiet) MessageBox.Show(L.T("AI Space was uninstalled."), L.T("Uninstall AI Space"), MessageBoxButton.OK, MessageBoxImage.Information);
        Shutdown();
    }

    private static void AskForWebView2()
    {
        var answer = MessageBox.Show(L.T("AI Space shows its pages with the Microsoft Edge WebView2 Runtime, which this computer does not have. Download it from Microsoft now?"), "AI Space", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (answer == MessageBoxResult.Yes) AppModel.OpenOutside(new Uri("https://go.microsoft.com/fwlink/p/?LinkId=2124703"));
    }

    private static void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        Log.Write($"unhandled: {e.Exception}");
        // A failed background step is logged; the app keeps running.
        e.Handled = true;
    }
}
