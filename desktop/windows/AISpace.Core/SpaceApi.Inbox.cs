using System.Text.Json;

namespace AISpace.Core;

/// <summary>The inbox page's and the desk pet's routes (src/space/notify/api.ts, src/space/panel/pets.ts).</summary>
public sealed partial class SpaceApi
{
    /// <summary><c>GET /api/inbox</c> under a filter, of one app or all.</summary>
    public async Task<(IReadOnlyList<InboxThread> Items, InboxSummary Summary)> InboxThreads(InboxFilter filter, string? app = null, CancellationToken ct = default) =>
        InboxRules.Decode(await GetJson<JsonElement>(InboxRules.Path(filter, app), ct).ConfigureAwait(false));

    /// <summary><c>POST /api/inbox/mark</c>: threads read or unread, done or open again (done implies read). Answers the new summary.</summary>
    public async Task<InboxSummary> MarkInbox(IReadOnlyList<string> threads, bool? read = null, bool? done = null, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object> { ["threads"] = threads };
        if (read is { } r) body["read"] = r;
        if (done is { } d) body["done"] = d;
        return InboxRules.Summary(await PostJson<JsonElement>("/api/inbox/mark", body, ct).ConfigureAwait(false));
    }

    /// <summary><c>POST /api/inbox/read-all</c>: every unread thread read, of one app or all. Answers the new summary.</summary>
    public async Task<InboxSummary> ReadAllInbox(string? app = null, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object>();
        if (!string.IsNullOrEmpty(app)) body["app"] = app;
        return InboxRules.Summary(await PostJson<JsonElement>("/api/inbox/read-all", body, ct).ConfigureAwait(false));
    }

    /// <summary><c>GET /api/pets/mood</c>: the Space's mood for the desk pet; null from a Space without the route or with an answer that is not a mood.</summary>
    public async Task<SpaceMood?> Mood(CancellationToken ct = default)
    {
        try
        {
            return PetRules.DecodeMood(await GetJson<JsonElement>(PetRules.MoodPath, ct).ConfigureAwait(false));
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Http or SpaceApiFailure.InvalidResponse)
        {
            return null;
        }
    }
}
