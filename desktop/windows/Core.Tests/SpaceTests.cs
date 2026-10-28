using System.Net;
using System.Text;
using AISpace.Core;
using Xunit;

namespace AISpace.Core.Tests;

public class CatalogueTests
{
    const string Apps = """
        {"apps":[
          {"id":"keep","title":"Keep","url":"/apps/keep/","icon":"📝"},
          {"id":"ai-todo","title":"Todo","url":"/apps/ai-todo/","i18n":{"zh":{"title":"待办"}}},
          {"id":"vault","title":"Vault","url":"/apps/vault/"},
          {"id":"thinkbook/ai-design","title":"Design Studio","url":"https://d.example.com/","peer":"thinkbook"},
          {"id":"old","title":"Old","url":"/old/","status":"archived"},
          {"id":"secret","title":"Secret","url":"/s/","hidden":true},
          {"id":"broken"}
        ]}
        """;
    const string Agents = """
        {"agents":[
          {"id":"space/assistant","app":"space","name":"assistant","title":"Space Assistant"},
          {"id":"ai-todo/planner","app":"ai-todo","name":"planner","title":"Planner"},
          {"id":"thinkbook/ai-design/designer","app":"ai-design","name":"designer","title":"Designer","peer":"thinkbook"},
          {"title":"no id"}
        ]}
        """;

    static readonly Catalogue Catalogue = Catalogue.Decode(Apps, Agents);

    [Fact]
    public void RowsTheClientCannotUseAreSkipped()
    {
        Assert.Equal(["keep", "ai-todo", "vault", "thinkbook/ai-design"], Catalogue.Apps.Select(a => a.Ref));
        Assert.Equal(3, Catalogue.Agents.Count);
        Assert.Equal("待办", Catalogue.Entry("app:ai-todo")!.TitleIn("zh"));
        Assert.Equal("Todo", Catalogue.Entry("app:ai-todo")!.TitleIn("en"));
        Assert.Throws<FormatException>(() => Catalogue.Decode("{}", Agents));
    }

    [Fact]
    public void APeersAgentIsReachedThroughThePeer()
    {
        Assert.Equal("/api/agents/ai-todo/planner", Catalogue.Route("ai-todo/planner")!.Base);
        Assert.Equal("/api/peers/thinkbook/agents/ai-design/designer", Catalogue.Route("thinkbook/ai-design/designer")!.Base);
    }

    [Fact]
    public void TheDefaultSectionsAndTheirAgents()
    {
        var dial = FloatingBallRules.Resolve(Catalogue, null);
        Assert.Equal(("keep", "space/assistant", true), (dial[Section.Keep].Entry!.Ref, dial[Section.Keep].Agent, dial[Section.Keep].Borrowed));
        Assert.Equal("space/assistant", dial[Section.Assistant].Agent);
        Assert.False(dial[Section.Assistant].Borrowed);
        Assert.Equal("ai-todo/planner", dial[Section.Todo].Agent);
        Assert.Equal("thinkbook/ai-design/designer", dial[Section.Design].Agent);
    }

    [Fact]
    public void SettingsChoicesAndEmptySections()
    {
        var dial = FloatingBallRules.Resolve(Catalogue, ["app:vault", "agent:ai-todo/planner", FloatingBallRules.EmptySlot, "app:gone"]);
        Assert.Equal("vault", dial[Section.Keep].Entry!.Ref);
        Assert.True(dial[Section.Keep].Borrowed);
        Assert.Equal("ai-todo/planner", dial[Section.Assistant].Agent);
        Assert.Equal(new DialEntry(null, null, false, true), dial[Section.Todo]);
        Assert.Equal(new DialEntry(null, null, false, false), dial[Section.Design]);
        Assert.Equal(new DialEntry(null, null, false, false), FloatingBallRules.Resolve(null, null)[Section.Todo]);
    }
}

public class ChatTests
{
    [Fact]
    public void EventsAreReadAsTheServerWritesThem()
    {
        var p = new SseParser();
        Assert.Null(p.Feed(": keep-alive"));
        Assert.Null(p.Feed("id: 7"));
        Assert.Equal((7L, "{\"a\":1}"), p.Feed("data: {\"a\":1}\r")!.Value);
        Assert.Equal(((long?)null, "x"), p.Feed("data:x")!.Value);
    }

    [Fact]
    public void AReplyIsBuiltFromItsEvents()
    {
        var r = new TurnReply();
        r.Apply("""{"type":"system","subtype":"init","session_id":"s1","model":"m"}""");
        r.Apply("""{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hel"}}}""");
        Assert.Equal("Hel", r.Text);
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Read"}]}}""");
        r.Apply("""{"type":"approval_request","id":"r1","tool":"Bash","title":"Run ls"}""");
        Assert.Equal("Hello", r.Text);
        Assert.Equal(["Read"], r.Tools);
        Assert.Equal("r1", Assert.Single(r.Waiting).Id);
        r.Apply("""{"type":"approval_resolved","id":"r1","decision":"allow"}""");
        Assert.Empty(r.Waiting);
        r.Apply("not json");
        r.Apply("""{"type":"done"}""");
        Assert.True(r.Done);
        Assert.Equal("s1", r.SessionId);
    }

    [Fact]
    public void AFailedOrStoppedTurnSaysSo()
    {
        var r = new TurnReply();
        r.Apply("""{"type":"error","error":"rate limit"}""");
        Assert.Equal("⚠️ rate limit", r.Text);
        var s = new TurnReply();
        s.Apply("""{"type":"error","status":"stopped"}""");
        Assert.True(s.Stopped);
        var e = new TurnReply();
        e.Apply("""{"type":"result","is_error":true,"result":"not logged in"}""");
        Assert.Equal("not logged in", e.Text);
    }

    [Fact]
    public void PicturesWithinTheSpacesLimits()
    {
        Assert.Equal("image/png", ChatImage.TypeOf([0x89, 0x50, 0x4e, 0x47, 0x0d]));
        Assert.Equal("image/jpeg", ChatImage.TypeOf([0xff, 0xd8, 0xff, 0xe0]));
        Assert.Null(ChatImage.TypeOf([0x42, 0x4d, 0, 0]));
        var small = new ChatImage("a.png", "image/png", new byte[10]);
        Assert.True(ChatImage.Fits([], small));
        Assert.False(ChatImage.Fits([small, small, small, small], small));
        Assert.False(ChatImage.Fits([], new ChatImage("big.png", "image/png", new byte[ChatImage.MaxBytes + 1])));
        var body = TurnReply.Body("hi", [small], "", "s1");
        Assert.Equal(true, body["interactive"]);
        Assert.Equal("s1", body["sessionId"]);
        Assert.False(body.ContainsKey("permissionMode"));
    }
}

public class SpaceClientTests
{
    [Theory]
    [InlineData("space.example.com", "https://space.example.com/")]
    [InlineData("https://space.example.com/panel?x=1", "https://space.example.com/")]
    [InlineData("127.0.0.1:8700", "http://127.0.0.1:8700/")]
    [InlineData("localhost:8700", "http://localhost:8700/")]
    public void AddressesAreNormalized(string typed, string expected) => Assert.Equal(expected, SpaceClient.NormalizeAddress(typed).ToString());

    [Theory]
    [InlineData("")]
    [InlineData("http://space.example.com")]
    [InlineData("ftp://space.example.com")]
    [InlineData("https://me:pw@space.example.com")]
    public void BadAddressesAreRefused(string typed) => Assert.Throws<FormatException>(() => SpaceClient.NormalizeAddress(typed));

    sealed class Fake(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public readonly List<HttpRequestMessage> Seen = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add(request);
            return Task.FromResult(answer(request));
        }
    }

    [Fact]
    public async Task AChatTurnStreamsItsEventsWithTheDeviceToken()
    {
        var fake = new Fake(_ =>
        {
            var res = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("id: 1\ndata: {\"type\":\"done\"}\n\n", Encoding.UTF8, "text/event-stream") };
            res.Headers.Add("x-run-id", "run-1");
            return res;
        });
        using var client = new SpaceClient("https://space.example.com", "spd_test", fake);
        string? run = null;
        var lines = new List<string>();
        await foreach (var line in client.Chat(new AgentInfo("ai-todo/planner", "ai-todo", "planner", null), TurnReply.Body("hi", [], "", null), r => run = r))
            lines.Add(line);
        Assert.Equal("run-1", run);
        Assert.Equal(["{\"type\":\"done\"}"], lines);
        var req = Assert.Single(fake.Seen);
        Assert.Equal("https://space.example.com/api/agents/ai-todo/planner/chat", req.RequestUri!.ToString());
        Assert.Equal("Bearer spd_test", req.Headers.Authorization!.ToString());
        Assert.Equal("https://space.example.com", req.Headers.GetValues("Origin").Single());
    }

    [Fact]
    public async Task ASignInRedirectAsksForTheToken()
    {
        var fake = new Fake(_ => new HttpResponseMessage(HttpStatusCode.Redirect));
        using var client = new SpaceClient("https://space.example.com", null, fake);
        await Assert.ThrowsAsync<SignInException>(() => client.GetText("/api/apps"));
    }
}

public class PreferencesTests
{
    [Fact]
    public void PreferencesSurviveARoundTripAndABrokenFile()
    {
        var dir = Path.Combine(Path.GetTempPath(), "aispace-prefs-" + Guid.NewGuid());
        var file = Path.Combine(dir, "preferences.json");
        try
        {
            var p = new Preferences { Address = "https://s.example.com/", SavedOrigin = new Pt(10.4, 20.6) };
            p.Slots["https://s.example.com/"] = FloatingBallRules.Setting(Section.Todo, "app:vault", null);
            p.Save(file);
            var back = Preferences.Load(file);
            Assert.Equal(new Pt(10, 21), back.SavedOrigin);
            Assert.Equal("app:vault", FloatingBallRules.Slot(Section.Todo, back.Slots["https://s.example.com/"]));
            File.WriteAllText(file, "{ not json");
            Assert.Equal("", Preferences.Load(file).Address);
            Assert.True(File.Exists(file + ".unreadable"));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}

public class ConversationTests
{
    sealed class Space : HttpMessageHandler
    {
        public readonly List<string> Bodies = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Bodies.Add(await request.Content!.ReadAsStringAsync(ct));
            var events = """
                data: {"type":"system","subtype":"init","session_id":"s1"}

                data: {"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Hi"}}}

                data: {"type":"done"}


                """;
            var res = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(events, Encoding.UTF8, "text/event-stream") };
            res.Headers.Add("x-run-id", "run-" + Bodies.Count);
            return res;
        }
    }

    [Fact]
    public async Task TheNextMessageContinuesTheSessionUntilANewConversation()
    {
        var space = new Space();
        using var client = new SpaceClient("https://space.example.com", "spd_test", space);
        var chat = new Conversation(client, new AgentInfo("space/assistant", "space", "assistant", null), () => "");
        var changes = 0;
        chat.Changed += () => changes++;
        await chat.Send("hello", []);
        Assert.Equal(["hello", "Hi"], chat.Messages.Select(m => m.Text));
        Assert.False(chat.Busy);
        Assert.False(chat.Messages[1].Live);
        Assert.DoesNotContain("sessionId", space.Bodies[0]);
        await chat.Send("again", []);
        Assert.Contains("\"sessionId\":\"s1\"", space.Bodies[1]);
        chat.Reset();
        Assert.Empty(chat.Messages);
        await chat.Send("  ", []);
        Assert.Equal(2, space.Bodies.Count);
        Assert.True(changes > 4);
    }
}
