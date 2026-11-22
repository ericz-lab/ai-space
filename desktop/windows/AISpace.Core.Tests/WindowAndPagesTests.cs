using System.Net;
using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

public class WindowPlacementTests
{
    // The laptop the window first opened on: 1280 × 800 at 150 %, a 48 high taskbar.
    private static readonly ScreenRect Laptop = new(0, 0, 1280, 752);
    private static readonly ScreenRect Right = new(1280, 0, 1920, 1040);

    [Fact]
    public void ANewWindowIsNoLargerThanItsWorkAreaAndCentredOnIt()
    {
        Assert.Equal(new ScreenRect(0, 0, 1280, 752), WindowPlacement.Centered(1280, 820, Laptop));
        Assert.Equal(new ScreenRect(260, 76, 760, 600), WindowPlacement.Centered(760, 600, Laptop));
    }

    [Fact]
    public void ASavedPlaceAboveTheScreenComesBackWithItsTitleBarOnIt()
    {
        // The place the first launch saved: centred at Top = -34, taller than the work area.
        var fit = WindowPlacement.Fit(new ScreenRect(0, -34, 1280, 817.33), [Laptop], 640, 420);
        Assert.Equal(new ScreenRect(0, 0, 1280, 752), fit);
        Assert.True(WindowPlacement.IsOnScreen(fit, [Laptop]));
        Assert.False(WindowPlacement.IsOnScreen(new ScreenRect(0, -34, 1280, 817.33), [Laptop]));
    }

    [Fact]
    public void APlaceOnTheScreenStaysAsItIs()
    {
        var place = new ScreenRect(100, 50, 900, 600);
        Assert.Equal(place, WindowPlacement.Fit(place, [Laptop, Right], 640, 420));
        var there = new ScreenRect(1400, 100, 1200, 800);
        Assert.Equal(there, WindowPlacement.Fit(there, [Laptop, Right], 640, 420));
    }

    [Fact]
    public void AWindowAcrossTwoMonitorsMovesOntoTheOneItCoversMost()
    {
        var fit = WindowPlacement.Fit(new ScreenRect(1000, 100, 1000, 600), [Laptop, Right]);
        Assert.Equal(new ScreenRect(1280, 100, 1000, 600), fit);
        var left = WindowPlacement.Fit(new ScreenRect(800, 700, 1000, 600), [Laptop, Right]);
        Assert.Equal(Right, WindowPlacement.AreaFor(new ScreenRect(800, 700, 1000, 600), [Laptop, Right]));
        Assert.True(WindowPlacement.IsOnScreen(left, [Laptop, Right]));
    }

    [Fact]
    public void AWindowOnAMonitorThatIsGoneComesToTheNearestOne()
    {
        var fit = WindowPlacement.Fit(new ScreenRect(-2000, 200, 800, 500), [Laptop, Right]);
        Assert.Equal(new ScreenRect(0, 200, 800, 500), fit);
        var below = WindowPlacement.Fit(new ScreenRect(2000, 3000, 800, 500), [Laptop, Right]);
        Assert.Equal(new ScreenRect(2000, 540, 800, 500), below);
    }

    [Fact]
    public void AWindowSmallerThanItsMinimumGrowsUnlessTheScreenIsSmaller()
    {
        Assert.Equal(new ScreenRect(10, 10, 640, 420), WindowPlacement.Fit(new ScreenRect(10, 10, 100, 100), [Laptop], 640, 420));
        Assert.Equal(new ScreenRect(0, 0, 600, 400), WindowPlacement.Fit(new ScreenRect(0, 0, 100, 100), [new ScreenRect(0, 0, 600, 400)], 640, 420));
        var none = new ScreenRect(5, 5, 10, 10);
        Assert.Equal(none, WindowPlacement.Fit(none, []));
    }
}

public class SpacePagesTests
{
    private static readonly Uri Space = new("http://127.0.0.1:8700/");

    private static SpacePage? Of(string url) => SpacePages.Of(new Uri(url), Space);

    [Fact]
    public void TheBuiltInPagesAreTheSpacesOwn()
    {
        Assert.Equal(new SpacePage(SpacePageKind.Inbox), Of("http://127.0.0.1:8700/?page=inbox"));
        Assert.Equal(new SpacePage(SpacePageKind.Shortcuts), Of("http://127.0.0.1:8700/?page=shortcuts"));
        Assert.Equal(new SpacePage(SpacePageKind.Terminal), Of("http://127.0.0.1:8700/?lang=zh&page=terminal"));
        Assert.Equal(new SpacePage(SpacePageKind.Settings), Of("http://127.0.0.1:8700/index.html?page=settings"));
        Assert.Equal(new SpacePage(SpacePageKind.Home), Of("http://127.0.0.1:8700/"));
        Assert.Equal(new SpacePage(SpacePageKind.Home), Of("http://127.0.0.1:8700"));
        Assert.Equal(new SpacePage(SpacePageKind.Home), Of("http://127.0.0.1:8700/?page=tasks"));
    }

    [Fact]
    public void AChatPageNamesItsAgentAndSession()
    {
        Assert.Equal(new SpacePage(SpacePageKind.Chat, "space/assistant", "s1"), Of("http://127.0.0.1:8700/?page=chat&agent=space%2Fassistant&session=s1"));
        Assert.Equal(new SpacePage(SpacePageKind.Chat), Of("http://127.0.0.1:8700/?page=chat&agent="));
    }

    [Fact]
    public void FragmentLinksAsThePanelReadsThem()
    {
        Assert.Equal(new SpacePage(SpacePageKind.Inbox), Of("http://127.0.0.1:8700/#inbox"));
        Assert.Equal(new SpacePage(SpacePageKind.Terminal), Of("http://127.0.0.1:8700/#terminal"));
        Assert.Equal(new SpacePage(SpacePageKind.Chat, "ai-todo/planner", Text: "hello world"), Of("http://127.0.0.1:8700/#chat=ai-todo%2Fplanner&text=hello%20world"));
        Assert.Equal(new SpacePage(SpacePageKind.Chat), Of("http://127.0.0.1:8700/#chat"));
        // A window's key takes no value; an unknown fragment is the panel's own business.
        Assert.Equal(new SpacePage(SpacePageKind.Home), Of("http://127.0.0.1:8700/#inbox=x"));
        Assert.Equal(new SpacePage(SpacePageKind.Home), Of("http://127.0.0.1:8700/#top"));
    }

    [Fact]
    public void OtherAddressesAreNotPagesOfTheSpace()
    {
        Assert.Null(Of("http://127.0.0.1:8700/_space/apps/ai-todo?page=inbox"));
        Assert.Null(Of("http://127.0.0.1:8700/api/inbox"));
        Assert.Null(Of("http://localhost:8700/?page=inbox"));
        Assert.Null(Of("https://127.0.0.1:8700/?page=inbox"));
        Assert.Null(Of("https://evil.example.com/?page=inbox"));
        Assert.Null(SpacePages.Of(new Uri("mailto:a@b.c"), Space));
    }

    [Fact]
    public void APanelUnderAPathOwnsOnlyThatPath()
    {
        var space = new Uri("https://example.com/space/");
        Assert.Equal(new SpacePage(SpacePageKind.Inbox), SpacePages.Of(new Uri("https://example.com/space/?page=inbox"), space));
        Assert.Equal(new SpacePage(SpacePageKind.Inbox), SpacePages.Of(new Uri("https://example.com/space?page=inbox"), space));
        Assert.Null(SpacePages.Of(new Uri("https://example.com/?page=inbox"), space));
        Assert.Equal("https://example.com/space/?page=terminal", SpacePages.PageUrl(new Uri("https://example.com/space"), SpacePageKind.Terminal).AbsoluteUri);
    }

    [Fact]
    public void ATabOfOnePageHandsTheOthersToTheWindow()
    {
        Assert.True(SpacePages.LeavesTab(new Uri("http://127.0.0.1:8700/"), Space, SpacePageKind.Terminal));
        Assert.True(SpacePages.LeavesTab(new Uri("http://127.0.0.1:8700/?page=inbox"), Space, SpacePageKind.Chat));
        Assert.False(SpacePages.LeavesTab(new Uri("http://127.0.0.1:8700/?page=terminal"), Space, SpacePageKind.Terminal));
        Assert.False(SpacePages.LeavesTab(new Uri("http://127.0.0.1:8700/?page=chat&agent=b"), Space, SpacePageKind.Chat));
        Assert.False(SpacePages.LeavesTab(new Uri("http://127.0.0.1:8700/api/terminal"), Space, SpacePageKind.Terminal));
        Assert.False(SpacePages.LeavesTab(new Uri("https://login.example.com/"), Space, SpacePageKind.Terminal));
    }

    [Fact]
    public void PageAddresses()
    {
        Assert.Equal("http://127.0.0.1:8700/?page=terminal", SpacePages.PageUrl(Space, SpacePageKind.Terminal).AbsoluteUri);
        Assert.Equal("http://127.0.0.1:8700/?page=settings", SpacePages.PageUrl(Space, SpacePageKind.Settings).AbsoluteUri);
        Assert.Equal("http://127.0.0.1:8700/", SpacePages.PageUrl(Space, SpacePageKind.Home).AbsoluteUri);
        Assert.Equal("http://127.0.0.1:8700/?page=chat", SpacePages.PageUrl(Space, SpacePageKind.Chat).AbsoluteUri);
        Assert.Equal("http://127.0.0.1:8700/?page=chat&agent=space%2Fassistant", SpacePages.ChatUrl(Space, "space/assistant").AbsoluteUri);
        var draft = SpacePages.ChatUrl(Space, "space/assistant", "a b&c");
        Assert.Equal("http://127.0.0.1:8700/?page=chat&agent=space%2Fassistant#chat=space%2Fassistant&text=a%20b%26c", draft.AbsoluteUri);
        // Read back, the address is the same chat with the same draft.
        Assert.Equal(new SpacePage(SpacePageKind.Chat, "space/assistant", Text: "a b&c"), SpacePages.Of(new Uri(draft.GetLeftPart(UriPartial.Path) + draft.Fragment), Space));
        Assert.Equal(new SpacePage(SpacePageKind.Chat, "x", "s"), SpacePages.Of(SpacePages.ChatUrl(Space, "x", session: "s"), Space));
    }
}

public class SpaceApiJsonTests
{
    private sealed record Thing(string Name, int Count, string? Missing);

    [Fact]
    public async Task ReadsAndWritesCamelCaseJson()
    {
        HttpRequestMessage? sent = null;
        string? body = null;
        var handler = new ScriptedHandler(r =>
        {
            sent = r;
            body = r.Content?.ReadAsStringAsync().Result;
            return ScriptedHandler.Json("""{"name":"x","count":2}""");
        });
        var api = new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>("s=1"), handler);
        var thing = await api.GetJson<Thing>("/api/thing");
        Assert.Equal(new Thing("x", 2, null), thing);
        Assert.Equal("s=1", sent!.Headers.GetValues("Cookie").Single());

        var answer = await api.PostJson<JsonElement>("/api/thing", new Thing("y", 3, null));
        Assert.Equal(HttpMethod.Post, sent!.Method);
        Assert.Equal("""{"name":"y","count":3}""", body);
        Assert.Equal("https://space.example.com", sent.Headers.GetValues("Origin").Single());
        Assert.Equal(2, answer.GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task FailuresAreSpaceApiExceptions()
    {
        var signIn = new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>(null), new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized)));
        Assert.Equal(SpaceApiFailure.AuthenticationRequired, (await Assert.ThrowsAsync<SpaceApiException>(() => signIn.GetJson<JsonElement>("/api/x"))).Kind);
        var html = new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>(null), new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("<html>") }));
        Assert.Equal(SpaceApiFailure.InvalidResponse, (await Assert.ThrowsAsync<SpaceApiException>(() => html.GetJson<JsonElement>("/api/x"))).Kind);
        var refused = new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>(null), new ScriptedHandler(_ => new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("""{"error":"no such thing"}""") }));
        var e = await Assert.ThrowsAsync<SpaceApiException>(() => refused.SendJson<JsonElement>(HttpMethod.Put, "/api/x", new { a = 1 }));
        Assert.Equal((SpaceApiFailure.Http, "no such thing", 400), (e.Kind, e.Message, e.Status));
    }
}
