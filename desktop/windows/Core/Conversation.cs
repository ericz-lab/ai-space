namespace AISpace.Core;

/// <summary>A message of the conversation as Quick Chat draws it.</summary>
public sealed class ChatMessage
{
    public required bool FromPerson { get; init; }
    public string Text { get; set; } = "";
    public IReadOnlyList<ChatImage> Images { get; init; } = [];
    public IReadOnlyList<Approval> Waiting { get; set; } = [];
    public bool Failed { get; set; }
    public bool Live { get; set; }
}

/// <summary>
/// One conversation with an agent: a smaller ChatController (the Mac's) for Quick Chat. Each turn is
/// a background run on the Space; the reply streams in, Stop ends the run, an approval the turn
/// waits on is answered here, and the next message continues the same session. Called and
/// answering on one thread (the UI's): <see cref="Changed"/> is raised there.
/// </summary>
public sealed class Conversation(SpaceClient client, AgentInfo agent, Func<string> permission)
{
    readonly List<ChatMessage> messages = [];
    string? sessionId;
    string? runId;
    CancellationTokenSource? turn;

    public AgentInfo Agent { get; } = agent;
    public IReadOnlyList<ChatMessage> Messages => messages;
    public bool Busy => turn is not null;
    public event Action? Changed;

    public async Task Send(string text, IReadOnlyList<ChatImage> images)
    {
        var message = text.Trim();
        if (Busy || (message.Length == 0 && images.Count == 0)) return;
        messages.Add(new ChatMessage { FromPerson = true, Text = message, Images = images });
        var reply = new ChatMessage { FromPerson = false, Live = true };
        messages.Add(reply);
        var cts = turn = new CancellationTokenSource();
        Changed?.Invoke();
        var events = new TurnReply();
        try
        {
            await foreach (var line in client.Chat(Agent, TurnReply.Body(message, images, permission(), sessionId), id => runId = id, cts.Token))
            {
                events.Apply(line);
                reply.Text = events.Text;
                reply.Waiting = events.Waiting.ToList();
                Changed?.Invoke();
                if (events.Done) break;
            }
            sessionId = events.SessionId ?? sessionId;
            reply.Failed = events.Failure is not null;
            if (events.Stopped) reply.Text = (reply.Text.Length > 0 ? reply.Text + "\n\n" : "") + "⏹";
        }
        catch (OperationCanceledException)
        {
            // The window went away: the run goes on on the Space.
        }
        catch (Exception e)
        {
            reply.Failed = true;
            reply.Text = (reply.Text.Length > 0 ? reply.Text + "\n\n" : "") + "⚠️ " + e.Message;
        }
        finally
        {
            reply.Live = false;
            reply.Waiting = [];
            runId = null;
            turn = null;
            cts.Dispose();
            Changed?.Invoke();
        }
    }

    /// <summary>Stop ends the run on the Space; its stream then ends with <c>stopped</c>.</summary>
    public async Task Stop()
    {
        if (runId is { } id)
        {
            try { await client.Stop(Agent, id); }
            catch (Exception) { turn?.Cancel(); }
        }
        else turn?.Cancel();
    }

    public async Task Answer(Approval approval, bool allow)
    {
        if (runId is not { } id) return;
        await client.Answer(Agent, id, approval.Id, allow);
    }

    /// <summary>A new conversation: the next message starts a new session.</summary>
    public void Reset()
    {
        if (Busy) return;
        messages.Clear();
        sessionId = null;
        Changed?.Invoke();
    }
}
