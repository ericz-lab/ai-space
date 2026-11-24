using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// One action's form, its run and its result (the web's src/web/ActionRunner.tsx, the iPhone's
/// <c>ShortcutExecution</c>): the inputs with how a relative date reads in this computer's zone and
/// where a write goes, one button (Show for a read, Create for a write, Run for a task) with no
/// second prompt, and the result card. A submission carries a request id that changes only once a
/// run came back, so a second click, or a send again after the network failed, answers the first
/// run instead of running twice. A run still going is read again every 1.5 seconds while the page
/// is shown; it goes on in the Space whatever the page does.
/// </summary>
internal sealed class ShortcutRunner
{
    private readonly PageContext _context;
    private readonly ShortcutAction _action;
    private readonly Action _runsChanged;
    private readonly Dictionary<string, string> _values;
    private readonly string _zone = ShortcutRules.IanaZone();
    private readonly StackPanel _panel = new();
    private readonly StackPanel _form = new();
    private readonly StackPanel _actions = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
    private readonly TextBlock _meta = Ui.Text("", 12, secondary: true);
    private readonly TextBlock _error = Ui.Text("", 13);
    private readonly ContentControl _result = new() { Focusable = false };
    private readonly DispatcherTimer _follow = new() { Interval = ShortcutRules.FollowEvery };
    private readonly Button _again;
    private readonly List<Control> _inputs = [];
    private readonly Button _go;
    private string _requestId = Guid.NewGuid().ToString();
    private ShortcutRun? _run;
    private bool _busy;
    private bool _active = true;
    private bool _closed;

    /// <param name="values">The values the form opens with (what Home's command box read from the text); else the action's own.</param>
    public ShortcutRunner(PageContext context, ShortcutAction action, Action runsChanged, Dictionary<string, string>? values = null)
    {
        _context = context;
        _action = action;
        _runsChanged = runsChanged;
        _values = values ?? ShortcutRules.InitialValues(action);
        _follow.Tick += (_, _) => Follow();
        _again = Ui.Button(L.T("New"), Reset);
        _again.Margin = new Thickness(0, 0, 8, 0);
        _go = Ui.Button(L.T("Show"), Submit, accent: true);
        _actions.Children.Add(_again);
        _actions.Children.Add(_go);

        var lang = InboxParts.Lang;
        var title = Ui.Text(ShortcutRules.Title(action, lang), 18, bold: true);
        _panel.Children.Add(title);
        if (ShortcutRules.Description(action, lang) is { } d)
        {
            var desc = Ui.Text(d, 13, secondary: true);
            desc.Margin = new Thickness(0, 2, 0, 0);
            _panel.Children.Add(desc);
        }
        if (!action.Available)
        {
            var missing = Ui.Text(L.F("Not available: {0}", action.Reason ?? ""), 13);
            missing.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCautionBrush");
            missing.Margin = new Thickness(0, 8, 0, 0);
            _panel.Children.Add(missing);
        }
        _form.Margin = new Thickness(0, 12, 0, 0);
        foreach (var input in action.Inputs) _form.Children.Add(Field(input, lang));
        _panel.Children.Add(_form);

        var bottom = new DockPanel { Margin = new Thickness(0, 12, 0, 0), LastChildFill = true };
        DockPanel.SetDock(_actions, Dock.Right);
        bottom.Children.Add(_actions);
        _meta.VerticalAlignment = VerticalAlignment.Center;
        _meta.Margin = new Thickness(0, 0, 12, 0);
        bottom.Children.Add(_meta);
        _panel.Children.Add(bottom);

        _error.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        _error.Margin = new Thickness(0, 8, 0, 0);
        _error.Visibility = Visibility.Collapsed;
        System.Windows.Automation.AutomationProperties.SetLiveSetting(_error, System.Windows.Automation.AutomationLiveSetting.Assertive);
        _panel.Children.Add(_error);
        _result.Margin = new Thickness(0, 12, 0, 0);
        _panel.Children.Add(_result);
        Draw();
    }

    public ShortcutAction Action => _action;

    public FrameworkElement View => _panel;

    /// <summary>The page is shown or hidden: a run still going is followed only while it is shown.</summary>
    public void SetActive(bool active)
    {
        _active = active;
        if (active && _run is { Running: true } && !_closed) _follow.Start();
        else _follow.Stop();
    }

    public void Close()
    {
        _closed = true;
        _follow.Stop();
    }

    /// <summary>Sends the form as it is, when it can be sent (Home runs a complete read at once).</summary>
    public void Run() => Submit();

    /// <summary>Focus on the button when the form is complete, else on the first empty required input, for the keyboard.</summary>
    public void FocusNext()
    {
        var missing = ShortcutRules.Missing(_action, _values).FirstOrDefault();
        var i = missing is null ? -1 : _action.Inputs.ToList().FindIndex(x => x.Name == missing.Name);
        Control target = i >= 0 && i < _inputs.Count ? _inputs[i] : _go;
        _panel.Dispatcher.BeginInvoke(() => target.Focus(), DispatcherPriority.Input);
    }

    /// <summary>Focus on the first input (or the button when there is none), for the keyboard.</summary>
    public void FocusFirst()
    {
        Control target = _inputs.Count > 0 ? _inputs[0] : _go;
        _panel.Dispatcher.BeginInvoke(() => target.Focus(), DispatcherPriority.Input);
    }

    private FrameworkElement Field(ShortcutInput input, string lang)
    {
        var label = ShortcutRules.InputLabel(_action, input, lang);
        var caption = Ui.Text(input.Required ? label + " *" : label, 13);
        caption.Margin = new Thickness(0, 0, 0, 4);
        var hint = Ui.Text("", 12, secondary: true);
        hint.Margin = new Thickness(0, 4, 0, 0);
        void Hint()
        {
            var value = _values.GetValueOrDefault(input.Name, "");
            var today = ShortcutRules.Today(DateTimeOffset.Now, TimeZoneInfo.Local);
            var text = input.Type switch
            {
                "date" => ShortcutRules.ResolvedDate(value, today) ?? (value.Length == 0 ? L.T("today, tomorrow or YYYY-MM-DD") : null),
                "period" => ShortcutRules.ResolvedPeriodText(value, today),
                "time" => value.Length == 0 ? L.T("HH:MM, 24-hour") : null,
                _ => null,
            };
            hint.Text = text ?? "";
            hint.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
        }
        void Set(string v)
        {
            _values[input.Name] = v;
            Hint();
            Draw();
        }

        Control control;
        var value = _values.GetValueOrDefault(input.Name, "");
        switch (input.Type)
        {
            case "period":
            case "choice":
            case "task":
            {
                var box = new ComboBox { MinWidth = 220, HorizontalAlignment = HorizontalAlignment.Left };
                if (!input.Required) box.Items.Add(new ComboBoxItem { Content = "—", Tag = "" });
                var options = input.Type == "period"
                    ? ShortcutRules.Periods.Select(p => new ShortcutOption(p, PeriodLabel(p)))
                    : input.Options.Select(o => o with { Label = ShortcutRules.OptionLabel(_action, o, lang) });
                foreach (var o in options) box.Items.Add(new ComboBoxItem { Content = o.Label, Tag = o.Value });
                box.SelectedItem = box.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == value) ?? box.Items.OfType<ComboBoxItem>().FirstOrDefault();
                if (box.SelectedItem is ComboBoxItem { Tag: string first } && first != value) _values[input.Name] = first;
                box.SelectionChanged += (_, _) =>
                {
                    if (box.SelectedItem is ComboBoxItem { Tag: string v }) Set(v);
                };
                control = box;
                break;
            }
            case "date":
            {
                // Typed, or picked from the relative words the server reads.
                var box = new ComboBox { IsEditable = true, MinWidth = 220, HorizontalAlignment = HorizontalAlignment.Left, Text = value };
                box.Items.Add("today");
                box.Items.Add("tomorrow");
                box.AddHandler(System.Windows.Controls.Primitives.TextBoxBase.TextChangedEvent, new TextChangedEventHandler((_, _) => Set(box.Text.Trim())));
                box.SelectionChanged += (_, _) =>
                {
                    if (box.SelectedItem is string s) Set(s);
                };
                box.KeyDown += SubmitOnEnter;
                control = box;
                break;
            }
            default:
            {
                var box = new TextBox { Text = value, MinWidth = 220, HorizontalAlignment = input.Type == "text" ? HorizontalAlignment.Stretch : HorizontalAlignment.Left, MaxWidth = input.Type == "text" ? double.PositiveInfinity : 220 };
                if (input.Type == "number") InputMethod.SetIsInputMethodEnabled(box, false);
                box.TextChanged += (_, _) => Set(box.Text);
                box.KeyDown += SubmitOnEnter;
                control = box;
                break;
            }
        }
        System.Windows.Automation.AutomationProperties.SetName(control, label);
        _inputs.Add(control);
        if (input.Required) System.Windows.Automation.AutomationProperties.SetIsRequiredForForm(control, true);
        Hint();
        return new StackPanel { Margin = new Thickness(0, 0, 0, 12), Children = { caption, control, hint } };
    }

    /// <summary>Enter in a field submits, as the web's form; Enter that ends an IME composition arrives as <see cref="Key.ImeProcessed"/> and does not.</summary>
    private void SubmitOnEnter(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        if (ShortcutRules.OffersSubmit(_run, _action.Effect)) Submit();
    }

    private static string PeriodLabel(string p) => p switch
    {
        "today" => L.T("Today"),
        "tomorrow" => L.T("Tomorrow"),
        "this-week" => L.T("This Week"),
        "next-week" => L.T("Next Week"),
        "this-month" => L.T("This Month"),
        "last-7-days" => L.T("Last 7 Days"),
        _ => p,
    };

    private bool CanSubmit => _action.Available && ShortcutRules.Missing(_action, _values).Count == 0 && !_busy && _run is not { Running: true };

    private void Draw()
    {
        var meta = new List<string>();
        if (_action.Effect == "write") meta.Add(L.F("Goes to {0}", _action.Peer is { Length: > 0 } p ? $"{_action.App} · {p}" : _action.App));
        if (ShortcutRules.Zoned(_action)) meta.Add(L.F("Time zone {0}", _zone));
        _meta.Text = string.Join(" · ", meta);

        _again.Visibility = _run is { Running: false } ? Visibility.Visible : Visibility.Collapsed;
        _go.Visibility = ShortcutRules.OffersSubmit(_run, _action.Effect) ? Visibility.Visible : Visibility.Collapsed;
        _go.Content = _busy || _run is { Running: true } ? L.T("Running…") : ShortcutRules.SubmitKind(_action.Effect) switch
        {
            ShortcutSubmit.Create => L.T("Create"),
            ShortcutSubmit.Run => L.T("Run"),
            _ => L.T("Show"),
        };
        _go.IsEnabled = CanSubmit;
        _result.Content = _run is null ? null : RunCard(_context, _run, _action, ShortcutRules.Retryable(_run, _action) ? Retry : null, _busy);
    }

    private void ShowError(string? text)
    {
        _error.Text = text ?? "";
        _error.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
    }

    private void Submit()
    {
        if (!CanSubmit || _context.Api is not { } api) return;
        var body = ShortcutRules.RunBody(_action, _values, _zone, _requestId);
        Send(async () => await api.StartShortcut(body));
    }

    private void Retry()
    {
        if (_run is not { } run || _busy || _context.Api is not { } api) return;
        Send(async () => await api.RetryShortcut(run.Id));
    }

    private void Send(Func<Task<ShortcutRun>> call)
    {
        _busy = true;
        ShowError(null);
        Draw();
        InboxParts.Run(async () =>
        {
            try
            {
                var run = await call();
                if (_closed) return;
                _run = run;
                // The next submission is a new one.
                _requestId = Guid.NewGuid().ToString();
            }
            finally
            {
                _busy = false;
            }
            Draw();
            SetActive(_active);
            _runsChanged();
        }, e =>
        {
            // A refused request made no run: the form can be corrected and sent again with the
            // same request id; after a lost answer the same id lets the Space answer the first run.
            ShowError(InboxParts.Message(e));
            Draw();
        });
    }

    private void Follow()
    {
        if (_run is not { Running: true } run || _context.Api is not { } api)
        {
            _follow.Stop();
            return;
        }
        _follow.Stop();
        InboxParts.Run(async () =>
        {
            var now = await api.GetShortcutRun(run.Id);
            if (_closed) return;
            _run = now;
            Draw();
            if (!now.Running) _runsChanged();
            SetActive(_active);
        }, e =>
        {
            ShowError(InboxParts.Message(e));
            // Tried again on the next tick while the page is shown.
            SetActive(_active);
        });
    }

    private void Reset()
    {
        _run = null;
        _follow.Stop();
        ShowError(null);
        Draw();
    }

    // The result card, shared with the recent runs.

    /// <summary>
    /// A run's card (the web's <c>RunCard</c>): its result (a value with Copy, a receipt, a list, a
    /// task's run), its error, "may have been created" for a write whose answer was lost, and
    /// Retry when <paramref name="retry"/> is given.
    /// </summary>
    public static FrameworkElement RunCard(PageContext context, ShortcutRun run, ShortcutAction? action, Action? retry, bool busy = false)
    {
        var panel = new StackPanel();
        if (run.Running && run.Result is null) panel.Children.Add(Ui.Text(L.T("Running…"), 13, secondary: true));
        if (run.Result is { } result) panel.Children.Add(Result(context, result, run.Timezone));
        if (run.Status == "error" && !(run.Result is { Kind: "task", Error: { Length: > 0 } }) && !string.IsNullOrEmpty(run.Error)) panel.Children.Add(Critical(run.Error));
        if (run.Status == "unknown")
        {
            var app = action?.App ?? run.Action.Split('/')[0];
            var text = L.F("The answer was lost, so {0} may have created it.", app);
            if (action?.Idempotent == true) text += " " + L.T("It recognises a repeated request, so retrying will not create a second one.");
            panel.Children.Add(Critical(text));
            if (!string.IsNullOrEmpty(run.Error)) panel.Children.Add(Ui.Text(run.Error, 12, secondary: true));
        }
        if (retry is not null)
        {
            var b = Ui.Button(L.T("Retry"), retry);
            b.IsEnabled = !busy;
            b.HorizontalAlignment = HorizontalAlignment.Left;
            b.Margin = new Thickness(0, 8, 0, 0);
            panel.Children.Add(b);
        }
        var card = new Border { Child = panel, Padding = new Thickness(14), CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(1) };
        card.SetResourceReference(Border.BackgroundProperty, "CardBackgroundFillColorSecondaryBrush");
        card.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        System.Windows.Automation.AutomationProperties.SetName(card, L.T("Result"));
        System.Windows.Automation.AutomationProperties.SetLiveSetting(card, System.Windows.Automation.AutomationLiveSetting.Polite);
        return card;
    }

    private static TextBlock Critical(string text)
    {
        var t = Ui.Text(text, 13);
        t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        t.Margin = new Thickness(0, 4, 0, 0);
        return t;
    }

    private static FrameworkElement Result(PageContext context, ShortcutResult r, string? zone)
    {
        var tz = Zone(zone);
        string When(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, tz).ToString("g", CultureInfo.CurrentCulture);
        var panel = new StackPanel();
        switch (r.Kind)
        {
            case "value":
            {
                var big = Ui.Text(r.Text ?? r.Value ?? "", 26, bold: true);
                var copy = Ui.Button(L.T("Copy"), () => { });
                copy.Click += (_, _) =>
                {
                    try
                    {
                        Clipboard.SetText(ShortcutRules.CopyText(r));
                        copy.Content = L.T("Copied");
                    }
                    catch (System.Runtime.InteropServices.COMException)
                    {
                        // The clipboard is held by another program; the button stays as it was.
                    }
                };
                copy.Margin = new Thickness(12, 0, 0, 0);
                copy.VerticalAlignment = VerticalAlignment.Center;
                var line = new DockPanel();
                DockPanel.SetDock(copy, Dock.Right);
                line.Children.Add(copy);
                line.Children.Add(big);
                panel.Children.Add(line);
                if (!string.IsNullOrEmpty(r.Detail)) panel.Children.Add(Ui.Text(r.Detail, 13, secondary: true));
                var parts = new List<string>();
                if (!string.IsNullOrEmpty(r.Source)) parts.Add(L.F("Source: {0}", r.Source));
                if (r.AsOf is { } asOf) parts.Add(L.F("as of {0}", When(asOf)));
                if (r.Stale) parts.Add(L.T("cached quote, the provider could not refresh it"));
                if (parts.Count > 0) panel.Children.Add(Ui.Text(string.Join(" · ", parts), 12, secondary: true));
                break;
            }
            case "receipt":
            {
                panel.Children.Add(Ui.Text(L.T("Created"), 14, bold: true));
                foreach (var i in r.Receipt)
                {
                    var sub = string.Join(" · ", new[] { i.Id.Length > 0 ? "#" + i.Id : "", i.Detail ?? "" }.Where(s => s.Length > 0));
                    panel.Children.Add(Item(context, null, i.Title, i.Url, sub, null));
                }
                break;
            }
            case "list":
            {
                if (r.Items.Count == 0) panel.Children.Add(Ui.Text(L.T("Nothing found."), 13, secondary: true));
                foreach (var i in r.Items)
                {
                    // A wall clock from another zone says which; an all-day date has none.
                    var when = i.At is { } at ? When(at)
                        : string.Join(" ", new[] { i.Date, i.Time, i.Time is not null && i.Timezone is { } z && z != zone ? z : null }.Where(s => !string.IsNullOrEmpty(s)));
                    var sub = string.Join(" · ", new[] { i.Tag, i.Source }.Where(s => !string.IsNullOrEmpty(s)));
                    panel.Children.Add(Item(context, when, i.Title, i.Url, sub, i.Detail));
                }
                if (r.AsOf is { } asOf) panel.Children.Add(Ui.Text(L.F("as of {0}", When(asOf)), 12, secondary: true));
                break;
            }
            case "task":
            {
                var head = new WrapPanel();
                var name = Ui.Text(r.Task ?? "", 14, bold: true, wrap: false);
                name.Margin = new Thickness(0, 0, 8, 0);
                head.Children.Add(name);
                head.Children.Add(StatusTag(r.TaskStatus ?? "running"));
                panel.Children.Add(head);
                var parts = new List<string>();
                if (r.StartedAt is { } started) parts.Add(When(started));
                if (r.RunId is { } id) parts.Add(L.F("run #{0}", id));
                if (parts.Count > 0) panel.Children.Add(Ui.Text(string.Join(" · ", parts), 12, secondary: true));
                if (!string.IsNullOrEmpty(r.Error)) panel.Children.Add(Critical(r.Error));
                if (!string.IsNullOrEmpty(r.Output))
                {
                    var output = new TextBlock { Text = r.Output, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, TextWrapping = TextWrapping.Wrap };
                    output.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorPrimaryBrush");
                    var box = new Border { Child = output, Padding = new Thickness(10), CornerRadius = new CornerRadius(4), Margin = new Thickness(0, 8, 0, 0), MaxHeight = 320 };
                    box.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorSecondaryBrush");
                    panel.Children.Add(new ScrollViewer { Content = box, MaxHeight = 320, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Focusable = false });
                }
                break;
            }
        }
        return panel;
    }

    /// <summary>A row of a list or a receipt: its time, its title (a link when it has one), a line under it and its detail.</summary>
    private static FrameworkElement Item(PageContext context, string? when, string title, string? url, string? sub, string? detail)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        if (!string.IsNullOrEmpty(when)) panel.Children.Add(Ui.Text(when, 12, secondary: true));
        if (!string.IsNullOrEmpty(url))
        {
            var link = new Hyperlink(new Run(title)) { ToolTip = url };
            link.SetResourceReference(TextElement.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
            link.Click += (_, _) => context.OpenLink(url);
            var t = new TextBlock { FontSize = 14, TextWrapping = TextWrapping.Wrap };
            t.Inlines.Add(link);
            panel.Children.Add(t);
        }
        else
        {
            panel.Children.Add(Ui.Text(title, 14));
        }
        if (!string.IsNullOrEmpty(sub)) panel.Children.Add(Ui.Text(sub, 12, secondary: true));
        if (!string.IsNullOrEmpty(detail)) panel.Children.Add(Ui.Text(detail, 13, secondary: true));
        return panel;
    }

    /// <summary>A run's status as a coloured tag: Running, Done, Failed or Unknown.</summary>
    public static Border StatusTag(string status) => status switch
    {
        "ok" => InboxParts.Tag(L.T("Done"), "SystemFillColorSuccessBackgroundBrush", "TextFillColorPrimaryBrush"),
        "error" => InboxParts.Tag(L.T("Failed"), "SystemFillColorCriticalBackgroundBrush", "TextFillColorPrimaryBrush"),
        "running" => InboxParts.Tag(L.T("Running"), "SystemFillColorAttentionBackgroundBrush", "TextFillColorPrimaryBrush"),
        _ => InboxParts.Tag(L.T("Unknown"), "SystemFillColorCautionBackgroundBrush", "TextFillColorPrimaryBrush"),
    };

    /// <summary>The run's zone, for its times as the web shows them; this computer's when Windows does not know it.</summary>
    private static TimeZoneInfo Zone(string? id)
    {
        if (string.IsNullOrEmpty(id)) return TimeZoneInfo.Local;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id);
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return TimeZoneInfo.Local;
        }
    }
}
