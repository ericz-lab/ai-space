using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// A native conversation with one agent of a Space (the Mac's <c>ChatView</c>): the thread, the
/// turn's status, approval and question cards, the permission and model pickers and the composer.
/// Enter sends, Shift+Enter starts a new line; while a turn runs a message joins it, and Stop ends
/// it on the Space. Pictures come by Attach, drag and drop or Ctrl+V. The conversation itself is the
/// app's (<see cref="AppModel.Conversation"/>), so the main window's Chat and Quick Chat show the
/// same one; this view only draws it and keeps what is being written.
///
/// The main window's <see cref="ChatPage"/> shows the agent picker, Earlier Conversations and New
/// Conversation in the view's own header; Quick Chat (<paramref name="compact"/>) puts them in its
/// window's bar and draws the thread in a narrower frame.
/// </summary>
internal sealed class ChatView : UserControl
{
    /// <summary>About 72 characters of body text (docs/design-guidelines.md, chat panel).</summary>
    private const double Column = 680;

    private readonly AppModel _model;
    private readonly bool _compact;
    private readonly ScrollViewer _scroll;
    private readonly StackPanel _list = new();
    private readonly ComboBox _permission = new() { FontSize = 12, MinWidth = 0, Padding = new Thickness(8, 3, 6, 3) };
    private readonly ComboBox _modelPick = new() { FontSize = 12, MinWidth = 0, Padding = new Thickness(8, 3, 6, 3) };
    private readonly WrapPanel _attachments = new() { Margin = new Thickness(0, 6, 0, 0) };
    private readonly TextBlock _imageError;
    private readonly TextBox _field;
    private readonly TextBlock _hint;
    private readonly Button _attach, _send, _stop;
    private readonly VoiceButton? _mic;
    private readonly DispatcherTimer _redraw;
    private readonly Dictionary<Guid, (string Key, FrameworkElement Element)> _drawn = [];
    /// <summary>Open tool rows and folds, by step id: they stay open while the reply is drawn again.</summary>
    private readonly HashSet<string> _expanded = [];
    /// <summary>A question card's choices and typed answers, by step id then question id.</summary>
    private readonly Dictionary<string, Dictionary<string, List<string>>> _picked = [];
    private readonly Dictionary<string, Dictionary<string, string>> _typed = [];
    private readonly HashSet<string> _answering = [];
    private readonly Dictionary<string, string> _answerErrors = [];
    private List<ChatImage> _images = [];
    private Guid? _space;
    private AgentInfo? _agent;
    private string? _wantedAgent;
    private string? _wantedSession;
    private ChatConversation? _conv;
    private bool _filling;
    private bool _stickToEnd = true;

    public ChatView(AppModel model, bool compact)
    {
        _model = model;
        _compact = compact;
        Focusable = false;
        Ui.Background(this);

        Agents = new ComboBox { MinWidth = compact ? 100 : 200, MaxWidth = compact ? 170 : 320, VerticalAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(Agents, L.T("Agent"));
        Agents.SelectionChanged += (_, _) =>
        {
            if (_filling || Agents.SelectedItem is not ComboBoxItem { Tag: string id } || _space is not { } space) return;
            _wantedAgent = id;
            Resolve();
            AgentPicked?.Invoke(space, id);
            FocusComposer();
        };
        History = Ui.IconButton("", L.T("Earlier Conversations"), ShowHistory);
        NewChat = Ui.IconButton(Ui.Add, L.T("New Conversation"), () =>
        {
            _conv?.NewConversation();
            FocusComposer();
        });

        // The thread.
        _list.Margin = new Thickness(compact ? 14 : 24, 12, compact ? 14 : 24, 16);
        var column = new Border { Child = _list, MaxWidth = Column + 48, HorizontalAlignment = HorizontalAlignment.Stretch };
        _scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
        _scroll.ScrollChanged += (_, e) =>
        {
            // Scrolled by the person (not by the thread growing): follow the end only when it is there.
            if (e.ExtentHeightChange == 0 && e.ViewportHeightChange == 0) _stickToEnd = _scroll.VerticalOffset >= _scroll.ScrollableHeight - 24;
        };

        // The permission and model pickers.
        foreach (var p in ChatPermissions.All) _permission.Items.Add(new ComboBoxItem { Content = ChatText.Permission(p), Tag = p });
        _permission.ToolTip = L.T("The choice is remembered and applies to new messages. Ask before changes lets the agent ask you before an edit or a command; All permissions allows commands and file changes without asking.");
        System.Windows.Automation.AutomationProperties.SetName(_permission, L.T("Permission"));
        _permission.SelectionChanged += (_, _) =>
        {
            if (_filling || _permission.SelectedItem is not ComboBoxItem { Tag: ChatPermission p }) return;
            _model.SetChatPermission(p);
        };
        _modelPick.ToolTip = L.T("Model (next message)");
        System.Windows.Automation.AutomationProperties.SetName(_modelPick, L.T("Model"));
        _modelPick.SelectionChanged += (_, _) =>
        {
            if (_filling || _modelPick.SelectedItem is not ComboBoxItem { Tag: string value } || _space is not { } space || _agent is not { } agent) return;
            _model.SetChatModel(space, agent.Id, value);
        };
        var pickers = new WrapPanel { Margin = new Thickness(0, 0, 0, 6) };
        _permission.Margin = new Thickness(0, 0, 6, 0);
        _permission.MaxWidth = compact ? 170 : 220;
        _modelPick.MaxWidth = compact ? 170 : 320;
        pickers.Children.Add(_permission);
        pickers.Children.Add(_modelPick);

        // The composer.
        _field = new TextBox
        {
            AcceptsReturn = true,
            AcceptsTab = false,
            TextWrapping = TextWrapping.Wrap,
            MinHeight = 38,
            MaxHeight = 160,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Padding = new Thickness(10, 8, 10, 8),
            VerticalContentAlignment = VerticalAlignment.Center,
            FontSize = 14,
        };
        _hint = Ui.Text("", 14, secondary: true, wrap: false);
        _hint.IsHitTestVisible = false;
        _hint.Margin = new Thickness(13, 0, 13, 0);
        _hint.VerticalAlignment = VerticalAlignment.Center;
        _hint.TextTrimming = TextTrimming.CharacterEllipsis;
        _field.TextChanged += (_, _) => UpdateComposer();
        _field.PreviewKeyDown += OnFieldKey;
        var fieldHost = new Grid();
        fieldHost.Children.Add(_field);
        fieldHost.Children.Add(_hint);

        _attach = Ui.IconButton("", L.T("Add images"), ChooseImages);
        _stop = Ui.IconButton("", L.T("Stop"), () => _conv?.Stop());
        _stop.Foreground = new SolidColorBrush(Color.FromRgb(0xC4, 0x2B, 0x1C));
        _send = new Button { Content = Ui.Glyph("", 15), Padding = new Thickness(10, 7, 10, 7), ToolTip = L.T("Send"), VerticalAlignment = VerticalAlignment.Bottom };
        _send.SetResourceReference(StyleProperty, "AccentButtonStyle");
        System.Windows.Automation.AutomationProperties.SetName(_send, L.T("Send"));
        _send.Click += (_, _) => Send();
        var composer = new DockPanel { LastChildFill = true };
        _attach.VerticalAlignment = VerticalAlignment.Bottom;
        _stop.VerticalAlignment = VerticalAlignment.Bottom;
        DockPanel.SetDock(_attach, Dock.Left);
        composer.Children.Add(_attach);
        var right = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(6, 0, 0, 0) };
        if (model.Voice is { } voice)
        {
            // What is said goes into the field and waits there, never sent by itself.
            _mic = new VoiceButton(voice, () => _space is { } s && _model.Store.Get(s) is { } c ? _model.Api(c) : null, text =>
            {
                _field.Text = _field.Text.Length == 0 ? text : _field.Text.TrimEnd() + " " + text;
                FocusComposer();
            });
            right.Children.Add(_mic);
        }
        right.Children.Add(_stop);
        right.Children.Add(_send);
        DockPanel.SetDock(right, Dock.Right);
        composer.Children.Add(right);
        fieldHost.Margin = new Thickness(4, 0, 0, 0);
        composer.Children.Add(fieldHost);

        _imageError = Ui.Text("", 12);
        _imageError.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        _imageError.Visibility = Visibility.Collapsed;
        var bottom = new StackPanel { MaxWidth = Column + 48, Margin = new Thickness(compact ? 10 : 20, 8, compact ? 10 : 20, 10) };
        bottom.Children.Add(pickers);
        bottom.Children.Add(_attachments);
        bottom.Children.Add(_imageError);
        bottom.Children.Add(composer);
        var bottomBar = new Border { Child = bottom, BorderThickness = new Thickness(0, 1, 0, 0) };
        bottomBar.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");

        var root = new DockPanel();
        if (!compact)
        {
            var header = new DockPanel { Margin = new Thickness(16, 8, 12, 8) };
            var actions = Ui.Row(History, NewChat);
            DockPanel.SetDock(actions, Dock.Right);
            header.Children.Add(actions);
            var agentRow = Ui.Row(Ui.Glyph(Ui.Agent, 16), Agents);
            header.Children.Add(agentRow);
            var headerBar = new Border { Child = header, BorderThickness = new Thickness(0, 0, 0, 1) };
            headerBar.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");
            DockPanel.SetDock(headerBar, Dock.Top);
            root.Children.Add(headerBar);
        }
        DockPanel.SetDock(bottomBar, Dock.Bottom);
        root.Children.Add(bottomBar);
        root.Children.Add(_scroll);
        Content = root;

        AllowDrop = true;
        PreviewDragOver += (_, e) =>
        {
            if (!Pictures(e.Data)) return;
            e.Effects = DragDropEffects.Copy;
            e.Handled = true;
        };
        PreviewDrop += (_, e) =>
        {
            if (!Pictures(e.Data)) return;
            e.Handled = true;
            AddFrom(e.Data);
        };

        _redraw = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(80) };
        _redraw.Tick += (_, _) =>
        {
            _redraw.Stop();
            Redraw();
        };
        _model.ChatPrefsChanged += OnPrefs;
        Redraw();
    }

    private void OnPrefs()
    {
        FillPickers();
        Redraw();
    }

    /// <summary>The agent picker: in the view's header, or in Quick Chat's bar.</summary>
    public ComboBox Agents { get; }
    /// <summary>Earlier Conversations: the agent's stored sessions.</summary>
    public Button History { get; }
    public Button NewChat { get; }

    public Guid? Space => _space;
    public AgentInfo? Agent => _agent;
    /// <summary>The agent the view shows or waits for, by id.</summary>
    public string? AgentId => _agent?.Id ?? _wantedAgent;
    public string Draft => _field.Text;

    /// <summary>The person picked another agent (Quick Chat remembers it).</summary>
    public event Action<Guid, string>? AgentPicked;

    /// <summary>The agent the view shows changed (the main window's title names it).</summary>
    public event Action? AgentChanged;

    /// <summary>
    /// Shows <paramref name="agent"/> of <paramref name="space"/> (null: the one shown, else Space
    /// Assistant); <paramref name="text"/>, when given, replaces what is in the field and waits
    /// there; <paramref name="session"/> opens that stored conversation.
    /// </summary>
    public void Show(Guid space, string? agent, string? text = null, string? session = null)
    {
        if (_space != space)
        {
            _space = space;
            _wantedAgent = agent;
        }
        else if (agent is not null)
        {
            _wantedAgent = agent;
        }
        _wantedSession = session ?? _wantedSession;
        FillAgents();
        Resolve();
        if (text is not null)
        {
            _field.Text = text;
            _field.CaretIndex = _field.Text.Length;
        }
        _mic?.Check();
    }

    /// <summary>The Space's live state changed: agents may have come, and a run started elsewhere may wait to be followed.</summary>
    public void LiveChanged()
    {
        FillAgents();
        Resolve();
        Attach();
    }

    /// <summary>The view came on screen.</summary>
    public void Shown()
    {
        Attach();
        _conv?.RefreshCards();
        _mic?.Check();
        Redraw();
    }

    /// <summary>The view is gone for good; the conversation goes on in the app.</summary>
    public void Detach()
    {
        if (_conv is not null) _conv.Changed -= Schedule;
        _conv = null;
        _model.ChatPrefsChanged -= OnPrefs;
        _redraw.Stop();
    }

    public void FocusComposer() => Dispatcher.BeginInvoke(DispatcherPriority.Input, () =>
    {
        _field.Focus();
        Keyboard.Focus(_field);
        _field.CaretIndex = _field.Text.Length;
    });

    /// <summary>A picture handed over by the floating ball: attached, never sent by itself.</summary>
    public void AddImage(ChatImage image) => AddPicture(image.Bytes, image.Name);

    /// <summary>Hands the unsent text over to another view (Open in Main Window) and empties this field.</summary>
    public string TakeDraft()
    {
        var text = _field.Text;
        _field.Text = "";
        return text;
    }

    private void Attach()
    {
        if (_conv is not null && _space is { } s && _model.Lives.TryGetValue(s, out var live)) _conv.AttachRunning(live.Running);
    }

    // Agents

    /// <summary>One entry per agent, the local machine's first (as the panel lists them), a peer's named after it.</summary>
    private List<AgentInfo> AgentList()
    {
        if (_space is not { } s || !_model.Lives.TryGetValue(s, out var live)) return [];
        return live.Agents.Where(a => a.Peer is null || !live.Agents.Any(b => b.Peer is null && b.App == a.App && b.Name == a.Name)).ToList();
    }

    private void FillAgents()
    {
        if (Agents.IsDropDownOpen) return;
        _filling = true;
        try
        {
            Agents.Items.Clear();
            foreach (var a in AgentList())
            {
                var title = a.Peer is null ? a.DisplayTitle() : $"{a.DisplayTitle()} · {a.Peer}";
                var item = new ComboBoxItem { Content = title, Tag = a.Id, IsEnabled = !a.Stale };
                Agents.Items.Add(item);
                if (a.Id == AgentId) Agents.SelectedItem = item;
            }
            Agents.Visibility = Agents.Items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _filling = false;
        }
    }

    /// <summary>The agent wanted (or the one shown, else Space Assistant, else the first) and its conversation.</summary>
    private void Resolve()
    {
        if (_space is not { } space || _model.Store.Get(space) is not { } c)
        {
            SetConversation(null, null);
            return;
        }
        var agents = AgentList();
        var agent = (_wantedAgent is { } wanted ? agents.FirstOrDefault(a => a.Id == wanted) ?? agents.FirstOrDefault(a => ChatAgents.LocalId(a) == wanted && a.Peer is null) : null)
            ?? (_agent is { } shown && _wantedAgent is null ? agents.FirstOrDefault(a => a.Id == shown.Id) : null)
            ?? (_wantedAgent is null || agents.Count > 0 ? agents.FirstOrDefault(a => a.Id == "space/assistant") ?? agents.FirstOrDefault(a => !a.Stale) : null);
        if (agent is null)
        {
            // The agents are not known yet: wait for them.
            SetConversation(null, null);
            return;
        }
        _wantedAgent = null;
        SetConversation(agent, _model.Conversation(c, agent));
        if (_wantedSession is { } sid && !_conv!.Busy)
        {
            _wantedSession = null;
            _ = OpenSession(sid);
        }
    }

    private void SetConversation(AgentInfo? agent, ChatConversation? conv)
    {
        var changed = !ReferenceEquals(conv, _conv) || agent?.Id != _agent?.Id;
        _agent = agent;
        if (changed)
        {
            if (_conv is not null) _conv.Changed -= Schedule;
            _conv = conv;
            if (_conv is not null) _conv.Changed += Schedule;
            _drawn.Clear();
            _stickToEnd = true;
            Attach();
            AgentChanged?.Invoke();
        }
        _filling = true;
        try
        {
            Agents.SelectedItem = Agents.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == agent?.Id);
        }
        finally
        {
            _filling = false;
        }
        if (changed) FillPickers();
        Redraw();
    }

    // History

    private async void ShowHistory()
    {
        if (_conv is not { } conv || conv.Busy) return;
        await conv.LoadSessions();
        if (!ReferenceEquals(conv, _conv)) return;
        var menu = new ContextMenu { PlacementTarget = History, Placement = PlacementMode.Bottom };
        if (conv.Sessions.Count == 0) menu.Items.Add(new MenuItem { Header = L.T("No earlier conversations"), IsEnabled = false });
        foreach (var s in conv.Sessions.Take(40))
        {
            var when = s.Ts > 0 ? DateTimeOffset.FromUnixTimeMilliseconds((long)s.Ts).LocalDateTime.ToString("g", System.Globalization.CultureInfo.CurrentCulture) : "";
            var title = s.Title.Length > 0 ? s.Title : L.T("Untitled conversation");
            var item = new MenuItem { Header = title.Length > 60 ? title[..60] + "…" : title, InputGestureText = when, IsChecked = s.Sid == conv.SessionId };
            var session = s;
            item.Click += (_, _) => _ = OpenSession(session.Sid, session);
            menu.Items.Add(item);
        }
        menu.IsOpen = true;
    }

    private async Task OpenSession(string sid, ChatSession? session = null)
    {
        if (_conv is not { } conv) return;
        if (session is null)
        {
            await conv.LoadSessions();
            session = conv.Sessions.FirstOrDefault(s => s.Sid == sid);
        }
        // Continuing a stored conversation keeps the model it ran on.
        if (session is not null && _agent is { } agent && _space is { } space && ChatAgents.SessionChoice(agent, session) is { Length: > 0 } pick)
        {
            _model.SetChatModel(space, agent.Id, pick);
        }
        _stickToEnd = true;
        await conv.Open(sid);
    }

    // Drawing

    private void Schedule()
    {
        if (!_redraw.IsEnabled) _redraw.Start();
    }

    private void FillPickers()
    {
        // Never closes a list under the pointer; it is filled again with the next change.
        if (_permission.IsDropDownOpen || _modelPick.IsDropDownOpen) return;
        _filling = true;
        try
        {
            var permission = _model.ChatPermission;
            _permission.SelectedItem = _permission.Items.OfType<ComboBoxItem>().First(i => (ChatPermission)i.Tag == permission);
            _modelPick.Items.Clear();
            if (_agent is { } agent && _space is { } space)
            {
                var saved = _model.ChatModel(space, agent.Id) ?? "";
                string? group = null;
                foreach (var e in ChatAgents.Entries(agent, saved, ChatText.ModelWords))
                {
                    if (e.Group is { } g && g != group && group is not null) _modelPick.Items.Add(new Separator());
                    if (e.Group is not null) group = e.Group;
                    var item = new ComboBoxItem { Content = e.Label, Tag = e.Value, IsEnabled = e.Enabled };
                    _modelPick.Items.Add(item);
                    if (e.Value == saved) _modelPick.SelectedItem = item;
                }
            }
            _modelPick.Visibility = _modelPick.Items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        finally
        {
            _filling = false;
        }
    }

    private void UpdateComposer()
    {
        var busy = _conv?.Busy == true;
        var empty = _field.Text.Trim().Length == 0 && _images.Count == 0;
        _hint.Text = busy ? L.T("Add to the reply in progress…") : _agent is { } a ? L.F("Message {0}", a.DisplayTitle()) : "";
        _hint.Visibility = _field.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        System.Windows.Automation.AutomationProperties.SetName(_field, _hint.Text);
        _field.IsEnabled = _conv is not null;
        _attach.IsEnabled = _conv is not null && _images.Count < ChatImage.MaxCount;
        _stop.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        _send.Visibility = !busy || !empty ? Visibility.Visible : Visibility.Collapsed;
        _send.IsEnabled = _conv is not null && !empty;
        _modelPick.IsEnabled = !busy;
        History.IsEnabled = _conv is not null && !busy;
        NewChat.IsEnabled = _conv is not null && !busy && _conv.Messages.Count > 0;
    }

    private void Redraw()
    {
        _redraw.Stop();
        UpdateComposer();
        var children = new List<UIElement>();
        var conv = _conv;
        if (conv is null || conv.Messages.Count == 0) children.Add(Intro());
        if (conv is not null)
        {
            var seen = new HashSet<Guid>();
            for (var i = 0; i < conv.Messages.Count; i++)
            {
                var m = conv.Messages[i];
                var last = i == conv.Messages.Count - 1;
                var key = $"{m.Version}|{last}|{conv.Busy}|{_model.ChatPermission}";
                seen.Add(m.Id);
                if (!_drawn.TryGetValue(m.Id, out var drawn) || drawn.Key != key)
                {
                    drawn = (key, m.Role == ChatRole.User ? ChatParts.UserMessage(m) : Reply(conv, m, last));
                    _drawn[m.Id] = drawn;
                }
                if (children.Count > 0) drawn.Element.Margin = new Thickness(drawn.Element.Margin.Left, 14, drawn.Element.Margin.Right, 0);
                children.Add(drawn.Element);
            }
            foreach (var id in _drawn.Keys.Where(k => !seen.Contains(k)).ToList()) _drawn.Remove(id);
            if (conv.Error is { } error)
            {
                var e = Ui.Text("⚠ " + error, 13);
                e.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
                e.Margin = new Thickness(0, 14, 0, 0);
                children.Add(e);
            }
        }
        if (!children.SequenceEqual(_list.Children.OfType<UIElement>()))
        {
            _list.Children.Clear();
            foreach (var c in children) _list.Children.Add(c);
        }
        if (_stickToEnd) Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () => _scroll.ScrollToEnd());
    }

    /// <summary>The agent before the first message: its name and what it does; Quick Chat lists its keys.</summary>
    private FrameworkElement Intro()
    {
        var column = new StackPanel { Margin = new Thickness(0, 4, 0, 0) };
        if (_agent is not { } agent)
        {
            var known = _space is { } s && _model.Lives.TryGetValue(s, out var live) && live.Status == LiveStatus.Ok;
            column.Children.Add(Ui.Text(known && AgentList().Count == 0 ? L.T("This Space has no agent to chat with.") : L.T("Connecting…"), 13, secondary: true));
            return column;
        }
        if (!_compact)
        {
            var name = Ui.Row(Ui.Glyph(Ui.Agent, 22), Ui.Text(agent.DisplayTitle(), 17, bold: true, wrap: false));
            column.Children.Add(name);
        }
        if (agent.Description is { Length: > 0 } d)
        {
            var text = Ui.Text(Lang.Pick(d, agent.I18n, false), 13, secondary: true);
            text.Margin = new Thickness(_compact ? 0 : 30, 4, 0, 0);
            column.Children.Add(text);
        }
        if (_compact)
        {
            var keys = Ui.Text(L.T("Enter sends · Shift+Enter starts a new line · Esc closes"), 12, secondary: true);
            keys.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorTertiaryBrush");
            keys.Margin = new Thickness(0, 8, 0, 0);
            column.Children.Add(keys);
        }
        return column;
    }

    private void OpenLink(Uri url)
    {
        if (_space is { } s) _model.OpenLink(url, s);
        else AppModel.OpenOutside(url);
    }

    /// <summary>An agent's reply: its steps in order (or its text), what waits to be read, the status row, cards, refusals and failure.</summary>
    private StackPanel Reply(ChatConversation conv, ChatMessage m, bool last)
    {
        var column = new StackPanel { Margin = new Thickness(0, 0, 24, 0) };
        void Add(FrameworkElement e, double gap = 10)
        {
            if (column.Children.Count > 0) e.Margin = new Thickness(e.Margin.Left, gap, e.Margin.Right, e.Margin.Bottom);
            column.Children.Add(e);
        }
        if (m.Steps.Count == 0)
        {
            if (m.Text.Length > 0) Add(ChatParts.Markdown(m.Text, OpenLink));
        }
        else
        {
            foreach (var group in ChatTools.Groups(m.Steps))
            {
                var step = group[0];
                if (step.Kind == ChatStepKind.Tool)
                {
                    // Consecutive calls stack as one tight list; a past session's run of two or more folds to one line.
                    if (group.Count > 1 && m.Historic) Add(ChatParts.ToolFold(group, _expanded), 6);
                    else Add(Ui.Column(0, [.. group.Select(s => ChatParts.ToolRow(s, _expanded))]), 6);
                    continue;
                }
                switch (step.Kind)
                {
                    case ChatStepKind.Text:
                        Add(ChatParts.Markdown(step.Text, OpenLink));
                        break;
                    case ChatStepKind.Approval when step.Questions.Count > 0:
                        Add(QuestionCard(conv, m, step));
                        break;
                    case ChatStepKind.Approval:
                        Add(ApprovalCard(conv, m, step));
                        break;
                    default:
                        Add(ChatParts.SteerRow(step.Text, pending: false));
                        break;
                }
            }
            if (m.Note is { } note) Add(Ui.Text("⚠ " + note, 13, secondary: true));
            if (!m.Live && m.Stopped) Add(Ui.Text(L.T("(stopped)"), 12, secondary: true), 6);
        }
        foreach (var p in m.Pending) Add(ChatParts.SteerRow(p, pending: true), 8);
        if (m.Activity is { } activity) Add(ChatParts.Status(ChatText.Activity(activity)), 8);
        if (m.Live && m.Steps.FirstOrDefault(s => s.Kind == ChatStepKind.Approval && s.State == ChatStepState.Waiting) is { } waiting)
        {
            Add(Ui.Text(waiting.Questions.Count == 0 ? L.T("Waiting for your approval…") : L.T("Waiting for your answer…"), 13, secondary: true), 8);
        }
        if (m.Cards.Count > 0)
        {
            var actionable = conv.CardsActionable(m);
            foreach (var card in m.Cards)
            {
                var shown = card;
                Add(ChatParts.Card(card, actionable, ids => _ = conv.UndoCard(m, shown, ids), OpenLink));
            }
        }
        // With live chat a refusal is an approval card; this is for runtimes that cannot ask.
        if (m.Denied.Count > 0 && !m.Steps.Any(s => s.Kind == ChatStepKind.Approval))
        {
            Add(ChatParts.Denied(m.Denied, _model.ChatPermission.Granting(m.Denied.ToList()), last && !conv.Busy && !m.Live ? conv.GrantAndRetry : null));
        }
        if (m.Failure is { } failure) Add(ChatParts.FailureCard(failure, last && conv.RetryableMessage is not null ? conv.Retry : null));
        column.ContextMenu = ChatParts.CopyMenu(m.Text);
        if (column.Children.Count == 0) column.Children.Add(ChatParts.Status(ChatText.Activity(ChatActivity.Starting)));
        return column;
    }

    // Approvals and questions (docs/runtimes.md#live-chat): nothing is allowed without an explicit choice here.

    private FrameworkElement ApprovalCard(ChatConversation conv, ChatMessage m, ChatStep step)
    {
        var waiting = step.State == ChatStepState.Waiting && m.Live;
        var (background, border, status) = step.State switch
        {
            ChatStepState.Waiting => ("SystemFillColorAttentionBackgroundBrush", "AccentFillColorDefaultBrush", L.T("Waiting for you")),
            ChatStepState.Allowed => ("SystemFillColorSuccessBackgroundBrush", "SystemFillColorSuccessBrush", L.T("Allowed")),
            ChatStepState.Denied => ("SystemFillColorCriticalBackgroundBrush", "SystemFillColorCriticalBrush", L.T("Denied")),
            ChatStepState.Cancelled => ("SubtleFillColorSecondaryBrush", "CardStrokeColorDefaultBrush", L.T("Not answered")),
            _ => ("SubtleFillColorSecondaryBrush", "CardStrokeColorDefaultBrush", ""),
        };
        var column = new StackPanel();
        column.Children.Add(CardHead("", step.Title, status));
        if (step.Text.Length > 0)
        {
            var text = ChatParts.Code(step.Text, 12, wrap: true);
            text.MaxHeight = 160;
            text.Margin = new Thickness(0, 6, 0, 0);
            column.Children.Add(text);
        }
        if (step.Output.Length > 0)
        {
            var why = Ui.Text(step.Output, 12, secondary: true);
            why.Margin = new Thickness(0, 4, 0, 0);
            column.Children.Add(why);
        }
        if (waiting)
        {
            var allow = Ui.Button(L.T("Allow"), () => Reply(conv, m, step, true, null), accent: true);
            var deny = Ui.Button(L.T("Deny"), () => Reply(conv, m, step, false, null));
            var row = Ui.Row(allow, deny);
            row.Margin = new Thickness(0, 8, 0, 0);
            row.IsEnabled = !_answering.Contains(step.Id);
            column.Children.Add(row);
        }
        AnswerError(column, step);
        return ChatParts.Box(column, background, border, 12);
    }

    private static DockPanel CardHead(string glyph, string title, string status)
    {
        var head = new DockPanel();
        if (status.Length > 0)
        {
            var s = Ui.Text(status, 12, secondary: true, wrap: false);
            s.VerticalAlignment = VerticalAlignment.Center;
            DockPanel.SetDock(s, Dock.Right);
            head.Children.Add(s);
        }
        var g = Ui.Glyph(glyph, 14);
        g.Margin = new Thickness(0, 0, 8, 0);
        g.SetResourceReference(TextBlock.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
        DockPanel.SetDock(g, Dock.Left);
        head.Children.Add(g);
        head.Children.Add(Ui.Text(title, 13.5, bold: true));
        return head;
    }

    private void AnswerError(StackPanel column, ChatStep step)
    {
        if (!_answerErrors.TryGetValue(step.Id, out var error)) return;
        var e = Ui.Text(error, 12);
        e.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        e.Margin = new Thickness(0, 6, 0, 0);
        column.Children.Add(e);
    }

    /// <summary>
    /// A question the agent asks while its turn runs: pick an option or type an answer. One
    /// question with one choice goes back on the click; otherwise the answers go with Send. Skip
    /// answers nothing and the agent goes on without it.
    /// </summary>
    private FrameworkElement QuestionCard(ChatConversation conv, ChatMessage m, ChatStep step)
    {
        var waiting = step.State == ChatStepState.Waiting && m.Live;
        var status = step.State switch
        {
            ChatStepState.Waiting => L.T("Waiting for you"),
            ChatStepState.Allowed => L.T("Answered"),
            ChatStepState.Denied => L.T("Skipped"),
            ChatStepState.Cancelled => L.T("Not answered"),
            _ => "",
        };
        if (!_picked.TryGetValue(step.Id, out var picked)) _picked[step.Id] = picked = [];
        if (!_typed.TryGetValue(step.Id, out var typed)) _typed[step.Id] = typed = [];
        var questions = step.Questions;
        Dictionary<string, IReadOnlyList<string>> Answers() => questions.ToDictionary(q => q.Id, q => q.Answer(picked.GetValueOrDefault(q.Id) ?? [], typed.GetValueOrDefault(q.Id) ?? ""));
        bool Ready() => Answers().Values.All(a => a.Count > 0);
        var sending = _answering.Contains(step.Id);
        var column = new StackPanel();
        column.Children.Add(CardHead("", L.T("Question"), status));
        var send = Ui.Button(L.T("Send"), () =>
        {
            if (Ready()) Reply(conv, m, step, true, Answers());
        }, accent: true);
        void Update()
        {
            send.Visibility = questions.Count > 1 || questions.Any(q => q.MultiSelect) || typed.Values.Any(t => t.Trim().Length > 0) ? Visibility.Visible : Visibility.Collapsed;
            send.IsEnabled = Ready() && !sending;
        }
        foreach (var q in questions)
        {
            var part = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
            if (q.Header.Length > 0) part.Children.Add(Ui.Text(q.Header, 12, secondary: true, bold: true));
            part.Children.Add(Ui.Text(q.Question, 13.5));
            if (waiting)
            {
                var options = new List<(ChatQuestionOption Option, Border Face)>();
                void Mark()
                {
                    var typing = !q.MultiSelect && (typed.GetValueOrDefault(q.Id) ?? "").Trim().Length > 0;
                    foreach (var (o, face) in options)
                    {
                        var on = (picked.GetValueOrDefault(q.Id) ?? []).Contains(o.Label) && !typing;
                        face.SetResourceReference(Border.BorderBrushProperty, on ? "AccentFillColorDefaultBrush" : "CardStrokeColorDefaultBrush");
                        face.SetResourceReference(Border.BackgroundProperty, on ? "SystemFillColorAttentionBackgroundBrush" : "CardBackgroundFillColorDefaultBrush");
                    }
                }
                foreach (var o in q.Options)
                {
                    var label = Ui.Column(2, Ui.Text(o.Label, 13, bold: true));
                    if (o.Description.Length > 0) label.Children.Add(Ui.Text(o.Description, 12, secondary: true));
                    var face = new Border { Child = label, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(12, 7, 12, 7) };
                    var b = new Button { Content = face, Padding = new Thickness(0), Background = Brushes.Transparent, BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(0, 6, 0, 0), IsEnabled = !sending };
                    System.Windows.Automation.AutomationProperties.SetName(b, o.Label);
                    var option = o;
                    b.Click += (_, _) =>
                    {
                        var current = picked.GetValueOrDefault(q.Id) ?? [];
                        picked[q.Id] = q.MultiSelect ? (current.Contains(option.Label) ? current.Where(l => l != option.Label).ToList() : [.. current, option.Label]) : [option.Label];
                        if (!q.MultiSelect) typed[q.Id] = "";
                        Mark();
                        Update();
                        if (questions.Count == 1 && !q.MultiSelect) Reply(conv, m, step, true, Answers());
                    };
                    options.Add((o, face));
                    part.Children.Add(b);
                }
                var field = new TextBox { Text = typed.GetValueOrDefault(q.Id) ?? "", Margin = new Thickness(0, 6, 0, 0), IsEnabled = !sending };
                System.Windows.Automation.AutomationProperties.SetName(field, L.T("Your answer"));
                var hint = Ui.Text(q.Options.Count == 0 ? L.T("Your answer") : L.T("Or type your own answer"), 13, secondary: true, wrap: false);
                hint.IsHitTestVisible = false;
                hint.Margin = new Thickness(11, 6, 0, 0);
                hint.VerticalAlignment = VerticalAlignment.Center;
                hint.Visibility = field.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                field.TextChanged += (_, _) =>
                {
                    typed[q.Id] = field.Text;
                    hint.Visibility = field.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                    Mark();
                    Update();
                };
                field.KeyDown += (_, e) =>
                {
                    if (e.Key != Key.Enter || !Ready()) return;
                    e.Handled = true;
                    Reply(conv, m, step, true, Answers());
                };
                var host = new Grid();
                host.Children.Add(field);
                host.Children.Add(hint);
                part.Children.Add(host);
                Mark();
            }
            else if (step.Answers.GetValueOrDefault(q.Id) is { Count: > 0 } shown)
            {
                var a = Ui.Text("→ " + string.Join(", ", shown), 13, bold: true);
                a.SetResourceReference(TextBlock.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
                part.Children.Add(a);
            }
            column.Children.Add(part);
        }
        if (waiting)
        {
            var skip = Ui.Button(L.T("Skip"), () => Reply(conv, m, step, false, null));
            skip.IsEnabled = !sending;
            var row = Ui.Row(send, skip);
            row.Margin = new Thickness(0, 10, 0, 0);
            column.Children.Add(row);
            Update();
        }
        AnswerError(column, step);
        return ChatParts.Box(column, waiting ? "SystemFillColorAttentionBackgroundBrush" : "SubtleFillColorSecondaryBrush", waiting ? "AccentFillColorDefaultBrush" : "CardStrokeColorDefaultBrush", 12);
    }

    private async void Reply(ChatConversation conv, ChatMessage m, ChatStep step, bool allow, IReadOnlyDictionary<string, IReadOnlyList<string>>? answers)
    {
        if (!_answering.Add(step.Id)) return;
        _answerErrors.Remove(step.Id);
        m.Version++;
        Redraw();
        var error = await conv.Answer(step.RequestId, allow, answers);
        _answering.Remove(step.Id);
        if (error is not null) _answerErrors[step.Id] = error;
        m.Version++;
        Redraw();
    }

    // Sending

    private void OnFieldKey(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter && (Keyboard.Modifiers & ModifierKeys.Shift) == 0 && (Keyboard.Modifiers & ModifierKeys.Control) == 0)
        {
            e.Handled = true;
            Send();
        }
        else if (e.Key == Key.V && Keyboard.Modifiers == ModifierKeys.Control && PasteImage())
        {
            e.Handled = true;
        }
    }

    private void Send()
    {
        if (_conv is not { } conv) return;
        var text = _field.Text.Trim();
        if (text.Length == 0 && _images.Count == 0) return;
        conv.Send(text, _images);
        _field.Text = "";
        _images = [];
        _imageError.Visibility = Visibility.Collapsed;
        DrawAttachments();
        _stickToEnd = true;
        Redraw();
    }

    // Pictures

    private static bool Pictures(IDataObject data) => data.GetDataPresent(DataFormats.FileDrop) || data.GetDataPresent(DataFormats.Bitmap);

    private void ChooseImages()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Multiselect = true,
            Title = L.T("Add images"),
            Filter = L.T("Images") + "|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.tif;*.tiff;*.heic",
        };
        if (dialog.ShowDialog(Window.GetWindow(this)) != true) return;
        foreach (var f in dialog.FileNames) AddFile(f);
        FocusComposer();
    }

    private bool PasteImage()
    {
        try
        {
            if (Clipboard.ContainsFileDropList())
            {
                var files = Clipboard.GetFileDropList().Cast<string>().Where(IsPictureFile).ToList();
                if (files.Count == 0) return false;
                foreach (var f in files) AddFile(f);
                return true;
            }
            if (Clipboard.ContainsImage() && Clipboard.GetImage() is { } bitmap)
            {
                AddPicture(Png(bitmap), "Image.png");
                return true;
            }
        }
        catch (System.Runtime.InteropServices.COMException e)
        {
            Log.Write($"chat: paste: {e.Message}");
        }
        return false;
    }

    private static bool IsPictureFile(string path) => System.IO.Path.GetExtension(path).ToLowerInvariant() is ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" or ".bmp" or ".tif" or ".tiff" or ".heic";

    private void AddFrom(IDataObject data)
    {
        if (data.GetData(DataFormats.FileDrop) is string[] files)
        {
            foreach (var f in files) AddFile(f);
        }
        else if (data.GetData(DataFormats.Bitmap) is BitmapSource bitmap)
        {
            AddPicture(Png(bitmap), "Image.png");
        }
        FocusComposer();
    }

    private void AddFile(string path)
    {
        try
        {
            // Far over the limit even before conversion: not read at all.
            if (new FileInfo(path).Length > ChatImage.MaxBytes * 4L)
            {
                ImageError(L.T("Add up to 4 images, 5 MB each and 10 MB in total."));
                return;
            }
            AddPicture(File.ReadAllBytes(path), System.IO.Path.GetFileName(path));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException)
        {
            ImageError(L.T("Could not read this image."));
        }
    }

    /// <summary>A picture in a type the Space takes as it is (PNG, JPEG, GIF, WebP), any other the system can read as PNG.</summary>
    private void AddPicture(byte[] bytes, string name)
    {
        var type = ChatImage.TypeOf(bytes);
        if (type is null)
        {
            try
            {
                var frame = BitmapDecoder.Create(new MemoryStream(bytes), BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
                bytes = Png(frame);
                type = "image/png";
                name = System.IO.Path.ChangeExtension(name, ".png");
            }
            catch (Exception e) when (e is NotSupportedException or FileFormatException or IOException or ArgumentException or InvalidOperationException)
            {
                ImageError(L.T("Could not read this image."));
                return;
            }
        }
        var next = _images.Append(new ChatImage(name, type, bytes)).ToList();
        if (!ChatImage.Validate(next))
        {
            ImageError(L.T("Add up to 4 images, 5 MB each and 10 MB in total."));
            return;
        }
        _images = next;
        _imageError.Visibility = Visibility.Collapsed;
        DrawAttachments();
        UpdateComposer();
    }

    private static byte[] Png(BitmapSource source)
    {
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(source));
        using var stream = new MemoryStream();
        encoder.Save(stream);
        return stream.ToArray();
    }

    private void ImageError(string text)
    {
        _imageError.Text = text;
        _imageError.Visibility = Visibility.Visible;
    }

    private void DrawAttachments()
    {
        _attachments.Children.Clear();
        foreach (var image in _images)
        {
            var remove = new Button { Content = Ui.Glyph(Ui.Close, 9), Padding = new Thickness(4), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top, ToolTip = L.T("Remove image"), Margin = new Thickness(0, 2, 8, 0) };
            System.Windows.Automation.AutomationProperties.SetName(remove, L.T("Remove image"));
            var shown = image;
            remove.Click += (_, _) =>
            {
                _images = _images.Where(i => !ReferenceEquals(i, shown)).ToList();
                DrawAttachments();
                UpdateComposer();
            };
            var cell = new Grid();
            cell.Children.Add(ChatParts.Thumbnail(image, 64));
            cell.Children.Add(remove);
            _attachments.Children.Add(cell);
        }
        _attachments.Visibility = _images.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}
