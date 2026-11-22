using System.Diagnostics;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;
using AISpace.Views;
using AISpace.Web;
using Microsoft.Win32;

namespace AISpace;

/// <summary>What a web tab of the main window shows.</summary>
internal enum WebTabKind
{
    /// <summary>An app of the Space, at its own page.</summary>
    App,
    /// <summary>The Space's terminal page (<c>/?page=terminal</c>).</summary>
    Terminal,
    /// <summary>The Space's chat page (<c>/?page=chat&amp;agent=…</c>).</summary>
    Chat,
    /// <summary>The web panel itself, for what has no native page yet and for signing in.</summary>
    Panel,
    /// <summary>The Space's App Store page (<c>/?page=store</c>).</summary>
    Store,
}

/// <summary>
/// A web tab of the main window: an app of the Space, or one of the Space's own pages (terminal,
/// chat, the App Store, the web panel). <see cref="Key"/> names it among the Space's tabs: <c>app:&lt;id&gt;</c>,
/// <c>terminal</c>, <c>chat</c>, <c>store</c>, <c>panel</c>.
/// </summary>
internal sealed record WebTab(string Key, WebTabKind Kind, AppInfo? App, PanelView View)
{
    public static string AppKey(string app) => "app:" + app;

    public string Title => Kind switch
    {
        WebTabKind.App => App!.DisplayTitle(),
        WebTabKind.Terminal => L.T("Terminal"),
        WebTabKind.Panel => L.T("Web Panel"),
        WebTabKind.Store => L.T("App Store"),
        _ => View.PageTitle is { Length: > 0 } t ? t.Replace(" · ai-space", "", StringComparison.Ordinal) : L.T("Chat"),
    };
}

/// <summary>
/// What the windows show and do, apart from how they draw it (the Mac's <c>AppModel</c>): the saved
/// Spaces, the one selected, each Space's native pages and web tabs, the background refresh of
/// every Space for the inbox and the notification area, and where links go. Runs on the UI thread.
///
/// The main window shows, for the selected Space, either one of its native pages
/// (<see cref="SelectedPage"/>: Home, Inbox, Shortcuts, Settings) or one of its web tabs
/// (<see cref="SelectedTab"/>). While the Space needs a sign-in, its web panel (where the sign-in
/// page appears) stands in for every native page, until the panel has signed in.
/// </summary>
internal sealed class AppModel
{
    public static readonly string Version = typeof(AppModel).Assembly.GetName().Version?.ToString(3) ?? "0";

    private readonly Dispatcher _ui;
    private readonly FileSeenStore _seen;
    private readonly Dictionary<Guid, PanelView> _panels = [];
    private readonly Dictionary<Guid, List<WebTab>> _tabs = [];
    private readonly Dictionary<Guid, Dictionary<PageKind, NativePage>> _pages = [];
    private readonly Dictionary<Guid, SpaceApi> _apis = [];
    private readonly Dictionary<Guid, IconStore> _icons = [];

    public AppModel(Dispatcher ui, AppPaths paths)
    {
        _ui = ui;
        Paths = paths;
        Store = new ConnectionStore(paths.Connections);
        Prefs = Preferences.Load(paths.Preferences);
        Web = new WebProfiles(paths.WebData);
        _seen = new FileSeenStore(paths.InboxSeen);
        ThisComputer = new ThisComputerSetup(this);
        Selected = Prefs.Selected is { } s && Store.Get(s) is not null ? s : Store.Default?.Id;
        Store.Changed += SyncLives;
        SystemEvents.PowerModeChanged += (_, e) =>
        {
            if (e.Mode == PowerModes.Resume) _ui.BeginInvoke(Resumed);
        };
    }

    public AppPaths Paths { get; }
    public ConnectionStore Store { get; }
    public Preferences Prefs { get; }
    public WebProfiles Web { get; }
    public ThisComputerSetup ThisComputer { get; }
    public Dictionary<Guid, SpaceLive> Lives { get; } = [];

    /// <summary>Set by the app: posts new inbox threads as Windows notifications.</summary>
    public Action<IReadOnlyList<InboxItem>, Connection, bool>? PostNotifications { get; set; }

    /// <summary>Set by the app: opens its own settings window on a tab (0 General, 1 Spaces).</summary>
    public Action<int>? OpenAppSettings { get; set; }

    /// <summary>Set by the app: Quick Chat on a Space's agent, with a draft.</summary>
    public Action<Guid?, string?, string?>? OpenQuickChat { get; set; }

    public Guid? Selected { get; private set; }
    /// <summary>The native page the main window shows while no web tab is selected.</summary>
    public PageKind SelectedPage { get; private set; } = PageKind.Home;
    /// <summary>The web tab the main window shows (<see cref="WebTab.Key"/>); null for the native page.</summary>
    public string? SelectedTab { get; private set; }
    public Connection? SelectedConnection => Selected is { } id ? Store.Get(id) : null;
    public SpaceLive? SelectedLive => Selected is { } id && Lives.TryGetValue(id, out var l) ? l : null;
    public int Unread => Lives.Values.Sum(l => l.Summary.Unread);

    /// <summary>Anything the windows show changed.</summary>
    public event Action? Changed;
    /// <summary>The main window should come forward.</summary>
    public event Action? ShowWindowRequested;
    /// <summary>The overlay's or a menu's "Edit Space": the window opens the form for it.</summary>
    public event Action<Guid>? EditRequested;

    public void Start()
    {
        SyncLives();
        ThisComputer.Start();
    }

    public void SavePrefs() => Prefs.Save(Paths.Preferences);

    public void NotifyChanged() => Changed?.Invoke();

    // Native calls

    /// <summary>The Space's routes with its profile's cookies, read on the UI thread where WebView2 wants them.</summary>
    public SpaceApi Api(Connection c)
    {
        if (_apis.TryGetValue(c.Id, out var api) && ConnectionRules.SameOrigin(api.Base, c.Uri)) return api;
        var id = c.Id;
        api = new SpaceApi(c.Uri, url => _ui.InvokeAsync(() => Web.CookieHeader(id, url)).Task.Unwrap(), userAgent: $"ai-space-windows/{Version}");
        _apis[c.Id] = api;
        return api;
    }

    /// <summary>The Space's icons, fetched with its sign-in, kept for the app's run.</summary>
    public IconStore Icons(Guid connection)
    {
        if (_icons.TryGetValue(connection, out var store)) return store;
        store = new IconStore(() => Store.Get(connection) is { } c ? Api(c) : null);
        _icons[connection] = store;
        return store;
    }

    // Native pages

    /// <summary>The Space's native page, made on first use and kept until the Space is discarded.</summary>
    public NativePage Page(Connection c, PageKind kind)
    {
        if (!_pages.TryGetValue(c.Id, out var pages)) _pages[c.Id] = pages = [];
        if (pages.TryGetValue(kind, out var page)) return page;
        var context = new PageContext(this, c.Id);
        page = kind switch
        {
            PageKind.Home => new HomePage(context),
            PageKind.Inbox => new InboxPage(context),
            PageKind.Shortcuts => new ShortcutsPage(context),
            _ => new SpaceSettingsPage(context),
        };
        pages[kind] = page;
        return page;
    }

    /// <summary>Every native page made so far, of every Space.</summary>
    public IEnumerable<NativePage> Pages() => _pages.Values.SelectMany(p => p.Values);

    /// <summary>
    /// The native page the main window shows now; null when a web tab is shown, when the Space
    /// needs a sign-in (its panel is shown instead) or without a Space.
    /// </summary>
    public NativePage? ShownPage() => SelectedConnection is { } c && ShownView() is null ? Page(c, SelectedPage) : null;

    /// <summary>Whether the Space's native pages wait for a sign-in on its web panel.</summary>
    public bool NeedsSignIn(Guid connection) => Lives.TryGetValue(connection, out var l) && l.Status == LiveStatus.SignInNeeded;

    // Web pages

    public PanelView NewView(Connection c, Uri home, bool verifiesSpace, string? app)
    {
        var id = c.Id;
        var view = new PanelView(Web, c, home, verifiesSpace, app)
        {
            OpenLink = url => OpenLink(url, id),
            CheckSpace = ct => Store.Get(id) is { } current ? Api(current).CheckSpace(ct) : Task.FromResult(SpaceState.Unreachable("")),
            EditConnection = () => EditRequested?.Invoke(id),
        };
        view.StateChanged += OnViewState;
        view.Changed += _ => Changed?.Invoke();
        return view;
    }

    /// <summary>The Space's web panel, made and loaded on first use: the Web Panel tab, and the sign-in page while one is needed.</summary>
    public PanelView Panel(Connection c)
    {
        if (_panels.TryGetValue(c.Id, out var p) && !p.IsDisposed && ConnectionRules.SameOrigin(p.Home, c.Uri)) return p;
        p?.Close();
        p = NewView(c, c.Uri, verifiesSpace: true, app: null);
        _panels[c.Id] = p;
        p.Load();
        return p;
    }

    public IReadOnlyList<WebTab> Tabs(Guid connection) => _tabs.TryGetValue(connection, out var t) ? t : [];

    /// <summary>Every web page the main window holds, of every Space.</summary>
    public IEnumerable<PanelView> Views() => _panels.Values.Concat(_tabs.Values.SelectMany(t => t.Select(x => x.View))).Distinct().Where(v => !v.IsDisposed);

    /// <summary>The web page the main window shows now: the selected tab, or the panel while the Space needs a sign-in; null for a native page.</summary>
    public PanelView? ShownView()
    {
        if (SelectedConnection is not { } c) return null;
        if (SelectedTab is { } key && Tabs(c.Id).FirstOrDefault(t => t.Key == key) is { } tab) return tab.View;
        return NeedsSignIn(c.Id) ? Panel(c) : null;
    }

    /// <summary>The selected web tab; null when a native page (or the sign-in) is shown.</summary>
    public WebTab? ShownTab() => SelectedConnection is { } c && SelectedTab is { } key ? Tabs(c.Id).FirstOrDefault(t => t.Key == key) : null;

    private void OnViewState(PanelView view, SpaceState state)
    {
        if (Store.Get(view.Connection.Id) is not { } c) return;
        // Signed in on the panel (or it answers again): the native pages come back once the live state agrees.
        if (state.Kind == SpaceStateKind.Ready && view.VerifiesSpace && Lives.TryGetValue(c.Id, out var live) && live.Status != LiveStatus.Ok)
        {
            _icons.GetValueOrDefault(c.Id)?.Clear();
            _ = live.Refresh(catalogue: true);
        }
    }

    // The main window's place

    /// <summary>Shows another Space, on its Home.</summary>
    public void Select(Guid id)
    {
        if (Store.Get(id) is null) return;
        Selected = id;
        SelectedTab = null;
        SelectedPage = PageKind.Home;
        Prefs.Selected = id;
        SavePrefs();
        Changed?.Invoke();
    }

    public void ShowMainWindow(Guid? connection = null)
    {
        if (connection is { } id && Store.Get(id) is not null && id != Selected)
        {
            Selected = id;
            Prefs.Selected = id;
            SavePrefs();
        }
        Changed?.Invoke();
        ShowWindowRequested?.Invoke();
    }

    /// <summary>The Space to act on: the one named, else the one shown, else the default.</summary>
    private Connection? Target(Guid? connection) => (connection is { } id ? Store.Get(id) : null) ?? SelectedConnection ?? Store.Default;

    /// <summary>A native page of a Space (the one shown when null).</summary>
    public void ShowPage(Guid? connection, PageKind page)
    {
        if (Target(connection) is not { } c)
        {
            ShowMainWindow();
            return;
        }
        Selected = c.Id;
        SelectedTab = null;
        SelectedPage = page;
        ShowMainWindow(c.Id);
    }

    /// <summary>A web tab of a Space by its key.</summary>
    public void ShowTab(Guid connection, string key)
    {
        Selected = connection;
        SelectedTab = key;
        ShowMainWindow(connection);
    }

    public void ShowInbox(Guid? connection = null) => ShowPage(connection, PageKind.Inbox);

    /// <summary>
    /// The web tab of one of the Space's own pages, made (at <paramref name="url"/>) or moved there;
    /// with <paramref name="keepPage"/> a tab that is already open is shown as it is.
    /// </summary>
    private void ShowSpaceTab(Connection c, WebTabKind kind, Uri url, bool keepPage = false)
    {
        var key = kind.ToString().ToLowerInvariant();
        if (!_tabs.TryGetValue(c.Id, out var tabs)) _tabs[c.Id] = tabs = [];
        var tab = tabs.FirstOrDefault(t => t.Key == key);
        if (tab is null || tab.View.IsDisposed)
        {
            if (tab is not null) tabs.Remove(tab);
            var view = kind == WebTabKind.Panel ? Panel(c) : NewView(c, url, verifiesSpace: false, app: null);
            if (kind != WebTabKind.Panel)
            {
                var own = kind switch
                {
                    WebTabKind.Terminal => SpacePageKind.Terminal,
                    WebTabKind.Store => SpacePageKind.Store,
                    _ => SpacePageKind.Chat,
                };
                view.Leaves = u => SpacePages.LeavesTab(u, c.Uri, own);
            }
            tab = new WebTab(key, kind, null, view);
            tabs.Add(tab);
            if (kind != WebTabKind.Panel) view.Load();
            else if (view.Current != url && url != c.Uri) view.Navigate(url);
        }
        else if (!keepPage && tab.View.Current != url && (kind != WebTabKind.Panel || url != c.Uri))
        {
            tab.View.Navigate(url);
        }
        ShowTab(c.Id, key);
    }

    /// <summary>An agent's chat in the Space's chat tab (its chat page); the text fills the message field and is never sent.</summary>
    public void ShowChat(Guid? connection = null, string? agent = null, string? text = null)
    {
        if (Target(connection) is not { } c)
        {
            ShowMainWindow();
            return;
        }
        ShowSpaceTab(c, WebTabKind.Chat, SpacePages.ChatUrl(c.Uri, agent, text));
    }

    /// <summary>The Space's terminal in its tab.</summary>
    public void ShowTerminal(Guid? connection = null)
    {
        if (Target(connection) is not { } c)
        {
            ShowMainWindow();
            return;
        }
        ShowSpaceTab(c, WebTabKind.Terminal, SpacePages.PageUrl(c.Uri, SpacePageKind.Terminal));
    }

    /// <summary>
    /// The Space's App Store in its tab; <paramref name="pick"/> opens it as the first-use card does,
    /// with every installable app ticked. What is installed there the page pins to the panel's home
    /// screen, and Home takes it from there (<see cref="HomeScreens.FollowPanel"/>).
    /// </summary>
    public void ShowStore(Guid? connection = null, bool pick = false)
    {
        if (Target(connection) is not { } c)
        {
            ShowMainWindow();
            return;
        }
        // An open store keeps its page (an install may be running there) unless the card asks for its ticks.
        ShowSpaceTab(c, WebTabKind.Store, SpacePages.StoreUrl(c.Uri, pick), keepPage: !pick);
    }

    /// <summary>The Space's web panel in its tab, at <paramref name="url"/> (one of its pages) when given.</summary>
    public void ShowWebPanel(Guid? connection = null, Uri? url = null)
    {
        if (Target(connection) is not { } c)
        {
            ShowMainWindow();
            return;
        }
        ShowSpaceTab(c, WebTabKind.Panel, url ?? c.Uri);
    }

    /// <summary>One of the Space's own pages (<see cref="SpacePages"/>): natively where the app has the page, else in its tab.</summary>
    public void ShowSpacePage(Guid connection, SpacePage page)
    {
        if (Store.Get(connection) is not { } c) return;
        switch (page.Kind)
        {
            case SpacePageKind.Home:
                ShowPage(connection, PageKind.Home);
                break;
            case SpacePageKind.Inbox:
                ShowPage(connection, PageKind.Inbox);
                break;
            case SpacePageKind.Shortcuts:
                ShowPage(connection, PageKind.Shortcuts);
                break;
            case SpacePageKind.Settings:
                ShowPage(connection, PageKind.Settings);
                break;
            case SpacePageKind.Terminal:
                ShowTerminal(connection);
                break;
            case SpacePageKind.Store:
                ShowStore(connection);
                break;
            default:
                // The chat page on the linked agent and session; a fragment link's text becomes its draft.
                ShowSpaceTab(c, WebTabKind.Chat, SpacePages.ChatUrl(c.Uri, page.Agent, page.Text, page.Session));
                break;
        }
    }

    // Apps and links

    /// <summary>Opens an app as a tab of the main window, loading <paramref name="url"/> in it when given.</summary>
    public void OpenApp(AppInfo app, Guid connection, Uri? url = null)
    {
        if (Store.Get(connection) is not { } c) return;
        if (!_tabs.TryGetValue(connection, out var tabs)) _tabs[connection] = tabs = [];
        var key = WebTab.AppKey(app.Id);
        var tab = tabs.FirstOrDefault(t => t.Key == key);
        if (tab is null)
        {
            var home = url ?? app.PageUrl(c.Uri);
            if (home is null) return;
            tab = new WebTab(key, WebTabKind.App, app, NewView(c, home, verifiesSpace: false, app.Id));
            tabs.Add(tab);
            tab.View.Load();
        }
        else if (url is not null && tab.View.Current != url)
        {
            tab.View.Navigate(url);
        }
        ShowTab(connection, key);
    }

    public void CloseTab(Guid connection, string key)
    {
        if (!_tabs.TryGetValue(connection, out var tabs)) return;
        var i = tabs.FindIndex(t => t.Key == key);
        if (i < 0) return;
        // The panel stays loaded: it is also where the Space signs in.
        if (tabs[i].Kind != WebTabKind.Panel) tabs[i].View.Close();
        tabs.RemoveAt(i);
        if (Selected == connection && SelectedTab == key) SelectedTab = tabs.Count == 0 ? null : tabs[Math.Min(i, tabs.Count - 1)].Key;
        Changed?.Invoke();
    }

    /// <summary>
    /// A link leaving a page (or opening a new window), or one a native page follows: a page of the
    /// Space never leaves the app (<see cref="SpacePages"/>), an app's opens as its tab, anything
    /// else in the browser.
    /// </summary>
    public void OpenLink(Uri url, Guid connection)
    {
        if (Store.Get(connection) is { } c)
        {
            if (SpacePages.Of(url, c.Uri) is { } page)
            {
                ShowSpacePage(connection, page);
                return;
            }
            if (Lives.TryGetValue(connection, out var live) && AppRoutes.AppFor(url, live.Apps, c.Uri) is { } app)
            {
                OpenApp(app, connection, url);
                return;
            }
        }
        OpenOutside(url);
    }

    public static void OpenOutside(Uri url)
    {
        if (!NavigationPolicy.MayOpenExternally(url)) return;
        try
        {
            Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Log.Write($"open {url}: {e.Message}");
        }
    }

    public void OpenInboxItem(Guid connection, string? url)
    {
        if (Store.Get(connection) is not { } c) return;
        if (!string.IsNullOrEmpty(url) && Uri.TryCreate(c.Uri, url, out var target) && ConnectionRules.IsWeb(target))
        {
            OpenLink(target, connection);
            ShowWindowRequested?.Invoke();
        }
        else
        {
            ShowInbox(connection);
        }
    }

    /// <summary>An <c>aispace:</c> link from another program.</summary>
    public void Handle(DeepLink link, Action<string?, string?> quickChat)
    {
        switch (link)
        {
            case DeepLink.Chat chat:
                quickChat(chat.Agent, chat.Text);
                break;
            case DeepLink.Open open:
                if ((SelectedConnection ?? Store.Default) is { } c && Lives.TryGetValue(c.Id, out var live) && live.App(open.App) is { } app) OpenApp(app, c.Id);
                else ShowMainWindow();
                break;
            case DeepLink.ShowInbox:
                ShowInbox();
                break;
            default:
                ShowMainWindow();
                break;
        }
    }

    // Saved Spaces

    public Connection Add(string name, Uri url)
    {
        var c = Store.Add(name, url);
        ShowPage(c.Id, PageKind.Home);
        return c;
    }

    /// <summary>A new address starts fresh pages; the old ones' unsent text is gone, which the form says.</summary>
    public void Update(Guid id, string name, Uri url)
    {
        if (Store.Update(id, name, url)) Discard(id);
        Changed?.Invoke();
    }

    /// <summary>Forgets the Space on this computer. The Space itself, its agents and its data are untouched.</summary>
    public async Task Remove(Guid id, bool clearSignIn)
    {
        Discard(id);
        _seen.Forget(id);
        _apis.Remove(id);
        Store.Remove(id);
        if (Selected == id) Selected = Store.Default?.Id;
        Changed?.Invoke();
        await Web.Forget(id, clearSignIn);
    }

    /// <summary>Ends the Space's session on this computer: cookies and all other site data of its profile, and its open pages.</summary>
    public async Task SignOut(Guid id)
    {
        Discard(id, keepLive: true);
        if (Selected == id)
        {
            SelectedTab = null;
            SelectedPage = PageKind.Home;
        }
        Changed?.Invoke();
        await Web.Clear(id);
        if (Lives.TryGetValue(id, out var live)) await live.Refresh(catalogue: true);
    }

    public void SetDefault(Guid id) => Store.SetDefault(id);

    /// <summary>The AI Space found on this computer: saved as This Computer unless a saved Space already has its address, and shown.</summary>
    public Connection AdoptThisComputer(Uri url)
    {
        var c = Store.Connections.FirstOrDefault(s => ConnectionRules.SameOrigin(s.Uri, url)) ?? Store.Add(L.T("This Computer"), url, makeDefault: true);
        Select(c.Id);
        return c;
    }

    private void Discard(Guid id, bool keepLive = false)
    {
        if (_panels.Remove(id, out var p)) p.Close();
        if (_tabs.Remove(id, out var tabs)) tabs.ForEach(t => t.View.Close());
        if (_pages.Remove(id, out var pages))
        {
            foreach (var page in pages.Values) page.Close();
        }
        if (_icons.Remove(id, out var icons)) icons.Clear();
        if (!keepLive && Lives.Remove(id, out var live)) live.Stop();
    }

    private void SyncLives()
    {
        var current = Store.Connections.ToDictionary(c => c.Id);
        foreach (var (id, live) in Lives.ToList())
        {
            if (current.TryGetValue(id, out var c) && c.Url == live.Connection.Url) continue;
            live.Stop();
            Lives.Remove(id);
        }
        foreach (var c in Store.Connections.Where(c => !Lives.ContainsKey(c.Id)))
        {
            var live = new SpaceLive(c, Api(c), _seen);
            live.NewInbox += (l, items) => PostNotifications?.Invoke(items, l.Connection, Store.Connections.Count > 1);
            live.Refreshed += OnRefreshed;
            Lives[c.Id] = live;
            live.Start();
        }
        if (Selected is not { } s || !current.ContainsKey(s)) Selected = Store.Default?.Id;
        Changed?.Invoke();
    }

    private void OnRefreshed(SpaceLive live)
    {
        if (_pages.TryGetValue(live.Connection.Id, out var pages))
        {
            foreach (var page in pages.Values.ToList()) page.LiveChanged();
        }
        Changed?.Invoke();
    }

    private void Resumed()
    {
        foreach (var v in Views()) v.RecoverIfFailed();
        foreach (var live in Lives.Values) _ = live.Refresh();
    }

    /// <summary>Stops the background refresh before the app quits; pages and Spaces keep running elsewhere.</summary>
    public void Stop()
    {
        foreach (var live in Lives.Values) live.Stop();
        foreach (var page in Pages().ToList()) page.Close();
        foreach (var v in Views().ToList()) v.Close();
    }
}
