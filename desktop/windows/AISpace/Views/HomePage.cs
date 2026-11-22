using System.Text;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// Home: the Space's screens and its library, natively, as the Mac's launcher and the Linux
/// client's <c>app/home.ts</c> lay them out (docs/windows-desktop.md#home).
///
/// At the top the command box (docs/panel.md#omnibox): typing searches every app, agent, widget and
/// built-in page with the other clients' ranking (<see cref="HomeSearch"/>); Enter opens the best
/// match when its name holds the whole query, else hands the text to Space Assistant's chat as a
/// draft, never sent (Ctrl+Enter always does). Under it a tab per screen and the Library. A screen
/// draws its tiles, then its widget cards; the Library everything, by kind, with a filter. The
/// screens are this computer's (<see cref="ScreenStore"/>, <c>screens.json</c>): copied from the
/// panel's once, then changed here (a tile's context menu, the ⋯ button) without touching the Space.
///
/// The catalogue (<see cref="SpaceApi.GetHome"/>) is read when the page is first shown, on F5, and
/// after each background refresh while it is shown; it is drawn again only when what it shows
/// changed, keeping the focused tile. The bottom of the page is left free for the desk pet's walk.
/// </summary>
internal sealed partial class HomePage : NativePage
{
    private const string LibraryId = "library";

    /// <summary>One store per file, shared by every Space's Home.</summary>
    private static readonly Dictionary<string, ScreenStore> Stores = [];

    private readonly ScreenStore _store;
    private readonly HomeCards _cards;
    private readonly Grid _root = new();
    private readonly ContentControl _banner = new() { Focusable = false };
    private readonly FrameworkElement _box;
    private readonly TextBox _field;
    private readonly WrapPanel _tabs = new();
    private readonly Button _screenActions;
    private readonly StackPanel _body = new();
    private HomeCatalogue? _catalogue;
    private DateTimeOffset? _catalogueAt;
    private string? _error;
    private bool _loading, _again, _stale = true, _closed;
    private string _query = "";
    private string _shownId = HomeScreens.Home;
    private LibraryFilter _filter = LibraryFilter.All;
    private string? _drawn, _tabsDrawn;
    /// <summary>While the page itself sets the tabs' and chips' state: their Checked and Unchecked are not the person's.</summary>
    private bool _syncing;
    private FrameworkElement? _first;

    public HomePage(PageContext context) : base(context)
    {
        var file = Path.Combine(context.Model.Paths.Config, "screens.json");
        if (!Stores.TryGetValue(file, out var store)) Stores[file] = store = new ScreenStore(file);
        _store = store;
        _cards = new HomeCards(context, OpenWidget);

        _box = Ui.SearchBox(L.T("Search apps, agents and widgets, or ask Space Assistant"), OnQuery, _ => Submit(alwaysAsk: false));
        _box.MaxWidth = 720;
        _field = Ui.SearchField(_box);
        _field.FontSize = 15;
        _field.MinHeight = 40;
        _field.PreviewKeyDown += OnBoxKey;

        _screenActions = Ui.IconButton(Ui.More, L.T("Screen Actions"), ScreenMenu);
        DockPanel.SetDock(_screenActions, Dock.Right);
        KeyboardNavigation.SetDirectionalNavigation(_tabs, KeyboardNavigationMode.Contained);
        var tabsRow = new DockPanel { Margin = new Thickness(0, 14, 0, 0), LastChildFill = true };
        tabsRow.Children.Add(_screenActions);
        tabsRow.Children.Add(_tabs);
        var header = new StackPanel();
        header.Children.Add(_box);
        header.Children.Add(tabsRow);
        var headerFrame = new Border { Child = header, MaxWidth = 1100, Padding = new Thickness(32, 20, 32, 6) };

        // The bottom 140 scroll past the last row, so the desk pet never sits on a tile for good.
        var column = new Border { Child = _body, MaxWidth = 1100, Padding = new Thickness(32, 4, 32, 140) };
        var scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
        Ui.Background(scroll);

        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(headerFrame, 1);
        Grid.SetRow(scroll, 2);
        _root.Children.Add(_banner);
        _root.Children.Add(headerFrame);
        _root.Children.Add(scroll);
        Content = _root;
        PreviewKeyDown += OnPageKey;
    }

    public override string Title => L.T("Home");

    private string SpaceKey => Context.SpaceId.ToString();

    private static string Lang => Core.Lang.Current;

    // The window's calls

    public override void Shown()
    {
        if (_stale || _catalogue is null) Load();
        Draw();
        Dispatcher.BeginInvoke(() =>
        {
            if (IsShown && !IsKeyboardFocusWithin) _field.Focus();
        }, DispatcherPriority.Input);
    }

    public override void LiveChanged()
    {
        if (IsShown) Load();
        else _stale = true;
    }

    public override void Refresh() => Load();

    public override void Close()
    {
        _closed = true;
        // Removed (not signed out, nor moved to a new address): its screens go with it.
        if (Context.Connection is null) _store.Forget(SpaceKey);
    }

    // Reading the catalogue

    private async void Load()
    {
        if (_closed) return;
        if (_loading)
        {
            _again = true;
            return;
        }
        if (Context.Api is not { } api) return;
        // The window shows the sign-in page meanwhile; read again once signed in.
        if (Context.Live?.Status == LiveStatus.SignInNeeded)
        {
            _stale = true;
            return;
        }
        _loading = true;
        _stale = false;
        try
        {
            var c = await api.GetHome();
            if (_closed) return;
            _catalogue = c;
            _catalogueAt = DateTimeOffset.Now;
            _error = null;
            Seed(c);
        }
        catch (SpaceApiException e)
        {
            _error = e.Kind == SpaceApiFailure.AuthenticationRequired ? L.T("Sign-in needed") : e.Message;
            _stale = true;
        }
        catch (Exception e)
        {
            // Never out of an async void: the page says it could not read the Space and offers Try Again.
            Log.Write($"Home could not read the Space: {e}");
            _error = e.Message;
            _stale = true;
        }
        finally
        {
            _loading = false;
        }
        if (_closed) return;
        try
        {
            Draw();
        }
        catch (Exception e) when (e is InvalidOperationException or ArgumentException or NullReferenceException or KeyNotFoundException)
        {
            Log.Write($"Home could not draw: {e}");
        }
        if (_again)
        {
            _again = false;
            Load();
        }
    }

    /// <summary>The panel's screens become this computer's the first time; a screen pinned with one machine's variant of an agent shows the agent once.</summary>
    private void Seed(HomeCatalogue c)
    {
        _store.Seed(SpaceKey, c.PanelScreens());
        if (c.AgentGroups.Count == 0) return;
        if (_store.Screens(SpaceKey).Any(s => !AgentGroups.CanonicalItems(s.Items, c.AgentGroups).SequenceEqual(s.Items)))
        {
            _store.Edit(SpaceKey, all => all.Select(s => s with { Items = AgentGroups.CanonicalItems(s.Items, c.AgentGroups) }));
        }
    }

    // The command box

    private void OnQuery(string text)
    {
        if (text == _query) return;
        // A new search shows every kind: the Library's filter would hide the match Enter opens.
        if (_query.Trim().Length == 0 && text.Trim().Length > 0) _filter = LibraryFilter.All;
        _query = text;
        Draw();
    }

    private void OnBoxKey(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.Control)
        {
            e.Handled = true;
            Submit(alwaysAsk: true);
        }
        else if (e.Key == Key.Down && Keyboard.Modifiers == ModifierKeys.None && _first is { } first)
        {
            e.Handled = true;
            first.Focus();
        }
    }

    private void OnPageKey(object sender, KeyEventArgs e)
    {
        var ctrl = Keyboard.Modifiers == ModifierKeys.Control;
        if (ctrl && e.Key is Key.F or Key.K or Key.L)
        {
            e.Handled = true;
            _field.Focus();
            _field.SelectAll();
        }
        else if (ctrl && e.Key is Key.PageDown or Key.PageUp)
        {
            e.Handled = true;
            Step(e.Key == Key.PageDown ? 1 : -1);
        }
        else if (e.Key == Key.Escape && _query.Length > 0 && !_field.IsKeyboardFocusWithin)
        {
            e.Handled = true;
            ClearQuery();
            _field.Focus();
        }
    }

    private void ClearQuery()
    {
        _query = "";
        if (_field.Text.Length > 0) _field.Text = "";
        Draw();
    }

    /// <summary>Enter: the best match when its name holds the whole query, else the text to Space Assistant as a draft.</summary>
    private void Submit(bool alwaysAsk)
    {
        var q = _query.Trim();
        if (q.Length == 0) return;
        var first = _catalogue is { } c ? HomeSearch.Rank(q, Searchable(c), 1).FirstOrDefault() : null;
        if (!alwaysAsk && first is not null && HomeSearch.OpensByDefault(q, first)) Open(first);
        else Ask(q);
        ClearQuery();
    }

    private void Ask(string text)
    {
        var agents = _catalogue?.AgentGroups.SelectMany(g => g.Machines).Select(a => a.Id) ?? Context.Live?.Agents.Select(a => a.Id) ?? [];
        Context.OpenChat(FloatingBallRules.AgentFor(BallSection.Assistant, agents), text);
    }

    // Opening things

    private void Open(HomeEntry e)
    {
        switch (e.Kind)
        {
            case HomeKind.App:
                if ((_catalogue?.AppInfos.GetValueOrDefault(e.Ref) ?? Context.Live?.App(e.Ref)) is { } app) Context.OpenApp(app);
                else if (e.Link is { Length: > 0 } link) Context.OpenLink(HomeCatalogue.FillLink(link));
                break;
            case HomeKind.Agent:
                Context.OpenChat(e.Ref);
                break;
            case HomeKind.Widget:
                if (_catalogue?.Widget(e.Ref) is { } w) OpenWidget(w, null);
                break;
            default:
                OpenBuiltin(e.Ref);
                break;
        }
    }

    private void OpenBuiltin(string name)
    {
        switch (name)
        {
            case "inbox": Context.Show(PageKind.Inbox); break;
            case "shortcuts": Context.Show(PageKind.Shortcuts); break;
            case "settings": Context.Show(PageKind.Settings); break;
            case "terminal": Context.OpenTerminal(); break;
            default: Context.OpenWebPanel(); break;
        }
    }

    /// <summary>A widget's link (a row, a block), else its own page, else its app.</summary>
    private void OpenWidget(HomeWidget w, string? link)
    {
        var target = string.IsNullOrEmpty(link) ? w.Link : link;
        if (!string.IsNullOrEmpty(target))
        {
            Context.OpenLink(HomeCatalogue.FillLink(target));
            return;
        }
        if ((_catalogue?.AppInfos.GetValueOrDefault(w.App) ?? Context.Live?.App(w.App)) is { } app) Context.OpenApp(app);
    }

    // Drawing

    private IEnumerable<HomeEntry> Builtins() => HomeBuiltin.All.Select(b => b.Entry());

    /// <summary>What the command box searches: apps, the built-in pages, agents, widgets.</summary>
    private IEnumerable<HomeEntry> Searchable(HomeCatalogue c) => c.Apps.Concat(Builtins()).Concat(c.Agents).Concat(c.Widgets.Select(HomeCatalogue.WidgetEntry));

    private IReadOnlyList<HomeScreen> Screens() => _store.Screens(SpaceKey);

    /// <summary>
    /// Draws what changed since the last time: the tabs when the screens did, the page when its
    /// content did (the catalogue, the query, the screen, the counts on the tiles, the ages). The
    /// Space is read every 30 seconds and the answer is nearly always the same, so nearly always
    /// nothing is drawn; when it is, the tile that had the focus gets it back.
    /// </summary>
    private void Draw()
    {
        var screens = Screens();
        if (_shownId != LibraryId && screens.All(s => s.Id != _shownId)) _shownId = HomeScreens.Home;
        DrawTabs(screens);
        DrawBanner();
        var sig = Signature(screens);
        if (sig == _drawn) return;
        _drawn = sig;
        var focused = _body.IsKeyboardFocusWithin && Keyboard.FocusedElement is FrameworkElement { Tag: string key } ? key : null;
        _body.Children.Clear();
        _first = null;
        if (_catalogue is not { } c)
        {
            _body.Children.Add(_error is null
                ? Ui.EmptyState(Ui.Home, L.T("Loading the Space…"))
                : Ui.EmptyState(Ui.Warning, L.T("Home could not be loaded"), _error, Ui.Button(L.T("Try Again"), Load, accent: true)));
            return;
        }
        var q = _query.Trim();
        if (q.Length > 0) DrawResults(c, q);
        else if (_shownId == LibraryId) DrawLibrary(c);
        else DrawScreen(c, screens.First(s => s.Id == _shownId));
        if (focused is not null && Find(_body, focused) is { } again) again.Focus();
    }

    private static FrameworkElement? Find(DependencyObject root, string key)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is ButtonBase { Tag: string k } b && k == key) return b;
            if (Find(child, key) is { } found) return found;
        }
        return null;
    }

    private string Signature(IReadOnlyList<HomeScreen> screens)
    {
        var s = new StringBuilder();
        s.Append(_error is null ? "" : "error\n").Append(_catalogue is null ? "none\n" : "").Append(_query.Trim()).Append('\n').Append(_shownId).Append('\n').Append(_filter).Append('\n');
        // Ages ("5 minutes ago") move on every few minutes; the theme changes the drawings' colours.
        s.Append(DateTimeOffset.Now.ToUnixTimeSeconds() / 300).Append(Ui.SystemDark()).Append('\n');
        foreach (var sc in screens) s.Append(sc.Id).Append('=').Append(sc.Name).Append(':').AppendJoin(',', sc.Items).Append('\n');
        if (_catalogue is { } c)
        {
            foreach (var e in c.Apps.Concat(c.Agents)) s.Append(e.Key).Append('|').Append(e.Title).Append('|').Append(e.Icon).Append('|').Append(e.Reach).Append('|').Append(e.Peer).Append('\n');
            foreach (var w in c.Widgets) s.Append(w.Id).Append('|').Append(w.Title).Append('|').Append(w.State).Append('\n');
        }
        if (Context.Live is { } live)
        {
            s.Append("unread=").Append(live.Summary.Unread).Append('\n');
            foreach (var i in live.Inbox.Where(i => i.Unread && !i.Done)) s.Append(i.App).Append(',');
            s.Append('\n');
            foreach (var r in live.Running) s.Append(r.Agent).Append(',');
        }
        return s.ToString();
    }

    private void DrawBanner()
    {
        _banner.Content = _error is not null && _catalogue is not null && _catalogueAt is { } at
            ? Ui.Banner(L.F("Showing what was last known ({0}).", HomeText.Ago(at)), L.T("Try Again"), Load)
            : null;
    }

    private void DrawTabs(IReadOnlyList<HomeScreen> screens)
    {
        var sig = string.Join("\n", screens.Select(s => s.Id + "=" + s.Name));
        if (sig != _tabsDrawn)
        {
            _tabsDrawn = sig;
            _tabs.Children.Clear();
            for (var i = 0; i < screens.Count; i++)
            {
                var id = screens[i].Id;
                _tabs.Children.Add(Choice(OnAccent(Ui.Text(ScreenTitle(screens, i), 13, wrap: false)), ScreenTitle(screens, i), id, false, () => ShowTab(id)));
            }
            var lib = Ui.Row(OnAccent(Ui.Glyph(Ui.Apps, 13)), OnAccent(Ui.Text(L.T("Library"), 13, wrap: false)));
            _tabs.Children.Add(Choice(lib, L.T("Library"), LibraryId, false, () => ShowTab(LibraryId)));
        }
        _syncing = true;
        try
        {
            foreach (var t in _tabs.Children.OfType<ToggleButton>()) t.IsChecked = (string)t.Tag == _shownId && _query.Trim().Length == 0;
        }
        finally
        {
            _syncing = false;
        }
        _screenActions.Visibility = _shownId == LibraryId ? Visibility.Collapsed : Visibility.Visible;
    }

    /// <summary>
    /// A tab or a filter chip: one of a set, the one shown checked. It acts on Checked, not Click,
    /// because UI Automation's Toggle (screen readers, accessibility tools) checks a ToggleButton
    /// without a Click; unchecking the one shown (a second click) only puts its check back.
    /// </summary>
    private ToggleButton Choice(UIElement content, string name, string tag, bool on, Action select)
    {
        var t = new ToggleButton { Content = content, Tag = tag, IsChecked = on, Padding = new Thickness(12, 5, 12, 5), Margin = new Thickness(0, 0, 6, 6), MinWidth = 64 };
        AutomationProperties.SetName(t, name);
        PaintLabels(t);
        t.Checked += (_, _) =>
        {
            PaintLabels(t);
            if (!_syncing) select();
        };
        t.Unchecked += (_, _) =>
        {
            PaintLabels(t);
            if (_syncing) return;
            _syncing = true;
            try
            {
                t.IsChecked = true;
            }
            finally
            {
                _syncing = false;
            }
        };
        return t;
    }

    /// <summary>A label that takes its colour from its button, so it stays readable on the accent fill of a checked tab.</summary>
    private static TextBlock OnAccent(TextBlock t)
    {
        t.Tag = OnAccentTag;
        return t;
    }

    private const string OnAccentTag = "on-accent";

    /// <summary>The labels of a tab or chip in the theme's text colour for its state: on the accent fill when checked.</summary>
    private static void PaintLabels(ToggleButton t)
    {
        var key = t.IsChecked == true ? "TextOnAccentFillColorPrimaryBrush" : "TextFillColorPrimaryBrush";
        void Walk(object node)
        {
            if (node is TextBlock { Tag: OnAccentTag } label) label.SetResourceReference(TextBlock.ForegroundProperty, key);
            if (node is DependencyObject d)
            {
                foreach (var child in LogicalTreeHelper.GetChildren(d)) Walk(child);
            }
        }
        Walk(t.Content);
    }

    private void ShowTab(string id)
    {
        _shownId = id;
        if (_query.Length > 0) ClearQuery();
        else Draw();
    }

    /// <summary>The next tab (1) or the previous one (-1): the screens, then the Library.</summary>
    private void Step(int by)
    {
        var ids = Screens().Select(s => s.Id).Append(LibraryId).ToList();
        var i = ids.IndexOf(_shownId) + by;
        if (i >= 0 && i < ids.Count) ShowTab(ids[i]);
    }

    private static string ScreenTitle(IReadOnlyList<HomeScreen> screens, int index) =>
        HomeScreens.Title(screens, index, L.T("Main"), n => L.F("Screen {0}", n));

    /// <summary>Everything the Space has: apps with the built-in pages, agents, widgets, as the filter keeps them.</summary>
    private void DrawLibrary(HomeCatalogue c)
    {
        var tiles = c.Apps.Concat(Builtins()).ToList();
        var widgets = c.Widgets.ToList();
        _body.Children.Add(FilterRow(HomeSearch.Counts(Searchable(c))));
        if (HomeSearch.Keeps(_filter, tiles[0]))
        {
            _body.Children.Add(Ui.SectionHeader(L.T("Apps")));
            _body.Children.Add(TileGrid(tiles, null));
        }
        if (_filter is LibraryFilter.All or LibraryFilter.Agents && c.Agents.Count > 0)
        {
            _body.Children.Add(Ui.SectionHeader(L.T("Agents")));
            _body.Children.Add(TileGrid(c.Agents, null));
        }
        if (_filter is LibraryFilter.All or LibraryFilter.Widgets && widgets.Count > 0)
        {
            _body.Children.Add(Ui.SectionHeader(L.T("Widgets")));
            _body.Children.Add(CardGrid(widgets, null));
        }
        if (_filter == LibraryFilter.Agents && c.Agents.Count == 0 || _filter == LibraryFilter.Widgets && widgets.Count == 0)
        {
            _body.Children.Add(Ui.EmptyState(Ui.Apps, L.T("None of this kind yet")));
        }
    }

    /// <summary>What matches the query, best names first, under the row that asks Space Assistant.</summary>
    private void DrawResults(HomeCatalogue c, string q)
    {
        var all = HomeSearch.Rank(q, Searchable(c));
        var opens = HomeSearch.OpensByDefault(q, all.FirstOrDefault());
        var ask = new Button { Padding = new Thickness(14, 10, 14, 10), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 4, 0, 4), Tag = "ask" };
        if (!opens) ask.SetResourceReference(StyleProperty, "AccentButtonStyle");
        var label = Ui.Text(L.F("Ask Space Assistant: “{0}”", q), 14, wrap: false);
        if (!opens) label.ClearValue(TextBlock.ForegroundProperty);
        ask.Content = Ui.Row(Ui.Glyph(Ui.Chat, 15), label);
        ask.ToolTip = opens ? L.T("Ctrl+Enter asks Space Assistant") : L.T("Enter asks Space Assistant");
        AutomationProperties.SetName(ask, L.F("Ask Space Assistant: “{0}”", q));
        ask.Click += (_, _) =>
        {
            Ask(q);
            ClearQuery();
        };
        _body.Children.Add(ask);
        _first = ask;
        _body.Children.Add(FilterRow(HomeSearch.Counts(all)));
        var found = all.Where(e => HomeSearch.Keeps(_filter, e)).ToList();
        var tiles = found.Where(e => e.Kind != HomeKind.Widget).ToList();
        var widgets = found.Where(e => e.Kind == HomeKind.Widget).Select(e => c.Widget(e.Ref)).OfType<HomeWidget>().ToList();
        if (tiles.Count == 0 && widgets.Count == 0)
        {
            var none = Ui.Text(L.T("Nothing matches. Press Enter to ask Space Assistant."), 13, secondary: true);
            none.Margin = new Thickness(4, 16, 0, 0);
            _body.Children.Add(none);
            return;
        }
        if (tiles.Count > 0)
        {
            var grid = TileGrid(tiles, null);
            grid.Margin = new Thickness(grid.Margin.Left, 8, 0, 0);
            _body.Children.Add(grid);
        }
        if (widgets.Count > 0)
        {
            var cards = CardGrid(widgets, null);
            cards.Margin = new Thickness(0, 12, 0, 0);
            _body.Children.Add(cards);
        }
    }

    /// <summary>One screen: its tiles in one grid, its widget cards below, in the screen's order.</summary>
    private void DrawScreen(HomeCatalogue c, HomeScreen screen)
    {
        var byKey = c.ByKey();
        var tiles = new List<HomeEntry>();
        var widgets = new List<HomeWidget>();
        foreach (var key in screen.Items)
        {
            if (key.StartsWith("builtin:", StringComparison.Ordinal))
            {
                if (HomeBuiltin.Of(key["builtin:".Length..]) is { } b) tiles.Add(b.Entry());
            }
            else if (byKey.TryGetValue(key, out var e))
            {
                if (e.Kind == HomeKind.Widget)
                {
                    if (c.Widget(e.Ref) is { } w) widgets.Add(w);
                }
                else
                {
                    tiles.Add(e);
                }
            }
        }
        if (tiles.Count == 0 && widgets.Count == 0)
        {
            var open = Ui.Button(L.T("Open Library"), () => ShowTab(LibraryId), accent: true);
            var empty = Ui.EmptyState(Ui.Apps, L.T("Nothing on this screen yet"), L.T("Right-click an app, agent or widget in the Library (or press Shift+F10 on it) and choose a screen to add it."), open);
            empty.Margin = new Thickness(0, 48, 0, 0);
            _body.Children.Add(empty);
            _first = open;
            return;
        }
        if (tiles.Count > 0)
        {
            var grid = TileGrid(tiles, screen.Id);
            grid.Margin = new Thickness(grid.Margin.Left, 8, 0, 0);
            _body.Children.Add(grid);
        }
        if (widgets.Count > 0)
        {
            var cards = CardGrid(widgets, screen.Id);
            cards.Margin = new Thickness(0, 16, 0, 0);
            _body.Children.Add(cards);
        }
    }

    private FrameworkElement FilterRow(IReadOnlyDictionary<LibraryFilter, int> counts)
    {
        var row = new WrapPanel { Margin = new Thickness(0, 4, 0, 0) };
        KeyboardNavigation.SetDirectionalNavigation(row, KeyboardNavigationMode.Contained);
        AutomationProperties.SetName(row, L.T("Filter by kind"));
        foreach (var (filter, label) in new[] { (LibraryFilter.All, L.T("All")), (LibraryFilter.Apps, L.T("Apps")), (LibraryFilter.Agents, L.T("Agents")), (LibraryFilter.Widgets, L.T("Widgets")) })
        {
            var n = counts.GetValueOrDefault(filter);
            var count = OnAccent(Ui.Text(n.ToString(System.Globalization.CultureInfo.CurrentCulture), 12, wrap: false));
            count.Opacity = 0.7;
            count.VerticalAlignment = VerticalAlignment.Center;
            var t = Choice(Ui.Row(OnAccent(Ui.Text(label, 13, wrap: false)), count), $"{label} ({n})", "filter:" + filter, _filter == filter, () =>
            {
                _filter = filter;
                Draw();
            });
            t.Padding = new Thickness(12, 4, 12, 4);
            t.MinWidth = 0;
            row.Children.Add(t);
        }
        return row;
    }

    private WrapPanel TileGrid(IEnumerable<HomeEntry> entries, string? screen)
    {
        var grid = HomeTiles.Grid();
        foreach (var e in entries) grid.Children.Add(Tile(e, screen));
        if (_first is null && grid.Children.Count > 0) _first = (FrameworkElement)grid.Children[0];
        return grid;
    }

    private WrapPanel CardGrid(IEnumerable<HomeWidget> widgets, string? screen)
    {
        var grid = HomeCards.Grid();
        foreach (var w in widgets)
        {
            var card = _cards.Card(w);
            var entry = HomeCatalogue.WidgetEntry(w);
            card.ContextMenu = new ContextMenu();
            card.ContextMenuOpening += (_, _) => FillEntryMenu(card.ContextMenu, entry, screen);
            grid.Children.Add(card);
        }
        if (_first is null && grid.Children.Count > 0) _first = grid.Children[0] is FrameworkElement f ? FirstButton(f) : null;
        return grid;
    }

    private static FrameworkElement? FirstButton(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is Button b) return b;
            if (FirstButton(child) is { } found) return found;
        }
        return null;
    }

    private Button Tile(HomeEntry e, string? screen)
    {
        var title = e.DisplayTitle();
        var live = Context.Live;
        var mark = TileMark.None;
        var count = 0;
        var states = new List<string>();
        FrameworkElement icon;
        if (e.Kind == HomeKind.Builtin)
        {
            icon = HomeTiles.BuiltinIcon(HomeBuiltin.Of(e.Ref)?.Glyph ?? Ui.Apps);
            if (e.Ref == "inbox" && live is { Summary.Unread: > 0 } l)
            {
                mark = TileMark.Count;
                count = l.Summary.Unread;
            }
        }
        else
        {
            icon = Context.Icons.View(e.Icon, title, HomeTiles.IconSize);
            if (e.Kind == HomeKind.Agent && live is not null && live.Running.Any(r => live.AgentId(r) == e.Ref))
            {
                mark = TileMark.Working;
                states.Add(L.T("Working on a reply"));
            }
            if (e.Kind == HomeKind.App && live is not null && _catalogue?.AppInfos.GetValueOrDefault(e.Ref) is { } info)
            {
                count = live.Inbox.Count(i => i.App == info.Name && i.Unread && !i.Done);
                if (count > 0) mark = TileMark.Count;
            }
        }
        if (count > 0) states.Add(L.F("{0} unread", count));
        string? note = e.Peer;
        switch (e.Reach)
        {
            case Reach.Down:
                note = L.T("not answering");
                mark = TileMark.Down;
                break;
            case Reach.Paused:
                note = L.T("paused");
                mark = TileMark.Paused;
                break;
            case Reach.PeerOffline:
                note = e.Peer is { } p ? L.F("{0} offline", p) : L.T("Offline");
                mark = TileMark.Offline;
                break;
        }
        if (note is not null && note != e.Peer) states.Add(note);
        else if (e.Peer is not null) states.Add(e.Peer);
        // The library's tiles tell what they are under the pointer; a screen's show their name only.
        string? tooltip = title;
        if (screen is null)
        {
            var where = e.Machines is { } machines ? L.F("On {0}", string.Join(Lang == "zh" ? "、" : ", ", machines.Select(m => m.Length == 0 ? L.T("this computer") : m))) : null;
            tooltip = string.Join("\n", new[] { title, e.DisplayDetail(), where }.Where(x => !string.IsNullOrEmpty(x)));
        }
        var tile = HomeTiles.Tile(e.Key, icon, title, note, states.Count > 0 ? string.Join(", ", states) : null, mark, count,
            dimmed: e.Reach is Reach.Paused or Reach.PeerOffline, tooltip, () => Open(e));
        tile.ContextMenu = new ContextMenu();
        tile.ContextMenuOpening += (_, _) => FillEntryMenu(tile.ContextMenu, e, screen);
        return tile;
    }
}
