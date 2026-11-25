using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Shell;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// Quick Chat (the Mac's <c>QuickChat</c>): a small window over every app with one agent's native
/// chat (<see cref="ChatView"/>), opened by the shortcut, the notification area, the jump list or an
/// <c>aispace://chat</c> link. The conversation is the app's, so it is the same one the main
/// window's Chat shows; text from a link is put in the message field and waits for the person to
/// send it. Closing it only hides it: an answer being written goes on.
///
/// Drawn to the Mac's size (Design Studio's design 12): 380 wide, no title bar, a 40 high header
/// to drag it by with the Space, the agent, Earlier Conversations, New Conversation, "Open in Main
/// Window" and Close; the permission and model pickers sit above the field. A section of the
/// floating ball opens it beside the ball (<see cref="FloatingBallRules.ChatOrigin"/>), a dropped
/// picture attached; the shortcut opens it in the upper middle of the screen.
/// </summary>
internal sealed class QuickChatWindow : Window
{
    private readonly AppModel _model;
    private readonly ComboBox _spaces = new() { Width = 100, Margin = new Thickness(0, 0, 6, 0), Visibility = Visibility.Collapsed };
    private readonly ChatView _chat;
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

        _chat = new ChatView(model, compact: true);
        _chat.AgentPicked += Remember;
        var open = Ui.IconButton(Ui.OpenOutside, L.T("Open in Main Window"), () =>
        {
            // The same conversation in the main window, with what is being written.
            if (_chat.Space is { } space)
            {
                var draft = _chat.TakeDraft();
                _model.ShowChat(space, _chat.AgentId, draft.Length > 0 ? draft : null);
            }
            Hide();
        });
        _spaces.SelectionChanged += (_, _) =>
        {
            if (_filling || _spaces.SelectedItem is not ComboBoxItem { Tag: Guid id }) return;
            Open(id, Remembered() is { } r && r.Connection == id ? r.Agent : null, null);
        };
        var close = Ui.IconButton(Ui.Close, L.T("Close (Esc)"), Hide);
        var bar = new DockPanel { Height = 40, Margin = new Thickness(8, 0, 4, 0) };
        DockPanel.SetDock(close, Dock.Right);
        DockPanel.SetDock(open, Dock.Right);
        DockPanel.SetDock(_chat.NewChat, Dock.Right);
        DockPanel.SetDock(_chat.History, Dock.Right);
        DockPanel.SetDock(_spaces, Dock.Left);
        bar.Children.Add(close);
        bar.Children.Add(open);
        bar.Children.Add(_chat.NewChat);
        bar.Children.Add(_chat.History);
        bar.Children.Add(_spaces);
        _chat.Agents.HorizontalAlignment = HorizontalAlignment.Left;
        bar.Children.Add(_chat.Agents);
        foreach (FrameworkElement c in bar.Children)
        {
            c.VerticalAlignment = VerticalAlignment.Center;
            WindowChrome.SetIsHitTestVisibleInChrome(c, true);
        }
        var barLine = new Border { Child = bar, BorderThickness = new Thickness(0, 0, 0, 1) };
        barLine.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");
        var root = new DockPanel();
        DockPanel.SetDock(barLine, Dock.Top);
        root.Children.Add(barLine);
        root.Children.Add(_chat);
        Ui.Background(root);
        Content = root;
        _model.Changed += Fill;
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible) _chat.Shown();
        };
    }

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
    /// (or the one it shows), with <paramref name="text"/> in its message field; beside
    /// <paramref name="near"/> (the floating ball) when given, with <paramref name="picture"/> attached.
    /// </summary>
    public void Present(string? agent, string? text, Guid? space = null, ScreenRect? near = null, BallPicture? picture = null)
    {
        var remembered = Remembered();
        var connection = (space is { } wanted && _model.Store.Get(wanted) is not null ? wanted : (Guid?)null)
            ?? (_chat.Space is { } shown && _model.Store.Get(shown) is not null ? shown : (Guid?)null)
            ?? remembered?.Connection ?? _model.Selected ?? _model.Store.Default?.Id;
        if (connection is not { } id)
        {
            _model.ShowMainWindow();
            return;
        }
        Open(id, agent ?? (_chat.Space == id ? null : remembered?.Connection == id ? remembered?.Agent : null), text);
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
        if (picture is not null) _chat.AddImage(new ChatImage(picture.Name, picture.Type, picture.Bytes));
        _chat.FocusComposer();
    }

    private void Open(Guid id, string? agent, string? text)
    {
        if (_model.Store.Get(id) is null) return;
        _chat.Show(id, agent, text);
        if (agent is not null) Remember(id, agent);
        Fill();
    }

    private void Fill()
    {
        // A Space or agent picked elsewhere may have new agents: the view lists them again.
        if (_chat.Space is { } space && _model.Lives.TryGetValue(space, out _)) _chat.LiveChanged();
        if (_spaces.IsDropDownOpen) return;
        _filling = true;
        try
        {
            _spaces.Items.Clear();
            foreach (var c in _model.Store.Connections)
            {
                var item = new ComboBoxItem { Content = c.DisplayNameOr(), Tag = c.Id };
                _spaces.Items.Add(item);
                if (c.Id == _chat.Space) _spaces.SelectedItem = item;
            }
            _spaces.Visibility = _model.Store.Connections.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _filling = false;
        }
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
