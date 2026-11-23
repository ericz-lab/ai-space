using System.Diagnostics;
using System.Net.Http;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace;

/// <summary>Where the first entry of the welcome page stands.</summary>
internal enum ThisComputerPhase
{
    /// <summary>The two entries wait for a click.</summary>
    Choose,
    /// <summary>Looking at this computer's ports after the click.</summary>
    Connecting,
    /// <summary>The installer runs, behind the progress bar.</summary>
    Installing,
    /// <summary>The installer failed, or what it installed does not answer.</summary>
    Failed,
}

/// <summary>What the look at the app's start found on this computer.</summary>
internal enum ThisComputerHere
{
    Unknown,
    Found,
    None,
}

/// <summary>
/// The first launch (docs/windows-desktop.md#this-computer): two entries, the AI Space on this
/// computer or one on another machine. The app looks at this computer when it starts with no saved
/// Space, only so the first entry can say what its click will do. That click connects straight to
/// the one found; with none, the app fetches the release's own one-command installer and runs it
/// (<see cref="ServiceInstaller"/>) behind a single progress bar (<see cref="InstallProgress"/>),
/// then connects. AI Space is never part of the app: the app does not carry, update, stop or remove it.
/// </summary>
internal sealed class ThisComputerSetup(AppModel model)
{
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(30);
    private const int MaxLines = 400;
    private readonly HttpClient _probe = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false });
    private readonly List<string> _lines = [];
    private InstallProgress _meter = new(DateTimeOffset.Now);
    private System.Windows.Threading.DispatcherTimer? _ticker;

    public ThisComputerPhase Phase { get; private set; } = ThisComputerPhase.Choose;
    public ThisComputerHere Here { get; private set; } = ThisComputerHere.Unknown;
    /// <summary>The progress bar while installing, 0 to 1.</summary>
    public double Progress { get; private set; }
    /// <summary>What the installer printed so far, kept for the failure's details; not shown while it runs.</summary>
    public IReadOnlyList<string> Lines => _lines;
    /// <summary>Why the installation failed, in the interface's language.</summary>
    public string Failure { get; private set; } = "";

    public event Action? Changed;

    /// <summary>At the app's start: looks only when no Space is saved, and saves nothing.</summary>
    public void Start()
    {
        if (model.Store.Connections.Count > 0) return;
        _ = LookAtStart();
    }

    private async Task LookAtStart()
    {
        var found = await Look();
        if (Phase == ThisComputerPhase.Choose) Here = found is null ? ThisComputerHere.None : ThisComputerHere.Found;
        Changed?.Invoke();
    }

    /// <summary>The address of the AI Space that answers on this computer, or null.</summary>
    private async Task<Uri?> Look()
    {
        string? env = null;
        try
        {
            var file = ThisComputer.EnvFile(Environment.GetEnvironmentVariable("SPACE_HOME"), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
            if (File.Exists(file)) env = await File.ReadAllTextAsync(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            Log.Write($"this computer: {e.Message}");
        }
        return await ThisComputer.Find(ThisComputer.CandidatePorts(env), (url, ct) => ThisComputer.Get(_probe, url, ct));
    }

    /// <summary>
    /// "Connect to Local AI Space" (also Retry): the one on this computer, looked for again at the
    /// click, is used as it is; the installer runs only when there is none.
    /// </summary>
    public async Task ConnectLocal()
    {
        if (Phase is ThisComputerPhase.Installing or ThisComputerPhase.Connecting) return;
        var retryLook = Phase == ThisComputerPhase.Failed && _installed;
        if (!retryLook) _installed = false;
        _lines.Clear();
        Failure = "";
        Set(ThisComputerPhase.Connecting);
        try
        {
            var found = await Look();
            if (found is null)
            {
                Here = ThisComputerHere.None;
                StartMeter(retryLook ? InstallStage.Starting : InstallStage.Fetching);
                Set(ThisComputerPhase.Installing);
                if (!retryLook)
                {
                    var code = await RunInstaller();
                    if (code != 0)
                    {
                        Fail(L.F("The installer stopped with code {0}.", code));
                        return;
                    }
                }
                _installed = true;
                _meter.Enter(InstallStage.Starting, DateTimeOffset.Now);
                Tick();
                found = await ThisComputer.WaitFor(Look, attempts: 15, pause: () => Task.Delay(TimeSpan.FromSeconds(2)));
            }
            if (found is null)
            {
                Fail(L.T("AI Space was installed, but it does not answer on this computer yet."));
                return;
            }
            StopMeter();
            Progress = 1;
            Here = ThisComputerHere.Found;
            _installed = false;
            model.AdoptThisComputer(found);
            Set(ThisComputerPhase.Choose);
        }
        catch (Exception e) when (e is IOException or HttpRequestException or OperationCanceledException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Write($"install AI Space: {e}");
            Fail(e.Message);
        }
    }

    /// <summary>The installer ended well before: Retry only looks for the Space again.</summary>
    private bool _installed;

    /// <summary>Leaves the failure for the two entries.</summary>
    public void Dismiss()
    {
        if (Phase == ThisComputerPhase.Failed) Set(ThisComputerPhase.Choose);
    }

    /// <summary>The bar follows the installer's steps and creeps on within one, four times a second.</summary>
    private void StartMeter(InstallStage stage)
    {
        _meter = new InstallProgress(DateTimeOffset.Now, stage);
        Progress = _meter.Value(DateTimeOffset.Now);
        _ticker?.Stop();
        _ticker = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        _ticker.Tick += (_, _) => Tick();
        _ticker.Start();
    }

    private void StopMeter()
    {
        _ticker?.Stop();
        _ticker = null;
    }

    private void Tick()
    {
        var value = Math.Max(Progress, _meter.Value(DateTimeOffset.Now));
        if (value == Progress) return;
        Progress = value;
        Changed?.Invoke();
    }

    /// <summary>Fetches the release's installer into a temporary file and runs it hidden; its exit code.</summary>
    private async Task<int> RunInstaller()
    {
        var source = ServiceInstaller.ScriptSource(Environment.GetEnvironmentVariable(ServiceInstaller.DownloadVariable));
        var file = Path.Combine(Path.GetTempPath(), $"ai-space-install-{Guid.NewGuid():N}.ps1");
        try
        {
            if (ServiceInstaller.IsRemote(source))
            {
                Add(L.F("Downloading {0}", source));
                using var http = new HttpClient { Timeout = DownloadTimeout };
                http.DefaultRequestHeaders.UserAgent.ParseAdd($"ai-space-windows/{AppModel.Version}");
                await File.WriteAllBytesAsync(file, await http.GetByteArrayAsync(source));
            }
            else
            {
                File.Copy(source, file, overwrite: true);
            }
            return await Run(ServiceInstaller.PowerShell(Environment.GetEnvironmentVariable("SystemRoot")), ServiceInstaller.Arguments(file));
        }
        finally
        {
            try
            {
                File.Delete(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private async Task<int> Run(string program, IReadOnlyList<string> arguments)
    {
        var info = new ProcessStartInfo(program)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        foreach (var a in arguments) info.ArgumentList.Add(a);
        foreach (var (name, value) in ServiceInstaller.Variables) info.Environment[name] = value;
        using var process = new Process { StartInfo = info };
        var ui = System.Windows.Application.Current.Dispatcher;
        void Line(string? line)
        {
            if (line is { } text) ui.InvokeAsync(() => Add(text));
        }
        process.OutputDataReceived += (_, e) => Line(e.Data);
        process.ErrorDataReceived += (_, e) => Line(e.Data);
        process.Start();
        // The installer asks nothing: an end of input instead of a wait for one.
        process.StandardInput.Close();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        using var limit = new CancellationTokenSource(InstallTimeout);
        try
        {
            await process.WaitForExitAsync(limit.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
            throw;
        }
        // The lines read on other threads reach the page before the result does.
        await ui.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.Background);
        return process.ExitCode;
    }

    private void Add(string line)
    {
        _meter.Read(line, DateTimeOffset.Now);
        Progress = Math.Max(Progress, _meter.Value(DateTimeOffset.Now));
        _lines.Add(line);
        if (_lines.Count > MaxLines) _lines.RemoveRange(0, _lines.Count - MaxLines);
        Changed?.Invoke();
    }

    private void Fail(string why)
    {
        StopMeter();
        Failure = why;
        Set(ThisComputerPhase.Failed);
    }

    private void Set(ThisComputerPhase phase)
    {
        Phase = phase;
        Changed?.Invoke();
    }
}
