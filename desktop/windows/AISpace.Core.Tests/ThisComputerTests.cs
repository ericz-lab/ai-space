using System.Net;
using AISpace.Core;

namespace AISpace.Core.Tests;

/// <summary>The first launch's search for an AI Space on this computer, and the installer it may run (docs/windows-desktop.md#this-computer).</summary>
public class ThisComputerTests
{
    private const string Identity = """{"product":"ai-space","api":1,"version":"0.2.1","edition":"server"}""";

    [Fact]
    public void ThePortComesFromTheWorkspacesEnv()
    {
        Assert.Equal(8712, ThisComputer.PortFromEnv("SPACE_AUTH=builtin\r\nSPACE_PORT=8712\r\n"));
        Assert.Equal(9000, ThisComputer.PortFromEnv("SPACE_PORT=\"9000\"\n"));
        Assert.Equal(9000, ThisComputer.PortFromEnv("SPACE_PORT= '9000' \nSPACE_PORT=9001\n"));
        Assert.Null(ThisComputer.PortFromEnv("# SPACE_PORT=8712\nOTHER_SPACE_PORT=1\n"));
        Assert.Null(ThisComputer.PortFromEnv("SPACE_PORT=\n"));
        Assert.Null(ThisComputer.PortFromEnv("SPACE_PORT=http\n"));
        Assert.Null(ThisComputer.PortFromEnv("SPACE_PORT=70000\n"));
        Assert.Null(ThisComputer.PortFromEnv("SPACE_PORT=0\n"));
        Assert.Null(ThisComputer.PortFromEnv(""));
        Assert.Null(ThisComputer.PortFromEnv(null));
    }

    [Fact]
    public void TheEnvFileIsTheWorkspaces()
    {
        Assert.Equal(Path.Combine("home", ".ai-space", ".env"), ThisComputer.EnvFile(null, "home"));
        Assert.Equal(Path.Combine("home", ".ai-space", ".env"), ThisComputer.EnvFile("  ", "home"));
        Assert.Equal(Path.Combine("elsewhere", ".env"), ThisComputer.EnvFile("elsewhere", "home"));
    }

    [Fact]
    public void TheWorkspacesPortIsAskedBeforeTheDefault()
    {
        Assert.Equal([8700], ThisComputer.CandidatePorts(null));
        Assert.Equal([8700], ThisComputer.CandidatePorts("SPACE_PORT=8700\n"));
        Assert.Equal([8712, 8700], ThisComputer.CandidatePorts("SPACE_PORT=8712\n"));
        Assert.Equal("http://127.0.0.1:8712/", ThisComputer.Address(8712).AbsoluteUri);
    }

    [Fact]
    public void OnlyAnAISpaceIsOne()
    {
        Assert.True(ThisComputer.IsAISpace(200, Identity));
        Assert.True(ThisComputer.IsAISpace(200, """{"product":"ai-space"}"""));
        Assert.False(ThisComputer.IsAISpace(200, """{"product":"something-else","api":1}"""));
        Assert.False(ThisComputer.IsAISpace(200, """{"product":1}"""));
        Assert.False(ThisComputer.IsAISpace(200, "<html>a dev server</html>"));
        Assert.False(ThisComputer.IsAISpace(200, "[]"));
        Assert.False(ThisComputer.IsAISpace(404, Identity));
        Assert.False(ThisComputer.IsAISpace(401, Identity));
        Assert.False(ThisComputer.IsAISpace(302, ""));
    }

    [Fact]
    public async Task TheFirstPortThatAnswersAsAISpaceIsFound()
    {
        var asked = new List<string>();
        Task<(int, string)> Get(Uri url, CancellationToken ct)
        {
            asked.Add(url.AbsoluteUri);
            if (url.Port == 8712) throw new HttpRequestException("connection refused");
            return Task.FromResult((200, Identity));
        }
        Assert.Equal("http://127.0.0.1:8700/", (await ThisComputer.Find([8712, 8700], Get))?.AbsoluteUri);
        Assert.Equal(["http://127.0.0.1:8712/api/space", "http://127.0.0.1:8700/api/space"], asked);
        Assert.Equal("http://127.0.0.1:8712/", (await ThisComputer.Find([8712, 8700], (_, _) => Task.FromResult((200, Identity))))?.AbsoluteUri);
    }

    [Fact]
    public async Task NothingIsFoundWhereNoAISpaceAnswers()
    {
        Assert.Null(await ThisComputer.Find([8700], (_, _) => throw new HttpRequestException("connection refused")));
        Assert.Null(await ThisComputer.Find([8700], (_, _) => Task.FromResult((200, "<html></html>"))));
        Assert.Null(await ThisComputer.Find([8712, 8700], (_, _) => Task.FromResult((503, ""))));
        // A port that accepts and never answers is given up on.
        async Task<(int, string)> Hangs(Uri url, CancellationToken ct)
        {
            await Task.Delay(Timeout.Infinite, ct);
            return (200, Identity);
        }
        Assert.Null(await ThisComputer.Find([8700], Hangs, TimeSpan.FromMilliseconds(50)));
    }

    [Fact]
    public async Task ACancelledSearchStops()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => ThisComputer.Find([8700], (_, ct) => Task.FromCanceled<(int, string)>(ct), ct: cancelled.Token));
    }

    [Fact]
    public async Task TheSearchReadsTheAnswerOverHttp()
    {
        HttpRequestMessage? seen = null;
        using var http = new HttpClient(new ScriptedHandler(r =>
        {
            seen = r;
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Identity) };
        }));
        var found = await ThisComputer.Find([8700], (url, ct) => ThisComputer.Get(http, url, ct));
        Assert.Equal("http://127.0.0.1:8700/", found?.AbsoluteUri);
        Assert.Equal(HttpMethod.Get, seen?.Method);
        Assert.Equal("/api/space", seen?.RequestUri?.AbsolutePath);
    }

    [Fact]
    public async Task AServiceJustInstalledIsWaitedFor()
    {
        var looks = 0;
        var pauses = 0;
        Task Pause()
        {
            pauses++;
            return Task.CompletedTask;
        }
        var found = await ThisComputer.WaitFor(() => Task.FromResult<Uri?>(++looks < 3 ? null : ThisComputer.Address(8700)), 15, Pause);
        Assert.Equal("http://127.0.0.1:8700/", found?.AbsoluteUri);
        Assert.Equal((3, 2), (looks, pauses));

        looks = pauses = 0;
        Assert.Null(await ThisComputer.WaitFor(() =>
        {
            looks++;
            return Task.FromResult<Uri?>(null);
        }, 4, Pause));
        Assert.Equal((4, 3), (looks, pauses));
    }

    [Fact]
    public void TheInstallerIsTheReleasesOwn()
    {
        Assert.Equal("https://github.com/ericz-lab/ai-space/releases/latest/download/install.ps1", ServiceInstaller.ScriptSource(null));
        Assert.Equal("https://github.com/ericz-lab/ai-space/releases/latest/download/install.ps1", ServiceInstaller.ScriptSource("  "));
        Assert.Equal("https://mirror.example.com/ai-space/install.ps1", ServiceInstaller.ScriptSource("https://mirror.example.com/ai-space/"));
        Assert.True(ServiceInstaller.IsRemote(ServiceInstaller.ScriptSource(null)));
        Assert.True(ServiceInstaller.IsRemote("http://127.0.0.1:9000/install.ps1"));
        // A directory on this machine, as the installer's own tests use it.
        Assert.Equal(Path.Combine(@"C:\release", "install.ps1"), ServiceInstaller.ScriptSource(@"C:\release\"));
        Assert.Equal(Path.Combine("C:/release", "install.ps1"), ServiceInstaller.ScriptSource("file:///C:/release"));
        Assert.False(ServiceInstaller.IsRemote(ServiceInstaller.ScriptSource(@"C:\release")));
    }

    [Fact]
    public void TheInstallerRunsInWindowsPowerShellAndOpensNoBrowser()
    {
        Assert.Equal(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", ServiceInstaller.PowerShell(@"C:\Windows"));
        Assert.Equal(@"D:\WINNT\System32\WindowsPowerShell\v1.0\powershell.exe", ServiceInstaller.PowerShell(@"D:\WINNT\"));
        Assert.Equal(@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe", ServiceInstaller.PowerShell(null));
        Assert.Equal(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", @"C:\Temp\ai-space-install.ps1"], ServiceInstaller.Arguments(@"C:\Temp\ai-space-install.ps1"));
        Assert.Equal("1", ServiceInstaller.Variables["AI_SPACE_NO_OPEN"]);
    }

    [Fact]
    public void AFailureShowsTheEndOfWhatTheInstallerPrinted()
    {
        var lines = Enumerable.Range(1, 30).Select(i => $"line {i}  ").Append("").Append("ai-space install: could not download SHA256SUMS").ToList();
        var tail = ServiceInstaller.Tail(lines, 3).Split('\n').ToList();
        Assert.Equal(["line 29", "line 30", "ai-space install: could not download SHA256SUMS"], tail);
        Assert.Equal("", ServiceInstaller.Tail([]));
    }
}
