using AISpace.Core;

namespace AISpace.Core.Tests;

// Ported from the Mac client's tests (desktop/macos/AISpaceTests), case for case where the rule is the same.

public class ConnectionRulesTests
{
    [Fact]
    public void LoopbackHosts()
    {
        foreach (var host in new[] { "127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]" }) Assert.True(ConnectionRules.IsLoopback(host), host);
        foreach (var host in new[] { "127.example.com", "128.0.0.1", "10.0.0.1", "127.0.0", "127.0.0.256", "space.example.com", "" }) Assert.False(ConnectionRules.IsLoopback(host), host);
    }

    [Fact]
    public void DefaultsTheSchemeByHost()
    {
        Assert.Equal("http://127.0.0.1:8700/", ConnectionRules.Normalize("127.0.0.1:8700").AbsoluteUri);
        Assert.Equal("http://localhost:8700/", ConnectionRules.Normalize("localhost:8700/").AbsoluteUri);
        Assert.Equal("http://[::1]:8700/", ConnectionRules.Normalize("[::1]:8700").AbsoluteUri);
        Assert.Equal("https://space.example.com/", ConnectionRules.Normalize(" space.example.com ").AbsoluteUri);
    }

    [Fact]
    public void DropsQueryAndFragmentAndLowercasesHost()
    {
        Assert.Equal("https://space.example.com/panel", ConnectionRules.Normalize("HTTPS://Space.Example.com/panel?lang=zh#chat").AbsoluteUri);
        Assert.Equal("https://space.example.com/", ConnectionRules.Normalize("https://space.example.com:443").AbsoluteUri);
    }

    [Theory]
    [InlineData("  ", ConnectionUrlError.Empty)]
    [InlineData("http://space.example.com", ConnectionUrlError.InsecureRemote)]
    [InlineData("http://192.168.1.5:8700", ConnectionUrlError.InsecureRemote)]
    [InlineData("https://op:secret@space.example.com", ConnectionUrlError.Credentials)]
    [InlineData("file:///C:/Users/me", ConnectionUrlError.UnsupportedScheme)]
    [InlineData("ftp://space.example.com", ConnectionUrlError.UnsupportedScheme)]
    [InlineData("https://exa mple.com", ConnectionUrlError.Invalid)]
    public void RefusesUnsafeAddresses(string input, ConnectionUrlError error)
    {
        Assert.Equal(error, Assert.Throws<ConnectionUrlException>(() => ConnectionRules.Normalize(input)).Code);
    }

    [Fact]
    public void SameOriginUsesEffectivePorts()
    {
        static Uri U(string s) => new(s);
        Assert.True(ConnectionRules.SameOrigin(U("https://a.example.com/x"), U("https://A.example.com:443/")));
        Assert.True(ConnectionRules.SameOrigin(U("http://127.0.0.1:8700/api"), U("http://127.0.0.1:8700/")));
        Assert.False(ConnectionRules.SameOrigin(U("http://127.0.0.1:8700/"), U("http://127.0.0.1:8701/")));
        Assert.False(ConnectionRules.SameOrigin(U("http://a.example.com/"), U("https://a.example.com/")));
        Assert.False(ConnectionRules.SameOrigin(U("https://a.example.com/"), U("https://b.example.com/")));
    }

    [Fact]
    public void OriginsLeaveTheDefaultPortOut()
    {
        Assert.Equal("https://space.example.com", ConnectionRules.OriginHeader(new Uri("https://space.example.com:443/x?y")));
        Assert.Equal("http://127.0.0.1:8700", ConnectionRules.OriginHeader(new Uri("http://127.0.0.1:8700/")));
        Assert.Equal("http://127.0.0.1:8700/", ConnectionRules.Origin(new Uri("http://127.0.0.1:8700/api/apps")).AbsoluteUri);
    }
}

public class SpaceCheckTests
{
    [Fact]
    public void ASpaceAnswerIsReady()
    {
        Assert.Equal(SpaceState.Ready, SpaceCheck.ClassifyLayout(200, "application/json;charset=utf-8", """{"ok":true,"layout":{"order":[],"hidden":[]}}"""));
    }

    [Fact]
    public void AReachablePortAloneIsNotReady()
    {
        Assert.NotEqual(SpaceState.Ready, SpaceCheck.ClassifyLayout(200, "text/html", "<html>"));
        Assert.NotEqual(SpaceState.Ready, SpaceCheck.ClassifyLayout(200, "application/json", """{"ok":true}"""));
        Assert.Equal(SpaceState.Incompatible("HTTP 404"), SpaceCheck.ClassifyLayout(404, "text/plain", "Not Found"));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(302)]
    [InlineData(401)]
    [InlineData(403)]
    public void AccessLayerAnswersMeanSignIn(int status)
    {
        Assert.Equal(SpaceState.AuthenticationRequired, SpaceCheck.ClassifyLayout(status, "", ""));
    }

    [Fact]
    public void TheIdentitySaysWhetherThisClientCanTalkToIt()
    {
        Assert.Null(SpaceCheck.ClassifyIdentity(200, """{"product":"ai-space","api":1,"version":"0.1.0","edition":"server"}"""));
        Assert.Equal(SpaceStateKind.Incompatible, SpaceCheck.ClassifyIdentity(200, """{"product":"ai-space","api":2}""")!.Kind);
        Assert.Equal(SpaceStateKind.Incompatible, SpaceCheck.ClassifyIdentity(200, """{"product":"other","api":1}""")!.Kind);
        Assert.Equal(SpaceStateKind.Incompatible, SpaceCheck.ClassifyIdentity(404, "")!.Kind);
        Assert.Equal(SpaceState.AuthenticationRequired, SpaceCheck.ClassifyIdentity(302, ""));
        Assert.Equal(SpaceStateKind.Incompatible, SpaceCheck.ClassifyIdentity(200, "<html>")!.Kind);
    }

    [Fact]
    public void NavigationErrors()
    {
        Assert.True(SpaceCheck.ClassifyNavigationError("CannotConnect")!.IsFailure);
        Assert.True(SpaceCheck.ClassifyNavigationError("HostNameNotResolved")!.IsFailure);
        Assert.Null(SpaceCheck.ClassifyNavigationError("OperationCanceled"));
        Assert.Equal(SpaceState.AuthenticationRequired, SpaceCheck.ClassifyNavigationError("ValidAuthenticationCredentialsRequired"));
    }
}

public class NavigationPolicyTests
{
    private static readonly Uri Panel = new("https://space.example.com/");

    private static NavigationDecision Decide(string url, bool mainFrame = true, bool link = false, bool newWindow = false, bool fromPanel = true) =>
        NavigationPolicy.Decide(new NavigationRequest(new Uri(url), mainFrame, link, newWindow, fromPanel), Panel);

    [Fact]
    public void PanelPagesStayInTheWindow()
    {
        Assert.Equal(NavigationDecision.Allow, Decide("https://space.example.com/?lang=zh"));
        Assert.Equal(NavigationDecision.Allow, Decide("https://space.example.com/settings", link: true));
        Assert.Equal(NavigationDecision.Allow, Decide("about:blank"));
    }

    [Fact]
    public void LinksAndNewWindowsGoToTheBrowser()
    {
        Assert.Equal(NavigationDecision.OpenExternally, Decide("https://todo.space.example.com/", link: true));
        Assert.Equal(NavigationDecision.OpenExternally, Decide("https://github.com/ericz-lab/ai-space", newWindow: true));
        Assert.Equal(NavigationDecision.OpenExternally, Decide("https://space.example.com/apps/x", newWindow: true));
        Assert.Equal(NavigationDecision.OpenExternally, Decide("mailto:op@example.com", link: true));
    }

    [Fact]
    public void SignInRedirectsStayInTheWindow()
    {
        // The access layer redirects the main frame to its login origin, then back.
        Assert.Equal(NavigationDecision.Allow, Decide("https://team.cloudflareaccess.com/cdn-cgi/access/login"));
        // Clicks on the login page (an identity provider button) belong to the sign-in flow.
        Assert.Equal(NavigationDecision.Allow, Decide("https://accounts.example.org/o/oauth2", link: true, fromPanel: false));
    }

    [Fact]
    public void FramesLoadButNeverEscalate()
    {
        Assert.Equal(NavigationDecision.Allow, Decide("https://widget.example.net/card", mainFrame: false));
        Assert.Equal(NavigationDecision.Cancel, Decide("javascript:alert(1)", mainFrame: false));
        Assert.Equal(NavigationDecision.Cancel, Decide("x-other-app://open"));
        Assert.Equal(NavigationDecision.Cancel, Decide("file:///C:/Windows/win.ini", newWindow: true));
    }

    [Fact]
    public void OnlyWebMailAndPhoneLinksLeaveForWindows()
    {
        Assert.True(NavigationPolicy.MayOpenExternally(new Uri("https://github.com/")));
        Assert.True(NavigationPolicy.MayOpenExternally(new Uri("mailto:op@example.com")));
        Assert.False(NavigationPolicy.MayOpenExternally(new Uri("ms-settings:privacy")));
        Assert.False(NavigationPolicy.MayOpenExternally(new Uri("search-ms:query=x")));
        Assert.False(NavigationPolicy.MayOpenExternally(new Uri("file:///C:/Windows/System32/calc.exe")));
    }
}

public class MediaCapturePolicyTests
{
    private static readonly Uri Space = new("https://space.example.com/");
    private static readonly Uri App = new("https://notes.space.example.com/");

    private static bool Grants(string page, string? frame = null, Uri? home = null, MediaCaptureKind kind = MediaCaptureKind.Microphone) =>
        MediaCapturePolicy.Grants(kind, new Uri(page), new Uri(frame ?? page), home ?? App, Space);

    [Fact]
    public void TheSessionsOwnPagesGetTheMicrophone()
    {
        Assert.True(Grants("https://notes.space.example.com/"));
        Assert.True(Grants("https://notes.space.example.com:443/voice"));
        Assert.True(Grants("https://space.example.com/apps/notes/"));
        Assert.True(Grants("https://space.example.com/", home: Space));
    }

    [Fact]
    public void OtherSitesAndFramesGetNothing()
    {
        Assert.False(Grants("https://evil.example.com/"));
        Assert.False(Grants("https://notes.space.example.com/", frame: "https://evil.example.com/"));
        Assert.False(Grants("http://notes.space.example.com/"));
        Assert.False(Grants("https://todo.space.example.com/"));
        Assert.False(MediaCapturePolicy.Grants(MediaCaptureKind.Microphone, null, null, App, Space));
    }

    [Fact]
    public void TheCameraIsNeverGranted()
    {
        Assert.False(Grants("https://notes.space.example.com/", kind: MediaCaptureKind.Camera));
        Assert.False(Grants("https://notes.space.example.com/", kind: MediaCaptureKind.Other));
    }
}

public class DesktopRulesTests
{
    [Fact]
    public void OpenTabShortcutsRespectLimitAndSelection()
    {
        Assert.Empty(OpenTabLayout.Visible([], null));
        Assert.Equal(["a"], OpenTabLayout.Visible(["a"], "a"));
        string[] ids = ["a", "b", "c", "d", "e", "f", "g"];
        Assert.Equal(ids[..5], OpenTabLayout.Visible(ids[..5], "e"));
        Assert.Equal(ids[..5], OpenTabLayout.Visible(ids, null));
        Assert.Equal(["a", "b", "c", "d", "g"], OpenTabLayout.Visible(ids, "g"));
        // Closing the selected page fills the fifth slot from the remaining open pages.
        Assert.Equal(ids[..5], OpenTabLayout.Visible(ids[..^1], "g"));
        Assert.Empty(OpenTabLayout.Visible([], "closed"));
    }

    private static InboxItem Item(string thread, string lastAt, bool unread = true, bool done = false) =>
        new(thread, "todo", "info", null, "x", null, 1, lastAt, unread, done);

    [Fact]
    public void FirstLookOnlyRecords()
    {
        var seen = new InboxSeen();
        Assert.Empty(seen.Fresh([Item("a", "1"), Item("b", "1")]));
        Assert.Equal(["b", "c"], seen.Fresh([Item("a", "1"), Item("b", "2"), Item("c", "1"), Item("d", "1", unread: false)]).Select(i => i.Thread));
        Assert.Empty(seen.Fresh([Item("a", "1"), Item("b", "2")]));
        Assert.Empty(seen.Fresh([Item("e", "1", done: true)]));
    }

    private static readonly Uri Space = new("https://space.example.com/");

    private static AppInfo App(string name, string url) => new(name, name, name, null, null, null, null, url, null, false);

    [Fact]
    public void LinksFindTheirApp()
    {
        var apps = new[] { App("todo", "https://todo.example.com/?lang={lang}"), App("notes", "/apps/notes/"), App("none", "") };
        Assert.Equal("todo", AppRoutes.AppFor(new Uri("https://todo.example.com/task/3"), apps, Space)?.Name);
        Assert.Equal("notes", AppRoutes.AppFor(new Uri("https://space.example.com/apps/notes/x"), apps, Space)?.Name);
        Assert.Null(AppRoutes.AppFor(new Uri("https://space.example.com/settings"), apps, Space));
        Assert.Null(AppRoutes.AppFor(new Uri("https://github.com/x"), apps, Space));
        Assert.Equal("https://todo.example.com/?lang=zh", apps[0].PageUrl(Space, "zh")?.AbsoluteUri);
        Assert.Null(apps[2].PageUrl(Space));
    }

    [Fact]
    public void DeepLinksNeverSend()
    {
        Assert.Equal(new DeepLink.Chat("ai-todo/planner", "hi there"), DeepLink.Parse("aispace://chat?agent=ai-todo/planner&text=hi+there"));
        Assert.Equal(new DeepLink.Chat(null, null), DeepLink.Parse("aispace://chat"));
        Assert.Equal(new DeepLink.Open("ai-todo"), DeepLink.Parse("aispace://open?app=ai-todo"));
        Assert.Equal(new DeepLink.Open("ai-todo"), DeepLink.Parse("AISPACE:open?app=ai-todo"));
        Assert.Null(DeepLink.Parse("aispace://open"));
        Assert.IsType<DeepLink.ShowInbox>(DeepLink.Parse("aispace://inbox"));
        Assert.IsType<DeepLink.Show>(DeepLink.Parse("aispace://"));
        Assert.Null(DeepLink.Parse("aispace://run?cmd=rm"));
        Assert.Null(DeepLink.Parse("https://chat"));
        var longText = DeepLink.Parse("aispace://chat?text=" + new string('a', 30_000)) as DeepLink.Chat;
        Assert.Equal(20_000, longText!.Text!.Length);
    }

    [Fact]
    public void PanelLinksOpenThePanelsOwnWindows()
    {
        var panel = new Uri("https://space.example.com/");
        Assert.Equal("https://space.example.com/#inbox", PanelLink.Inbox(panel).AbsoluteUri);
        Assert.Equal("https://space.example.com/#chat", PanelLink.Chat(panel, null).AbsoluteUri);
        Assert.Equal("https://space.example.com/#chat=ai-todo%2Fplanner&text=hi%20there", PanelLink.Chat(panel, "ai-todo/planner", "hi there").AbsoluteUri);
        Assert.Equal("http://127.0.0.1:8700/#terminal", PanelLink.Terminal(new Uri("http://127.0.0.1:8700/?x=1")).AbsoluteUri);
    }

    [Fact]
    public void ManifestTextFollowsTheLanguage()
    {
        var i18n = new Dictionary<string, LocalizedText> { ["zh"] = new("待办", null), ["ja-JP"] = new("やること", null) };
        Assert.Equal("待办", Lang.Pick("Todo", i18n, true, "zh"));
        Assert.Equal("やること", Lang.Pick("Todo", i18n, true, "ja"));
        Assert.Equal("Todo", Lang.Pick("Todo", i18n, true, "en"));
        Assert.Equal("Todo", Lang.Pick("Todo", null, true, "zh"));
    }
}
