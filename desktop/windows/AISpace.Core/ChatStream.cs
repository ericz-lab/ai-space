using System.Text.Json;
using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>One event of a run's stream: the <c>id:</c> line before it (the run's sequence number) and its <c>data:</c>.</summary>
public sealed record SseMessage(int? Id, string Data);

/// <summary>
/// Reads the lines of a server-sent event stream as src/space/agents/runtime.ts writes them (the
/// Mac's <c>SSEParser</c>): an optional <c>id: &lt;seq&gt;</c> line, then one <c>data:</c> line per
/// event; <c>:</c> lines are keep-alives.
/// </summary>
public sealed class SseParser
{
    private int? _id;

    public SseMessage? Feed(string line)
    {
        if (line.Length == 0)
        {
            _id = null;
            return null;
        }
        if (line.StartsWith(':')) return null;
        var colon = line.IndexOf(':');
        var field = colon < 0 ? line : line[..colon];
        var value = colon < 0 ? "" : line[(colon + 1)..];
        if (value.StartsWith(' ')) value = value[1..];
        switch (field)
        {
            case "id":
                _id = int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var n) ? n : null;
                return null;
            case "data":
                var message = new SseMessage(_id, value);
                _id = null;
                return message;
            default:
                return null;
        }
    }
}

/// <summary>
/// The web panel's three write-access choices (src/web/Chat.tsx). On a live turn
/// (docs/runtimes.md#live-chat) the read-only choice asks before an edit or a command instead of
/// refusing it.
/// </summary>
public enum ChatPermission
{
    ReadOnly,
    EditFiles,
    All,
}

public static class ChatPermissions
{
    public static readonly IReadOnlyList<ChatPermission> All = [ChatPermission.ReadOnly, ChatPermission.EditFiles, ChatPermission.All];

    /// <summary>The value the Space reads as <c>permissionMode</c>; the read-only tier sends none, as before live chat.</summary>
    public static string Wire(this ChatPermission p) => p switch
    {
        ChatPermission.EditFiles => "acceptEdits",
        ChatPermission.All => "bypassPermissions",
        _ => "",
    };

    public static ChatPermission? Parse(string? wire) => wire switch
    {
        "" or null => ChatPermission.ReadOnly,
        "acceptEdits" => ChatPermission.EditFiles,
        "bypassPermissions" => ChatPermission.All,
        _ => null,
    };

    /// <summary>A shell refusal needs all permissions; an edit first tries acceptEdits.</summary>
    public static ChatPermission Granting(this ChatPermission current, IReadOnlyCollection<string> denied) =>
        denied.Contains("Bash") || current != ChatPermission.ReadOnly ? ChatPermission.All : ChatPermission.EditFiles;
}

/// <summary>A picture attached to a message, as the Space takes it (src/space/agents/images.ts).</summary>
public sealed record ChatImage(string Name, string MediaType, byte[] Bytes)
{
    public const int MaxCount = 4;
    public const int MaxBytes = 5 * 1024 * 1024;
    public const int MaxTotal = 10 * 1024 * 1024;

    public Dictionary<string, string> Body => new() { ["name"] = Name.Length > 200 ? Name[..200] : Name, ["mediaType"] = MediaType, ["data"] = Convert.ToBase64String(Bytes) };

    /// <summary>Four at most, none empty or over 5 MB, 10 MB together.</summary>
    public static bool Validate(IReadOnlyList<ChatImage> images) =>
        images.Count <= MaxCount && images.All(i => i.Bytes.Length is > 0 and <= MaxBytes) && images.Sum(i => (long)i.Bytes.Length) <= MaxTotal;

    /// <summary>The media type of picture bytes by their signature: PNG, JPEG, GIF or WebP; null for anything the Space refuses.</summary>
    public static string? TypeOf(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 4 && b[0] == (byte)'G' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'8') return "image/gif";
        if (b.Length >= 12 && b[0] == (byte)'R' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'F' && b[8] == (byte)'W' && b[9] == (byte)'E' && b[10] == (byte)'B' && b[11] == (byte)'P') return "image/webp";
        return null;
    }
}

/// <summary>The controls captured when a turn is sent (the web's <c>queuedChatTurn</c>): changing them later does not change that turn.</summary>
public sealed record ChatTurnRequest(string Message, ChatPermission Permission, IReadOnlyList<ChatImage> Images, string? Model = null)
{
    /// <summary>
    /// Every turn is interactive: the conversation's live process can ask for an approval and take
    /// messages while it runs (docs/runtimes.md#live-chat). A runtime without live chat ignores the flag.
    /// </summary>
    public Dictionary<string, object> Body(string? sessionId)
    {
        var body = new Dictionary<string, object> { ["message"] = Message, ["interactive"] = true };
        if (Images.Count > 0) body["images"] = Images.Select(i => i.Body).ToList();
        if (Permission != ChatPermission.ReadOnly) body["permissionMode"] = Permission.Wire();
        if (!string.IsNullOrEmpty(Model)) body["model"] = Model;
        if (sessionId is not null) body["sessionId"] = sessionId;
        return body;
    }
}

/// <summary>
/// How long a client keeps following a turn whose event stream keeps dropping (the Mac's
/// <c>ChatReconnect</c>). Only consecutive failures count: an event that arrives resets the count.
/// The wait grows to 10 s, so a turn is given up after about three minutes without any event.
/// </summary>
public static class ChatReconnect
{
    public const int MaxFailures = 20;

    public static TimeSpan Delay(int failures) => TimeSpan.FromSeconds(Math.Min(10, Math.Max(1, failures) * 2));
}

public enum ChatActivityKind
{
    Starting,
    Reconnecting,
    /// <summary><see cref="ChatActivity.Detail"/> is the model when the runtime named it.</summary>
    Thinking,
    /// <summary><see cref="ChatActivity.Detail"/> is the tool.</summary>
    Running,
}

/// <summary>What a chat turn's status row says while it runs.</summary>
public sealed record ChatActivity(ChatActivityKind Kind, string Detail = "")
{
    public static readonly ChatActivity Starting = new(ChatActivityKind.Starting);
    public static readonly ChatActivity Reconnecting = new(ChatActivityKind.Reconnecting);
    public static ChatActivity Thinking(string model = "") => new(ChatActivityKind.Thinking, model);
    public static ChatActivity Running(string tool) => new(ChatActivityKind.Running, tool);
}

/// <summary>An option of an agent's question.</summary>
public sealed record ChatQuestionOption(string Label, string Description = "");

/// <summary>
/// A question the agent asks while its turn runs: an <c>approval_request</c> with <c>questions</c>
/// (src/space/runtimes/types.ts <c>AgentQuestion</c>). The person picks options or types an answer.
/// </summary>
public sealed record ChatQuestion(string Id, string Header, string Question, IReadOnlyList<ChatQuestionOption> Options, bool MultiSelect)
{
    public static IReadOnlyList<ChatQuestion> List(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Array) return [];
        var list = new List<ChatQuestion>();
        foreach (var q in raw.EnumerateArray())
        {
            if (q.ValueKind != JsonValueKind.Object || ChatJson.Str(q, "id") is not { } id) continue;
            var options = new List<ChatQuestionOption>();
            if (q.TryGetProperty("options", out var o) && o.ValueKind == JsonValueKind.Array)
            {
                foreach (var option in o.EnumerateArray())
                {
                    if (option.ValueKind == JsonValueKind.Object && ChatJson.Str(option, "label") is { } label) options.Add(new ChatQuestionOption(label, ChatJson.Str(option, "description") ?? ""));
                }
            }
            list.Add(new ChatQuestion(id, ChatJson.Str(q, "header") ?? "", ChatJson.Str(q, "question") ?? "", options, q.TryGetProperty("multiSelect", out var m) && m.ValueKind == JsonValueKind.True));
        }
        return list;
    }

    /// <summary>
    /// What goes back for this question (QuestionStep <c>answerOf</c> in src/web/Chat.tsx): a single
    /// choice is the typed answer when there is one, else the picked option; a multiple choice is
    /// every picked option and the typed answer after them.
    /// </summary>
    public IReadOnlyList<string> Answer(IReadOnlyList<string> picked, string typed)
    {
        var own = typed.Trim();
        if (!MultiSelect) return own.Length == 0 ? picked.Take(1).ToList() : [own];
        return own.Length == 0 ? picked.ToList() : [.. picked, own];
    }
}

public enum ChatStepKind
{
    Text,
    Tool,
    /// <summary>An action the agent waits for: <see cref="ChatStep.Title"/> the tool, <see cref="ChatStep.Text"/> what it wants to do, <see cref="ChatStep.Output"/> why.</summary>
    Approval,
    /// <summary>A message the person added while the turn ran.</summary>
    Steer,
}

public enum ChatStepState
{
    Running,
    Succeeded,
    Failed,
    Incomplete,
    Waiting,
    Allowed,
    Denied,
    Cancelled,
}

/// <summary>
/// Ordered, observable work in one turn (the Mac's <c>ChatStep</c>). Tool ids stay the same from
/// start to result. An approval with <see cref="Questions"/> is a question the agent asks;
/// <see cref="Answers"/> is what the person chose.
/// </summary>
public sealed record ChatStep(string Id, ChatStepKind Kind)
{
    public string Title { get; init; } = "";
    public string Text { get; init; } = "";
    public string Output { get; init; } = "";
    public ChatStepState State { get; init; } = ChatStepState.Running;
    public IReadOnlyList<ChatQuestion> Questions { get; init; } = [];
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Answers { get; init; } = new Dictionary<string, IReadOnlyList<string>>();

    /// <summary>The request id an answer names: the step's id without <c>approval:</c>.</summary>
    public string RequestId => Id.StartsWith("approval:", StringComparison.Ordinal) ? Id["approval:".Length..] : Id;
}

/// <summary>How a tool row is drawn, after the web panel's <c>toolVariant</c> (src/web/chat-steps.ts): one kind per family of tools across runtimes.</summary>
public enum ChatToolKind
{
    Bash,
    Read,
    Write,
    Edit,
    Search,
    Web,
    Code,
    Task,
    Plan,
    Other,
}

public static class ChatTools
{
    private static readonly (ChatToolKind Kind, string[] Names)[] Families =
    [
        (ChatToolKind.Bash, ["bash", "pwsh", "shell", "exec", "exec_command", "command", "command_execution", "local_shell", "run_command", "terminal"]),
        (ChatToolKind.Read, ["read", "read_file", "read_image", "view", "notebookread", "cat"]),
        (ChatToolKind.Write, ["write", "write_file", "create_file"]),
        (ChatToolKind.Edit, ["edit", "multiedit", "notebookedit", "apply_patch", "patch", "file_change", "str_replace"]),
        (ChatToolKind.Search, ["grep", "glob", "ls", "list", "search", "find", "toolsearch", "codebase_search"]),
        (ChatToolKind.Web, ["webfetch", "websearch", "web_fetch", "web_search", "fetch", "browse"]),
        (ChatToolKind.Code, ["run_code", "code"]),
        (ChatToolKind.Task, ["task", "agent", "subagent", "spawn_agent", "send_message", "wait_agent"]),
        (ChatToolKind.Plan, ["todowrite", "todo_write", "update_plan"]),
    ];

    public static ChatToolKind KindOf(string name)
    {
        var bare = name;
        // An MCP tool `mcp__server__tool` is known by its own name.
        if (bare.StartsWith("mcp__", StringComparison.Ordinal))
        {
            var last = bare.LastIndexOf("__", StringComparison.Ordinal);
            if (last > 3) bare = bare[(last + 2)..];
        }
        var key = bare.ToLowerInvariant();
        foreach (var (kind, names) in Families)
        {
            if (names.Contains(key)) return kind;
        }
        return ChatToolKind.Other;
    }

    /// <summary>An unknown tool's own name as a row's title: <c>mcp__a__b</c> as <c>a · b</c>.</summary>
    public static string OtherTitle(string name) => (name.StartsWith("mcp__", StringComparison.Ordinal) ? name[5..] : name).Replace("__", " · ", StringComparison.Ordinal);

    /// <summary>The first non-empty line, so a long command or a patch still reads as one row.</summary>
    public static string Summary(string text) => text.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0) ?? "";

    /// <summary>Whether a run of calls is all commands, so a folded transcript's head can say what ran (<c>allCommands</c>).</summary>
    public static bool AllCommands(IReadOnlyList<ChatStep> steps) => steps.Count > 0 && steps.All(s => s.Kind == ChatStepKind.Tool && KindOf(s.Title) == ChatToolKind.Bash);

    /// <summary>
    /// Runs of consecutive tool calls become one group, so they stack as a tight list between
    /// paragraphs (<c>stepGroups</c>); every other step is a group of its own.
    /// </summary>
    public static IReadOnlyList<IReadOnlyList<ChatStep>> Groups(IReadOnlyList<ChatStep> steps)
    {
        var groups = new List<List<ChatStep>>();
        foreach (var step in steps)
        {
            if (step.Kind == ChatStepKind.Tool && groups.Count > 0 && groups[^1] is [{ Kind: ChatStepKind.Tool }, ..] run) run.Add(step);
            else groups.Add([step]);
        }
        return groups;
    }
}

/// <summary>
/// One message of a stored conversation (<c>GET …/sessions/:sid</c>, <c>TranscriptMessage</c> in
/// src/space/runtimes/types.ts): the person's text, or the agent's with the tools it called and,
/// where the runtime's records have them, its text and tool calls in order, and its chat cards.
/// </summary>
public sealed record ChatHistoryMessage(bool IsUser, string Text, IReadOnlyList<string> Tools, IReadOnlyList<ChatStep> Steps, IReadOnlyList<ChatCardReceived> Cards)
{
    public static IReadOnlyList<ChatHistoryMessage> Decode(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("messages", out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var messages = new List<ChatHistoryMessage>();
        foreach (var m in list.EnumerateArray())
        {
            if (m.ValueKind != JsonValueKind.Object || ChatJson.Str(m, "role") is not { } role) continue;
            var user = role == "user";
            var tools = new List<string>();
            if (m.TryGetProperty("tools", out var t) && t.ValueKind == JsonValueKind.Array)
            {
                foreach (var tool in t.EnumerateArray())
                {
                    if (tool.ValueKind == JsonValueKind.Object && ChatJson.Str(tool, "name") is { } name) tools.Add(name);
                }
            }
            var steps = new List<ChatStep>();
            if (!user && m.TryGetProperty("steps", out var s) && s.ValueKind == JsonValueKind.Array)
            {
                var i = 0;
                foreach (var step in s.EnumerateArray())
                {
                    var id = $"history:{i++}";
                    if (step.ValueKind != JsonValueKind.Object) continue;
                    // The steps drawn like a finished live turn (src/web/chat-steps.ts `historySteps`).
                    switch (ChatJson.Str(step, "kind"))
                    {
                        case "text":
                            steps.Add(new ChatStep(id, ChatStepKind.Text) { Text = ChatJson.Str(step, "text") ?? "", State = ChatStepState.Succeeded });
                            break;
                        case "tool":
                            var failed = step.TryGetProperty("failed", out var f) && f.ValueKind == JsonValueKind.True;
                            steps.Add(new ChatStep(id, ChatStepKind.Tool) { Title = ChatJson.Str(step, "name") ?? "tool", Text = ChatJson.Str(step, "input") ?? "", Output = ChatJson.Str(step, "output") ?? "", State = failed ? ChatStepState.Failed : ChatStepState.Succeeded });
                            break;
                    }
                }
            }
            var cards = user || !m.TryGetProperty("cards", out var c) ? [] : ChatCards.Decode(c);
            messages.Add(new ChatHistoryMessage(user, ChatJson.Str(m, "text") ?? "", tools, steps, cards));
        }
        return messages;
    }
}

/// <summary>
/// One chat turn's reply, built from the run's events the way the panel's Chat.tsx and the Mac's
/// <c>ChatReply</c> read them: Claude-style stream-json, which every runtime adapter emits, then
/// <c>error</c> and <c>done</c>.
///
/// The status row (<see cref="Activity"/>) stays up for the whole turn: it clears only while text
/// streams; a finished paragraph, a tool result with nothing else running and an answered approval
/// with none still waiting go back to thinking (or the tool still running); a tool call shows as
/// running as soon as its block starts; an approval request clears it, since the view shows the
/// waiting line instead; done, stop and a failure clear it.
/// </summary>
public sealed class ChatReply
{
    private static readonly Regex PermissionWords = new("requires approval|permission|granted|denied", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private readonly List<ChatStep> _steps = [];
    private readonly Dictionary<string, string> _toolNames = [];
    /// <summary>The type of each content block of the model message being streamed, by index.</summary>
    private readonly Dictionary<int, string> _blockTypes = [];
    private readonly List<ChatCardReceived> _cards = [];
    private string? _streamingStep;
    /// <summary>A tool call whose input the model is still writing: started, not yet in an <c>assistant</c> event.</summary>
    private string? _generatingTool;
    private int _serial;

    public string? SessionId { get; private set; }
    public string FinishedText { get; private set; } = "";
    public string Streaming { get; private set; } = "";
    public List<string> Tools { get; } = [];
    public IReadOnlyList<ChatStep> Steps => _steps;
    public ChatActivity? Activity { get; set; } = ChatActivity.Starting;
    /// <summary>An error result with no text, shown in place of the reply.</summary>
    public string? Note { get; private set; }
    /// <summary>The run's own error as the Space reported it, apart from the reply text, so it shows as a failed turn.</summary>
    public string? Failure { get; private set; }
    public bool Stopped { get; private set; }
    public bool Finished { get; private set; }
    /// <summary>Tools refused for lack of permission: Grant and Retry raises the permission for them.</summary>
    public List<string> Denied { get; } = [];
    /// <summary>One per <c>steer</c> event: the messages added during the turn that the agent has read.</summary>
    public List<string> ConsumedSteers { get; } = [];
    /// <summary>What the agent's tools did this turn, from the <c>cards</c> events in order (docs/chat-cards.md).</summary>
    public IReadOnlyList<ChatCardReceived> Cards => _cards;

    /// <summary>What the agent wrote, without any note.</summary>
    public string Body => FinishedText + (Streaming.Length == 0 ? "" : (FinishedText.Length == 0 ? "" : "\n\n") + Streaming);

    public string Text => Note is null ? Body : Body.Length == 0 ? Note : Body + "\n\n" + Note;

    /// <summary>What the turn is doing when nothing more specific is known: the tool still running, else thinking.</summary>
    private ChatActivity Resumed()
    {
        if (_generatingTool is { } tool) return ChatActivity.Running(tool);
        return _steps.LastOrDefault(s => s.Kind == ChatStepKind.Tool && s.State == ChatStepState.Running) is { } running ? ChatActivity.Running(running.Title) : ChatActivity.Thinking();
    }

    private void RecordText(string text, bool final)
    {
        var index = _streamingStep is null ? -1 : _steps.FindIndex(s => s.Id == _streamingStep);
        if (index >= 0)
        {
            var step = _steps[index];
            _steps[index] = step with { Text = final ? text : step.Text + text, State = final ? ChatStepState.Succeeded : step.State };
        }
        else
        {
            var id = $"text:{++_serial}";
            _steps.Add(new ChatStep(id, ChatStepKind.Text) { Text = text, State = final ? ChatStepState.Succeeded : ChatStepState.Running });
            if (!final) _streamingStep = id;
        }
        if (final) _streamingStep = null;
    }

    /// <summary>The turn ended: running text is done, a running call has no result, an unanswered approval is not left waiting.</summary>
    public void EndSteps()
    {
        for (var i = 0; i < _steps.Count; i++)
        {
            var s = _steps[i];
            if (s.State == ChatStepState.Running) _steps[i] = s with { State = s.Kind == ChatStepKind.Text ? ChatStepState.Succeeded : ChatStepState.Incomplete };
            else if (s.State == ChatStepState.Waiting) _steps[i] = s with { State = ChatStepState.Cancelled };
        }
    }

    public void Apply(string line)
    {
        JsonElement ev;
        try
        {
            using var doc = JsonDocument.Parse(line);
            ev = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return;
        }
        if (ev.ValueKind != JsonValueKind.Object || ChatJson.Str(ev, "type") is not { } type) return;
        switch (type)
        {
            case "approval_request":
            {
                if (ChatJson.Str(ev, "id") is not { } id) return;
                var stepId = "approval:" + id;
                if (!_steps.Any(s => s.Id == stepId))
                {
                    _steps.Add(new ChatStep(stepId, ChatStepKind.Approval)
                    {
                        Title = ChatJson.Str(ev, "tool") ?? "tool",
                        Text = ChatJson.Str(ev, "title") ?? "",
                        Output = ChatJson.Str(ev, "detail") ?? "",
                        State = ChatStepState.Waiting,
                        Questions = ev.TryGetProperty("questions", out var q) ? ChatQuestion.List(q) : [],
                    });
                }
                // The turn is not running anything now; it waits for the person's answer.
                Activity = null;
                break;
            }
            case "approval_resolved":
            {
                if (ChatJson.Str(ev, "id") is not { } id) return;
                var i = _steps.FindIndex(s => s.Id == "approval:" + id);
                if (i < 0) return;
                var state = ChatJson.Str(ev, "decision") switch
                {
                    "allow" => ChatStepState.Allowed,
                    "deny" => ChatStepState.Denied,
                    _ => ChatStepState.Cancelled,
                };
                var answers = _steps[i].Answers;
                if (ev.TryGetProperty("answers", out var a) && a.ValueKind == JsonValueKind.Object) answers = ChatJson.Answers(a);
                _steps[i] = _steps[i] with { State = state, Answers = answers };
                // Answered: the turn goes on, unless it still waits for another answer.
                if (!Finished && !_steps.Any(s => s.Kind == ChatStepKind.Approval && s.State == ChatStepState.Waiting)) Activity = Resumed();
                break;
            }
            case "steer":
            {
                var text = ChatJson.Str(ev, "text") ?? "";
                ConsumedSteers.Add(text);
                _steps.Add(new ChatStep($"steer:{++_serial}", ChatStepKind.Steer) { Text = text, State = ChatStepState.Succeeded });
                break;
            }
            case "cards":
                _cards.AddRange(ChatCards.Event(ev));
                break;
            case "system" when ChatJson.Str(ev, "subtype") == "init":
                SessionId = ChatJson.Str(ev, "session_id") ?? SessionId;
                Activity = ChatActivity.Thinking(ChatJson.Str(ev, "model") ?? "");
                break;
            case "stream_event":
                StreamEvent(ev.TryGetProperty("event", out var e) && e.ValueKind == JsonValueKind.Object ? e : default);
                break;
            case "assistant":
                Assistant(ChatJson.Blocks(ev));
                break;
            case "user":
                foreach (var block in ChatJson.Blocks(ev))
                {
                    if (ChatJson.Str(block, "type") != "tool_result") continue;
                    var text = Detail(block.TryGetProperty("content", out var content) ? content : default);
                    var toolId = ChatJson.Str(block, "tool_use_id") ?? "";
                    var failed = block.TryGetProperty("is_error", out var err) && err.ValueKind == JsonValueKind.True;
                    var i = _steps.FindIndex(s => s.Id == "tool:" + toolId);
                    if (i >= 0) _steps[i] = _steps[i] with { Output = text, State = failed ? ChatStepState.Failed : ChatStepState.Succeeded };
                    Activity = Resumed();
                    if (!failed || !PermissionWords.IsMatch(text)) continue;
                    var tool = _toolNames.GetValueOrDefault(toolId) ?? "tool";
                    if (!Denied.Contains(tool)) Denied.Add(tool);
                }
                break;
            case "result":
                SessionId = ChatJson.Str(ev, "session_id") ?? SessionId;
                if (ev.TryGetProperty("is_error", out var isError) && isError.ValueKind == JsonValueKind.True && FinishedText.Length == 0 && Streaming.Length == 0)
                {
                    Note = ChatJson.Text(ev, "result") ?? ChatJson.Text(ev, "subtype") ?? "error";
                }
                break;
            case "error":
                if (ChatJson.Str(ev, "status") == "stopped")
                {
                    Stopped = true;
                }
                else
                {
                    Failure = ChatJson.Text(ev, "error") ?? "error";
                    Note = "⚠️ " + Failure;
                }
                break;
            case "done":
                EndSteps();
                Finished = true;
                Activity = null;
                break;
        }
    }

    private void StreamEvent(JsonElement e)
    {
        if (e.ValueKind != JsonValueKind.Object) return;
        if (e.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object && ChatJson.Str(delta, "type") == "text_delta" && ChatJson.Str(delta, "text") is { } t)
        {
            RecordText(t, final: false);
            Streaming += t;
            // The text appearing is the sign the turn runs.
            Activity = null;
        }
        // Claude's partial messages mark where each block starts and ends; a tool call shows as
        // running while its input is still being written.
        int? index = e.TryGetProperty("index", out var ix) && ix.ValueKind == JsonValueKind.Number && ix.TryGetInt32(out var n) ? n : null;
        switch (ChatJson.Str(e, "type"))
        {
            case "message_start":
                _blockTypes.Clear();
                _generatingTool = null;
                break;
            case "content_block_start":
                var block = e.TryGetProperty("content_block", out var b) && b.ValueKind == JsonValueKind.Object ? b : default;
                var kind = block.ValueKind == JsonValueKind.Object ? ChatJson.Str(block, "type") ?? "" : "";
                if (index is { } at) _blockTypes[at] = kind;
                if (kind == "tool_use")
                {
                    _generatingTool = ChatJson.Str(block, "name") ?? "tool";
                    Activity = Resumed();
                }
                break;
            case "content_block_stop":
                if (index is { } stopped && _blockTypes.GetValueOrDefault(stopped) == "text") Activity = Resumed();
                break;
        }
    }

    private void Assistant(IReadOnlyList<JsonElement> blocks)
    {
        var text = string.Concat(blocks.Where(b => ChatJson.Str(b, "type") == "text").Select(b => ChatJson.Str(b, "text") ?? ""));
        if (text.Length > 0)
        {
            FinishedText += (FinishedText.Length == 0 ? "" : "\n\n") + text;
            Streaming = "";
            // The paragraph is complete; the turn goes on until `done`. A tool call in the same
            // message replaces this below.
            Activity = Resumed();
        }
        foreach (var b in blocks)
        {
            var type = ChatJson.Str(b, "type");
            if (type == "text" && ChatJson.Str(b, "text") is { Length: > 0 } t)
            {
                RecordText(t, final: true);
                continue;
            }
            if (type != "tool_use" || ChatJson.Str(b, "id") is not { } id) continue;
            _generatingTool = null;
            var input = b.TryGetProperty("input", out var i) && i.ValueKind == JsonValueKind.Object ? i : default;
            var hint = Detail(Pick(input, "command", "file_path", "path", "query") ?? input);
            var at = _steps.FindIndex(s => s.Id == "tool:" + id);
            if (at >= 0)
            {
                if (hint.Length > 0) _steps[at] = _steps[at] with { Text = hint };
                continue;
            }
            var name = ChatJson.Str(b, "name") ?? "tool";
            _toolNames[id] = name;
            Tools.Add(name);
            _steps.Add(new ChatStep("tool:" + id, ChatStepKind.Tool) { Title = name, Text = hint });
            Activity = ChatActivity.Running(name);
        }
    }

    private static JsonElement? Pick(JsonElement o, params string[] keys)
    {
        if (o.ValueKind != JsonValueKind.Object) return null;
        foreach (var k in keys)
        {
            if (o.TryGetProperty(k, out var v) && v.ValueKind != JsonValueKind.Null) return v;
        }
        return null;
    }

    private const int Limit = 12_000;

    /// <summary>A tool's input or output as text, at most 12,000 characters: a string as it is, text blocks joined, anything else as JSON.</summary>
    public static string Detail(JsonElement value)
    {
        string Cut(string s) => s.Length > Limit ? s[..Limit] : s;
        switch (value.ValueKind)
        {
            case JsonValueKind.Undefined:
            case JsonValueKind.Null:
                return "";
            case JsonValueKind.String:
                return Cut(value.GetString() ?? "");
            case JsonValueKind.Object when !value.EnumerateObject().Any():
                return "";
            case JsonValueKind.Array:
                var texts = value.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.Object && ChatJson.Str(v, "type") == "text").Select(v => ChatJson.Str(v, "text")).OfType<string>().ToList();
                if (texts.Count > 0) return Cut(string.Join("\n", texts));
                break;
        }
        return Cut(JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true }));
    }
}

public enum ChatFailureKind
{
    /// <summary>The model service turned the request down for now: rate or usage limit, overload.</summary>
    Busy,
    /// <summary>The runtime on the Space is not signed in to its model service.</summary>
    SignedOut,
    TimedOut,
    /// <summary>The runtime stopped with an exit code and said nothing more.</summary>
    Exited,
    /// <summary>The runtime could not be started at all.</summary>
    Unavailable,
    /// <summary>The stream from the Space broke before the run said how it ended.</summary>
    Connection,
    Other,
}

/// <summary>
/// A failed chat turn told in words a person can act on (the Mac's <c>ChatFailure</c>). The Space
/// hands on what the runtime said, which may be a status line from the model service or only its
/// exit code; the raw text stays as the detail.
/// </summary>
public sealed record ChatFailure(ChatFailureKind Kind, string Detail, int Code = 0)
{
    public static ChatFailure Classify(string raw)
    {
        var detail = raw.Trim();
        var text = detail.ToLowerInvariant();
        bool Has(params string[] words) => words.Any(w => text.Contains(w, StringComparison.Ordinal));
        if (Has("429", "too many requests", "rate limit", "rate_limit", "usage limit", "quota", "overloaded", "529", "capacity")) return new(ChatFailureKind.Busy, detail);
        if (Has("not logged in", "log in", "login", "please run /login", "unauthorized", "401", "invalid api key", "authentication")) return new(ChatFailureKind.SignedOut, detail);
        if (Has("timed out", "timeout")) return new(ChatFailureKind.TimedOut, detail);
        var exit = Regex.Match(text, @"exited with (-?\d+)", RegexOptions.CultureInvariant);
        if (exit.Success && int.TryParse(exit.Groups[1].Value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var code)) return new(ChatFailureKind.Exited, detail, code);
        if (Has("could not run", "not found", "enoent", "no such file")) return new(ChatFailureKind.Unavailable, detail);
        return new(ChatFailureKind.Other, detail);
    }

    /// <summary>Whether sending the same message again may well work: the cause passes by itself.</summary>
    public bool Retryable => Kind is not (ChatFailureKind.SignedOut or ChatFailureKind.Unavailable);
}

/// <summary>The few JSON readings the chat's decoders share.</summary>
internal static class ChatJson
{
    public static string? Str(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>A value as text: a string as it is, anything else (a number, an object) as its JSON; null when absent.</summary>
    public static string? Text(JsonElement o, string key)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(key, out var v) || v.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        return v.ValueKind == JsonValueKind.String ? v.GetString() : v.GetRawText();
    }

    public static IReadOnlyList<JsonElement> Blocks(JsonElement ev)
    {
        if (!ev.TryGetProperty("message", out var m) || m.ValueKind != JsonValueKind.Object || !m.TryGetProperty("content", out var c) || c.ValueKind != JsonValueKind.Array) return [];
        return c.EnumerateArray().Where(b => b.ValueKind == JsonValueKind.Object).ToList();
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Answers(JsonElement o)
    {
        var d = new Dictionary<string, IReadOnlyList<string>>();
        foreach (var p in o.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Array) d[p.Name] = p.Value.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()!).ToList();
        }
        return d;
    }
}
