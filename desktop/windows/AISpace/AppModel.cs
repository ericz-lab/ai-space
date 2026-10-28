using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Local;
using AISpace.Shell;
using AISpace.Web;
using Microsoft.Win32;

namespace AISpace;

/// <summary>An app of a Space open as a tab of the main window.</summary>
internal sealed record AppTab(AppInfo App, PanelView View);

/// <summary>
/// What the windows show and do, apart from how they draw it (the Mac's <c>AppModel</c>): the saved
/// Spaces, the one selected, each Space's panel page and app tabs, the background refresh of every
/// Space for the inbox and the notification area, and where links go. Runs on the UI thread.
/// </summary>
internal sealed class AppModel
{
    public static readonly string Version = typeof(AppModel).Assembly.GetName().Version?.ToString(3) ?? "0";

    private readonly Dispatcher _ui;
    private readonly FileSeenStore _seen;
    private readonly Dictionary<Guid, PanelView> _panels = [];
    private readonly Dictionary<Guid, List<AppTab>> _tabs = [];
    private readonly Dictionary<Guid, SpaceApi> _apis = [];

    public AppModel(Dispatcher ui, AppPaths paths)
    {
        _ui = ui;
        Paths = paths;
        Store = new ConnectionStore(paths.Connections);
        Prefs = Preferences.Load(paths.Preferences);
        Web = new WebProfiles(paths.WebData);
        _seen = new FileSeenStore(paths.InboxSeen);
        Local = new LocalManager(this);
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
    public LocalManager Local { get; }
    public Dictionary<Guid, SpaceLive> Lives { get; } = [];

    /// <summary>Set by the app: posts new inbox threads as Windows notifications.</summary>
    public Action<IReadOnlyList<InboxItem>, Connection, bool>? PostNotifications { get; set; }

    public Guid? Selected { get; private set; }
    /// <summary>The app tab shown in the main window; null for the panel.</summary>
    public string? SelectedApp { get; private set; }
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
        Local.Start();
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

    // Pages

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

    /// <summary>The Space's panel page, made and loaded on first use.</summary>
    public PanelView Panel(Connection c)
    {
        if (_panels.TryGetValue(c.Id, out var p) && !p.IsDisposed && ConnectionRules.SameOrigin(p.Home, c.Uri)) return p;
        p?.Close();
        p = NewView(c, c.Uri, verifiesSpace: true, app: null);
        _panels[c.Id] = p;
        p.Load();
        return p;
    }

    public IReadOnlyList<AppTab> Tabs(Guid connection) => _tabs.TryGetValue(connection, out var t) ? t : [];

    /// <summary>Every page the main window holds, of every Space.</summary>
    public IEnumerable<PanelView> Views() => _panels.Values.Concat(_tabs.Values.SelectMany(t => t.Select(x => x.View))).Where(v => !v.IsDisposed);

    /// <summary>The page the main window shows now; null without a Space.</summary>
    public PanelView? ShownView()
    {
        if (SelectedConnection is not { } c) return null;
        if (SelectedApp is { } app && Tabs(c.Id).FirstOrDefault(t => t.App.Id == app) is { } tab) return tab.View;
        return Panel(c);
    }

    private void OnViewState(PanelView view, SpaceState state)
    {
        if (Store.Get(view.Connection.Id) is not { } c) return;
        // The Local edition's own Space: sign in again with the device credential, then reload.
        if (state.Kind == SpaceStateKind.AuthenticationRequired && c.Managed)
        {
            _ = SignInAgain(c, view);
            return;
        }
        if (state.Kind == SpaceStateKind.Ready && view.VerifiesSpace && Lives.TryGetValue(c.Id, out var live) && live.Status != LiveStatus.Ok)
        {
            _ = live.Refresh(catalogue: true);
        }
    }

    private async Task SignInAgain(Connection c, PanelView view)
    {
        if (await Local.SignIn(c)) view.Load();
    }

    // The main window's place

    public void Select(Guid id)
    {
        if (Store.Get(id) is null) return;
        Selected = id;
        SelectedApp = null;
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

    public void ShowTab(Guid connection, string? app)
    {
        Selected = connection;
        SelectedApp = app;
        ShowMainWindow(connection);
    }

    /// <summary>The panel, opening one of its windows when a link is given (src/web/panel-link.ts).</summary>
    public void ShowPanel(Guid? connection, Func<Uri, Uri>? link = null)
    {
        var c = (connection is { } id ? Store.Get(id) : null) ?? SelectedConnection ?? Store.Default;
        if (c is null)
        {
            ShowMainWindow();
            return;
        }
        var panel = Panel(c);
        if (link is not null) panel.Navigate(link(c.Uri));
        ShowTab(c.Id, null);
    }

    public void ShowInbox(Guid? connection = null) => ShowPanel(connection, PanelLink.Inbox);

    public void ShowChat(Guid? connection = null, string? agent = null, string? text = null) => ShowPanel(connection, u => PanelLink.Chat(u, agent, text));

    // Apps and links

    /// <summary>Opens an app as a tab of the main window, loading <paramref name="url"/> in it when given.</summary>
    public void OpenApp(AppInfo app, Guid connection, Uri? url = null)
    {
        if (Store.Get(connection) is not { } c) return;
        if (!_tabs.TryGetValue(connection, out var tabs)) _tabs[connection] = tabs = [];
        var tab = tabs.FirstOrDefault(t => t.App.Id == app.Id);
        if (tab is null)
        {
            var home = url ?? app.PageUrl(c.Uri);
            if (home is null) return;
            tab = new AppTab(app, NewView(c, home, verifiesSpace: false, app.Id));
            tabs.Add(tab);
            tab.View.Load();
        }
        else if (url is not null && tab.View.Current != url)
        {
            tab.View.Navigate(url);
        }
        ShowTab(connection, app.Id);
    }

    public void CloseTab(Guid connection, string app)
    {
        if (!_tabs.TryGetValue(connection, out var tabs)) return;
        var i = tabs.FindIndex(t => t.App.Id == app);
        if (i < 0) return;
        tabs[i].View.Close();
        tabs.RemoveAt(i);
        if (Selected == connection && SelectedApp == app) SelectedApp = tabs.Count == 0 ? null : tabs[Math.Min(i, tabs.Count - 1)].App.Id;
        Changed?.Invoke();
    }

    /// <summary>A link leaving a page: an app of the Space opens as its tab, anything else in the browser.</summary>
    public void OpenLink(Uri url, Guid connection)
    {
        if (Store.Get(connection) is { } c && Lives.TryGetValue(connection, out var live) && AppRoutes.AppFor(url, live.Apps, c.Uri) is { } app)
        {
            OpenApp(app, connection, url);
            return;
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
        ShowTab(c.Id, null);
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
        if (Selected == id) SelectedApp = null;
        Changed?.Invoke();
        await Web.Clear(id);
        if (Lives.TryGetValue(id, out var live)) await live.Refresh(catalogue: true);
    }

    public void SetDefault(Guid id) => Store.SetDefault(id);

    /// <summary>Saves (or re-points) the Local edition's own Space after an install, selects it and signs in to it.</summary>
    public Connection AdoptLocal(Uri url)
    {
        var existing = Store.ManagedConnection ?? Store.Connections.FirstOrDefault(c => ConnectionRules.SameOrigin(c.Uri, url));
        Connection c;
        if (existing is not null)
        {
            Store.SetManaged(existing.Id, url);
            c = Store.Get(existing.Id)!;
        }
        else
        {
            c = Store.Add(L.T("This Computer"), url, makeDefault: true, managed: true);
        }
        Store.SetDefault(c.Id);
        Selected = c.Id;
        SelectedApp = null;
        Changed?.Invoke();
        return c;
    }

    /// <summary>Reloads every page of a Space after its sign-in changed underneath them.</summary>
    public void ReloadPages(Guid id)
    {
        if (_panels.TryGetValue(id, out var p) && !p.IsDisposed) p.Load();
        foreach (var t in Tabs(id)) t.View.Reload();
    }

    private void Discard(Guid id, bool keepLive = false)
    {
        if (_panels.Remove(id, out var p)) p.Close();
        if (_tabs.Remove(id, out var tabs)) tabs.ForEach(t => t.View.Close());
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
            live.Refreshed += _ => Changed?.Invoke();
            Lives[c.Id] = live;
            live.Start();
        }
        if (Selected is not { } s || !current.ContainsKey(s)) Selected = Store.Default?.Id;
        Changed?.Invoke();
    }

    private void Resumed()
    {
        foreach (var v in Views()) v.RecoverIfFailed();
        foreach (var live in Lives.Values) _ = live.Refresh();
        _ = Local.Refresh();
    }

    /// <summary>Stops the background refresh before the app quits; pages and Spaces keep running elsewhere.</summary>
    public void Stop()
    {
        foreach (var live in Lives.Values) live.Stop();
        foreach (var v in Views().ToList()) v.Close();
    }
}
