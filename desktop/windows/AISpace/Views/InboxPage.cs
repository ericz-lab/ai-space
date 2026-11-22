using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Inbox: every app's notifications as threads (docs/windows-desktop.md#inbox; the web's
/// src/web/Inbox.tsx, the Mac's <c>InboxPage</c>, the Linux client's <c>app/inbox.ts</c>). The
/// server groups an app's notifications with the same key into one thread with a count; the page
/// lists them newest first under a filter (All, Unread, To handle, Done) and an app. Opening a
/// thread shows its text and marks it read; from there its link opens (<see cref="PageContext.OpenLink"/>),
/// and Mark as Done, Reopen and Mark as Unread change it; Mark as Read and Done are also on the row.
/// The list is fetched when the page is shown, after each background look at the Space
/// (<see cref="NativePage.LiveChanged"/>, every 30 seconds) and on F5; a change asks the Space
/// for a fresh look too, so the bar's, the tray's and the taskbar's counts follow.
/// </summary>
internal sealed class InboxPage : NativePage
{
    private static readonly InboxFilter[] Filters = [InboxFilter.All, InboxFilter.Unread, InboxFilter.Handle, InboxFilter.Done];

    private readonly Grid _root = new();
    private readonly TextBlock _summary = Ui.Text("", 13, secondary: true, wrap: false);
    private readonly Button _readAll;
    private readonly ComboBox _appChoice = new() { MinWidth = 160, Margin = new Thickness(0, 0, 0, 6), VerticalAlignment = VerticalAlignment.Top };
    private readonly StackPanel _list = new();
    private readonly ContentControl _state = new() { Focusable = false, Margin = new Thickness(0, 24, 0, 0) };
    private readonly TextBlock _error = Ui.Text("", 13);

    private InboxFilter _filter = InboxFilter.All;
    private string _app = "";
    private IReadOnlyList<InboxThread>? _items;
    private InboxSummary? _counts;
    private IReadOnlyList<string> _apps = [];
    private string? _open;
    private string _key = "";
    private int _request;
    private bool _stale = true;
    private bool _fillingApps;
    /// <summary>The thread whose row had the keyboard before the list was drawn again.</summary>
    private string? _focus;
    /// <summary>Each row's button, by thread, to put the keyboard back on it.</summary>
    private readonly Dictionary<string, Button> _toggles = [];

    public InboxPage(PageContext context) : base(context)
    {
        var title = Ui.Text(L.T("Inbox"), 26, bold: true, wrap: false);
        _readAll = Ui.Button(L.T("Mark All as Read"), ReadAll);
        _readAll.IsEnabled = false;
        var refresh = Ui.IconButton(Ui.Refresh, L.T("Reload"), Refresh);
        var head = new DockPanel { LastChildFill = true };
        var actions = Ui.Row(refresh, _readAll);
        actions.VerticalAlignment = VerticalAlignment.Center;
        DockPanel.SetDock(actions, Dock.Right);
        head.Children.Add(actions);
        var titles = Ui.Column(2, title, _summary);
        head.Children.Add(titles);

        var labels = new[] { L.T("All"), L.T("Unread"), L.T("To Handle"), L.T("Done") };
        var (filters, _) = InboxParts.Choice(L.T("Filter"), labels, 0, i =>
        {
            _filter = Filters[i];
            _open = null;
            _items = null;
            Reload();
        });
        filters.Margin = new Thickness(0, 0, 12, 0);
        System.Windows.Automation.AutomationProperties.SetName(_appChoice, L.T("App"));
        _appChoice.SelectionChanged += (_, _) =>
        {
            if (_fillingApps || _appChoice.SelectedItem is not ComboBoxItem { Tag: string app } || app == _app) return;
            _app = app;
            _open = null;
            _items = null;
            Reload();
        };
        FillApps();
        var bar = new DockPanel { Margin = new Thickness(0, 16, 0, 4) };
        DockPanel.SetDock(_appChoice, Dock.Right);
        bar.Children.Add(_appChoice);
        bar.Children.Add(filters);

        _error.Visibility = Visibility.Collapsed;
        _error.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        _error.Margin = new Thickness(0, 8, 0, 0);
        _list.Margin = new Thickness(0, 8, 0, 0);

        var column = new StackPanel();
        column.Children.Add(head);
        column.Children.Add(bar);
        column.Children.Add(_error);
        column.Children.Add(_state);
        column.Children.Add(_list);
        _root.Children.Add(Ui.PageFrame(column, 920));
        Content = _root;
        Draw();
    }

    public override string Title => L.T("Inbox");

    public override void Shown()
    {
        if (_stale || _items is null) Reload();
    }

    public override void LiveChanged()
    {
        if (IsShown) Reload(quiet: true);
        else _stale = true;
    }

    public override void Refresh() => Reload();

    public override void Close() => _request++;

    /// <summary>Fetches the list again; <paramref name="quiet"/> keeps what is shown until the answer comes (a background look).</summary>
    private void Reload(bool quiet = false)
    {
        if (Context.Api is not { } api) return;
        _stale = false;
        var mine = ++_request;
        if (!quiet && _items is null) Draw();
        var filter = _filter;
        var app = _app;
        InboxParts.Run(async () =>
        {
            var (items, summary) = await api.InboxThreads(filter, app.Length == 0 ? null : app);
            if (mine != _request) return;
            _items = items;
            _counts = summary;
            _apps = InboxRules.Apps(_apps, items);
            _error.Visibility = Visibility.Collapsed;
            FillApps();
            Draw();
        }, e =>
        {
            if (mine != _request) return;
            _stale = true;
            // A sign-in is the window's to ask for; the list stays as it was meanwhile.
            if (e.Kind == SpaceApiFailure.AuthenticationRequired) return;
            ShowError(L.F("The inbox could not be loaded: {0}", InboxParts.Message(e)));
        });
    }

    private void ShowError(string text)
    {
        _error.Text = text;
        _error.Visibility = Visibility.Visible;
        if (_items is null) Draw();
    }

    /// <summary>The app menu: All Apps, then every app seen so far.</summary>
    private void FillApps()
    {
        var wanted = new[] { "" }.Concat(_apps).ToList();
        if (_appChoice.Items.Count == wanted.Count && _appChoice.Items.OfType<ComboBoxItem>().Select(i => (string)i.Tag).SequenceEqual(wanted)) return;
        _fillingApps = true;
        _appChoice.Items.Clear();
        foreach (var app in wanted)
        {
            var item = new ComboBoxItem { Content = app.Length == 0 ? L.T("All Apps") : app, Tag = app };
            _appChoice.Items.Add(item);
            if (app == _app) _appChoice.SelectedItem = item;
        }
        _fillingApps = false;
    }

    private void Draw()
    {
        _summary.Text = _counts is { } s ? L.F("{0} unread · {1} to handle", s.Unread, s.Open) : "";
        _readAll.IsEnabled = _counts is { Unread: > 0 };
        var items = _items;
        if (items is null)
        {
            _key = "";
            _list.Children.Clear();
            _state.Content = _error.Visibility == Visibility.Visible ? null : Ui.Text(L.T("Loading the inbox…"), 13, secondary: true);
            return;
        }
        _state.Content = items.Count > 0 ? null : _filter == InboxFilter.All && _app.Length == 0
            ? Ui.EmptyState(Ui.Inbox, L.T("Nothing here yet"), L.T("Apps' notifications arrive here: results, reports and failures, one thread each."))
            : Ui.EmptyState(Ui.Inbox, L.T("Nothing matches this filter"));
        var key = InboxRules.Key(items) + "\n" + _open;
        if (key == _key) return;
        _key = key;
        _focus ??= _toggles.FirstOrDefault(t => t.Value.IsKeyboardFocusWithin).Key;
        _list.Children.Clear();
        _toggles.Clear();
        foreach (var item in items) _list.Children.Add(Row(item));
        if (_focus is { } focus)
        {
            _focus = null;
            if (_toggles.TryGetValue(focus, out var toggle)) Dispatcher.BeginInvoke(() => toggle.Focus(), System.Windows.Threading.DispatcherPriority.Input);
        }
    }

    /// <summary>One thread: its dot, title, count and time, its app and state; open, its text and actions.</summary>
    private FrameworkElement Row(InboxThread item)
    {
        var open = _open == item.Thread;

        var heading = Ui.Text(item.Heading, 14, bold: item.Unread, wrap: false);
        if (item.Done) heading.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        var line = new DockPanel { LastChildFill = true };
        var when = Ui.Text(InboxParts.When(item.LastAt), 12, secondary: true, wrap: false);
        when.ToolTip = InboxParts.Full(item.LastAt);
        when.Margin = new Thickness(8, 0, 0, 0);
        when.VerticalAlignment = VerticalAlignment.Center;
        DockPanel.SetDock(when, Dock.Right);
        line.Children.Add(when);
        if (item.Count > 1)
        {
            var count = InboxParts.Tag("×" + item.Count.ToString(System.Globalization.CultureInfo.CurrentCulture));
            count.Margin = new Thickness(6, 0, 0, 0);
            DockPanel.SetDock(count, Dock.Right);
            line.Children.Add(count);
        }
        line.Children.Add(heading);

        var meta = new WrapPanel();
        void Meta(UIElement e)
        {
            if (e is FrameworkElement f) f.Margin = new Thickness(0, 0, 8, 0);
            meta.Children.Add(e);
        }
        Meta(InboxParts.Tag(item.App));
        if (item.NeedsAction)
        {
            var needs = Ui.Text(L.T("needs action"), 12, wrap: false);
            needs.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCautionBrush");
            Meta(needs);
        }
        if (item.Done) Meta(Ui.Text(L.T("done"), 12, secondary: true, wrap: false));
        if (!string.IsNullOrWhiteSpace(item.Title) && !open)
        {
            var first = Ui.Text(InboxRules.FirstLine(item.Text), 12, secondary: true, wrap: false);
            first.MaxWidth = 560;
            Meta(first);
        }

        var dot = InboxParts.Dot(InboxRules.Tone(item.Level));
        dot.VerticalAlignment = VerticalAlignment.Top;
        dot.Margin = new Thickness(0, 7, 12, 0);
        // An unread thread's dot is full; a read one's faint.
        dot.Opacity = item.Unread ? 1 : 0.35;
        var face = new DockPanel();
        DockPanel.SetDock(dot, Dock.Left);
        face.Children.Add(dot);
        face.Children.Add(Ui.Column(4, line, meta));

        var toggle = new Button
        {
            Content = face,
            Padding = new Thickness(12, 10, 12, 10),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            ToolTip = open ? null : L.T("Show the message"),
        };
        System.Windows.Automation.AutomationProperties.SetName(toggle, AccessibleName(item));
        System.Windows.Automation.AutomationProperties.SetHelpText(toggle, InboxRules.FirstLine(item.Text));
        toggle.Click += (_, _) => Toggle(item);
        _toggles[item.Thread] = toggle;

        // Quick actions beside the row: Mark as Read while unread, Done or Reopen.
        var quick = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 6, 0) };
        if (item.Unread) quick.Children.Add(Ui.IconButton("", L.T("Mark as Read"), () => Mark(item, read: true)));
        quick.Children.Add(item.Done
            ? Ui.IconButton("", L.T("Reopen"), () => Mark(item, done: false))
            : Ui.IconButton(Ui.Accept, L.T("Mark as Done"), () => Mark(item, done: true)));

        var top = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(quick, Dock.Right);
        top.Children.Add(quick);
        top.Children.Add(toggle);

        var body = new StackPanel();
        body.Children.Add(top);
        if (open) body.Children.Add(Detail(item));

        var card = new Border { Child = body, CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Margin = new Thickness(0, 0, 0, 6), Tag = item.Thread };
        card.SetResourceReference(Border.BackgroundProperty, item.Unread ? "CardBackgroundFillColorDefaultBrush" : "CardBackgroundFillColorSecondaryBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        return card;
    }

    /// <summary>An open thread: its whole text, how often it came, and what can be done with it.</summary>
    private FrameworkElement Detail(InboxThread item)
    {
        var panel = new StackPanel { Margin = new Thickness(32, 0, 16, 14) };
        var text = Ui.Text(item.Text, 14);
        text.Margin = new Thickness(0, 0, 0, 8);
        panel.Children.Add(text);
        var when = item.Count > 1 && item.FirstAt is { } first
            ? L.F("{0} times since {1}", item.Count, InboxParts.Full(first))
            : InboxParts.Full(item.LastAt);
        if (when.Length > 0) panel.Children.Add(Ui.Text(when, 12, secondary: true));

        var buttons = new WrapPanel { Margin = new Thickness(0, 10, 0, 0) };
        void Add(Button b)
        {
            b.Margin = new Thickness(0, 0, 8, 4);
            buttons.Children.Add(b);
        }
        if (!string.IsNullOrEmpty(item.Url)) Add(Ui.Button(L.T("Open Link"), () => Context.OpenLink(item.Url!), accent: true));
        Add(item.Done ? Ui.Button(L.T("Reopen"), () => Mark(item, done: false)) : Ui.Button(L.T("Mark as Done"), () => Mark(item, done: true)));
        if (!item.Done) Add(Ui.Button(L.T("Mark as Unread"), () => Mark(item, read: false)));
        panel.Children.Add(buttons);
        return panel;
    }

    private static string AccessibleName(InboxThread item)
    {
        var parts = new List<string> { item.Heading, item.App };
        if (item.Unread) parts.Add(L.T("Unread"));
        if (item.NeedsAction) parts.Add(L.T("needs action"));
        if (item.Done) parts.Add(L.T("done"));
        if (item.Count > 1) parts.Add(L.F("{0} times", item.Count));
        parts.Add(InboxParts.When(item.LastAt));
        return string.Join(", ", parts);
    }

    /// <summary>Opens or closes a thread; opening an unread one marks it read, as the web panel does.</summary>
    private void Toggle(InboxThread item)
    {
        _focus = item.Thread;
        _open = _open == item.Thread ? null : item.Thread;
        if (_open is not null && item.Unread) Mark(item, read: true);
        else Draw();
    }

    /// <summary>Shows the change at once, sends it, then reads the list and the Space's counts again.</summary>
    private void Mark(InboxThread item, bool? read = null, bool? done = null)
    {
        if (Context.Api is not { } api || _items is null) return;
        _focus ??= item.Thread;
        _items = [.. _items.Select(i => i.Thread == item.Thread ? InboxRules.Marked(i, read, done) : i)];
        Draw();
        InboxParts.Run(async () =>
        {
            _counts = await api.MarkInbox([item.Thread], read, done);
            Draw();
            if (done == true && _open == item.Thread) _open = null;
            Changed(done == true ? L.T("Marked as done") : null);
        }, e =>
        {
            Ui.Toast(_root, L.F("The change was not saved: {0}", InboxParts.Message(e)), error: true);
            Reload(quiet: true);
        });
    }

    private void ReadAll()
    {
        if (Context.Api is not { } api) return;
        var app = _app;
        _readAll.IsEnabled = false;
        InboxParts.Run(async () =>
        {
            _counts = await api.ReadAllInbox(app.Length == 0 ? null : app);
            Changed(null);
        }, e =>
        {
            _readAll.IsEnabled = true;
            Ui.Toast(_root, L.F("The change was not saved: {0}", InboxParts.Message(e)), error: true);
        });
    }

    /// <summary>After a change: the list again, and a fresh look at the Space for the bar's, tray's and taskbar's counts.</summary>
    private void Changed(string? note)
    {
        if (note is not null) Ui.Toast(_root, note, seconds: 2.5);
        Reload(quiet: true);
        if (Context.Live is { } live) _ = live.Refresh();
    }
}
