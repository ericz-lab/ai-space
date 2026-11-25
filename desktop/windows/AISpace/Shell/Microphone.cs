using System.Runtime.InteropServices;
using AISpace.Core;
using Microsoft.Win32;

namespace AISpace.Shell;

/// <summary>
/// The default microphone as mono 16 kHz PCM16 (what the live route takes), in buffers of 100 ms,
/// through waveIn: Windows' own mapper converts from the device's format, so the app resamples
/// nothing and needs no audio library. The buffers are handed over on a thread of its own.
/// </summary>
internal sealed class Microphone : IDisposable
{
    private const int Buffers = 4, BufferBytes = 3200;

    private readonly Action<byte[]> _audio;
    private readonly AutoResetEvent _signal = new(false);
    private readonly IntPtr[] _headers = new IntPtr[Buffers];
    private readonly int _headerSize = Marshal.SizeOf<Native.WAVEHDR>();
    private readonly int _flagsOffset = (int)Marshal.OffsetOf<Native.WAVEHDR>(nameof(Native.WAVEHDR.Flags));
    private readonly int _recordedOffset = (int)Marshal.OffsetOf<Native.WAVEHDR>(nameof(Native.WAVEHDR.BytesRecorded));
    private IntPtr _device;
    /// <summary>The buffer that fills next.</summary>
    private int _next;
    private Thread? _thread;
    private volatile bool _stopping;

    public Microphone(Action<byte[]> audio) => _audio = audio;

    /// <summary>Why recording cannot start before trying: Windows' privacy switch, or no microphone. Null when it may.</summary>
    public static string? Unavailable()
    {
        static string? Read(RegistryKey root, string sub) => root.OpenSubKey(sub)?.GetValue("Value") as string;
        var allowed = MicrophoneAccess.Allowed(
            Read(Registry.LocalMachine, MicrophoneAccess.Key),
            Read(Registry.CurrentUser, MicrophoneAccess.Key),
            Read(Registry.CurrentUser, MicrophoneAccess.Key + @"\NonPackaged"));
        if (!allowed) return L.T("Windows does not let desktop apps use the microphone. Allow it in Settings → Privacy & security → Microphone, with “Let desktop apps access your microphone” on.");
        if (Native.waveInGetNumDevs() == 0) return L.T("No microphone was found. Connect one, or choose one in Settings → System → Sound.");
        return null;
    }

    /// <summary>Opens the default microphone and starts recording; throws with Windows' error code when it cannot.</summary>
    public void Start()
    {
        var format = new Native.WAVEFORMATEX { FormatTag = 1, Channels = 1, SamplesPerSec = 16000, AvgBytesPerSec = 32000, BlockAlign = 2, BitsPerSample = 16 };
        Check(Native.waveInOpen(out _device, Native.WAVE_MAPPER, ref format, _signal.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, Native.CALLBACK_EVENT), "waveInOpen");
        try
        {
            for (var i = 0; i < Buffers; i++)
            {
                var data = Marshal.AllocHGlobal(BufferBytes);
                var header = Marshal.AllocHGlobal(_headerSize);
                Marshal.StructureToPtr(new Native.WAVEHDR { Data = data, BufferLength = BufferBytes }, header, false);
                _headers[i] = header;
                Check(Native.waveInPrepareHeader(_device, header, (uint)_headerSize), "waveInPrepareHeader");
                Check(Native.waveInAddBuffer(_device, header, (uint)_headerSize), "waveInAddBuffer");
            }
            Check(Native.waveInStart(_device), "waveInStart");
        }
        catch
        {
            Close();
            throw;
        }
        _thread = new Thread(Run) { IsBackground = true, Name = "ai-space microphone" };
        _thread.Start();
    }

    private static void Check(uint result, string call)
    {
        if (result != 0) throw new IOException($"{call} failed ({result})");
    }

    private void Run()
    {
        while (!_stopping)
        {
            _signal.WaitOne(200);
            Collect(requeue: !_stopping);
        }
    }

    /// <summary>Hands over the filled buffers in the order they were queued (they fill round the ring), and queues each again.</summary>
    private void Collect(bool requeue)
    {
        for (var n = 0; n < Buffers; n++, _next = (_next + 1) % Buffers)
        {
            var header = _headers[_next];
            if (header == IntPtr.Zero || (Marshal.ReadInt32(header, _flagsOffset) & Native.WHDR_DONE) == 0) return;
            var count = Marshal.ReadInt32(header, _recordedOffset);
            if (count > 0)
            {
                var bytes = new byte[count];
                Marshal.Copy(Marshal.ReadIntPtr(header), bytes, 0, count);
                _audio(bytes);
            }
            Marshal.WriteInt32(header, _recordedOffset, 0);
            Marshal.WriteInt32(header, _flagsOffset, Marshal.ReadInt32(header, _flagsOffset) & ~(int)Native.WHDR_DONE);
            if (requeue) Native.waveInAddBuffer(_device, header, (uint)_headerSize);
        }
    }

    /// <summary>Stops recording: what was recorded up to now is handed over before this returns.</summary>
    public void Stop()
    {
        if (_device == IntPtr.Zero) return;
        _stopping = true;
        _signal.Set();
        _thread?.Join(1000);
        // Reset returns the buffers, the last ones partly filled.
        Native.waveInReset(_device);
        Collect(requeue: false);
        Close();
    }

    private void Close()
    {
        if (_device == IntPtr.Zero) return;
        Native.waveInReset(_device);
        for (var i = 0; i < Buffers; i++)
        {
            var header = _headers[i];
            if (header == IntPtr.Zero) continue;
            Native.waveInUnprepareHeader(_device, header, (uint)_headerSize);
            Marshal.FreeHGlobal(Marshal.ReadIntPtr(header));
            Marshal.FreeHGlobal(header);
            _headers[i] = IntPtr.Zero;
        }
        Native.waveInClose(_device);
        _device = IntPtr.Zero;
    }

    public void Dispose()
    {
        Stop();
        _signal.Dispose();
    }
}
