using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Shortcuts: the Space's action catalogue and its recent runs (docs/windows-desktop.md#shortcuts,
/// docs/shortcuts.md; the web's src/web/Shortcuts.tsx). The catalogue has a search over every
/// language's words; the actions that can run come first, and one that cannot says what it misses.
/// Choosing one opens its form (<see cref="ShortcutRunner"/>) under the catalogue; the recent runs
/// follow, each opening to its result. A run executes in the Space: leaving the page does not stop
/// it, and the list shows it when the page comes back. The runs are read again every 15 seconds
/// while the page is shown, every 2 while one is running.
/// </summary>
internal sealed class ShortcutsPage : NativePage
{
    private readonly Grid _root = new();
    private readonly FrameworkElement _search;
    private readonly WrapPanel _catalogue = new() { Orientation = Orientation.Horizontal };
    private readonly ContentControl _state = new() { Focusable = false };
    private readonly Border _selected;
    private readonly StackPanel _runsList = new();
    private readonly TextBlock _error = Ui.Text("", 13);
    private readonly DispatcherTimer _poll = new();
    private IReadOnlyList<ShortcutAction>? _actions;
    private IReadOnlyList<ShortcutRun> _runs = [];
    private string _query = "";
    private string? _selectedKey;
    private ShortcutRunner? _runner;
    private long? _openRun;
    /// <summary>The run row the person just opened or closed, to keep the keyboard on it when the list is drawn again.</summary>
    private long? _focusRun;
    private string _runsKey = "";
    private int _request;

    public ShortcutsPage(PageContext context) : base(context)
    {
        var title = Ui.Text(L.T("Shortcuts"), 26, bold: true, wrap: false);
        var blurb = Ui.Text(L.T("Actions the command box runs: calculate, convert, query apps, create, run tasks."), 13, secondary: true);
        var head = new DockPanel { LastChildFill = true };
        var refresh = Ui.IconButton(Ui.Refresh, L.T("Reload"), Refresh);
        refresh.VerticalAlignment = VerticalAlignment.Top;
        DockPanel.SetDock(refresh, Dock.Right);
        head.Children.Add(refresh);
        head.Children.Add(Ui.Column(2, title, blurb));

        _search = Ui.SearchBox(L.T("Find an action"), q =>
        {
            _query = q;
            DrawCatalogue();
        });
        _search.Margin = new Thickness(0, 16, 0, 12);
        _search.MaxWidth = 480;
        _search.HorizontalAlignment = HorizontalAlignment.Left;

        _selected = Ui.Card(new Grid(), 20);
        _selected.Margin = new Thickness(0, 8, 0, 0);
        _selected.Visibility = Visibility.Collapsed;

        _error.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        _error.Visibility = Visibility.Collapsed;
        _error.Margin = new Thickness(0, 8, 0, 0);
        System.Windows.Automation.AutomationProperties.SetName(_catalogue, L.T("Actions"));

        var column = new StackPanel();
        column.Children.Add(head);
        column.Children.Add(_error);
        column.Children.Add(_search);
        column.Children.Add(_state);
        column.Children.Add(_catalogue);
        column.Children.Add(_selected);
        column.Children.Add(Ui.SectionHeader(L.T("Recent Runs")));
        column.Children.Add(_runsList);
        _root.Children.Add(Ui.PageFrame(column, 1000));
        Content = _root;

        _poll.Tick += (_, _) => LoadRuns();
        _state.Content = Ui.Text(L.T("Loading the actions…"), 13, secondary: true);
        DrawRuns();
    }

    public override string Title => L.T("Shortcuts");

    public override void Shown()
    {
        if (_actions is null) Load();
        else LoadRuns();
        _runner?.SetActive(true);
    }

    public override void Hidden()
    {
        _poll.Stop();
        _runner?.SetActive(false);
    }

    public override void Refresh() => Load();

    public override void Close()
    {
        _request++;
        _poll.Stop();
        _runner?.Close();
    }

    private void Load()
    {
        if (Context.Api is not { } api) return;
        var mine = ++_request;
        InboxParts.Run(async () =>
        {
            var actions = await api.ShortcutActions();
            if (mine != _request) return;
            _actions = actions;
            _error.Visibility = Visibility.Collapsed;
            DrawCatalogue();
        }, e =>
        {
            if (mine != _request || e.Kind == SpaceApiFailure.AuthenticationRequired) return;
            _error.Text = L.F("The actions could not be loaded: {0}", InboxParts.Message(e));
            _error.Visibility = Visibility.Visible;
            if (_actions is null) _state.Content = null;
        });
        LoadRuns();
    }

    private void LoadRuns()
    {
        if (Context.Api is not { } api) return;
        _poll.Stop();
        InboxParts.Run(async () =>
        {
            try
            {
                _runs = await api.ShortcutRuns();
                DrawRuns();
            }
            finally
            {
                Schedule();
            }
        }, _ => { });
    }

    /// <summary>The next look at the runs, while the page is shown: soon while one is running.</summary>
    private void Schedule()
    {
        _poll.Stop();
        if (!IsShown) return;
        _poll.Interval = ShortcutRules.RecentEvery(_runs);
        _poll.Start();
    }

    private void DrawCatalogue()
    {
        var actions = _actions;
        if (actions is null) return;
        var lang = InboxParts.Lang;
        var shown = ShortcutRules.Search(actions, _query, lang);
        _state.Content = shown.Count > 0 ? null
            : actions.Count == 0 ? Ui.EmptyState(Ui.Shortcuts, L.T("No actions on this Space"))
            : Ui.Text(L.T("No action matches."), 13, secondary: true);
        _catalogue.Children.Clear();
        foreach (var a in shown) _catalogue.Children.Add(Card(a, lang));
        // A catalogue read again keeps the open form (and what was typed in it).
        if (_selectedKey is { } key && _runner is null && actions.FirstOrDefault(a => a.Key == key) is { } chosen) Open(chosen);
    }

    private Button Card(ShortcutAction a, string lang)
    {
        var on = a.Key == _selectedKey;
        var title = Ui.Text(ShortcutRules.Title(a, lang), 14, bold: true, wrap: false);
        var sub = a.Builtin ? L.T("Built in") : a.App;
        if (a.Peer is { Length: > 0 } peer) sub += " · " + peer;
        if (a.Effect == "write") sub += " · " + L.T("creates");
        else if (a.Effect == "run") sub += " · " + L.T("runs a task");
        var face = new StackPanel();
        face.Children.Add(title);
        face.Children.Add(Ui.Text(sub, 12, secondary: true, wrap: false));
        if (!a.Available && !string.IsNullOrEmpty(a.Reason))
        {
            var why = Ui.Text(a.Reason, 12, wrap: false);
            why.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCautionBrush");
            face.Children.Add(why);
        }
        var b = new Button
        {
            Content = face,
            Width = 228,
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 0, 8, 8),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Top,
            ToolTip = a.Available ? ShortcutRules.Description(a, lang) : a.Reason,
            BorderThickness = new Thickness(on ? 2 : 1),
            Opacity = a.Available ? 1 : 0.7,
            Tag = a.Key,
        };
        b.SetResourceReference(Control.BackgroundProperty, "CardBackgroundFillColorDefaultBrush");
        b.SetResourceReference(Control.BorderBrushProperty, on ? "AccentFillColorDefaultBrush" : "CardStrokeColorDefaultBrush");
        System.Windows.Automation.AutomationProperties.SetName(b, $"{ShortcutRules.Title(a, lang)}, {sub}" + (a.Available ? "" : ", " + L.F("Not available: {0}", a.Reason ?? "")));
        System.Windows.Automation.AutomationProperties.SetItemStatus(b, on ? L.T("Form open") : "");
        b.Click += (_, _) =>
        {
            var closing = _selectedKey == a.Key;
            if (closing) CloseForm();
            else Open(a);
            DrawCatalogue();
            if (!closing) _runner?.FocusFirst();
            else if (_catalogue.Children.OfType<Button>().FirstOrDefault(c => c.Tag as string == a.Key) is { } again) Dispatcher.BeginInvoke(() => again.Focus(), DispatcherPriority.Input);
        };
        return b;
    }

    /// <summary>The action's form under the catalogue; the one open before closes.</summary>
    private void Open(ShortcutAction a)
    {
        _runner?.Close();
        _selectedKey = a.Key;
        _runner = new ShortcutRunner(Context, a, LoadRuns);
        _runner.SetActive(IsShown);
        var close = Ui.IconButton(Ui.Close, L.T("Close the Form"), () =>
        {
            CloseForm();
            DrawCatalogue();
        });
        close.HorizontalAlignment = HorizontalAlignment.Right;
        close.VerticalAlignment = VerticalAlignment.Top;
        var grid = new Grid();
        grid.Children.Add(_runner.View);
        grid.Children.Add(close);
        _runner.View.Margin = new Thickness(0, 0, 40, 0);
        _selected.Child = grid;
        _selected.Visibility = Visibility.Visible;
    }

    private void CloseForm()
    {
        _runner?.Close();
        _runner = null;
        _selectedKey = null;
        _selected.Child = null;
        _selected.Visibility = Visibility.Collapsed;
    }

    private void DrawRuns()
    {
        var key = string.Join("\n", _runs.Select(r => $"{r.Id}\u001f{r.Status}\u001f{r.Result?.TaskStatus}\u001f{r.Attempts}")) + "\n" + _openRun + "\n" + (_actions?.Count ?? -1);
        if (key == _runsKey) return;
        _runsKey = key;
        _runsList.Children.Clear();
        if (_runs.Count == 0)
        {
            _runsList.Children.Add(Ui.Text(L.T("Nothing run yet."), 13, secondary: true));
            return;
        }
        var lang = InboxParts.Lang;
        foreach (var run in _runs)
        {
            var action = _actions is null ? null : ShortcutRules.ActionOf(run, _actions);
            var title = action is null ? run.Title : ShortcutRules.Title(action, lang);
            var open = _openRun == run.Id;
            var status = ShortcutRunner.StatusTag(run.Status);
            status.Margin = new Thickness(0, 0, 10, 0);
            var when = Ui.Text(InboxParts.When(run.CreatedAt), 12, secondary: true, wrap: false);
            when.ToolTip = InboxParts.Full(run.CreatedAt);
            when.Margin = new Thickness(10, 0, 0, 0);
            var summary = ShortcutRules.Summary(run);
            var row = new DockPanel { LastChildFill = true };
            DockPanel.SetDock(status, Dock.Left);
            DockPanel.SetDock(when, Dock.Right);
            row.Children.Add(status);
            row.Children.Add(when);
            var name = Ui.Text(title, 14, bold: true, wrap: false);
            name.MaxWidth = 300;
            DockPanel.SetDock(name, Dock.Left);
            row.Children.Add(name);
            var s = Ui.Text(summary, 13, secondary: true, wrap: false);
            s.Margin = new Thickness(10, 0, 0, 0);
            s.VerticalAlignment = VerticalAlignment.Center;
            row.Children.Add(s);
            var line = new Button
            {
                Content = row,
                Padding = new Thickness(12, 8, 12, 8),
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
                HorizontalAlignment = HorizontalAlignment.Stretch,
            };
            System.Windows.Automation.AutomationProperties.SetName(line, string.Join(", ", new[] { title, summary, StatusName(run.Status), InboxParts.When(run.CreatedAt) }.Where(p => p.Length > 0)));
            var id = run.Id;
            line.Click += (_, _) =>
            {
                _openRun = _openRun == id ? null : id;
                _focusRun = id;
                DrawRuns();
            };
            var body = new StackPanel();
            body.Children.Add(line);
            if (open)
            {
                var card = ShortcutRunner.RunCard(Context, run, action, null);
                card.Margin = new Thickness(12, 0, 12, 12);
                body.Children.Add(card);
            }
            var border = new Border { Child = body, CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Margin = new Thickness(0, 0, 0, 6) };
            border.SetResourceReference(Border.BackgroundProperty, "CardBackgroundFillColorDefaultBrush");
            border.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
            _runsList.Children.Add(border);
            if (_focusRun == id)
            {
                _focusRun = null;
                Dispatcher.BeginInvoke(() => line.Focus(), DispatcherPriority.Input);
            }
        }
    }

    private static string StatusName(string status) => status switch
    {
        "ok" => L.T("Done"),
        "error" => L.T("Failed"),
        "running" => L.T("Running"),
        _ => L.T("Unknown"),
    };
}
