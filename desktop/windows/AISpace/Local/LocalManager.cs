using System.Diagnostics;
using System.Net;
using System.Text.Json;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Local;

/// <summary>Where WSL stands for the Local edition.</summary>
internal enum WslReadiness
{
    Checking,
    /// <summary>No WSL, or no WSL 2 distribution: <c>wsl --install</c> sets up both.</summary>
    Missing,
    Ready,
}

/// <summary>What an update does while the Space has work in progress (<c>space local install</c>).</summary>
internal enum WhenBusy
{
    Refuse,
    Wait,
    Now,
}

/// <summary>The Linux release the Local edition carries: <c>local\bundle.tar.gz</c> and its <c>RELEASE.json</c> beside the program.</summary>
internal sealed record LocalBundle(string Tarball, Release Release)
{
    public static LocalBundle? Find()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "local");
        var json = Path.Combine(dir, "RELEASE.json");
        var tar = Path.Combine(dir, "bundle.tar.gz");
        if (!File.Exists(json) || !File.Exists(tar)) return null;
        try
        {
            return JsonSerializer.Deserialize<Release>(File.ReadAllText(json)) is { } r ? new LocalBundle(tar, r) : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}

/// <summary>
/// The Local edition's side of the app (docs/windows-desktop.md#this-computer, the Mac's
/// <c>LocalManager</c>): AI Space runs in a WSL 2 distribution as the Linux edition does, a systemd
/// user service that <c>space local</c> installs, starts and stops. The app unpacks the release it
/// carries into the distribution, keeps the distribution up with a hidden <c>wsl.exe</c> (WSL stops
/// one nobody uses), and signs in to the Space with its device credential, kept in Windows
/// Credential Manager. Quitting the app leaves the service running.
/// </summary>
internal sealed class LocalManager(AppModel model)
{
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromMinutes(40);
    private const string CredentialPrefix = "ai-space/local-device/";
    private string? _staged;
    private DateTimeOffset? _lastSignIn;
    private CancellationTokenSource? _retry;

    public LocalBundle? Bundle { get; } = LocalBundle.Find();
    public bool Available => Bundle is not null;
    public WslReadiness Wsl { get; private set; } = WslReadiness.Checking;
    public IReadOnlyList<WslDistro> Distros { get; private set; } = [];
    public string? Distro { get; private set; }
    public LocalStatus? Status { get; private set; }
    /// <summary>What is being done, for the button that waits on it; null when idle.</summary>
    public string? Busy { get; private set; }
    public LocalFailure? Failure { get; private set; }
    public IReadOnlyList<LocalInstallResult.BundledApp> LastApps { get; private set; } = [];
    /// <summary>The work an automatic update is waiting for; null when it is not waiting.</summary>
    public SpaceActivity? UpdateWaitingFor { get; private set; }

    public event Action? Changed;

    private void Notify()
    {
        Changed?.Invoke();
        model.NotifyChanged();
    }

    public void Start()
    {
        if (!Available) return;
        _ = StartUp();
    }

    private async Task StartUp()
    {
        await Refresh();
        if (Status is { IsManaged: true } s && !s.Service.Disabled) EnsureKeepAlive();
        await EnsureSignIn();
        await AutoUpdate();
    }

    // WSL

    private async Task CheckWsl()
    {
        if (!WslExe.Exists)
        {
            Wsl = WslReadiness.Missing;
            return;
        }
        var list = await WslExe.Run(["--list", "--verbose"], null, TimeSpan.FromSeconds(60));
        Distros = Core.Wsl.ParseList(list.Output);
        Distro = Core.Wsl.Pick(Distros, model.Prefs.WslDistro)?.Name;
        Wsl = Distro is null ? WslReadiness.Missing : WslReadiness.Ready;
    }

    /// <summary>Opens Windows' own installer of WSL and Ubuntu in a console; the person comes back with Check Again.</summary>
    public void InstallWsl() => WslExe.OpenConsole(Core.Wsl.Install());

    public void ChooseDistro(string name)
    {
        model.Prefs.WslDistro = name;
        model.SavePrefs();
        _staged = null;
        _ = Refresh();
    }

    /// <summary>systemd on (it runs the service) and lingering on (the service runs without a login), once.</summary>
    private async Task PrepareDistro(string distro)
    {
        var conf = await WslExe.Run(Core.Wsl.Exec(distro, "/bin/cat", "/etc/wsl.conf"), null, TimeSpan.FromSeconds(60));
        var existing = conf.Ok ? conf.Output : null;
        if (!Core.Wsl.SystemdConfigured(existing))
        {
            var write = await WslExe.Run(Core.Wsl.WriteWslConf(distro, Core.Wsl.RenderWslConf(existing)), TimeSpan.FromSeconds(60));
            if (!write.Ok) throw new LocalFailure("wsl", L.F("Could not turn on systemd in {0}: {1}", distro, write.Tail));
            StopKeepAlive();
            await WslExe.Run(["--terminate", distro], null, TimeSpan.FromSeconds(60));
        }
        var init = await WslExe.Run(Core.Wsl.Exec(distro, "/bin/cat", "/proc/1/comm"), null, TimeSpan.FromMinutes(2));
        if (init.Output.Trim() != "systemd") throw new LocalFailure("wsl", L.F("systemd is not running in {0}. Restart it with \"wsl --shutdown\" and try again.", distro));
        var user = (await WslExe.Run(Core.Wsl.Exec(distro, "/usr/bin/id", "-un"), null, TimeSpan.FromSeconds(60))).Output.Trim();
        if (user.Length > 0 && user != "root") await WslExe.Run(Core.Wsl.AsRoot(distro, "loginctl", "enable-linger", user), null, TimeSpan.FromSeconds(60));
    }

    /// <summary>The carried release, unpacked in the distribution once per version; the directory it is in.</summary>
    private async Task<string> Staged(string distro)
    {
        if (_staged is not null) return _staged;
        var bundle = Bundle ?? throw new LocalFailure("no-bundle", L.T("This copy of AI Space does not carry the Local edition."));
        var r = await WslExe.Run(Core.Wsl.Stage(distro, Core.Wsl.ToWslPath(bundle.Tarball), bundle.Release.DirName), TimeSpan.FromMinutes(10));
        var dest = r.Output.Trim().Split('\n').LastOrDefault()?.Trim();
        if (!r.Ok || string.IsNullOrEmpty(dest) || !dest.StartsWith('/')) throw new LocalFailure("stage", L.F("Could not unpack AI Space in {0}: {1}", distro, r.Tail));
        return _staged = dest;
    }

    private async Task<T> Run<T>(params string[] args)
    {
        var distro = Distro ?? throw new LocalFailure("wsl", L.T("WSL is not set up yet."));
        var bundle = await Staged(distro);
        var all = args.Concat(LocalVersions.RuntimeArgs(model.Prefs.ChosenRuntimes));
        var r = await WslExe.Run(Core.Wsl.SpaceLocal(distro, bundle, all), CommandTimeout);
        return LocalOutput.Decode<T>(r.Output);
    }

    private async Task Perform(string what, Func<Task> work)
    {
        if (Busy is not null) return;
        Busy = what;
        Failure = null;
        Notify();
        try
        {
            await work();
        }
        catch (LocalFailure f)
        {
            Failure = f;
            if (f.Status is { } s) Status = s;
        }
        catch (Exception e) when (e is IOException or SpaceApiException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            Failure = new LocalFailure("error", e.Message);
        }
        finally
        {
            Busy = null;
            Notify();
        }
    }

    // Commands

    public async Task Refresh()
    {
        if (!Available) return;
        await CheckWsl();
        if (Wsl == WslReadiness.Ready)
        {
            try
            {
                Status = await Run<LocalStatus>("status");
            }
            catch (LocalFailure f)
            {
                Failure = f;
            }
        }
        Notify();
    }

    /// <summary>
    /// Sets up or updates the Space, then makes sure the app has it saved and is signed in to it. An
    /// update while the Space is busy is refused with the work (<see cref="LocalFailure.Activity"/>),
    /// waits for it, or ends it now.
    /// </summary>
    public async Task Install(bool migrate = false, WhenBusy whenBusy = WhenBusy.Refuse, string? defaultModel = null)
    {
        if (Busy is not null) return;
        _retry?.Cancel();
        UpdateWaitingFor = null;
        var label = migrate ? L.T("Moving…") : whenBusy == WhenBusy.Wait ? L.T("Waiting for the work in progress, then updating…") : Status?.IsManaged == true ? L.T("Updating…") : L.T("Setting up…");
        await Perform(label, async () =>
        {
            await CheckWsl();
            var distro = Distro ?? throw new LocalFailure("wsl", L.T("WSL is not set up yet."));
            await PrepareDistro(distro);
            var current = await Run<LocalStatus>("status");
            Status = current;
            List<string> args = ["install"];
            if (migrate) args.Add("--migrate");
            if (whenBusy == WhenBusy.Wait) args.Add("--wait");
            if (whenBusy == WhenBusy.Now) args.Add("--now");
            if (current.NeedsDeviceCredential(Token() is not null)) args.AddRange(["--device", Environment.MachineName]);
            if (defaultModel is not null) args.AddRange(["--default-model", defaultModel]);
            var result = await Run<LocalInstallResult>([.. args]);
            if (result.Device is { } device)
            {
                SaveToken(result.Workspace, device.Token);
                _lastSignIn = null;
            }
            LastApps = result.Apps;
            Status = await Run<LocalStatus>("status");
            EnsureKeepAlive();
            if (!Uri.TryCreate(result.Url, UriKind.Absolute, out var url)) return;
            var c = model.AdoptLocal(url);
            if (await SignIn(c)) model.ReloadPages(c.Id);
            if (model.Lives.TryGetValue(c.Id, out var live)) await live.Refresh(catalogue: true);
        });
    }

    /// <summary>
    /// The app carries a newer release than the one installed: update the service without asking,
    /// once the Space has no work in progress, trying again every two minutes while it has. A
    /// service the person stopped is left as it is.
    /// </summary>
    public async Task AutoUpdate()
    {
        _retry?.Cancel();
        if (Status is not { UpdateAvailable: true, Installed: not null } s || s.Service.Disabled || Busy is not null)
        {
            UpdateWaitingFor = null;
            return;
        }
        await Install();
        if (Failure is { Code: "busy" } f)
        {
            Failure = null;
            UpdateWaitingFor = f.Activity;
            Notify();
            var cts = _retry = new CancellationTokenSource();
            try
            {
                await Task.Delay(TimeSpan.FromMinutes(2), cts.Token);
                await Refresh();
                await AutoUpdate();
            }
            catch (OperationCanceledException)
            {
            }
        }
        else
        {
            UpdateWaitingFor = null;
        }
    }

    public Task StartService() => Lifecycle(L.T("Starting…"), "start", keepAlive: true);

    public Task StopService() => Lifecycle(L.T("Stopping…"), "stop", keepAlive: false);

    public Task RestartService() => Lifecycle(L.T("Restarting…"), "restart", keepAlive: true);

    /// <summary>Stops and unregisters the service. The workspace and the distribution stay.</summary>
    public async Task RemoveService()
    {
        await Lifecycle(L.T("Removing…"), "remove-service", keepAlive: false);
        if (Failure is null && model.Store.ManagedConnection is { } c) model.Store.SetManaged(c.Id, c.Uri, managed: false);
    }

    private async Task Lifecycle(string what, string verb, bool keepAlive)
    {
        _retry?.Cancel();
        UpdateWaitingFor = null;
        await Perform(what, async () =>
        {
            if (keepAlive) EnsureKeepAlive();
            Status = await Run<LocalStatus>(verb);
            if (!keepAlive) StopKeepAlive();
        });
    }

    // Keeping the distribution up

    private Process? RunningKeepAlive()
    {
        try
        {
            if (!int.TryParse(File.ReadAllText(model.Paths.KeepAlivePid).Trim(), out var pid)) return null;
            var p = Process.GetProcessById(pid);
            return p.ProcessName.Equals("wsl", StringComparison.OrdinalIgnoreCase) && !p.HasExited ? p : null;
        }
        catch (Exception e) when (e is IOException or ArgumentException or InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>A hidden <c>wsl.exe</c> that sleeps in the distribution, started once and left running when the app quits.</summary>
    public void EnsureKeepAlive()
    {
        if (Distro is not { } distro || RunningKeepAlive() is not null) return;
        try
        {
            var psi = new ProcessStartInfo(WslExe.Path) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            foreach (var a in Core.Wsl.KeepAlive(distro)) psi.ArgumentList.Add(a);
            var p = Process.Start(psi);
            if (p is null) return;
            Directory.CreateDirectory(Path.GetDirectoryName(model.Paths.KeepAlivePid)!);
            File.WriteAllText(model.Paths.KeepAlivePid, p.Id.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or UnauthorizedAccessException)
        {
            Log.Write($"keep-alive: {e.Message}");
        }
    }

    public void StopKeepAlive()
    {
        try
        {
            RunningKeepAlive()?.Kill();
            File.Delete(model.Paths.KeepAlivePid);
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            Log.Write($"keep-alive: {e.Message}");
        }
    }

    // Signing in

    /// <summary>The workspace the device credential belongs to, in the distribution.</summary>
    private string? WorkspaceKey => Status?.Workspace.Path is { Length: > 0 } p ? p : null;

    private static string Target(string distro, string workspace) => $"{CredentialPrefix}{distro}{workspace}";

    private string? Token() => Distro is { } d && WorkspaceKey is { } w ? Native.ReadCredential(Target(d, w)) : null;

    private void SaveToken(string workspace, string token)
    {
        if (Distro is not { } d) return;
        if (!Native.WriteCredential(Target(d, workspace), Environment.UserName, token, "AI Space on this computer")) Log.Write("could not keep the device credential");
    }

    private void DeleteToken()
    {
        if (Distro is { } d && WorkspaceKey is { } w) Native.DeleteCredential(Target(d, w));
    }

    /// <summary>
    /// Exchanges the device credential for a session cookie in the Space's profile, so the pages and
    /// the native calls are signed in. At most once every 20 seconds, so a refusal cannot loop.
    /// </summary>
    public async Task<bool> SignIn(Connection c)
    {
        if (!c.Managed || Token() is not { } token) return false;
        if (_lastSignIn is { } last && DateTimeOffset.UtcNow - last < TimeSpan.FromSeconds(20)) return false;
        _lastSignIn = DateTimeOffset.UtcNow;
        try
        {
            using var response = await model.Api(c).Post(new Uri(c.Uri, DeviceSession.Path), DeviceSession.Headers(c.Uri, token));
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                // Revoked, or a workspace that never knew it: Repair (install) makes a new one.
                DeleteToken();
                Failure = new LocalFailure("device", L.T("This computer's sign-in to its Space is no longer valid. Use Repair to make a new one."));
                Notify();
                return false;
            }
            if (response.StatusCode != HttpStatusCode.OK) return false;
            await model.Web.SetCookies(c.Id, SpaceApi.ResponseCookies(response.Headers, c.Uri));
            return true;
        }
        catch (SpaceApiException)
        {
            return false;
        }
    }

    /// <summary>At start: the managed Space's profile has no session cookie yet, or it expired.</summary>
    private async Task EnsureSignIn()
    {
        if (model.Store.ManagedConnection is not { } c) return;
        try
        {
            if (await model.Web.HasSession(c.Id, c.Uri)) return;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Log.Write($"session check: {e.Message}");
            return;
        }
        if (!await SignIn(c)) return;
        model.ReloadPages(c.Id);
        if (model.Lives.TryGetValue(c.Id, out var live)) await live.Refresh(catalogue: true);
    }

    /// <summary>The Space's log, opened from the distribution's files.</summary>
    public void OpenLog()
    {
        if (Distro is not { } d || Status is null) return;
        var file = Core.Wsl.ToWindowsPath(d, Status.Workspace.Path.TrimEnd('/') + "/logs/space.log");
        try
        {
            Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Write($"open log: {e.Message}");
        }
    }
}
