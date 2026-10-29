using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using AISpace.Core;
using AISpace.Web;

namespace AISpace;

/// <summary>
/// The main window: the selected Space's panel, its apps as tabs beside it, and a bar with the
/// Spaces, the inbox, chat and settings. Every page stays loaded while another is shown, so
/// switching keeps its state; closing the window only hides it while the app keeps running.
/// </summary>
internal sealed class MainWindow : Window
{
    private readonly AppModel _model;
    private readonly Func<bool> _quitting;
    private readonly ComboBox _spaces = new() { MinWidth = 170, MaxWidth = 260, VerticalAlignment = VerticalAlignment.Center };
    private readonly StackPanel _tabs = new() { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
    private readonly Button _back, _forward, _reload, _browser, _inbox, _chat, _settings;
    private readonly TextBlock _inboxCount = new() { FontSize = 12, Margin = new Thickness(4, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid _pages = new();
    private readonly Border _bar = new() { BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(8, 6, 8, 6) };
    private readonly ContentControl _welcome = new() { Visibility = Visibility.Collapsed };
    private bool _filling;
    private bool _fullScreen;
    private WindowState _beforeFullScreen;

    public MainWindow(AppModel model, Func<bool> quitting, Action openSettings, Action addSpace, Func<FrameworkElement> welcome)
    {
        _model = model;
        _quitting = quitting;
        Title = "AI Space";
        Width = 1280;
        Height = 820;
        MinWidth = 640;
        MinHeight = 420;
        Icon = BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico"));
        TaskbarItemInfo = new TaskbarItemInfo();
        Restore(model.Prefs.Window);

        _back = Ui.IconButton(Ui.Back, L.T("Back"), () => _model.ShownView()?.GoBack());
        _forward = Ui.IconButton(Ui.Forward, L.T("Forward"), () => _model.ShownView()?.GoForward());
        _reload = Ui.IconButton(Ui.Refresh, L.T("Reload"), Reload);
        _browser = Ui.IconButton(Ui.OpenOutside, L.T("Open in Browser"), () =>
        {
            if (_model.ShownView() is { } v) AppModel.OpenOutside(v.BrowserUrl);
        });
        _inbox = new Button { Padding = new Thickness(8, 6, 8, 6), Background = Brushes.Transparent, BorderThickness = new Thickness(0), ToolTip = L.T("Inbox") };
        _inbox.Content = Ui.Row(Ui.Glyph(Ui.Inbox), _inboxCount);
        System.Windows.Automation.AutomationProperties.SetName(_inbox, L.T("Inbox"));
        _inbox.Click += (_, _) => _model.ShowInbox();
        _chat = Ui.IconButton(Ui.Chat, L.T("Chat"), () => _model.ShowChat());
        _settings = Ui.IconButton(Ui.Settings, L.T("Settings"), openSettings);

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
        var nav = Ui.Row(_back, _forward, _reload);
        nav.Margin = new Thickness(8, 0, 8, 0);
        var tabsScroll = new ScrollViewer { Content = _tabs, HorizontalScrollBarVisibility = ScrollBarVisibility.Hidden, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled };
        var actions = Ui.Row(_browser, _inbox, _chat, _settings);
        Grid.SetColumn(_spaces, 0);
        Grid.SetColumn(nav, 1);
        Grid.SetColumn(tabsScroll, 2);
        Grid.SetColumn(actions, 3);
        bar.Children.Add(_spaces);
        bar.Children.Add(nav);
        bar.Children.Add(tabsScroll);
        bar.Children.Add(actions);
        _bar.Child = bar;
        _bar.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");

        var root = new DockPanel();
        DockPanel.SetDock(_bar, Dock.Top);
        root.Children.Add(_bar);
        var body = new Grid();
        body.Children.Add(_pages);
        body.Children.Add(_welcome);
        root.Children.Add(body);
        Content = root;
        Ui.Background(root);

        _welcome.Content = welcome();
        _model.Changed += Refresh;
        Loaded += (_, _) => Refresh();
        PreviewKeyDown += OnKey;
    }

    private void Reload()
    {
        _model.ShownView()?.Reload();
        if (_model.SelectedLive is { } live) _ = live.Refresh(catalogue: true);
    }

    /// <summary>Brings the window forward, restoring it from the taskbar or the notification area.</summary>
    public void Bring()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = _model.Prefs.Window?.Maximized == true ? WindowState.Maximized : WindowState.Normal;
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
        _pages.Visibility = hasSpaces ? Visibility.Visible : Visibility.Collapsed;
        foreach (var b in new[] { _back, _forward, _reload, _browser, _inbox, _chat }) b.Visibility = hasSpaces ? Visibility.Visible : Visibility.Collapsed;

        var shown = hasSpaces ? _model.ShownView() : null;
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

        _back.IsEnabled = shown?.CanGoBack == true;
        _forward.IsEnabled = shown?.CanGoForward == true;
        var live = _model.SelectedLive;
        var unread = live?.Summary.Unread ?? 0;
        _inboxCount.Text = unread > 0 ? (unread > 99 ? "99+" : unread.ToString(System.Globalization.CultureInfo.CurrentCulture)) : "";
        _inboxCount.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        FillTabs(shown);
        var c = _model.SelectedConnection;
        Title = c is null ? "AI Space" : shown?.App is not null && shown.PageTitle.Length > 0 ? $"{shown.PageTitle} — {c.DisplayNameOr()}" : $"{c.DisplayNameOr()} — AI Space";
        Badge(_model.Unread);
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

    /// <summary>Home, then the app tabs in the order they opened; past five, the rest under More.</summary>
    private void FillTabs(PanelView? shown)
    {
        _tabs.Children.Clear();
        if (_model.SelectedConnection is not { } c) return;
        var home = new ToggleButton { Content = Ui.Row(Ui.Glyph(Ui.Home, 14), Ui.Text(L.T("Home"), wrap: false)), IsChecked = _model.SelectedApp is null, Padding = new Thickness(10, 4, 10, 4), Margin = new Thickness(0, 0, 4, 0) };
        home.Click += (_, _) => _model.ShowTab(c.Id, null);
        _tabs.Children.Add(home);
        var tabs = _model.Tabs(c.Id);
        var ids = tabs.Select(t => t.App.Id).ToList();
        var visible = OpenTabLayout.Visible(ids, _model.SelectedApp);
        foreach (var tab in tabs.Where(t => visible.Contains(t.App.Id))) _tabs.Children.Add(Tab(c, tab));
        var hidden = tabs.Where(t => !visible.Contains(t.App.Id)).ToList();
        if (hidden.Count == 0) return;
        var more = Ui.IconButton(Ui.More, L.T("More tabs"), () => { });
        var menu = new ContextMenu();
        foreach (var tab in hidden)
        {
            var item = new MenuItem { Header = tab.App.DisplayTitle() };
            item.Click += (_, _) => _model.ShowTab(c.Id, tab.App.Id);
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

    private ToggleButton Tab(Connection c, AppTab tab)
    {
        var close = new Button { Content = Ui.Glyph(Ui.Close, 10), Padding = new Thickness(4), Margin = new Thickness(6, 0, 0, 0), Background = Brushes.Transparent, BorderThickness = new Thickness(0), ToolTip = L.T("Close Tab") };
        close.Click += (_, e) =>
        {
            e.Handled = true;
            _model.CloseTab(c.Id, tab.App.Id);
        };
        var title = tab.View.State.Kind == SpaceStateKind.Unreachable ? $"{tab.App.DisplayTitle()} ⚠" : tab.App.DisplayTitle();
        var t = new ToggleButton
        {
            Content = Ui.Row(Ui.Text(title, wrap: false), close),
            IsChecked = _model.SelectedApp == tab.App.Id,
            Padding = new Thickness(10, 4, 4, 4),
            Margin = new Thickness(0, 0, 4, 0),
            MaxWidth = 220,
            ToolTip = tab.View.Current?.ToString(),
        };
        t.Click += (_, _) => _model.ShowTab(c.Id, tab.App.Id);
        t.MouseUp += (_, e) =>
        {
            if (e.ChangedButton == MouseButton.Middle) _model.CloseTab(c.Id, tab.App.Id);
        };
        return t;
    }

    private void OnKey(object sender, KeyEventArgs e)
    {
        // Only while the bar has focus; a page that has it handles its own keys.
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.W && _model.SelectedConnection is { } c && _model.SelectedApp is { } app)
        {
            _model.CloseTab(c.Id, app);
            e.Handled = true;
        }
        else if (e.Key == Key.F5)
        {
            Reload();
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

    private void Restore(Preferences.WindowPlace? place)
    {
        if (place is null || place.Width < MinWidth || place.Height < MinHeight)
        {
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            return;
        }
        // Only where a screen still is: a monitor may have been unplugged since.
        var area = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
        if (!area.IntersectsWith(new Rect(place.Left, place.Top, place.Width, place.Height)))
        {
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Width = place.Width;
            Height = place.Height;
            return;
        }
        Left = place.Left;
        Top = place.Top;
        Width = place.Width;
        Height = place.Height;
        if (place.Maximized) WindowState = WindowState.Maximized;
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
