using System.Runtime.CompilerServices;
using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The agents' chat routes (src/space/agents/api.ts), as the Mac's <c>ChatController</c> calls them:
/// <c>POST …/chat</c> (a new turn, answered with its event stream and <c>x-run-id</c>),
/// <c>GET …/runs/:id/events?after=</c> (re-attach to a running turn), <c>…/stop</c>, <c>…/steer</c>,
/// <c>…/approvals/:rid</c>, <c>GET …/sessions</c> and <c>…/sessions/:sid</c>, and the chat cards'
/// <c>/api/agents/cards/state|action</c>. Every route is under the agent's base
/// (<see cref="ChatAgents.Base"/>): a peer's agent goes through <c>/api/peers/&lt;peer&gt;</c>.
/// </summary>
public sealed partial class SpaceApi : IChatApi
{
    private HttpClient? _streams;

    /// <summary>
    /// A server-sent event stream: each <c>data:</c> line with the <c>id:</c> before it, and the run
    /// id from the <c>x-run-id</c> header. The stream has no time limit (a turn may run for an hour);
    /// a refusal (sign-in, an HTTP error with the route's <c>error</c>) throws before it opens.
    /// </summary>
    public async Task<ChatEvents> Events(HttpMethod method, string path, object? json = null, CancellationToken ct = default)
    {
        var r = await Request(method, path, json, accept: "text/event-stream").ConfigureAwait(false);
        _streams ??= new HttpClient(_handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        foreach (var ua in _http.DefaultRequestHeaders.UserAgent) r.Headers.UserAgent.Add(ua);
        HttpResponseMessage response;
        try
        {
            response = await _streams.SendAsync(r, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException e)
        {
            r.Dispose();
            throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
        }
        if (!response.IsSuccessStatusCode)
        {
            using (response)
            using (r)
            {
                var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                Check((int)response.StatusCode, body.Length > 4096 ? body[..4096] : body);
            }
        }
        var runId = response.Headers.TryGetValues("x-run-id", out var ids) ? ids.FirstOrDefault() : null;
        return new ChatEvents(runId, Lines(r, response, ct));
    }

    private static async IAsyncEnumerable<SseMessage> Lines(HttpRequestMessage request, HttpResponseMessage response, [EnumeratorCancellation] CancellationToken ct)
    {
        using var _ = request;
        using var __ = response;
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        using var reader = new StreamReader(stream);
        var parser = new SseParser();
        while (true)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            }
            catch (HttpRequestException e)
            {
                throw new SpaceApiException(SpaceApiFailure.Network, e.Message);
            }
            if (line is null) yield break;
            if (parser.Feed(line) is { } message) yield return message;
        }
    }

    Task<ChatEvents> IChatApi.ChatEvents(HttpMethod method, string path, object? body, CancellationToken ct) => Events(method, path, body, ct);

    Task IChatApi.ChatPost(string path, object body, CancellationToken ct) => Send(HttpMethod.Post, path, body, ct);

    Task<JsonElement> IChatApi.ChatGet(string path, CancellationToken ct) => Get(path, ct);

    async Task<(int Status, string Body)> IChatApi.ChatAnswer(string path, object body, CancellationToken ct)
    {
        var (status, _, text) = await Answer(HttpMethod.Post, path, body, ct).ConfigureAwait(false);
        return (status, text);
    }
}

/// <summary>A model an agent's chat may run on (<c>modelOptions</c> of <c>GET /api/agents</c>): runtime and tier, and why it cannot be picked now.</summary>
public sealed record ChatModelChoice(string Value, string Runtime, string Tier, string Model, string? Unavailable = null);

/// <summary>One entry of the model picker: its value (sent as <c>model</c>; "" the default), its words, and whether it may be picked.</summary>
public sealed record ChatModelEntry(string Value, string Label, bool Enabled = true, string? Group = null);

/// <summary>The words of the model picker, in the interface's language.</summary>
public sealed record ChatModelWords(string Default, string Saved, Func<string, string> Tier, Func<string, string> Unavailable, Func<string, string> Claude);

/// <summary>The chat's rules about agents and their models, after src/web/Chat.tsx and chat-request.ts.</summary>
public static class ChatAgents
{
    /// <summary>The route base of the agent's chat: local, or forwarded to the peer that owns it.</summary>
    public static string Base(AgentInfo agent)
    {
        var prefix = agent.Peer is { } peer ? $"/api/peers/{SpacePath.Escape(peer)}" : "/api";
        return $"{prefix}/agents/{SpacePath.Escape(agent.App)}/{SpacePath.Escape(agent.Name)}";
    }

    /// <summary>The agent as its own machine names it in runs and card calls: <c>&lt;app&gt;/&lt;name&gt;</c>.</summary>
    public static string LocalId(AgentInfo agent) => $"{agent.App}/{agent.Name}";

    /// <summary>
    /// Space Assistant, and every agent that lists its runtime and tier choices, sends its own pick;
    /// an agent of an older peer without them takes the shared Claude model words.
    /// </summary>
    public static bool PicksRuntime(AgentInfo agent) => (agent.App == "space" && agent.Name == "assistant") || agent.ModelOptions is not null;

    /// <summary>The Claude model words an agent without its own choices is offered (the web's fallback list).</summary>
    public static readonly IReadOnlyList<string> ClaudeModels = ["haiku", "sonnet", "opus", "fable"];

    /// <summary>
    /// The picker's entries: the default (naming the agent's runtime when it has one), then every
    /// choice as "runtime · tier · model" grouped by runtime, a choice that is signed out or offline
    /// shown but not pickable, and a saved one no longer offered kept as it is.
    /// </summary>
    public static IReadOnlyList<ChatModelEntry> Entries(AgentInfo agent, string saved, ChatModelWords words)
    {
        var entries = new List<ChatModelEntry>();
        if (agent.ModelOptions is { } options)
        {
            entries.Add(new ChatModelEntry("", agent.Runtime is { Length: > 0 } rt ? $"{words.Default} · {rt}" : words.Default));
            if (saved.Length > 0 && !options.Any(o => o.Value == saved)) entries.Add(new ChatModelEntry(saved, $"{saved} ({words.Saved})"));
            foreach (var o in options)
            {
                var label = $"{o.Runtime} · {words.Tier(o.Tier)} · {o.Model}";
                if (o.Unavailable is { } why) label += $" ({words.Unavailable(why)})";
                entries.Add(new ChatModelEntry(o.Value, label, o.Unavailable is null, o.Runtime));
            }
            return entries;
        }
        entries.Add(new ChatModelEntry("", words.Default));
        if (saved.Length > 0 && !ClaudeModels.Contains(saved)) entries.Add(new ChatModelEntry(saved, $"{saved} ({words.Saved})"));
        entries.AddRange(ClaudeModels.Select(m => new ChatModelEntry(m, words.Claude(m))));
        return entries;
    }

    /// <summary>The model a stored session ran on, as the picker's value (the web's <c>pickSession</c>), so continuing it keeps its runtime.</summary>
    public static string SessionChoice(AgentInfo agent, ChatSession session)
    {
        if (agent.ModelOptions is not { } options) return "";
        var runtime = session.Runtime ?? agent.Runtime;
        return options.FirstOrDefault(o => o.Runtime == runtime && o.Model == session.Model)?.Value ?? (session.Model is { Length: > 0 } m ? $"{runtime}/{m}" : "");
    }
}
