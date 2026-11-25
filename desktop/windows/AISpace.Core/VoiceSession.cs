using System.Net.WebSockets;
using System.Text;
using System.Threading.Channels;

namespace AISpace.Core;

/// <summary>The live route as <see cref="VoiceSession"/> sees it: a socket of text and binary messages.</summary>
public interface IVoiceChannel : IAsyncDisposable
{
    Task SendText(string text, CancellationToken ct);
    Task SendBinary(byte[] data, CancellationToken ct);
    /// <summary>The next text message; null once the socket closed.</summary>
    Task<string?> Receive(CancellationToken ct);
}

public enum VoiceFailure
{
    /// <summary>The live route failed after it was ready (its message in the detail).</summary>
    Failed,
    /// <summary>The audio could not be sent as fast as it was recorded.</summary>
    TooSlow,
    /// <summary>The final text did not come within the limit after letting go.</summary>
    TimedOut,
    /// <summary>The clip sent to <c>POST /api/voice/transcribe</c> came back with an error.</summary>
    UploadFailed,
}

/// <summary>How one recording ended: its text (maybe empty: nothing was heard), a failure, or cancelled.</summary>
public abstract record VoiceOutcome
{
    public sealed record Text(string Value) : VoiceOutcome;
    public sealed record Failed(VoiceFailure Kind, string Detail) : VoiceOutcome;
    public sealed record Cancelled : VoiceOutcome;
}

/// <summary>
/// One recording, transcribed live (docs/windows-desktop.md#voice-input): the Mac's
/// <c>LiveVoice</c> without the microphone, which the app feeds (<see cref="Feed"/>, mono 16 kHz
/// PCM16 from any thread). The socket (<c>WS /api/voice/realtime</c>) is opened at once and told
/// the language; what is recorded before it answers <c>ready</c> (a cold model load takes about
/// 15 s) is held, up to 50 seconds, and sent first, in frames of at most 100 ms. Partial and final
/// events update <see cref="TextChanged"/>. <see cref="Stop"/> (the key let go) sends the rest and
/// <c>stop</c>; the text comes after <c>done</c>, at most 70 seconds later. Until the route is
/// ready the whole recording is also kept, so when the socket is refused, fails or never gets
/// ready, it goes up as a WAV clip to <c>POST /api/voice/transcribe</c> and that text is the
/// outcome. Recording ends by itself after 90 seconds (<see cref="RecordingEnded"/>).
/// </summary>
public sealed class VoiceSession
{
    public const int BytesPerSecond = 32000;

    public sealed record Limits(TimeSpan Finish, int MaxBacklogBytes, int MaxRecordingBytes)
    {
        public static readonly Limits Default = new(TimeSpan.FromSeconds(70), 50 * BytesPerSecond, 90 * BytesPerSecond);
    }

    private readonly Func<CancellationToken, Task<IVoiceChannel>> _connect;
    private readonly Func<byte[], string, CancellationToken, Task<string>> _upload;
    private readonly Limits _limits;
    private readonly object _gate = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly Channel<byte[]> _audio = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
    private readonly TaskCompletionSource<VoiceOutcome> _done = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly VoiceTranscript _transcript = new();
    private MemoryStream? _clip = new();
    private IVoiceChannel? _channel;
    private CancellationTokenSource? _sender;
    private bool _started, _recording, _ready, _clipOnly, _uploading, _finished;
    private int _backlog;
    private long _recorded;

    /// <param name="connect">Opens the live socket (it may throw: refused, unreachable).</param>
    /// <param name="upload">Sends a WAV clip with the language and returns its text.</param>
    /// <param name="language">The code sent (<see cref="VoiceLanguage.Code"/>); empty lets the provider detect it.</param>
    public VoiceSession(Func<CancellationToken, Task<IVoiceChannel>> connect, Func<byte[], string, CancellationToken, Task<string>> upload, string language, Limits? limits = null)
    {
        _connect = connect;
        _upload = upload;
        Language = language;
        _limits = limits ?? Limits.Default;
    }

    public string Language { get; }

    /// <summary>The transcript so far, tidied (raised on a background thread).</summary>
    public event Action<string>? TextChanged;

    /// <summary>The session stopped taking audio by itself (the limit, or held too long for a transcriber that is not ready): close the microphone.</summary>
    public event Action? RecordingEnded;

    public Task<VoiceOutcome> Outcome => _done.Task;

    /// <summary>Whether the live route is used (false once the recording will go up as a clip).</summary>
    public bool Live
    {
        get { lock (_gate) return !_clipOnly; }
    }

    public void Start()
    {
        lock (_gate)
        {
            if (_started) return;
            _started = _recording = true;
        }
        _ = Listen(_cts.Token);
    }

    /// <summary>Recorded audio, from any thread. Ignored once recording stopped.</summary>
    public void Feed(ReadOnlySpan<byte> pcm)
    {
        if (pcm.IsEmpty) return;
        bool full = false, limit, ready;
        lock (_gate)
        {
            if (!_recording) return;
            _recorded += pcm.Length;
            if (_clip is { } clip && clip.Length + pcm.Length <= _limits.MaxRecordingBytes) clip.Write(pcm);
            if (!_clipOnly)
            {
                if (_backlog + pcm.Length > _limits.MaxBacklogBytes) full = true;
                else
                {
                    _backlog += pcm.Length;
                    _audio.Writer.TryWrite(pcm.ToArray());
                }
            }
            limit = _recorded >= _limits.MaxRecordingBytes;
            ready = _ready;
        }
        // Held as long as allowed while the model loads: stop recording and keep it.
        if (full && ready) Fail(VoiceFailure.TooSlow, "");
        else if (full || limit) End(byItself: true);
    }

    /// <summary>The key was let go (or the microphone was clicked again): the rest goes, then the text.</summary>
    public void Stop() => End(byItself: false);

    /// <summary>Abandons the recording: nothing is sent any more and the outcome is <see cref="VoiceOutcome.Cancelled"/>.</summary>
    public void Cancel() => Complete(new VoiceOutcome.Cancelled());

    private void End(bool byItself)
    {
        bool upload;
        lock (_gate)
        {
            if (!_recording) return;
            _recording = false;
            _audio.Writer.TryComplete();
            upload = _clipOnly;
        }
        if (byItself) RecordingEnded?.Invoke();
        if (upload) _ = Upload();
        else _ = FinishTimer();
    }

    private async Task FinishTimer()
    {
        try
        {
            await Task.Delay(_limits.Finish, _cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        bool ready;
        lock (_gate) ready = _ready;
        if (ready) Fail(VoiceFailure.TimedOut, "");
        else FallBack();
    }

    private async Task Listen(CancellationToken ct)
    {
        try
        {
            var channel = await _connect(ct).ConfigureAwait(false);
            lock (_gate)
            {
                if (_finished || _clipOnly)
                {
                    _ = channel.DisposeAsync().AsTask();
                    return;
                }
                _channel = channel;
            }
            await channel.SendText(VoiceLanguage.StartMessage(Language), ct).ConfigureAwait(false);
            while (!ct.IsCancellationRequested)
            {
                var message = await channel.Receive(ct).ConfigureAwait(false) ?? throw new WebSocketException("the voice connection closed");
                var e = VoiceEvent.Parse(message) ?? throw new InvalidDataException("not a voice event");
                switch (e.Type)
                {
                    case "ready":
                        bool start;
                        lock (_gate)
                        {
                            start = !_ready && !_clipOnly;
                            if (start)
                            {
                                _ready = true;
                                _clip = null;
                            }
                        }
                        if (start) StartSender(channel);
                        break;
                    case "partial" or "final":
                        if (e.SegmentId is not { } id || e.Text is not { } text) throw new InvalidDataException("a voice event without its segment");
                        string now;
                        lock (_gate) now = _transcript.Update(id, text, e.Type == "final");
                        TextChanged?.Invoke(now);
                        break;
                    case "done":
                        string final;
                        lock (_gate) final = _transcript.Text;
                        Complete(new VoiceOutcome.Text(final.Trim()));
                        return;
                    case "error":
                        if (IsReady()) Fail(VoiceFailure.Failed, e.Message ?? "");
                        else FallBack();
                        return;
                }
            }
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            // A refused upgrade (no live provider: 503) or a dropped link before `ready`.
            if (IsReady()) Fail(VoiceFailure.Failed, e.Message);
            else FallBack();
        }
        catch (Exception)
        {
            // Cancelled: the outcome is already set.
        }
    }

    private bool IsReady()
    {
        lock (_gate) return _ready;
    }

    /// <summary>Once the transcriber is ready: what was held goes first, then live audio, then <c>stop</c>.</summary>
    private void StartSender(IVoiceChannel channel)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
        lock (_gate) _sender = cts;
        _ = Task.Run(async () =>
        {
            var ct = cts.Token;
            try
            {
                var frames = new VoicePcmFrames();
                await foreach (var data in _audio.Reader.ReadAllAsync(ct).ConfigureAwait(false))
                {
                    foreach (var frame in frames.Append(data)) await channel.SendBinary(frame, ct).ConfigureAwait(false);
                    lock (_gate) _backlog -= data.Length;
                }
                if (frames.Finish() is { } tail) await channel.SendBinary(tail, ct).ConfigureAwait(false);
                await channel.SendText("{\"type\":\"stop\"}", ct).ConfigureAwait(false);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                Fail(VoiceFailure.Failed, e.Message);
            }
            catch (Exception)
            {
            }
        });
    }

    /// <summary>The live route will not answer: the recording, whole, goes up as a clip once it ends.</summary>
    private void FallBack()
    {
        IVoiceChannel? channel;
        bool upload;
        lock (_gate)
        {
            if (_clipOnly || _finished) return;
            _clipOnly = true;
            _audio.Writer.TryComplete();
            _sender?.Cancel();
            channel = _channel;
            _channel = null;
            upload = !_recording;
        }
        if (channel is not null) _ = channel.DisposeAsync().AsTask().ContinueWith(_ => { }, TaskScheduler.Default);
        if (upload) _ = Upload();
    }

    private async Task Upload()
    {
        byte[] pcm;
        lock (_gate)
        {
            if (_uploading || _finished) return;
            _uploading = true;
            pcm = _clip?.ToArray() ?? [];
        }
        if (pcm.Length == 0)
        {
            Complete(new VoiceOutcome.Text(""));
            return;
        }
        try
        {
            var text = await _upload(VoiceText.Wav(pcm), Language, _cts.Token).ConfigureAwait(false);
            Complete(new VoiceOutcome.Text(VoiceText.Tidy(text.Trim())));
        }
        catch (Exception e) when (!_cts.IsCancellationRequested)
        {
            Fail(VoiceFailure.UploadFailed, e.Message);
        }
        catch (Exception)
        {
        }
    }

    private void Fail(VoiceFailure kind, string detail) => Complete(new VoiceOutcome.Failed(kind, detail));

    private void Complete(VoiceOutcome outcome)
    {
        IVoiceChannel? channel;
        lock (_gate)
        {
            if (_finished) return;
            _finished = true;
            _recording = false;
            _audio.Writer.TryComplete();
            channel = _channel;
            _channel = null;
        }
        _cts.Cancel();
        if (channel is not null) _ = channel.DisposeAsync().AsTask().ContinueWith(_ => { }, TaskScheduler.Default);
        _done.TrySetResult(outcome);
    }
}

/// <summary><see cref="IVoiceChannel"/> on a <see cref="ClientWebSocket"/> (<see cref="SpaceApi.VoiceSocket"/>).</summary>
public sealed class WebSocketVoiceChannel(ClientWebSocket socket) : IVoiceChannel
{
    private readonly byte[] _buffer = new byte[16 * 1024];

    public Task SendText(string text, CancellationToken ct) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, ct);

    public Task SendBinary(byte[] data, CancellationToken ct) =>
        socket.SendAsync(data, WebSocketMessageType.Binary, true, ct);

    public async Task<string?> Receive(CancellationToken ct)
    {
        using var message = new MemoryStream();
        while (true)
        {
            var r = await socket.ReceiveAsync(_buffer, ct).ConfigureAwait(false);
            if (r.MessageType == WebSocketMessageType.Close) return null;
            message.Write(_buffer, 0, r.Count);
            if (message.Length > 1024 * 1024) throw new InvalidDataException("a voice event too large");
            if (r.EndOfMessage) return Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                using var t = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, t.Token).ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
        }
        socket.Dispose();
    }
}
