using AISpace.Core;

namespace AISpace.Core.Tests;

/// <summary>The one progress bar of an installation from the first launch (docs/editions.md#ai-space-client).</summary>
public class InstallProgressTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 22, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void TheInstallersLinesMarkItsSteps()
    {
        Assert.Equal(InstallStage.Looking, InstallProgress.StageOf("ai-space: looking for the latest release for windows-x64"));
        Assert.Equal(InstallStage.Downloading, InstallProgress.StageOf("ai-space: downloading ai-space-0.3.0-windows-x64.tar.gz"));
        Assert.Equal(InstallStage.Placing, InstallProgress.StageOf(@"ai-space 0.3.0 (bd7cae0) in C:\Users\a\AppData\Local\ai-space\releases\0.3.0"));
        Assert.Equal(InstallStage.Apps, InstallProgress.StageOf("ai-space core: installed, answering on 127.0.0.1:8700 (workspace C:\\Users\\a\\.ai-space)"));
        Assert.Equal(InstallStage.Starting, InstallProgress.StageOf("ai-space is running. Open the panel: http://127.0.0.1:8700/"));
        Assert.Null(InstallProgress.StageOf("Downloading https://github.com/ericz-lab/ai-space/releases/latest/download/install.ps1"));
        Assert.Null(InstallProgress.StageOf(null));
    }

    [Fact]
    public void TheBarOnlyGoesForwardAndStaysBelowOne()
    {
        var p = new InstallProgress(T0);
        var t = T0;
        var last = p.Value(t);
        Assert.Equal(0, last);
        foreach (var line in new[] { "ai-space: looking for x", "ai-space: downloading x.tar.gz", "noise", "ai-space 0.3.0 (abc) in C:\\x", "ai-space core: installed, answering", "ai-space is running." })
        {
            t = t.AddMinutes(10);
            var creeping = p.Value(t);
            Assert.True(creeping >= last);
            p.Read(line, t);
            last = p.Value(t);
            Assert.True(last >= creeping);
        }
        Assert.Equal(InstallStage.Starting, p.Stage);
        Assert.True(p.Value(t.AddHours(1)) < 1);
        p.Read("ai-space: downloading again", t);
        Assert.Equal(InstallStage.Starting, p.Stage);
    }

    [Fact]
    public void EachStepStartsAboveTheCeilingOfTheOneBefore()
    {
        var all = Enum.GetValues<InstallStage>();
        for (var i = 1; i < all.Length; i++) Assert.True(InstallProgress.Span(all[i - 1]).To <= InstallProgress.Span(all[i]).From);
    }
}
