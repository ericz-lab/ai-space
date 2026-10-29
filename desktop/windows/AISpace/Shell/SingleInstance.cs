using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;

namespace AISpace.Shell;

/// <summary>
/// One running copy per Windows session. A second start (a link, the jump list, the Start menu
/// while the app sits in the notification area) hands its arguments to the first over a pipe only
/// this user can open, then exits.
/// </summary>
internal sealed class SingleInstance : IDisposable
{
    private static readonly string Name = $"ai-space-windows-{Process.GetCurrentProcess().SessionId}";
    private readonly Mutex _mutex;
    private readonly CancellationTokenSource _stop = new();

    public SingleInstance()
    {
        _mutex = new Mutex(true, @"Local\" + Name, out var first);
        IsFirst = first;
    }

    public bool IsFirst { get; }

    /// <summary>Gives the arguments to the running copy; false when none answered.</summary>
    public static bool Send(IReadOnlyList<string> args)
    {
        try
        {
            // The running copy may bring its window forward: this start came from the person.
            Native.AllowSetForegroundWindow(Native.ASFW_ANY);
            using var pipe = new NamedPipeClientStream(".", Name, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            pipe.Connect(3000);
            using var w = new StreamWriter(pipe);
            w.WriteLine(JsonSerializer.Serialize(args));
            w.Flush();
            return true;
        }
        catch (Exception e) when (e is IOException or TimeoutException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Hands every later start's arguments to <paramref name="received"/>, on a background thread.</summary>
    public void Listen(Action<string[]> received)
    {
        _ = Task.Run(async () =>
        {
            while (!_stop.IsCancellationRequested)
            {
                try
                {
                    await using var pipe = new NamedPipeServerStream(Name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                    await pipe.WaitForConnectionAsync(_stop.Token);
                    using var r = new StreamReader(pipe);
                    var line = await r.ReadLineAsync(_stop.Token);
                    if (line is null) continue;
                    var args = JsonSerializer.Deserialize<string[]>(line);
                    if (args is not null) received(args);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (Exception e) when (e is IOException or JsonException)
                {
                    Log.Write($"single instance: {e.Message}");
                }
            }
        });
    }

    public void Dispose()
    {
        _stop.Cancel();
        if (IsFirst) _mutex.ReleaseMutex();
        _mutex.Dispose();
    }
}
