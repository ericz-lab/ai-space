using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using AISpace.Core;
using AISpace.Views;
using AISpace.Web;

namespace AISpace;

/// <summary>
/// The main window. Its bar holds the Space picker, Home's places (the Library, then a tab per
/// screen, <see cref="HomePage.Places"/>: each opens Home there), then the web tabs (the apps
/// opened, the chat, the terminal, the web panel), then, while a web tab is shown, Back, Forward,
/// Reload and Open in Browser, the Inbox with its count while something is unread, and a menu
/// with the Space's other pages (Inbox, Shortcuts, Terminal, Settings), the web panel, Quick Chat
/// and the app's settings. Below, the
/// selected native page or web tab; while the Space needs a sign-in, its web panel's sign-in page
/// in place of the native pages. Every page and tab stays loaded while another is shown, so
/// switching keeps its state; closing the window only hides it while the app keeps running.
/// </summary>
internal sealed class MainWindow : Window
{
    /// <summary>The size a first window asks for; it never exceeds the work area of its monitor.</summary>
    private const double FirstWidth = 1280, FirstHeight = 820;
    /// <summary>Under this width the bar holds fewer screen tabs and the Library's shows its icon only.</summary>
    private const double LabelsFrom = 1100;
    /// <summary>Screen tabs in the bar under <see cref="LabelsFrom"/>; above it, <see cref="HomeScreens.InBar"/>.</summary>
    private const int NarrowScreens = 2;

    private readonly AppModel _model;
    private readonly Func<bool> _quitting;
    private readonly ComboBox _spaces = new() { MinWidth = 150, MaxWidth = 240, VerticalAlignment = VerticalAlignment.Center };
    /// <summary>Home's places: the Library, then a tab per screen (the rest under a menu).</summary>
    private readonly StackPanel _places = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(8, 0, 4, 0) };
    /// <summary>Every Space's Home whose places the bar follows.</summary>
    private readonly HashSet<HomePage> _homes = [];
    private string? _placesDrawn;
    private readonly StackPanel _tabs = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
    private readonly Border _inboxBadge = Ui.Badge(0);
    /// <summary>The Inbox with its count, in the bar only while something is unread (the menu always has the Inbox).</summary>
    private readonly Button _inbox;
    private readonly Button _back, _forward, _reload, _browser, _menu;
    private readonly StackPanel _webActions;
    private readonly Grid _pages = new();
    private readonly DockPanel _nativeHost = new();
    private readonly Grid _native = new();
    private readonly Border _banner = new() { Visibility = Visibility.Collapsed };
    /// <summary>Above the native Home page, for the desk pet (<see cref="PetView"/>): no background, so it takes the pointer only where its elements are.</summary>
    private readonly Grid _homeOverlay = new() { Background = null, Visibility = Visibility.Collapsed };
    private readonly Border _bar = new() { BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(8, 6, 8, 6) };
    private readonly ContentControl _welcome = new() { Visibility = Visibility.Collapsed };
    private bool _filling;
    private bool _fullScreen;
    private WindowState _beforeFullScreen;
    /// <summary>Normal or maximized, as the window last was before it was minimized: what Bring restores.</summary>
    private WindowState _shownState = WindowState.Normal;

    public MainWindow(AppModel model, Func<bool> quitting, Action openSettings, Action addSpace, Func<FrameworkElement> welcome)
    {
        _model = model;
        _quitting = quitting;
        Title = "AI Space";
        MinWidth = 640;
        MinHeight = 420;
        Icon = BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico"));
        TaskbarItemInfo = new TaskbarItemInfo();
        Restore(model.Prefs.Window);
        // Again once shown: the system may still move a new window by its frame or a change of scale.
        Shell.Native.KeepOnScreen(this);

        _back = Ui.IconButton(Ui.Back, L.T("Back"), () => _model.ShownView()?.GoBack());
        _forward = Ui.IconButton(Ui.Forward, L.T("Forward"), () => _model.ShownView()?.GoForward());
        _reload = Ui.IconButton(Ui.Refresh, L.T("Reload"), Reload);
        _browser = Ui.IconButton(Ui.OpenOutside, L.T("Open in Browser"), () =>
        {
            if (_model.ShownView() is { } v) AppModel.OpenOutside(v.BrowserUrl);
        });
        _webActions = Ui.Row(_back, _forward, _reload, _browser);
        _menu = Ui.IconButton(Ui.More, L.T("More"), () => { });
        _menu.ContextMenu = Menu(openSettings);
        _menu.Click += (_, _) =>
        {
            _menu.ContextMenu.PlacementTarget = _menu;
            _menu.ContextMenu.Placement = PlacementMode.Bottom;
            _menu.ContextMenu.IsOpen = true;
        };

        _inboxBadge.Margin = new Thickness(6, 0, 0, 0);
        _inbox = Ui.IconButton(Ui.Inbox, L.T("Inbox"), () => _model.ShowPage(null, PageKind.Inbox));
        _inbox.Content = Ui.Row(Ui.Glyph(Ui.Inbox, 16), _inboxBadge);
        _inbox.Visibility = Visibility.Collapsed;

        _spaces.SelectionChanged += (_, _) =>
        {
            if (_filling || _spaces.SelectedItem is not ComboBoxItem { Tag: var tag }) return;
            if (tag is Guid id) _model.Select(id);
            else if (tag is "add")
            {
                Fill();
                addSpace();
            }
        };

        var bar = new Grid();
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var divider = new Border { Width = 1, Margin = new Thickness(4, 6, 8, 6) };
        divider.SetResourceReference(Border.BackgroundProperty, "DividerStrokeColorDefaultBrush");
        var tabsScroll = new ScrollViewer { Content = _tabs, HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
        var tabsRow = new DockPanel();
        DockPanel.SetDock(divider, Dock.Left);
        tabsRow.Children.Add(divider);
        tabsRow.Children.Add(tabsScroll);
        var actions = Ui.Row(_webActions, _inbox, _menu);
        Grid.SetColumn(_spaces, 0);
        Grid.SetColumn(_places, 1);
        Grid.SetColumn(tabsRow, 2);
        Grid.SetColumn(actions, 3);
        bar.Children.Add(_spaces);
        bar.Children.Add(_places);
        bar.Children.Add(tabsRow);
        bar.Children.Add(actions);
        _bar.Child = bar;
        _bar.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");

        // The native pages, with the overlay for the desk pet over Home and a banner while the Space cannot be reached.
        var nativeBody = new Grid();
        nativeBody.Children.Add(_native);
        nativeBody.Children.Add(_homeOverlay);
        DockPanel.SetDock(_banner, Dock.Top);
        _nativeHost.Children.Add(_banner);
        _nativeHost.Children.Add(nativeBody);
        PetView.Attach(_homeOverlay, model);

        var root = new DockPanel();
        DockPanel.SetDock(_bar, Dock.Top);
        root.Children.Add(_bar);
        var body = new Grid();
        body.Children.Add(_pages);
        body.Children.Add(_nativeHost);
        body.Children.Add(_welcome);
        root.Children.Add(body);
        Content = root;
        Ui.Background(root);

        _welcome.Content = welcome();
        _model.Changed += Refresh;
        Loaded += (_, _) => Refresh();
        SizeChanged += (_, _) => FillPlaces();
        PreviewKeyDown += OnKey;
    }

    private ContextMenu Menu(Action openSettings)
    {
        var menu = new ContextMenu();
        MenuItem Item(string header, string glyph, Action click, string? keys = null)
        {
            var item = new MenuItem { Header = header, Icon = Ui.Glyph(glyph, 14), InputGestureText = keys ?? "" };
            item.Click += (_, _) => click();
            menu.Items.Add(item);
            return item;
        }
        // The Space's pages the bar has no tab for (Home is its screens' tabs).
        var inbox = Item(L.T("Inbox"), Ui.Inbox, () => _model.ShowPage(null, PageKind.Inbox), "Ctrl+2");
        var shortcuts = Item(L.T("Shortcuts"), Ui.Shortcuts, () => _model.ShowPage(null, PageKind.Shortcuts), "Ctrl+3");
        var terminal = Item(L.T("Terminal"), Ui.Terminal, () => _model.ShowTerminal(), "Ctrl+4");
        var settings = Item(L.T("Settings"), Ui.Settings, () => _model.ShowPage(null, PageKind.Settings), "Ctrl+5");
        menu.Items.Add(new Separator());
        var panel = Item(L.T("Open Web Panel"), Ui.Web, () => _model.ShowWebPanel());
        var chat = Item(L.T("Chat"), Ui.Chat, () => _model.ShowChat());
        Item(L.T("Quick Chat"), Ui.Chat, () => _model.OpenQuickChat?.Invoke(_model.Selected, null, null));
        menu.Items.Add(new Separator());
        Item(L.T("AI Space Settings…"), Ui.Settings, openSettings);
        menu.Opened += (_, _) =>
        {
            var space = _model.SelectedConnection is not null;
            foreach (var item in new[] { inbox, shortcuts, terminal, settings, panel, chat }) item.IsEnabled = space;
            var unread = _model.SelectedLive?.Summary.Unread ?? 0;
            inbox.Header = unread > 0 ? L.F("Inbox ({0} unread)", unread) : L.T("Inbox");
        };
        return menu;
    }

    private void Reload()
    {
        if (_model.ShownView() is { } v) v.Reload();
        else _model.ShownPage()?.Refresh();
        if (_model.SelectedLive is { } live) _ = live.Refresh(catalogue: true);
    }

    /// <summary>Brings the window forward, restoring it from the taskbar or the notification area.</summary>
    public void Bring()
    {
        if (!IsVisible) Show();
        // As the window was before it was minimized, not as it was saved at the last close: it may
        // have been maximized or restored since.
        if (WindowState == WindowState.Minimized) WindowState = _shownState;
        Activate();
        var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
        Shell.Native.SetForegroundWindow(handle);
        _model.ShownView()?.FocusPage();
    }

    private void Refresh()
    {
        Fill();
        var hasSpaces = _model.Store.Connections.Count > 0;
        _welcome.Visibility = hasSpaces ? Visibility.Collapsed : Visibility.Visible;
        _menu.Visibility = hasSpaces ? Visibility.Visible : Visibility.Collapsed;

        var shown = hasSpaces ? _model.ShownView() : null;
        var page = hasSpaces ? _model.ShownPage() : null;

        // The web pages: every one stays a child (hidden) so it keeps its page.
        var views = _model.Views().ToHashSet();
        foreach (var child in _pages.Children.OfType<PanelView>().ToList())
        {
            if (!views.Contains(child)) _pages.Children.Remove(child);
        }
        foreach (var v in views)
        {
            if (!_pages.Children.Contains(v))
            {
                _pages.Children.Add(v);
                v.FullScreenChanged += OnFullScreen;
            }
            v.Visibility = v == shown ? Visibility.Visible : Visibility.Collapsed;
        }
        _pages.Visibility = shown is null ? Visibility.Collapsed : Visibility.Visible;

        // The native pages, likewise.
        var pages = _model.Pages().ToHashSet();
        foreach (var child in _native.Children.OfType<NativePage>().ToList())
        {
            if (pages.Contains(child)) continue;
            child.SetShown(false);
            _native.Children.Remove(child);
        }
        if (page is not null && !_native.Children.Contains(page)) _native.Children.Add(page);
        foreach (var p in _native.Children.OfType<NativePage>().ToList())
        {
            p.Visibility = p == page ? Visibility.Visible : Visibility.Collapsed;
            p.SetShown(p == page && IsVisible);
        }
        _nativeHost.Visibility = page is null ? Visibility.Collapsed : Visibility.Visible;
        _homeOverlay.Visibility = page is HomePage ? Visibility.Visible : Visibility.Collapsed;
        Banner(page is not null ? _model.SelectedLive : null);

        var tab = _model.ShownTab();
        _webActions.Visibility = shown is not null ? Visibility.Visible : Visibility.Collapsed;
        _back.IsEnabled = shown?.CanGoBack == true;
        _forward.IsEnabled = shown?.CanGoForward == true;
        var unread = hasSpaces ? _model.SelectedLive?.Summary.Unread ?? 0 : 0;
        if (_inboxBadge.Child is TextBlock count) count.Text = unread > 99 ? "99+" : unread.ToString(System.Globalization.CultureInfo.CurrentCulture);
        _inbox.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        _inbox.ToolTip = L.F("Inbox ({0} unread)", unread);
        System.Windows.Automation.AutomationProperties.SetName(_inbox, L.F("Inbox ({0} unread)", unread));
        FillPlaces();
        FillTabs();
        var c = _model.SelectedConnection;
        var what = tab is not null ? tab.Title : page?.Title ?? "";
        Title = c is null ? "AI Space" : what.Length > 0 ? $"{what} — {c.DisplayNameOr()}" : $"{c.DisplayNameOr()} — AI Space";
        Badge(_model.Unread);
    }

    /// <summary>The selected Space's Home, for its places; null without a Space or while it needs a sign-in (the bar then shows none).</summary>
    private HomePage? SelectedHome() =>
        _model.SelectedConnection is { } c && !_model.NeedsSignIn(c.Id) ? _model.Page(c, PageKind.Home) as HomePage : null;

    /// <summary>
    /// Home's places as tabs: the Library, then a tab per screen, as many as the width allows (the rest, and the shown
    /// one's place among them, as the web tabs do: <see cref="HomeScreens.BarTabs"/>). A tab is checked only while Home shows it; from any page it opens Home there. A right
    /// click (Shift+F10) holds the screen's actions. Drawn again only when something it shows changed.
    /// </summary>
    private void FillPlaces()
    {
        var home = SelectedHome();
        if (home is not null && _homes.Add(home)) home.PlacesChanged += _ => FillPlaces();
        var onHome = home is not null && _model.ShownPage() == home;
        var wide = ActualWidth >= LabelsFrom;
        var places = home?.Places() ?? [];
        var shown = home?.ShownPlace;
        var sig = home is null ? "" : $"{home.Context.SpaceId}|{onHome}|{wide}|{shown}|{string.Join("|", places.Select(p => p.Id + "=" + p.Title))}";
        if (sig == _placesDrawn) return;
        _placesDrawn = sig;
        _places.Children.Clear();
        _places.Visibility = home is null ? Visibility.Collapsed : Visibility.Visible;
        if (home is null) return;
        // The Library first, as the web panel has it left of the screens; it never goes under the overflow menu.
        var library = places.First(p => p.Id == HomePage.LibraryPlace).Title;
        var libraryContent = wide ? Ui.Row(Ui.Glyph(Ui.Apps, 14), Ui.Text(library, wrap: false)) : (UIElement)Ui.Glyph(Ui.Apps, 14);
        _places.Children.Add(Place(home, HomePage.LibraryPlace, libraryContent, library, onHome && shown == HomePage.LibraryPlace));
        var screens = places.Where(p => p.Id != HomePage.LibraryPlace).ToList();
        var inBar = HomeScreens.BarTabs(screens.Select(s => s.Id).ToList(), shown, wide ? HomeScreens.InBar : NarrowScreens);
        foreach (var (id, title) in screens.Where(s => inBar.Contains(s.Id)))
        {
            _places.Children.Add(Place(home, id, Ui.Text(title, wrap: false), title, onHome && shown == id));
        }
        var rest = screens.Where(s => !inBar.Contains(s.Id)).ToList();
        if (rest.Count > 0)
        {
            var more = Ui.IconButton("\uE70D", L.T("More screens"), () => { });
            var menu = new ContextMenu();
            foreach (var (id, title) in rest)
            {
                var item = new MenuItem { Header = title };
                item.Click += (_, _) => home.ShowPlace(id);
                menu.Items.Add(item);
            }
            more.ContextMenu = menu;
            more.Click += (_, _) =>
            {
                menu.PlacementTarget = more;
                menu.Placement = PlacementMode.Bottom;
                menu.IsOpen = true;
            };
            more.Margin = new Thickness(0, 0, 4, 0);
            _places.Children.Add(more);
        }
    }

    /// <summary>
    /// One place's tab. It acts on Checked and Unchecked rather than Click, so UI Automation's Toggle
    /// (screen readers) works as a click does: either way the place is shown and the bar drawn anew.
    /// </summary>
    private ToggleButton Place(HomePage home, string id, UIElement content, string name, bool on)
    {
        if (content is TextBlock text)
        {
            text.TextTrimming = TextTrimming.CharacterEllipsis;
            text.MaxWidth = 140;
        }
        var button = new ToggleButton { Content = content, IsChecked = on, Padding = new Thickness(10, 4, 10, 4), Margin = new Thickness(0, 0, 4, 0), ToolTip = name, BorderThickness = new Thickness(0) };
        // The theme's checked look is the accent fill; the bar marks the place shown with a subtle one.
        if (on) button.SetResourceReference(BackgroundProperty, "SubtleFillColorSecondaryBrush");
        else button.Background = Brushes.Transparent;
        System.Windows.Automation.AutomationProperties.SetName(button, name);
        void Pick()
        {
            home.ShowPlace(id);
            // Clicking the tab already shown unchecks it and changes nothing else: draw the bar again.
            Dispatcher.BeginInvoke(() =>
            {
                _placesDrawn = null;
                FillPlaces();
            });
        }
        button.Checked += (_, _) => Pick();
        button.Unchecked += (_, _) => Pick();
        button.ContextMenu = new ContextMenu();
        button.ContextMenuOpening += (_, _) => home.FillPlaceMenu(button.ContextMenu, id);
        return button;
    }

    /// <summary>A Space the native pages cannot reach: say so above them, with Try Again.</summary>
    private void Banner(SpaceLive? live)
    {
        if (live is not { Status: LiveStatus.Offline })
        {
            _banner.Visibility = Visibility.Collapsed;
            return;
        }
        var name = live.Connection.DisplayNameOr();
        _banner.Child = Ui.Banner(live.StatusDetail.Length > 0 ? $"{L.F("Cannot reach {0}", name)}: {live.StatusDetail}" : L.F("Cannot reach {0}", name), L.T("Try Again"), () => _ = live.Refresh(catalogue: true));
        _banner.Visibility = Visibility.Visible;
    }

    /// <summary>The Space picker: each saved Space with where it stands, then Add a Space.</summary>
    private void Fill()
    {
        // A refresh never closes the list under the pointer.
        if (_spaces.IsDropDownOpen) return;
        _filling = true;
        try
        {
            _spaces.Items.Clear();
            foreach (var c in _model.Store.Connections)
            {
                var status = _model.Lives.TryGetValue(c.Id, out var l) ? l.Status : LiveStatus.Unknown;
                var dot = new System.Windows.Shapes.Ellipse { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center, Fill = StatusBrush(status) };
                var item = new ComboBoxItem { Tag = c.Id, Content = Ui.Row(dot, Ui.Text(c.DisplayNameOr(), wrap: false)), ToolTip = $"{c.Url}\n{StatusText(status)}" };
                _spaces.Items.Add(item);
                if (c.Id == _model.Selected) _spaces.SelectedItem = item;
            }
            _spaces.Items.Add(new ComboBoxItem { Tag = "add", Content = Ui.Row(Ui.Glyph(Ui.Add, 12), Ui.Text(L.T("Add a Space…"), wrap: false)) });
            _spaces.Visibility = _model.Store.Connections.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _filling = false;
        }
    }

    public static Brush StatusBrush(LiveStatus s) => s switch
    {
        LiveStatus.Ok => new SolidColorBrush(Color.FromRgb(0x2E, 0xA0, 0x43)),
        LiveStatus.SignInNeeded => new SolidColorBrush(Color.FromRgb(0xD9, 0x8C, 0x1F)),
        LiveStatus.Offline => new SolidColorBrush(Color.FromRgb(0xC4, 0x2B, 0x1C)),
        _ => new SolidColorBrush(Color.FromRgb(0x8A, 0x8A, 0x8A)),
    };

    public static string StatusText(LiveStatus s) => s switch
    {
        LiveStatus.Ok => L.T("Connected"),
        LiveStatus.SignInNeeded => L.T("Sign-in needed"),
        LiveStatus.Offline => L.T("Offline"),
        _ => L.T("Connecting…"),
    };

    /// <summary>The web tabs in the order they opened; past five, the rest under More.</summary>
    private void FillTabs()
    {
        _tabs.Children.Clear();
        if (_model.SelectedConnection is not { } c) return;
        var tabs = _model.Tabs(c.Id);
        var visible = OpenTabLayout.Visible(tabs.Select(t => t.Key).ToList(), _model.SelectedTab);
        foreach (var tab in tabs.Where(t => visible.Contains(t.Key))) _tabs.Children.Add(Tab(c, tab));
        var hidden = tabs.Where(t => !visible.Contains(t.Key)).ToList();
        if (hidden.Count == 0) return;
        var more = Ui.IconButton(Ui.More, L.T("More tabs"), () => { });
        var menu = new ContextMenu();
        foreach (var tab in hidden)
        {
            var item = new MenuItem { Header = tab.Title };
            item.Click += (_, _) => _model.ShowTab(c.Id, tab.Key);
            menu.Items.Add(item);
        }
        more.ContextMenu = menu;
        more.Click += (_, _) =>
        {
            menu.PlacementTarget = more;
            menu.IsOpen = true;
        };
        _tabs.Children.Add(more);
    }

    private ToggleButton Tab(Connection c, WebTab tab)
    {
        var close = new Button { Content = Ui.Glyph(Ui.Close, 10), Padding = new Thickness(4), Margin = new Thickness(6, 0, 0, 0), Background = Brushes.Transparent, BorderThickness = new Thickness(0), ToolTip = L.T("Close Tab") };
        close.Click += (_, e) =>
        {
            e.Handled = true;
            _model.CloseTab(c.Id, tab.Key);
        };
        var title = tab.View.State.Kind == SpaceStateKind.Unreachable ? $"{tab.Title} ⚠" : tab.Title;
        var glyph = tab.Kind switch
        {
            WebTabKind.Terminal => Ui.Terminal,
            WebTabKind.Chat => Ui.Chat,
            WebTabKind.Panel => Ui.Web,
            _ => null,
        };
        var label = glyph is null ? Ui.Row(Ui.Text(title, wrap: false), close) : Ui.Row(Ui.Glyph(glyph, 12), Ui.Text(title, wrap: false), close);
        if (_model.SelectedTab == tab.Key)
        {
            // The checked tab is drawn on the accent fill: its words and icons in the colour made for it.
            foreach (var word in new[] { label }.Concat(LogicalTreeHelper.GetChildren(label).OfType<object>()).Append(close.Content).OfType<TextBlock>()) word.SetResourceReference(TextBlock.ForegroundProperty, "TextOnAccentFillColorPrimaryBrush");
        }
        var t = new ToggleButton
        {
            Content = label,
            IsChecked = _model.SelectedTab == tab.Key,
            Padding = new Thickness(10, 4, 4, 4),
            Margin = new Thickness(0, 0, 4, 0),
            MaxWidth = 220,
            ToolTip = tab.View.Current?.ToString(),
        };
        t.Click += (_, _) => _model.ShowTab(c.Id, tab.Key);
        t.MouseUp += (_, e) =>
        {
            if (e.ChangedButton == MouseButton.Middle) _model.CloseTab(c.Id, tab.Key);
        };
        return t;
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        // Only while the bar or a native page has focus; a web page that has it handles its own keys.
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.W && _model.SelectedConnection is { } c && _model.SelectedTab is { } tab)
        {
            _model.CloseTab(c.Id, tab);
            e.Handled = true;
        }
        else if (e.Key == Key.F5)
        {
            Reload();
            e.Handled = true;
        }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key is Key.PageDown or Key.PageUp && _model.ShownPage() is HomePage home)
        {
            // Ctrl+Page Down, Ctrl+Page Up: the next or previous of Home's places.
            home.Step(e.Key == Key.PageDown ? 1 : -1);
            e.Handled = true;
        }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key is >= Key.D1 and <= Key.D5 && _model.SelectedConnection is not null)
        {
            // Ctrl+1 … Ctrl+5: Home, then the pages of the menu in its order.
            switch (e.Key)
            {
                case Key.D1: _model.ShowPage(null, PageKind.Home); break;
                case Key.D2: _model.ShowPage(null, PageKind.Inbox); break;
                case Key.D3: _model.ShowPage(null, PageKind.Shortcuts); break;
                case Key.D4: _model.ShowTerminal(); break;
                default: _model.ShowPage(null, PageKind.Settings); break;
            }
            e.Handled = true;
        }
    }

    private void OnFullScreen(PanelView view, bool full)
    {
        if (full == _fullScreen) return;
        _fullScreen = full;
        if (full)
        {
            _beforeFullScreen = WindowState;
            _bar.Visibility = Visibility.Collapsed;
            WindowStyle = WindowStyle.None;
            WindowState = WindowState.Normal;
            WindowState = WindowState.Maximized;
        }
        else
        {
            _bar.Visibility = Visibility.Visible;
            WindowStyle = WindowStyle.SingleBorderWindow;
            WindowState = _beforeFullScreen;
        }
    }

    /// <summary>The unread count on the taskbar button, as the Mac shows it on the Dock icon.</summary>
    private void Badge(int unread)
    {
        if (unread <= 0)
        {
            TaskbarItemInfo.Overlay = null;
            TaskbarItemInfo.Description = "AI Space";
            return;
        }
        var text = unread > 99 ? "99+" : unread.ToString(System.Globalization.CultureInfo.CurrentCulture);
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.DrawEllipse(new SolidColorBrush(Color.FromRgb(0xD1, 0x34, 0x38)), null, new Point(16, 16), 16, 16);
            var ft = new FormattedText(text, System.Globalization.CultureInfo.CurrentCulture, FlowDirection.LeftToRight, new Typeface(new FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal), text.Length > 2 ? 12 : 17, Brushes.White, 1.0);
            dc.DrawText(ft, new Point(16 - ft.Width / 2, 16 - ft.Height / 2));
        }
        var bmp = new RenderTargetBitmap(32, 32, 96, 96, PixelFormats.Pbgra32);
        bmp.Render(visual);
        TaskbarItemInfo.Overlay = bmp;
        TaskbarItemInfo.Description = L.F("AI Space — {0} unread", text);
    }

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        if (WindowState != WindowState.Minimized) _shownState = WindowState;
    }

    protected override void OnPropertyChanged(DependencyPropertyChangedEventArgs e)
    {
        base.OnPropertyChanged(e);
        // A hidden window hides its native page too (Shown/Hidden follow what can be seen).
        if (e.Property == IsVisibleProperty && IsLoaded) Refresh();
    }

    /// <summary>
    /// The saved place, else the first size centred on the primary monitor; either way wholly on
    /// one monitor's work area (<see cref="WindowPlacement"/>), so the title bar can be reached.
    /// </summary>
    private void Restore(Preferences.WindowPlace? place)
    {
        WindowStartupLocation = WindowStartupLocation.Manual;
        var areas = Shell.Native.WorkAreas(this);
        var r = place is null || place.Width <= 0 || place.Height <= 0
            ? WindowPlacement.Centered(FirstWidth, FirstHeight, areas[0])
            : WindowPlacement.Fit(new ScreenRect(place.Left, place.Top, place.Width, place.Height), areas, MinWidth, MinHeight);
        Left = r.X;
        Top = r.Y;
        Width = r.Width;
        Height = r.Height;
        if (place?.Maximized == true) WindowState = _shownState = WindowState.Maximized;
    }

    private void SavePlace()
    {
        if (_fullScreen) return;
        var r = WindowState == WindowState.Normal ? new Rect(Left, Top, Width, Height) : RestoreBounds;
        if (r.IsEmpty) return;
        _model.Prefs.Window = new Preferences.WindowPlace(r.Left, r.Top, r.Width, r.Height, WindowState == WindowState.Maximized);
        _model.SavePrefs();
    }

    /// <summary>Close hides: the pages, their streams and unsent text stay; the app goes on in the notification area.</summary>
    protected override void OnClosing(CancelEventArgs e)
    {
        SavePlace();
        if (_quitting()) return;
        e.Cancel = true;
        Hide();
        HiddenByClose?.Invoke();
    }

    /// <summary>The window was hidden by its close button.</summary>
    public event Action? HiddenByClose;
}
