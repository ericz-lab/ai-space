using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Shell;
using AISpace.Core;
using AISpace.Shell;
using AISpace.Web;

namespace AISpace.Views;

/// <summary>
/// Quick Chat (the Mac's <c>QuickChat</c>): a small window over every app with one agent's chat,
/// opened by the shortcut, the notification area, the jump list or an <c>aispace://chat</c> link.
/// It shows the Space's own chat, so a conversation here is the same one the panel shows; text
/// from a link is put in the message field and waits for the person to send it. Closing it only
/// hides it: an answer being written goes on.
///
/// Drawn to the Mac's size (Design Studio's design 12): 380 wide, no title bar, a 40 high header
/// to drag it by with the Space, the agent, "Open in Main Window" and Close; the page's own chat
/// header below holds the model and the permission choice. A section of the floating ball opens
/// it beside the ball (<see cref="FloatingBallRules.ChatOrigin"/>), a dropped picture attached;
/// the shortcut opens it in the upper middle of the screen.
/// </summary>
internal sealed class QuickChatWindow : Window
{
    private readonly AppModel _model;
    private readonly ComboBox _spaces = new() { Width = 110, Margin = new Thickness(0, 0, 6, 0), Visibility = Visibility.Collapsed };
    private readonly ComboBox _agents = new() { MinWidth = 120 };
    private readonly Grid _host = new();
    private PanelView? _view;
    private bool _filling;
    private bool _placed;

    public QuickChatWindow(AppModel model)
    {
        _model = model;
        Title = L.T("Quick Chat");
        Width = FloatingBallRules.ChatWidth;
        Height = FloatingBallRules.ChatHeight;
        MinWidth = 340;
        MinHeight = 320;
        Topmost = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico"));
        // No title bar: the header is where it is dragged; the frame keeps Windows' shadow and round corners.
        WindowChrome.SetWindowChrome(this, new WindowChrome { CaptionHeight = 40, ResizeBorderThickness = new Thickness(6), GlassFrameThickness = new Thickness(0, 0, 0, 1), UseAeroCaptionButtons = false });
        SourceInitialized += (_, _) => Native.MakeToolWindow(this, noActivate: false);

        var open = Ui.IconButton(Ui.OpenOutside, L.T("Open in Main Window"), () =>
        {
            if (_view is { } v) _model.ShowChat(v.Connection.Id, AgentId());
            Hide();
        });
        _spaces.SelectionChanged += (_, _) =>
        {
            if (_filling || _spaces.SelectedItem is not ComboBoxItem { Tag: Guid id }) return;
            Open(id, null, null);
        };
        _agents.SelectionChanged += (_, _) =>
        {
            if (_filling || _view is null || AgentId() is not { } agent) return;
            Remember(_view.Connection.Id, agent);
            _view.Navigate(PanelLink.Chat(_view.Connection.Uri, agent));
        };
        var close = Ui.IconButton(Ui.Close, L.T("Close (Esc)"), Hide);
        var bar = new DockPanel { Height = 40, Margin = new Thickness(8, 0, 4, 0) };
        DockPanel.SetDock(close, Dock.Right);
        DockPanel.SetDock(open, Dock.Right);
        DockPanel.SetDock(_spaces, Dock.Left);
        bar.Children.Add(close);
        bar.Children.Add(open);
        bar.Children.Add(_spaces);
        bar.Children.Add(_agents);
        foreach (var c in new FrameworkElement[] { close, open, _spaces, _agents })
        {
            c.VerticalAlignment = VerticalAlignment.Center;
            WindowChrome.SetIsHitTestVisibleInChrome(c, true);
        }
        var root = new DockPanel();
        DockPanel.SetDock(bar, Dock.Top);
        root.Children.Add(bar);
        root.Children.Add(_host);
        Ui.Background(root);
        Content = root;
        _model.Changed += Fill;
    }

    private string? AgentId() => _agents.SelectedItem is ComboBoxItem { Tag: string id } ? id : null;

    /// <summary>The agent last talked to here, as <c>&lt;connection&gt; &lt;agent&gt;</c> in the preferences.</summary>
    private (Guid Connection, string Agent)? Remembered()
    {
        var parts = _model.Prefs.QuickChatAgent?.Split(' ', 2);
        return parts is [var c, var a] && Guid.TryParse(c, out var id) && _model.Store.Get(id) is not null ? (id, a) : null;
    }

    private void Remember(Guid connection, string agent)
    {
        _model.Prefs.QuickChatAgent = $"{connection} {agent}";
        _model.SavePrefs();
    }

    public void Toggle()
    {
        if (IsVisible && IsActive) Hide();
        else Present(null, null);
    }

    /// <summary>
    /// Shows the window on <paramref name="agent"/> (or the one last used) of <paramref name="space"/>
    /// (or the one it shows), with <paramref name="text"/> added to its message field; beside
    /// <paramref name="near"/> (the floating ball) when given, with <paramref name="picture"/> attached.
    /// </summary>
    public void Present(string? agent, string? text, Guid? space = null, ScreenRect? near = null, BallPicture? picture = null)
    {
        var remembered = Remembered();
        var connection = (space is { } wanted && _model.Store.Get(wanted) is not null ? wanted : (Guid?)null)
            ?? _view?.Connection.Id ?? remembered?.Connection ?? _model.Selected ?? _model.Store.Default?.Id;
        if (connection is not { } id)
        {
            _model.ShowMainWindow();
            return;
        }
        Open(id, agent ?? (remembered?.Connection == id ? remembered?.Agent : null), text);
        if (near is { } ball)
        {
            var area = Native.WorkArea(this, new Point(ball.X + ball.Width / 2, ball.Y + ball.Height / 2));
            var o = FloatingBallRules.ChatOrigin(ball, Width, Height, area);
            Left = o.X;
            Top = o.Y;
            _placed = true;
        }
        else if (!_placed)
        {
            // Near the top of the screen, as the Mac places its panel for the shortcut.
            var area = SystemParameters.WorkArea;
            Left = area.Left + (area.Width - Width) / 2;
            Top = area.Top + area.Height * 0.12;
            _placed = true;
        }
        Show();
        Activate();
        _view?.FocusPage();
        if (picture is not null && _view is { } v) _ = v.DropPicture(picture.Name, picture.Type, picture.Bytes);
    }

    private void Open(Guid id, string? agent, string? text)
    {
        if (_model.Store.Get(id) is not { } c) return;
        var link = PanelLink.Chat(c.Uri, agent, text);
        if (_view is { IsDisposed: false } v && v.Connection.Id == id && ConnectionRules.SameOrigin(v.Home, c.Uri))
        {
            v.Navigate(link);
        }
        else
        {
            _view?.Close();
            _host.Children.Clear();
            v = _model.NewView(c, c.Uri, verifiesSpace: true, app: null);
            _view = v;
            _host.Children.Add(v);
            v.Load(link);
        }
        if (agent is not null) Remember(id, agent);
        Fill();
        Select(agent ?? Remembered()?.Agent);
    }

    private void Fill()
    {
        if (_spaces.IsDropDownOpen || _agents.IsDropDownOpen) return;
        _filling = true;
        try
        {
            var current = _view?.Connection.Id;
            _spaces.Items.Clear();
            foreach (var c in _model.Store.Connections)
            {
                var item = new ComboBoxItem { Content = c.DisplayNameOr(), Tag = c.Id };
                _spaces.Items.Add(item);
                if (c.Id == current) _spaces.SelectedItem = item;
            }
            _spaces.Visibility = _model.Store.Connections.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
            var selected = AgentId();
            _agents.Items.Clear();
            if (current is { } id && _model.Lives.TryGetValue(id, out var live))
            {
                // One entry per agent, the local machine's, as the panel's agent list.
                foreach (var a in live.Agents.Where(a => a.Peer is null || !live.Agents.Any(b => b.Peer is null && b.App == a.App && b.Name == a.Name)))
                {
                    var title = a.Peer is null ? a.DisplayTitle() : $"{a.DisplayTitle()} · {a.Peer}";
                    _agents.Items.Add(new ComboBoxItem { Content = title, Tag = a.Id, IsEnabled = !a.Stale });
                }
            }
            if (selected is not null) SelectQuiet(selected);
            _agents.Visibility = _agents.Items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _filling = false;
        }
    }

    private void Select(string? agent)
    {
        _filling = true;
        try
        {
            SelectQuiet(agent);
        }
        finally
        {
            _filling = false;
        }
    }

    private void SelectQuiet(string? agent)
    {
        var match = _agents.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == agent)
            ?? _agents.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == "space/assistant");
        _agents.SelectedItem = match;
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!App.Quitting)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    protected override void OnKeyDown(System.Windows.Input.KeyEventArgs e)
    {
        if (e.Key == System.Windows.Input.Key.Escape)
        {
            Hide();
            e.Handled = true;
        }
        base.OnKeyDown(e);
    }
}
