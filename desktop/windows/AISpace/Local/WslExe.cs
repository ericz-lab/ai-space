using System.Diagnostics;
using System.Text;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Local;

/// <summary>Runs <c>wsl.exe</c> hidden and reads what it prints, whatever encoding it chose.</summary>
internal static class WslExe
{
    public static string Path => System.IO.Path.Combine(Environment.SystemDirectory, "wsl.exe");

    public static bool Exists => File.Exists(Path);

    public sealed record Result(int Code, string Output, string Error)
    {
        public bool Ok => Code == 0;
        /// <summary>The last lines of what went wrong, for a failure message.</summary>
        public string Tail => (Error.Trim().Length > 0 ? Error : Output).Trim() is var t && t.Length > 600 ? t[^600..] : t;
    }

    public static Task<Result> Run(WslCommand cmd, TimeSpan timeout) => Run(cmd.Args, cmd.Input, timeout);

    public static async Task<Result> Run(IReadOnlyList<string> args, string? input, TimeSpan timeout)
    {
        var psi = new ProcessStartInfo(Path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = input is not null,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        // wsl.exe's own messages in UTF-8 instead of UTF-16 (older versions ignore it; DecodeOutput copes).
        psi.Environment["WSL_UTF8"] = "1";
        using var p = new Process { StartInfo = psi };
        try
        {
            p.Start();
        }
        catch (System.ComponentModel.Win32Exception e)
        {
            return new Result(-1, "", e.Message);
        }
        var output = Read(p.StandardOutput.BaseStream);
        var error = Read(p.StandardError.BaseStream);
        if (input is not null)
        {
            // The shell reads the script from here; Unix line ends, no byte order mark.
            var bytes = new UTF8Encoding(false).GetBytes(input.Replace("\r\n", "\n", StringComparison.Ordinal));
            await p.StandardInput.BaseStream.WriteAsync(bytes);
            p.StandardInput.Close();
        }
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            await p.WaitForExitAsync(cts.Token);
        }
        catch (OperationCanceledException)
        {
            try
            {
                p.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
            Log.Write($"wsl {string.Join(' ', args.Take(6))}: timed out");
            return new Result(-1, Wsl.DecodeOutput(await output), "timed out");
        }
        return new Result(p.ExitCode, Wsl.DecodeOutput(await output), Wsl.DecodeOutput(await error));
    }

    private static async Task<byte[]> Read(Stream s)
    {
        using var m = new MemoryStream();
        await s.CopyToAsync(m);
        return m.ToArray();
    }

    /// <summary>Starts <c>wsl.exe</c> in a console window of its own, for what asks the person (installing WSL).</summary>
    public static void OpenConsole(IEnumerable<string> args)
    {
        var psi = new ProcessStartInfo(Path) { UseShellExecute = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        Process.Start(psi);
    }
}
