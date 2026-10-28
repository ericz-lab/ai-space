using System.Text;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// Server-sent events as src/space/agents/runtime.ts writes them: an optional <c>id: &lt;seq&gt;</c>
/// line, then one <c>data:</c> line per event; <c>:</c> lines are keep-alives (the Mac's SSEParser).
/// </summary>
public sealed class SseParser
{
    long? id;

    public (long? Id, string Data)? Feed(string rawLine)
    {
        var line = rawLine.EndsWith('\r') ? rawLine[..^1] : rawLine;
        if (line.Length == 0) { id = null; return null; }
        if (line.StartsWith(':')) return null;
        var colon = line.IndexOf(':');
        var field = colon < 0 ? line : line[..colon];
        var value = colon < 0 ? "" : line[(colon + 1)..];
        if (value.StartsWith(' ')) value = value[1..];
        if (field == "id") { id = long.TryParse(value, out var n) ? n : null; return null; }
        if (field != "data") return null;
        var message = (id, value);
        id = null;
        return message;
    }
}

/// <summary>A picture for the next message, as the Space takes it (src/space/agents/images.ts).</summary>
public sealed record ChatImage(string Name, string MediaType, byte[] Bytes)
{
    public const int MaxImages = 4;
    public const int MaxBytes = 5 * 1024 * 1024;
    public const int MaxTotalBytes = 10 * 1024 * 1024;

    /// <summary>The media type of image bytes by their signature, or null for anything the Space refuses (the caller converts it to PNG).</summary>
    public static string? TypeOf(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4e && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff) return "image/jpeg";
        if (b.Length >= 4 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x38) return "image/gif";
        if (b.Length >= 12 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return "image/webp";
        return null;
    }

    /// <summary>Whether one more picture fits: four at most, 5 MB each and 10 MB together.</summary>
    public static bool Fits(IReadOnlyCollection<ChatImage> current, ChatImage next) =>
        current.Count < MaxImages && next.Bytes.Length <= MaxBytes && current.Sum(i => i.Bytes.Length) + next.Bytes.Length <= MaxTotalBytes;
}

/// <summary>An approval or a question the running turn waits on.</summary>
public sealed record Approval(string Id, string Tool, string Title, string Detail);

/// <summary>
/// One chat turn's reply, built from the run's events the way the other clients read them
/// (desktop/linux/src/core/chat.ts, the Mac's ChatReply): Claude-style stream-json, which every
/// runtime adapter emits, followed by <c>error</c> and <c>done</c>.
/// </summary>
public sealed class TurnReply
{
    readonly StringBuilder finished = new();
    string streaming = "";
    readonly List<Approval> waiting = [];

    public string? SessionId { get; private set; }
    public List<string> Tools { get; } = [];
    public string? Failure { get; private set; }
    public string? Note { get; private set; }
    public bool Stopped { get; private set; }
    public bool Done { get; private set; }
    public IReadOnlyList<Approval> Waiting => waiting;

    public string Text
    {
        get
        {
            var body = finished.ToString() + (streaming.Length > 0 ? (finished.Length > 0 ? "\n\n" : "") + streaming : "");
            if (Note is null) return body;
            return body.Length > 0 ? body + "\n\n" + Note : Note;
        }
    }

    public void Apply(string line)
    {
        JsonElement ev;
        try { ev = JsonDocument.Parse(line).RootElement; }
        catch (JsonException) { return; }
        if (ev.ValueKind != JsonValueKind.Object || !ev.TryGetProperty("type", out var typeEl) || typeEl.ValueKind != JsonValueKind.String) return;
        string Str(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";
        switch (typeEl.GetString())
        {
            case "system":
                if (Str(ev, "subtype") == "init" && Str(ev, "session_id") is { Length: > 0 } sid) SessionId = sid;
                break;
            case "stream_event":
                if (ev.TryGetProperty("event", out var se) && se.ValueKind == JsonValueKind.Object && se.TryGetProperty("delta", out var delta)
                    && delta.ValueKind == JsonValueKind.Object && Str(delta, "type") == "text_delta")
                    streaming += Str(delta, "text");
                break;
            case "assistant":
                if (!ev.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object || !msg.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) break;
                var text = string.Concat(content.EnumerateArray().Where(b => b.ValueKind == JsonValueKind.Object && Str(b, "type") == "text").Select(b => Str(b, "text")));
                if (text.Length > 0)
                {
                    if (finished.Length > 0) finished.Append("\n\n");
                    finished.Append(text);
                    streaming = "";
                }
                foreach (var b in content.EnumerateArray())
                    if (b.ValueKind == JsonValueKind.Object && Str(b, "type") == "tool_use") Tools.Add(Str(b, "name") is { Length: > 0 } n ? n : "tool");
                break;
            case "approval_request":
                if (Str(ev, "id") is { Length: > 0 } rid && waiting.All(a => a.Id != rid))
                    waiting.Add(new Approval(rid, Str(ev, "tool") is { Length: > 0 } tool ? tool : "tool", Str(ev, "title"), Str(ev, "detail")));
                break;
            case "approval_resolved":
                waiting.RemoveAll(a => a.Id == Str(ev, "id"));
                break;
            case "result":
                if (Str(ev, "session_id") is { Length: > 0 } rsid) SessionId = rsid;
                if (ev.TryGetProperty("is_error", out var isError) && isError.ValueKind == JsonValueKind.True && finished.Length == 0 && streaming.Length == 0)
                    Note = Str(ev, "result") is { Length: > 0 } r ? r : "error";
                break;
            case "error":
                if (Str(ev, "status") == "stopped") Stopped = true;
                else
                {
                    Failure = Str(ev, "error") is { Length: > 0 } e ? e : "error";
                    Note = "⚠️ " + Failure;
                }
                break;
            case "done":
                Done = true;
                waiting.Clear();
                break;
        }
    }

    /// <summary>The body of <c>POST …/chat</c>: every turn is interactive, so the agent can ask before an edit or a command.</summary>
    public static Dictionary<string, object> Body(string message, IReadOnlyList<ChatImage> images, string permission, string? sessionId)
    {
        var body = new Dictionary<string, object> { ["message"] = message, ["interactive"] = true };
        if (images.Count > 0)
            body["images"] = images.Select(i => new Dictionary<string, string> { ["name"] = i.Name, ["mediaType"] = i.MediaType, ["data"] = Convert.ToBase64String(i.Bytes) }).ToList();
        if (permission.Length > 0) body["permissionMode"] = permission;
        if (sessionId is not null) body["sessionId"] = sessionId;
        return body;
    }
}
