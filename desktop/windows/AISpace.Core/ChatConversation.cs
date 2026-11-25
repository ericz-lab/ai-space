using System.Text.Json;

namespace AISpace.Core;

public enum ChatRole
{
    User,
    Agent,
}

/// <summary>
/// One message of a conversation as the view draws it (the Mac's <c>ChatMessage</c>). It changes in
/// place while its turn runs; <see cref="Version"/> counts the changes, so a view redraws only the
/// messages that changed.
/// </summary>
public sealed class ChatMessage(ChatRole role, string text)
{
    public Guid Id { get; } = Guid.NewGuid();
    public ChatRole Role { get; } = role;
    public string Text { get; set; } = text;
    public IReadOnlyList<ChatImage> Images { get; init; } = [];
    public IReadOnlyList<string> Tools { get; set; } = [];
    public IReadOnlyList<ChatStep> Steps { get; set; } = [];
    public IReadOnlyList<string> Denied { get; set; } = [];
    public ChatActivity? Activity { get; set; }
    /// <summary>The turn is still running.</summary>
    public bool Live { get; set; }
    /// <summary>Messages added to the running turn that the agent has not read yet.</summary>
    public IReadOnlyList<string> Pending { get; set; } = [];
    /// <summary>Why the turn failed, shown under what the agent wrote, with Try Again.</summary>
    public ChatFailure? Failure { get; set; }
    /// <summary>An error result with no reply text, drawn under the steps (it is part of <see cref="Text"/> too).</summary>
    public string? Note { get; set; }
    /// <summary>Stop ended the turn.</summary>
    public bool Stopped { get; set; }
    /// <summary>Restored from a stored session: its runs of tool calls fold to one line.</summary>
    public bool Historic { get; init; }
    /// <summary>What the turn's tools did, as chat cards (docs/chat-cards.md); live ones carry their token.</summary>
    public List<ChatShownCard> Cards { get; } = [];
    public int Version { get; set; }
}

/// <summary>A stored conversation of an agent (<c>GET …/sessions</c>): its id, title, last time (ms since 1970), runtime and model.</summary>
public sealed record ChatSession(string Sid, string Title, double Ts, string? Runtime = null, string? Model = null)
{
    public static IReadOnlyList<ChatSession> Decode(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("sessions", out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var sessions = new List<ChatSession>();
        foreach (var s in list.EnumerateArray())
        {
            if (s.ValueKind != JsonValueKind.Object || ChatJson.Str(s, "sid") is not { } sid) continue;
            var ts = s.TryGetProperty("ts", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetDouble() : 0;
            sessions.Add(new ChatSession(sid, ChatJson.Str(s, "title") ?? "", ts, ChatJson.Str(s, "runtime"), ChatJson.Str(s, "model")));
        }
        return sessions;
    }
}

/// <summary>An open event stream: the run it follows (the <c>x-run-id</c> header) and its events.</summary>
public sealed class ChatEvents(string? runId, IAsyncEnumerable<SseMessage> messages)
{
    public string? RunId { get; } = runId;
    public IAsyncEnumerable<SseMessage> Messages { get; } = messages;
}

/// <summary>The calls a conversation makes (<see cref="SpaceApi"/> with the Space's sign-in, or a test's stand-in).</summary>
public interface IChatApi
{
    /// <summary>An event stream (<c>GET</c> or <c>POST</c> with a JSON body). Throws <see cref="SpaceApiException"/> before it opens.</summary>
    Task<ChatEvents> ChatEvents(HttpMethod method, string path, object? body, CancellationToken ct);

    /// <summary>A JSON write; throws <see cref="SpaceApiException"/> unless it went through.</summary>
    Task ChatPost(string path, object body, CancellationToken ct);

    Task<JsonElement> ChatGet(string path, CancellationToken ct);

    /// <summary>The bare answer of a write, whatever its status (a card action's 409); throws only when nothing answered.</summary>
    Task<(int Status, string Body)> ChatAnswer(string path, object body, CancellationToken ct);
}

/// <summary>The words a conversation writes into the thread itself, in the interface's language.</summary>
public sealed record ChatWords(string Stopped, string SignIn, string Lost, string GrantMessage, string NoTurn, Func<string, string> AnswerFailed, string CardReadOnly)
{
    public static readonly ChatWords English = new("(stopped)", "Sign in on the panel first, then try again.", "The connection to the agent was lost.",
        "I have granted more permissions. Please finish the step that was refused for lack of permission.", "The answer did not reach the agent: no turn is running",
        why => $"The answer did not reach the agent: {why}", "This card is read-only now: the conversation has moved on.");
}

/// <summary>
/// One native conversation with an agent, shared by the main window's Chat tab and Quick Chat: the
/// Mac's <c>ChatController</c> (and the Linux client's <c>core/conversation.ts</c>) without a UI
/// toolkit. Each turn is a background run on the Space: a dropped stream reattaches after the last
/// event it saw, and only Stop ends the run, so hiding a window or losing the network never resends
/// a prompt. A message written while a turn runs joins that turn (steer); one the turn cannot take
/// waits and goes next, with its reply right after it.
///
/// Its methods run on one thread at a time (the UI thread in the app); <see cref="Changed"/> runs
/// after every change.
/// </summary>
public sealed class ChatConversation
{
    private readonly IChatApi _api;
    private readonly Func<TimeSpan, CancellationToken, Task> _sleep;
    private readonly List<(Guid Message, ChatTurnRequest Turn)> _queue = [];
    private readonly List<string> _pending = [];
    private readonly CancellationTokenSource _life = new();
    private int _steersSeen;
    private bool _stopRequested;
    /// <summary>One thread's identity: a late answer for a steer of an old thread must not land in a new one.</summary>
    private int _thread;
    private CancellationTokenSource? _turn;

    /// <param name="agentId">The agent as its own machine names it: <c>&lt;app&gt;/&lt;name&gt;</c>.</param>
    /// <param name="agentBase">The route base of its chat: <c>/api/agents/&lt;app&gt;/&lt;name&gt;</c>, or under <c>/api/peers/&lt;peer&gt;</c>.</param>
    /// <param name="local">The agent runs on the Space itself, so the Space's run list holds its turns.</param>
    public ChatConversation(string agentId, string agentBase, bool local, IChatApi api, ChatWords? words = null, Func<TimeSpan, CancellationToken, Task>? sleep = null)
    {
        AgentId = agentId;
        Base = agentBase;
        Local = local;
        _api = api;
        Words = words ?? ChatWords.English;
        _sleep = sleep ?? ((d, ct) => Task.Delay(d, ct));
    }

    public string AgentId { get; }
    public string Base { get; }
    public bool Local { get; }
    public ChatWords Words { get; }

    /// <summary>The permission and the model the next turn is sent with; the app reads its pickers.</summary>
    public Func<ChatPermission> Permission { get; set; } = () => ChatPermission.ReadOnly;
    public Action<ChatPermission> SetPermission { get; set; } = _ => { };
    public Func<string?> Model { get; set; } = () => null;

    public List<ChatMessage> Messages { get; } = [];
    public bool Busy { get; private set; }
    /// <summary>An earlier chat that would not open; a failed turn shows in its own reply.</summary>
    public string? Error { get; private set; }
    public IReadOnlyList<ChatSession> Sessions { get; private set; } = [];
    /// <summary>The stored conversation on show; null for a new one until its first reply names it.</summary>
    public string? SessionId { get; private set; }
    /// <summary>The run of the turn in progress; null between turns and before the Space names a new one.</summary>
    public string? RunId { get; private set; }
    /// <summary>Every run this conversation started or followed, so the same run is never followed twice.</summary>
    public HashSet<string> RunIds { get; } = [];

    /// <summary>After every change: the view redraws from <see cref="Messages"/>, <see cref="Busy"/> and <see cref="Error"/>.</summary>
    public event Action? Changed;

    /// <summary>A turn ended (it may have installed or changed apps, even when it failed or was stopped).</summary>
    public event Action? TurnEnded;

    private void Notify() => Changed?.Invoke();

    private void SetRun(string? id)
    {
        RunId = id;
        if (id is not null) RunIds.Add(id);
    }

    /// <summary>The message of the last turn when that turn failed: what Try Again sends once more.</summary>
    public string? RetryableMessage =>
        !Busy && Messages.Count >= 2 && Messages[^1] is { Role: ChatRole.Agent, Failure: not null } && Messages[^2] is { Role: ChatRole.User } prompt ? prompt.Text : null;

    /// <summary>Whether a reply's cards may act: no message of the person after it.</summary>
    public bool CardsActionable(ChatMessage message) => ChatCards.Actionable(Messages.Select(m => m.Role == ChatRole.User).ToList(), Messages.IndexOf(message));

    /// <summary>
    /// Picks up a turn of this agent running on the Space, started on any client: one that
    /// continues this conversation's session, or any while the conversation is empty. Nothing while
    /// a turn of its own runs, or while it waits for the Space to name the run it started.
    /// </summary>
    public void AttachRunning(IEnumerable<ChatRun> runs)
    {
        if (Busy || !Local) return;
        var waiting = runs.Where(r => r.Status == "running" && r.Agent == AgentId && !RunIds.Contains(r.Id)).ToList();
        var run = waiting.FirstOrDefault(r => SessionId is not null && (r.SessionId == SessionId || r.Sid == SessionId))
            ?? (Messages.Count == 0 ? waiting.FirstOrDefault() : null);
        if (run is null) return;
        SessionId ??= run.SessionId;
        Messages.Add(new ChatMessage(ChatRole.User, run.Message));
        Start(null, run.Id, null);
    }

    /// <summary>
    /// Sends a message. While a turn runs it joins that turn (the agent reads it after its current
    /// step); a turn that cannot take it is queued and sent next, in order, so nothing is lost.
    /// </summary>
    public void Send(string text, IReadOnlyList<ChatImage>? images = null)
    {
        var message = text.Trim();
        images ??= [];
        if (message.Length == 0 && images.Count == 0) return;
        var turn = new ChatTurnRequest(message, Permission(), images, Model());
        if (Busy)
        {
            if (RunId is { } run && _queue.Count == 0 && !_stopRequested) Steer(turn, run);
            else Enqueue(turn);
            Notify();
            return;
        }
        Messages.Add(new ChatMessage(ChatRole.User, message) { Images = images });
        Start(turn, null, null);
    }

    /// <summary>The person's answer to an approval or a question of the running turn; null when it reached the Space, else what to show in the card.</summary>
    public async Task<string?> Answer(string requestId, bool allow, IReadOnlyDictionary<string, IReadOnlyList<string>>? answers = null)
    {
        if (RunId is not { } run) return Words.NoTurn;
        var body = new Dictionary<string, object> { ["decision"] = allow ? "allow" : "deny" };
        if (answers is not null) body["answers"] = answers;
        try
        {
            await _api.ChatPost($"{Base}/runs/{SpacePath.Escape(run)}/approvals/{SpacePath.Escape(requestId)}", body, _life.Token);
            return null;
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
            return Words.AnswerFailed(e.Message);
        }
    }

    /// <summary>Hands the message to the running turn; when that is refused it becomes the next turn, shown in the thread at once.</summary>
    private async void Steer(ChatTurnRequest turn, string run)
    {
        var label = turn.Message.Length == 0 ? $"🖼 ×{turn.Images.Count}" : turn.Message;
        var thread = _thread;
        MarkPending(label, add: true);
        var body = new Dictionary<string, object> { ["message"] = turn.Message };
        if (turn.Images.Count > 0) body["images"] = turn.Images.Select(i => i.Body).ToList();
        try
        {
            await _api.ChatPost($"{Base}/runs/{SpacePath.Escape(run)}/steer", body, _life.Token);
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
            // The person moved to another thread meanwhile: the message belonged to the one that is gone.
            if (_thread != thread || _life.IsCancellationRequested) return;
            MarkPending(label, add: false);
            Enqueue(turn);
            if (!Busy) Next();
            Notify();
        }
    }

    private void MarkPending(string label, bool add)
    {
        if (add) _pending.Add(label);
        else if (_pending.LastIndexOf(label) is >= 0 and var at) _pending.RemoveAt(at);
        if (Messages.LastOrDefault(m => m.Role == ChatRole.Agent && m.Live) is { } live)
        {
            live.Pending = [.. _pending];
            live.Version++;
        }
    }

    /// <summary>The reply took an added message in: by its text, or the oldest waiting one for an image-only message.</summary>
    private void TakePending(string text)
    {
        var wanted = text.Trim();
        var at = _pending.FindIndex(p => p.Trim() == wanted);
        if (at >= 0) _pending.RemoveAt(at);
        else if (_pending.Count > 0) _pending.RemoveAt(0);
    }

    private void Enqueue(ChatTurnRequest turn)
    {
        var m = new ChatMessage(ChatRole.User, turn.Message) { Images = turn.Images };
        Messages.Add(m);
        _queue.Add((m.Id, turn));
    }

    /// <summary>Sends the failed turn's message again in place of the failed reply; the draft is untouched.</summary>
    public void Retry()
    {
        if (RetryableMessage is not { } text) return;
        Messages.RemoveAt(Messages.Count - 1);
        Start(new ChatTurnRequest(text, Permission(), Messages[^1].Images, Model()), null, null);
    }

    /// <summary>Raises the permission for the refused tools and asks the agent to finish the step (the web's Grant and Retry).</summary>
    public void GrantAndRetry()
    {
        if (Busy || Messages.Count == 0 || Messages[^1] is not { Role: ChatRole.Agent, Denied.Count: > 0 } last) return;
        var permission = Permission().Granting(last.Denied.ToList());
        SetPermission(permission);
        Messages.Add(new ChatMessage(ChatRole.User, Words.GrantMessage));
        Start(new ChatTurnRequest(Words.GrantMessage, permission, [], Model()), null, null);
    }

    /// <summary>
    /// Stops the run on the Space; its stream then ends by itself. Pressed before the Space has
    /// named the run, the stop is sent as soon as it does: dropping the stream would leave the run
    /// going on the Space, unseen.
    /// </summary>
    public void Stop()
    {
        _stopRequested = true;
        if (RunId is { } run) SendStop(run);
    }

    private void SendStop(string run) => _ = Quiet(_api.ChatPost($"{Base}/runs/{SpacePath.Escape(run)}/stop", new Dictionary<string, object>(), _life.Token));

    private static async Task Quiet(Task t)
    {
        try
        {
            await t;
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
        }
    }

    public async Task LoadSessions()
    {
        try
        {
            Sessions = ChatSession.Decode(await _api.ChatGet($"{Base}/sessions", _life.Token));
            Notify();
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
        }
    }

    /// <summary>Shows a stored conversation; the next message continues it. Not while a turn runs.</summary>
    public async Task Open(string sid)
    {
        if (Busy) return;
        try
        {
            var stored = ChatHistoryMessage.Decode(await _api.ChatGet($"{Base}/sessions/{SpacePath.Escape(sid)}", _life.Token));
            if (Busy) return;
            Messages.Clear();
            foreach (var m in stored)
            {
                // The agent's text and tool calls come back in order, drawn like a finished live turn;
                // its cards come back without a token, read-only.
                if (m.Text.Length == 0 && m.Steps.Count == 0 && m.Cards.Count == 0) continue;
                var message = new ChatMessage(m.IsUser ? ChatRole.User : ChatRole.Agent, m.Text) { Tools = m.Tools, Steps = m.Steps, Historic = !m.IsUser };
                message.Cards.AddRange(m.Cards.Select(c => new ChatShownCard(c)));
                Messages.Add(message);
            }
            SessionId = sid;
            _thread++;
            Error = null;
            RefreshCards();
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
            Error = e.Message;
        }
        Notify();
    }

    /// <summary>An empty conversation; the next message starts a new session. Not while a turn runs.</summary>
    public void NewConversation()
    {
        if (Busy) return;
        Messages.Clear();
        SessionId = null;
        _thread++;
        Error = null;
        Notify();
    }

    // Chat cards (docs/chat-cards.md)

    /// <summary>Reads every card's current state again: a card says the current state each time it is shown.</summary>
    public void RefreshCards()
    {
        foreach (var m in Messages)
        {
            foreach (var c in m.Cards) _ = LoadCardState(m, c);
        }
    }

    private async Task LoadCardState(ChatMessage message, ChatShownCard card)
    {
        if (card.Received.Card.State is null) return;
        try
        {
            var (status, body) = await _api.ChatAnswer($"{ChatCards.Base(Base)}/state", ChatCards.StateBody(AgentId, card.Received), _life.Token);
            if (status is < 200 or >= 300) return;
            var items = ChatCards.StateItems(Parse(body));
            if (items.Count == 0) return;
            card.Merge(items);
            message.Version++;
            Notify();
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
            // The card shows what was printed.
        }
    }

    private static JsonElement Parse(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return default;
        }
    }

    /// <summary>Undoes items of a card (the header's Undo: every one still open); the answer's states replace the shown ones.</summary>
    public async Task UndoCard(ChatMessage message, ChatShownCard card, IReadOnlyList<string> ids)
    {
        if (card.Received.Token is not { } token || card.Busy || ids.Count == 0) return;
        card.Busy = true;
        card.Note = null;
        card.Version++;
        message.Version++;
        Notify();
        try
        {
            var (status, body) = await _api.ChatAnswer($"{ChatCards.Base(Base)}/action", ChatCards.ActionBody(token, card.Received.Index, ids), _life.Token);
            var outcome = ChatCards.Outcome(status, body);
            switch (outcome.Kind)
            {
                case ChatCardOutcomeKind.ReadOnly:
                    card.ReadOnly = true;
                    card.Note = Words.CardReadOnly;
                    break;
                case ChatCardOutcomeKind.Error:
                    card.Note = outcome.Note;
                    break;
                default:
                    card.Merge(outcome.Items);
                    break;
            }
        }
        catch (Exception e) when (e is SpaceApiException or OperationCanceledException)
        {
            card.Note = e.Message;
        }
        finally
        {
            card.Busy = false;
            card.Version++;
            message.Version++;
            Notify();
        }
    }

    /// <summary>Ends every stream and call of the conversation for good (its Space was removed or signed out); runs on the Space go on.</summary>
    public void Close()
    {
        _life.Cancel();
    }

    private bool Next()
    {
        if (_queue.Count == 0) return false;
        var (message, turn) = _queue[0];
        _queue.RemoveAt(0);
        Start(turn, null, message);
        return true;
    }

    private void Start(ChatTurnRequest? turn, string? attach, Guid? replyingTo)
    {
        Busy = true;
        Error = null;
        _stopRequested = false;
        _pending.Clear();
        _steersSeen = 0;
        var reply = new ChatReply();
        if (attach is not null) reply.Activity = ChatActivity.Reconnecting;
        var placeholder = new ChatMessage(ChatRole.Agent, "") { Activity = reply.Activity, Live = true };
        // A queued turn's reply belongs right after its own message, not at the end.
        var at = replyingTo is { } id ? Messages.FindIndex(m => m.Id == id) : -1;
        if (at >= 0) Messages.Insert(at + 1, placeholder);
        else Messages.Add(placeholder);
        SetRun(attach);
        _turn = CancellationTokenSource.CreateLinkedTokenSource(_life.Token);
        Notify();
        _ = Run(turn, reply, placeholder, _turn.Token);
    }

    private async Task Run(ChatTurnRequest? turn, ChatReply reply, ChatMessage target, CancellationToken ct)
    {
        var lastSeq = 0;
        var failures = 0;
        while (!reply.Finished && !ct.IsCancellationRequested)
        {
            try
            {
                ChatEvents opened;
                if (RunId is { } run)
                {
                    opened = await _api.ChatEvents(HttpMethod.Get, $"{Base}/runs/{SpacePath.Escape(run)}/events?after={lastSeq}", null, ct);
                }
                else if (turn is not null)
                {
                    opened = await _api.ChatEvents(HttpMethod.Post, $"{Base}/chat", turn.Body(SessionId), ct);
                    SetRun(opened.RunId);
                    if (_stopRequested && RunId is { } named) SendStop(named);
                }
                else
                {
                    break;
                }
                await foreach (var m in opened.Messages.WithCancellation(ct))
                {
                    if (m.Id is { } seq)
                    {
                        if (seq <= lastSeq) continue;
                        lastSeq = seq;
                    }
                    reply.Apply(m.Data);
                    failures = 0;
                    Update(target, reply);
                    if (reply.Finished) break;
                }
            }
            catch (SpaceApiException e) when (e.Kind == SpaceApiFailure.AuthenticationRequired)
            {
                Fail(target, new ChatFailure(ChatFailureKind.Connection, Words.SignIn));
                break;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e) when (e is SpaceApiException or IOException or HttpRequestException or OperationCanceledException)
            {
                // A turn that never got a run cannot be reattached; one that did is resumed.
                if (RunId is null)
                {
                    Fail(target, e is SpaceApiException { Kind: SpaceApiFailure.Http } ? ChatFailure.Classify(e.Message) : new ChatFailure(ChatFailureKind.Connection, e.Message));
                    break;
                }
            }
            if (reply.Finished || ct.IsCancellationRequested) break;
            failures++;
            if (failures > ChatReconnect.MaxFailures)
            {
                Fail(target, new ChatFailure(ChatFailureKind.Connection, Words.Lost));
                break;
            }
            reply.Activity = ChatActivity.Reconnecting;
            Update(target, reply);
            try
            {
                await _sleep(ChatReconnect.Delay(failures), ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
        if (_life.IsCancellationRequested) return;
        if (reply.SessionId is { } sid) SessionId = sid;
        reply.EndSteps();
        reply.Activity = null;
        Update(target, reply);
        target.Live = false;
        target.Pending = [];
        target.Activity = null;
        target.Version++;
        SetRun(null);
        TurnEnded?.Invoke();
        // A message that could not join this turn goes now, in the order it was written.
        if (!Next())
        {
            _pending.Clear();
            _stopRequested = false;
            Busy = false;
        }
        Notify();
    }

    private void Update(ChatMessage target, ChatReply reply)
    {
        // A failure is drawn as its own card, so the text keeps only what the agent wrote.
        var text = reply.Failure is null ? reply.Text : reply.Body;
        if (reply.Stopped) text += (text.Length == 0 ? "" : "\n\n") + Words.Stopped;
        target.Text = text;
        target.Tools = [.. reply.Tools];
        target.Steps = [.. reply.Steps];
        target.Denied = [.. reply.Denied];
        if (reply.Failure is null && reply.Note is not null) target.Note = reply.Note;
        if (reply.Stopped) target.Stopped = true;
        // The reply says which added messages the agent has read; the rest still wait.
        while (_steersSeen < reply.ConsumedSteers.Count) TakePending(reply.ConsumedSteers[_steersSeen++]);
        target.Pending = [.. _pending];
        target.Activity = reply.Activity;
        if (reply.Failure is { } failure) target.Failure = ChatFailure.Classify(failure);
        // New cards join the reply with their state still to read; the ones shown keep theirs.
        if (reply.Cards.Count > target.Cards.Count)
        {
            var added = reply.Cards.Skip(target.Cards.Count).Select(c => new ChatShownCard(c)).ToList();
            target.Cards.AddRange(added);
            foreach (var c in added) _ = LoadCardState(target, c);
        }
        target.Version++;
        Notify();
    }

    private void Fail(ChatMessage target, ChatFailure failure)
    {
        target.Activity = null;
        target.Failure = failure;
        target.Version++;
        Notify();
    }
}
