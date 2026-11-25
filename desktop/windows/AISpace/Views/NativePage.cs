using System.Windows;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>The main window's native pages, one set per saved Space (the bar's Home, Inbox, Shortcuts, Settings and Chat).</summary>
internal enum PageKind
{
    Home,
    Inbox,
    Shortcuts,
    /// <summary>The Space's own settings (<see cref="SpaceSettingsPage"/>), not the app's (<see cref="SettingsWindow"/>).</summary>
    Settings,
    /// <summary>A native conversation with one of the Space's agents (<see cref="ChatPage"/>); the bar shows its tab while it is open.</summary>
    Chat,
}

/// <summary>
/// What a native page is given: its Space, that Space's live state and API, its icons, and the
/// window's ways of opening things. One context per Space and page; everything is looked up when
/// asked, so a page made before the first refresh sees the live state once it is there.
/// </summary>
internal sealed class PageContext(AppModel model, Guid space)
{
    public AppModel Model { get; } = model;

    /// <summary>The saved Space's id: it stays the same while the Space is saved.</summary>
    public Guid SpaceId { get; } = space;

    /// <summary>The saved Space; null once it was removed (the page is closed then).</summary>
    public Connection? Connection => Model.Store.Get(SpaceId);

    /// <summary>
    /// What the app knows of the Space, refreshed in the background every 30 seconds: its status
    /// (<see cref="LiveStatus"/>), apps, agents, the open inbox, the runs in progress and the first
    /// screen's keys. Null before the Space is known. After each refresh the page's
    /// <see cref="NativePage.LiveChanged"/> runs.
    /// </summary>
    public SpaceLive? Live => Model.Lives.TryGetValue(SpaceId, out var l) ? l : null;

    /// <summary>The Space's routes with its sign-in (the cookies of its WebView2 profile): <see cref="SpaceApi.GetJson{T}"/>, <see cref="SpaceApi.PostJson{T}"/>, ….</summary>
    public SpaceApi? Api => Connection is { } c ? Model.Api(c) : null;

    /// <summary>The Space's icons (apps, agents), fetched with its sign-in and kept.</summary>
    public IconStore Icons => Model.Icons(SpaceId);

    // Opening things. Each brings the main window forward on this Space.

    /// <summary>Another native page of this Space.</summary>
    public void Show(PageKind page) => Model.ShowPage(SpaceId, page);

    /// <summary>An app of the Space in its tab, at <paramref name="url"/> when given (else its own page).</summary>
    public void OpenApp(AppInfo app, Uri? url = null) => Model.OpenApp(app, SpaceId, url);

    /// <summary>An agent's chat (the native Chat page); <paramref name="text"/> fills the message field and is never sent.</summary>
    public void OpenChat(string? agent, string? text = null) => Model.ShowChat(SpaceId, agent, text);

    /// <summary>The Space's terminal (its xterm.js page in an in-app tab).</summary>
    public void OpenTerminal() => Model.ShowTerminal(SpaceId);

    /// <summary>The Space's App Store (its page in an in-app tab); <paramref name="pick"/> ticks every installable app, as the first-use card asks.</summary>
    public void OpenStore() => Model.ShowStore(SpaceId);

    /// <summary>The Space's web panel in its in-app tab, at <paramref name="url"/> when given (a page of the panel the app has no native copy of).</summary>
    public void OpenWebPanel(Uri? url = null) => Model.ShowWebPanel(SpaceId, url);

    /// <summary>
    /// A link from the page, as a link from a web page goes: a page of the Space opens natively or
    /// in its tab, an app's page in that app's tab, anything else in the default browser. A path
    /// (<c>/x</c>) is the Space's.
    /// </summary>
    public void OpenLink(string url)
    {
        if (Connection is { } c && Uri.TryCreate(c.Uri, url, out var u)) Model.OpenLink(u, SpaceId);
    }

    /// <summary>The default browser, for an address that is not the app's to show.</summary>
    public static void OpenInBrowser(Uri url) => AppModel.OpenOutside(url);

    /// <summary>The app's own settings window (General: notifications, Quick Chat, the floating ball…; Spaces).</summary>
    public void OpenAppSettings(int tab = 0) => Model.OpenAppSettings?.Invoke(tab);

    /// <summary>Quick Chat on <paramref name="agent"/> of this Space, <paramref name="text"/> in its field.</summary>
    public void QuickChat(string? agent, string? text = null) => Model.OpenQuickChat?.Invoke(SpaceId, agent, text);
}

/// <summary>
/// The contract of a native page of the main window. A page is made the first time it is shown
/// for its Space, with that Space's <see cref="PageContext"/>, and kept while hidden (switching
/// pages, tabs or Spaces keeps its state: scroll, search text, a half-written form) until its
/// Space is removed, changes its address or signs out, when <see cref="Close"/> runs. Pages are
/// WPF, drawn in the Fluent theme with <see cref="Ui"/>'s pieces, so they follow the system's
/// light or dark mode; their words go through <c>L.T</c>/<c>L.F</c>.
///
/// The window calls, on the UI thread:
/// <list type="bullet">
/// <item><see cref="Shown"/> when the page comes on screen (also again after the Space was switched back to);</item>
/// <item><see cref="Hidden"/> when another page, tab or Space takes its place;</item>
/// <item><see cref="LiveChanged"/> after every background refresh of the Space (shown or not; a page may only mark itself stale while hidden);</item>
/// <item><see cref="Refresh"/> when the person asks for it (F5, Reload): fetch again what the page shows;</item>
/// <item><see cref="Close"/> once, when the page is discarded: stop timers and streams.</item>
/// </list>
/// While the Space needs a sign-in the window shows the web panel's sign-in page in place of every
/// native page, and the native page again once signed in; a page need not handle that state.
/// </summary>
internal abstract class NativePage : UserControl
{
    protected NativePage(PageContext context)
    {
        Context = context;
        Focusable = false;
        Ui.Background(this);
    }

    public PageContext Context { get; }

    /// <summary>The page's name: the window's title shows it with the Space's.</summary>
    public abstract string Title { get; }

    public bool IsShown { get; private set; }

    public virtual void Shown()
    {
    }

    public virtual void Hidden()
    {
    }

    public virtual void LiveChanged()
    {
    }

    public virtual void Refresh()
    {
    }

    public virtual void Close()
    {
    }

    /// <summary>Called by the window only: keeps <see cref="IsShown"/> and calls <see cref="Shown"/>/<see cref="Hidden"/> once per change.</summary>
    internal void SetShown(bool shown)
    {
        if (shown == IsShown) return;
        IsShown = shown;
        if (shown) Shown();
        else Hidden();
    }

    /// <summary>
    /// A stub's content: the page's name, who builds it, and a way to the web panel's copy of the
    /// page meanwhile. Replaced by the real page.
    /// </summary>
    protected FrameworkElement Placeholder(string glyph, string title, SpacePageKind web)
    {
        var open = Ui.Button(L.T("Open in Web Panel"), () =>
        {
            if (Context.Connection is { } c) Context.OpenWebPanel(SpacePages.PageUrl(c.Uri, web));
        }, accent: true);
        return Ui.EmptyState(glyph, title, L.T("This page is not built into the app yet. The web panel has it."), open);
    }
}
