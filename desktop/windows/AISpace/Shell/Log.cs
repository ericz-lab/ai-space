using System.Diagnostics;
using AISpace.Core;

namespace AISpace.Shell;

/// <summary>A small log under <c>%LOCALAPPDATA%\ai-space\logs</c>, for what goes wrong where nobody sees it.</summary>
internal static class Log
{
    private static readonly object Gate = new();
    private const long MaxBytes = 1_000_000;

    public static string File => Path.Combine(AppPaths.ForUser().Logs, "windows.log");

    public static void Write(string message)
    {
        Debug.WriteLine("ai-space: " + message);
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(File)!);
                var info = new FileInfo(File);
                if (info.Exists && info.Length > MaxBytes) System.IO.File.Move(File, File + ".1", true);
                System.IO.File.AppendAllText(File, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
