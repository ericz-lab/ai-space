using System.Text;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The language voice input is transcribed in (docs/speech.md#languages): the Mac's and iPhone's
/// <c>VoiceLanguage</c> (desktop/macos/AISpace/Services/SpaceModels.swift). The setting is "Same as
/// AI Space" (the app's display language when it is one of <see cref="Codes"/>, else the provider
/// detects it), "Detect automatically" (nothing is sent), or one of the codes.
/// </summary>
public static class VoiceLanguage
{
    /// <summary>The setting's value for "Same as AI Space", the default.</summary>
    public const string SameAsApp = "";
    /// <summary>The setting's value for "Detect automatically": nothing is sent, the provider detects it.</summary>
    public const string Detect = "auto";
    /// <summary>The languages Settings offers: codes every speech provider of the Space takes as they are.</summary>
    public static readonly IReadOnlyList<string> Codes = ["zh", "en", "ja", "ko"];

    /// <summary>The <c>language</c> to send for a setting; empty lets the provider detect it.</summary>
    public static string Code(string? setting, string appLanguage)
    {
        setting ??= SameAsApp;
        if (setting == Detect) return "";
        if (Codes.Contains(setting)) return setting;
        var primary = appLanguage.Split('-', '_')[0].ToLowerInvariant();
        return Codes.Contains(primary) ? primary : "";
    }

    /// <summary>The live protocol's <c>start</c> message (docs/speech.md#live-protocol).</summary>
    public static string StartMessage(string language)
    {
        var code = Codes.Contains(language) ? language : "";
        return "{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"" + code + "\"}";
    }

    /// <summary>The multipart fields of a clip sent to <c>POST /api/voice/transcribe</c>: none when detecting.</summary>
    public static IReadOnlyList<(string Name, string Value)> UploadFields(string language) =>
        Codes.Contains(language) ? [("language", language)] : [];
}

/// <summary>
/// The live transcript: the final segments and the current one's draft, by <c>segment_id</c>
/// (the iPhone's <c>VoiceTranscript</c>). A final segment is kept once; a partial replaces the
/// segment's draft. Segments are joined by a space, which is then dropped between two Chinese or
/// Japanese characters (<see cref="VoiceText.Tidy"/>).
/// </summary>
public sealed class VoiceTranscript
{
    private readonly SortedDictionary<int, (string Text, bool Final)> _segments = [];

    public string Text { get; private set; } = "";

    public string Update(int id, string text, bool final)
    {
        if (!(_segments.TryGetValue(id, out var s) && s.Final)) _segments[id] = (text, final);
        Text = VoiceText.Tidy(string.Join(" ", _segments.Values.Select(v => v.Text.Trim()).Where(v => v.Length > 0)));
        return Text;
    }
}

/// <summary>The live route takes at most 100 ms (3,200 bytes) of 16 kHz mono PCM16 per message (the iPhone's <c>VoicePCMFrames</c>).</summary>
public sealed class VoicePcmFrames
{
    public const int FrameBytes = 3200;
    private readonly List<byte> _pending = [];

    public IReadOnlyList<byte[]> Append(ReadOnlySpan<byte> data)
    {
        foreach (var b in data) _pending.Add(b);
        var frames = new List<byte[]>();
        while (_pending.Count >= FrameBytes)
        {
            frames.Add([.. _pending.GetRange(0, FrameBytes)]);
            _pending.RemoveRange(0, FrameBytes);
        }
        return frames;
    }

    public byte[]? Finish()
    {
        if (_pending.Count == 0) return null;
        var tail = _pending.ToArray();
        _pending.Clear();
        return tail;
    }
}

/// <summary>Text rules of voice input (the Mac's <c>DictationRules</c>): joining, the overlay's tail, the clip.</summary>
public static class VoiceText
{
    /// <summary>
    /// Segments are joined by a space, which is wrong inside Chinese or Japanese text: a space
    /// between two such characters is dropped, one beside a Latin word or a digit stays.
    /// </summary>
    public static string Tidy(string text)
    {
        var sb = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == ' ' && i > 0 && i + 1 < text.Length && Wide(text[i - 1]) && Wide(text[i + 1])) continue;
            sb.Append(text[i]);
        }
        return sb.ToString();
    }

    /// <summary>CJK ideographs, kana, and their punctuation and full-width forms.</summary>
    public static bool Wide(char c) => c is >= '⺀' and <= '鿿' or >= '豈' and <= '﫿' or >= '＀' and <= '￯';

    /// <summary>
    /// How much of a long live transcript the overlay shows: its end, which is what is being said,
    /// cut at a word when one ends near the cut (a language without spaces is cut anywhere).
    /// </summary>
    public static string Tail(string text, int limit = 120)
    {
        text = text.Trim();
        if (text.Length <= limit) return text;
        var kept = text[^limit..];
        var space = kept.IndexOf(' ', 0, limit / 6);
        if (space >= 0) kept = kept[(space + 1)..];
        return "…" + kept;
    }

    /// <summary>A transcript put after what a field already holds (the Mac's <c>appendingTranscript</c>), with no space between Chinese text.</summary>
    public static string Append(string field, string text)
    {
        var kept = field.Trim();
        return kept.Length == 0 ? text : Tidy(kept + " " + text);
    }

    /// <summary>Mono 16 kHz PCM16 as a WAV file: the recording sent as a clip when the live route does not answer.</summary>
    public static byte[] Wav(ReadOnlySpan<byte> pcm, int sampleRate = 16000)
    {
        using var m = new MemoryStream(44 + pcm.Length);
        using var w = new BinaryWriter(m);
        w.Write("RIFF"u8);
        w.Write(36 + pcm.Length);
        w.Write("WAVE"u8);
        w.Write("fmt "u8);
        w.Write(16);
        w.Write((short)1);
        w.Write((short)1);
        w.Write(sampleRate);
        w.Write(sampleRate * 2);
        w.Write((short)2);
        w.Write((short)16);
        w.Write("data"u8);
        w.Write(pcm.Length);
        w.Write(pcm);
        w.Flush();
        return m.ToArray();
    }
}

/// <summary>One event of the live protocol (docs/speech.md#live-protocol).</summary>
public sealed record VoiceEvent(string Type, int? SegmentId, string? Text, string? Message)
{
    public static VoiceEvent? Parse(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var o = doc.RootElement;
            if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty("type", out var t) || t.ValueKind != JsonValueKind.String) return null;
            int? id = o.TryGetProperty("segment_id", out var s) && s.ValueKind == JsonValueKind.Number && s.TryGetInt32(out var n) ? n : null;
            string? Str(string name) => o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            return new VoiceEvent(t.GetString()!, id, Str("text"), Str("message"));
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>Which saved Space voice input goes to, and nothing else (docs/windows-desktop.md#voice-input).</summary>
public static class VoiceSpace
{
    /// <summary>
    /// The Space chosen under Transcribe with when it is still saved, else the selected Space,
    /// else the default. Never another: the saved Spaces may not all be the person's own, and
    /// speech goes nowhere unasked. A Space that cannot transcribe is said so, not replaced.
    /// </summary>
    public static Guid? Choose(IReadOnlyList<Guid> saved, Guid? pinned, Guid? selected, Guid? fallback)
    {
        if (pinned is { } p && saved.Contains(p)) return p;
        if (selected is { } s && saved.Contains(s)) return s;
        return fallback is { } f && saved.Contains(f) ? f : null;
    }
}

/// <summary>
/// Whether Windows lets desktop apps use the microphone: Settings › Privacy &amp; security ›
/// Microphone, kept as <c>Allow</c>/<c>Deny</c> under
/// <c>…\CapabilityAccessManager\ConsentStore\microphone</c> (the machine's switch, the user's
/// switch, and the user's "Let desktop apps access your microphone" under <c>NonPackaged</c>).
/// A value that is missing allows.
/// </summary>
public static class MicrophoneAccess
{
    public const string Key = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    public static bool Allowed(string? machine, string? user, string? desktopApps) =>
        !new[] { machine, user, desktopApps }.Any(v => string.Equals(v, "Deny", StringComparison.OrdinalIgnoreCase));
}
