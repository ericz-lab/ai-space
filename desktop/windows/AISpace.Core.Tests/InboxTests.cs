using System.Net;
using System.Text;
using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

public class InboxTests
{
    // Two threads as src/space/notify/api.ts answers them: a failing task (one thread of three) and a report.
    private const string Answer = """
        {
          "ok": true,
          "items": [
            { "thread": "k:ai-todo:sync", "app": "ai-todo", "level": "alert", "title": "Sync failed", "text": "Could not reach the server\nretrying", "url": "/apps/ai-todo/?t=1",
              "key": "sync", "notificationId": "n_3", "count": 3, "firstAt": "2026-11-20T08:00:00.000Z", "lastAt": "2026-11-21T09:30:00.000Z", "action": true, "unread": true, "done": false },
            { "thread": "n_9", "app": "news", "level": "report", "text": "Morning report is ready", "notificationId": "n_9", "count": 1,
              "firstAt": "2026-11-21T07:00:00.000Z", "lastAt": "2026-11-21T07:00:00.000Z", "action": false, "unread": false, "done": true },
            { "app": "broken" }
          ],
          "summary": { "unread": 1, "open": 1 }
        }
        """;

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void ThreadsDecodeAndAMalformedOneIsSkipped()
    {
        var (items, summary) = InboxRules.Decode(Json(Answer));
        Assert.Equal(2, items.Count);
        var sync = items[0];
        Assert.Equal("Sync failed", sync.Heading);
        Assert.Equal(3, sync.Count);
        Assert.True(sync.NeedsAction);
        Assert.Equal(new DateTimeOffset(2026, 11, 20, 8, 0, 0, TimeSpan.Zero), sync.FirstAt);
        Assert.Equal(InboxTone.Critical, InboxRules.Tone(sync.Level));
        // No title: the first line of the text names it.
        Assert.Equal("Morning report is ready", items[1].Heading);
        Assert.False(items[1].NeedsAction);
        Assert.Equal(new InboxSummary(1, 1), summary);
        // An answer without a summary counts it from the threads.
        Assert.Equal(new InboxSummary(1, 1), InboxRules.Decode(Json(Answer.Replace("\"summary\": { \"unread\": 1, \"open\": 1 }", "\"x\": 0", StringComparison.Ordinal))).Summary);
    }

    [Fact]
    public void EachFilterAsksTheRouteAsTheWebPanelDoes()
    {
        Assert.Equal("/api/inbox?filter=all&limit=200", InboxRules.Path(InboxFilter.All));
        Assert.Equal("/api/inbox?filter=unread&limit=200", InboxRules.Path(InboxFilter.Unread));
        Assert.Equal("/api/inbox?filter=open&action=1&limit=200", InboxRules.Path(InboxFilter.Handle));
        Assert.Equal("/api/inbox?filter=done&limit=200&app=ai-todo", InboxRules.Path(InboxFilter.Done, "ai-todo"));
    }

    [Fact]
    public void AMarkChangesTheThreadAsTheServerDoes()
    {
        var t = InboxRules.Decode(Json(Answer)).Items[0];
        var read = InboxRules.Marked(t, read: true);
        Assert.False(read.Unread);
        Assert.False(read.Done);
        // Done implies read; reopening leaves it read.
        var done = InboxRules.Marked(t, done: true);
        Assert.True(done.Done);
        Assert.False(done.Unread);
        Assert.False(done.NeedsAction);
        var reopened = InboxRules.Marked(done, done: false);
        Assert.False(reopened.Done);
        Assert.False(reopened.Unread);
        Assert.True(InboxRules.Marked(read, read: false).Unread);
        // A marked thread may leave its filter.
        Assert.False(InboxRules.Matches(done, InboxFilter.Handle));
        Assert.True(InboxRules.Matches(done, InboxFilter.Done));
        Assert.False(InboxRules.Matches(read, InboxFilter.Unread));
        Assert.True(InboxRules.Matches(read, InboxFilter.All));
    }

    [Fact]
    public void TheAppMenuKeepsEveryAppSeen()
    {
        var items = InboxRules.Decode(Json(Answer)).Items;
        Assert.Equal(["ai-todo", "news"], InboxRules.Apps([], items));
        Assert.Equal(["ai-todo", "keep", "news"], InboxRules.Apps(["keep", "news"], items.Take(1)));
    }

    [Fact]
    public void TheKeyChangesOnlyWithWhatTheListShows()
    {
        var items = InboxRules.Decode(Json(Answer)).Items;
        Assert.Equal(InboxRules.Key(items), InboxRules.Key(InboxRules.Decode(Json(Answer)).Items));
        Assert.NotEqual(InboxRules.Key(items), InboxRules.Key([InboxRules.Marked(items[0], read: true), items[1]]));
    }

    [Fact]
    public void TimesReadAsTheOtherClientsSayThem()
    {
        var now = new DateTimeOffset(2026, 11, 21, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal((RelativeUnit.JustNow, 0), InboxRules.Relative(now.AddSeconds(-30), now));
        Assert.Equal((RelativeUnit.Minutes, 5), InboxRules.Relative(now.AddMinutes(-5), now));
        Assert.Equal((RelativeUnit.Hours, 3), InboxRules.Relative(now.AddHours(-3), now));
        Assert.Equal((RelativeUnit.Days, 2), InboxRules.Relative(now.AddDays(-2), now));
        Assert.Equal(RelativeUnit.Date, InboxRules.Relative(now.AddDays(-9), now).Unit);
        Assert.Equal(new string('x', 139) + "…", InboxRules.FirstLine(new string('x', 200)));
        Assert.Equal("first", InboxRules.FirstLine("first\r\nsecond"));
    }

    [Fact]
    public async Task MarksAndReadAllPostWithTheSpacesOriginAndAnswerTheSummary()
    {
        var handler = new Recorder("""{ "ok": true, "changed": 1, "summary": { "unread": 0, "open": 2 } }""");
        var api = new SpaceApi(new Uri("http://127.0.0.1:8700/"), _ => Task.FromResult<string?>(null), handler);
        Assert.Equal(new InboxSummary(0, 2), await api.MarkInbox(["k:ai-todo:sync"], done: true));
        Assert.Equal("/api/inbox/mark", handler.Path);
        Assert.Equal("""{"threads":["k:ai-todo:sync"],"done":true}""", handler.Body);
        Assert.Equal("http://127.0.0.1:8700", handler.Origin);
        await api.ReadAllInbox("ai-todo");
        Assert.Equal("/api/inbox/read-all", handler.Path);
        Assert.Equal("""{"app":"ai-todo"}""", handler.Body);
    }

    [Fact]
    public async Task ASpaceWithoutTheMoodRouteHasNoMood()
    {
        var api = new SpaceApi(new Uri("http://127.0.0.1:8700/"), _ => Task.FromResult<string?>(null), new Recorder("""{ "ok": false, "error": "not found" }""", HttpStatusCode.NotFound));
        Assert.Null(await api.Mood());
        var ok = new SpaceApi(new Uri("http://127.0.0.1:8700/"), _ => Task.FromResult<string?>(null), new Recorder("""{ "ok": true, "state": "working", "move": "roam" }"""));
        Assert.Equal("look", PetRules.Shown(await ok.Mood())?.Rest);
    }

    internal sealed class Recorder(string answer, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public string? Path { get; private set; }
        public string? Body { get; private set; }
        public string? Origin { get; private set; }
        public HttpMethod? Method { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Method = request.Method;
            Path = request.RequestUri!.PathAndQuery;
            Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
            Origin = request.Headers.TryGetValues("Origin", out var o) ? o.First() : null;
            return new HttpResponseMessage(status) { Content = new StringContent(answer, Encoding.UTF8, "application/json") };
        }
    }
}
