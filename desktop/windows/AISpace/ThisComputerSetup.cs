using System.Diagnostics;
using System.Net.Http;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace;

/// <summary>Where the search for an AI Space on this computer stands, for the welcome page.</summary>
internal enum ThisComputerPhase
{
    /// <summary>Asking this computer's ports.</summary>
    Looking,
    /// <summary>None answers: the person chooses to install one or to connect elsewhere.</summary>
    NotFound,
    Installing,
    /// <summary>The installer failed, or what it installed does not answer.</summary>
    Failed,
}

/// <summary>
/// The first launch (docs/windows-desktop.md#this-computer): with no saved Space the app looks for
/// an AI Space on this computer and saves the one it finds, asking nothing. When there is none
/// the person may have it installed: the app fetches the release's own one-command installer and
/// runs it (<see cref="ServiceInstaller"/>), then looks again. AI Space is never part of the app:
/// the app does not carry, update, stop or remove it.
/// </summary>
internal sealed class ThisComputerSetup(AppModel model)
{
    private static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(30);
    private const int MaxLines = 400;
    private readonly HttpClient _probe = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false, UseProxy = false });
    private readonly List<string> _lines = [];

    public ThisComputerPhase Phase { get; private set; } = ThisComputerPhase.NotFound;
    /// <summary>What the installer printed so far.</summary>
    public IReadOnlyList<string> Lines => _lines;
    /// <summary>Why the installation failed, in the interface's language.</summary>
    public string Failure { get; private set; } = "";

    public event Action? Changed;

    /// <summary>At the app's start: looks only when no Space is saved, and takes the one found.</summary>
    public void Start()
    {
        if (model.Store.Connections.Count > 0) return;
        _ = LookAtStart();
    }

    private async Task LookAtStart()
    {
        Set(ThisComputerPhase.Looking);
        var found = await Look();
        // A Space the person added while the search ran stays the one shown.
        if (found is not null && model.Store.Connections.Count == 0) model.AdoptThisComputer(found);
        Set(ThisComputerPhase.NotFound);
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
    /// The person's choice to install AI Space here (also Retry). One that answers by now is taken
    /// as it is: the installer runs only when there is none.
    /// </summary>
    public async Task Install()
    {
        if (Phase is ThisComputerPhase.Installing or ThisComputerPhase.Looking) return;
        _lines.Clear();
        Failure = "";
        Set(ThisComputerPhase.Installing);
        try
        {
            var found = await Look();
            if (found is null)
            {
                var code = await RunInstaller();
                if (code != 0)
                {
                    Fail(L.F("The installer stopped with code {0}.", code));
                    return;
                }
                found = await ThisComputer.WaitFor(Look, attempts: 15, pause: () => Task.Delay(TimeSpan.FromSeconds(2)));
            }
            if (found is null)
            {
                Fail(L.T("AI Space was installed, but it does not answer on this computer yet."));
                return;
            }
            model.AdoptThisComputer(found);
            Set(ThisComputerPhase.NotFound);
        }
        catch (Exception e) when (e is IOException or HttpRequestException or OperationCanceledException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Write($"install AI Space: {e}");
            Fail(e.Message);
        }
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
        _lines.Add(line);
        if (_lines.Count > MaxLines) _lines.RemoveRange(0, _lines.Count - MaxLines);
        Changed?.Invoke();
    }

    private void Fail(string why)
    {
        Failure = why;
        Set(ThisComputerPhase.Failed);
    }

    private void Set(ThisComputerPhase phase)
    {
        Phase = phase;
        Changed?.Invoke();
    }
}
