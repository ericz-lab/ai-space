using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// Voice input's routes (docs/speech.md#compatibility): <c>GET /api/voice</c>,
/// <c>POST /api/voice/transcribe</c> and <c>WS /api/voice/realtime</c>, with the Space's sign-in.
/// The two that send speech name the Space's origin, as the panel's page does.
/// </summary>
public sealed partial class SpaceApi
{
    private HttpClient? _slow;

    /// <summary>Whether the Space can transcribe (<c>transcribe</c>); null when it did not answer (signed out, offline).</summary>
    public async Task<bool?> VoiceAvailable(CancellationToken ct = default)
    {
        try
        {
            var answer = await Get("/api/voice", ct).ConfigureAwait(false);
            return answer.ValueKind == JsonValueKind.Object && answer.TryGetProperty("transcribe", out var t) && t.ValueKind == JsonValueKind.True;
        }
        catch (SpaceApiException)
        {
            return null;
        }
    }

    /// <summary>A WAV clip to <c>POST /api/voice/transcribe</c> with the language (none when detecting): its <c>text</c>.</summary>
    public async Task<string> Transcribe(byte[] wav, string language, CancellationToken ct = default)
    {
        using var r = await Request(HttpMethod.Post, "/api/voice/transcribe").ConfigureAwait(false);
        r.Headers.TryAddWithoutValidation("Origin", ConnectionRules.OriginHeader(Base));
        var form = new MultipartFormDataContent();
        var file = new ByteArrayContent(wav);
        file.Headers.ContentType = new MediaTypeHeaderValue("audio/wav");
        form.Add(file, "file", "voice.wav");
        foreach (var (name, value) in VoiceLanguage.UploadFields(language)) form.Add(new StringContent(value), name);
        r.Content = form;
        // A cold model load and a long clip can take longer than the other routes' 30 seconds.
        _slow ??= new HttpClient(_handler, disposeHandler: false) { Timeout = TimeSpan.FromSeconds(120) };
        foreach (var ua in _http.DefaultRequestHeaders.UserAgent) r.Headers.UserAgent.Add(ua);
        string body;
        int status;
        try
        {
            using var response = await _slow.SendAsync(r, ct).ConfigureAwait(false);
            body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            status = (int)response.StatusCode;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
        }
        Check(status, body);
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() ?? "" : "";
        }
        catch (JsonException)
        {
            throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not the expected JSON", status);
        }
    }

    /// <summary>The live route's address: <c>ws</c> or <c>wss</c> as the Space is <c>http</c> or <c>https</c>.</summary>
    public Uri VoiceSocketUrl() => new UriBuilder(Url("/api/voice/realtime")) { Scheme = Base.Scheme == "https" ? "wss" : "ws" }.Uri;

    /// <summary>Opens <c>WS /api/voice/realtime</c> with the Space's cookies and origin; throws when it is refused (no live provider: 503).</summary>
    public async Task<IVoiceChannel> VoiceSocket(CancellationToken ct = default)
    {
        var socket = new ClientWebSocket();
        try
        {
            if (await _cookies(Url("/api/voice/realtime")).ConfigureAwait(false) is { Length: > 0 } cookie) socket.Options.SetRequestHeader("Cookie", cookie);
            socket.Options.SetRequestHeader("Origin", ConnectionRules.OriginHeader(Base));
            socket.Options.SetRequestHeader("User-Agent", _http.DefaultRequestHeaders.UserAgent.ToString());
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(TimeSpan.FromSeconds(20));
            await socket.ConnectAsync(VoiceSocketUrl(), limit.Token).ConfigureAwait(false);
            return new WebSocketVoiceChannel(socket);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}
