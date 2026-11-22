using System.Globalization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using System.Windows.Shapes;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>The words of the Settings page's states, times and model choices (the Core's rules say which; this says it in the interface's language).</summary>
internal static class SettingsWords
{
    public static string State(StateOf s) => s.Word switch
    {
        StateWord.Up => L.T("up"),
        StateWord.Down => L.T("down"),
        StateWord.Unknown => "?",
        StateWord.Paused => L.T("paused"),
        StateWord.Archived => L.T("archived"),
        StateWord.UnitProblem => L.T("unit problem"),
        StateWord.Fresh => L.T("fresh"),
        StateWord.Stale => L.T("stale"),
        StateWord.Retired => L.T("retired"),
        StateWord.Ready => L.T("ready"),
        StateWord.Unreachable => L.T("unreachable"),
        StateWord.NotInstalled => L.T("not installed"),
        StateWord.NotSignedIn => L.T("not signed in"),
        StateWord.Limited => L.T("limited"),
        StateWord.ProbeTimedOut => L.T("status check timed out"),
        StateWord.Unchecked => L.T("not checked"),
        StateWord.SpeechOff or StateWord.TaskOff => L.T("off"),
        StateWord.NotFound => L.T("not found"),
        StateWord.TaskOrphaned => L.T("orphaned"),
        StateWord.TaskRunning => L.T("running"),
        StateWord.TaskOk or StateWord.DeliveryOk => L.T("ok"),
        StateWord.TaskError => s.Count > 1 ? L.F("error ×{0}", s.Count) : L.T("error"),
        StateWord.TaskSkipped or StateWord.DeliverySkipped => L.T("skipped"),
        StateWord.TaskNeverRan => L.T("never ran"),
        StateWord.DeliveryPending => L.T("pending"),
        StateWord.DeliverySent => L.T("sent"),
        StateWord.DeliveryDead => L.T("dead"),
        _ => s.Word.ToString(),
    };

    /// <summary>"5 min ago", "in 2 h"; empty for no time.</summary>
    public static string Ago(DateTimeOffset? at)
    {
        if (at is not { } t) return "";
        var (unit, n) = SettingsRules.Relative(t, DateTimeOffset.Now);
        return unit switch
        {
            RelUnit.JustNow => L.T("just now"),
            RelUnit.MinutesAgo => L.F("{0} min ago", n),
            RelUnit.HoursAgo => L.F("{0} h ago", n),
            RelUnit.DaysAgo => L.F("{0} d ago", n),
            RelUnit.Now => L.T("now"),
            RelUnit.InLessThanAMinute => L.T("in less than a minute"),
            RelUnit.InMinutes => L.F("in {0} min", n),
            RelUnit.InHours => L.F("in {0} h", n),
            _ => L.F("in {0} d", n),
        };
    }

    public static string Duration(double ms)
    {
        var (unit, a, b) = SettingsRules.Duration(ms);
        return unit switch
        {
            DurationUnit.Milliseconds => L.F("{0} ms", a),
            DurationUnit.Seconds => L.F("{0} s", a),
            DurationUnit.MinutesSeconds => L.F("{0} min {1} s", a, b),
            DurationUnit.Minutes => L.F("{0} min", a),
            DurationUnit.HoursMinutes => L.F("{0} h {1} min", a, b),
            DurationUnit.Hours => L.F("{0} h", a),
            DurationUnit.DaysHours => L.F("{0} d {1} h", a, b),
            _ => L.F("{0} d", a),
        };
    }

    /// <summary>A date and time in the reader's locale and time zone.</summary>
    public static string When(DateTimeOffset at) => at.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);

    public static string Number(long n) => n.ToString("N0", CultureInfo.CurrentCulture);

    public static string Tier(string tier) => tier switch
    {
        "basic" => L.T("Basic"),
        "junior" => L.T("Junior"),
        "intermediate" => L.T("Intermediate"),
        "advanced" => L.T("Advanced"),
        _ => tier,
    };

    /// <summary>A model picker's entry as the panel labels it: runtime · tier · model, and why it is greyed.</summary>
    public static string Choice(ModelChoice c, string empty)
    {
        if (c.Kind == ChoiceKind.Empty) return empty;
        if (c.Kind == ChoiceKind.Missing || c.Option is not { } o) return L.F("{0} (not available)", c.Value);
        var label = (c.ShowRuntime ? o.Runtime + " · " : "") + Tier(o.Tier) + " · " + o.Model;
        return o.Unavailable switch
        {
            null => label,
            "offline" => L.F("{0} (offline)", label),
            _ => L.F("{0} (not signed in)", label),
        };
    }

    public static string Schedule(TaskSchedule s) => s.Kind switch
    {
        "every" when s.EveryMs is { } ms => L.F("every {0}", Duration(ms)),
        "cron" when s.Expr is { } e => s.Tz is { Length: > 0 } tz ? $"{e} ({tz})" : e,
        "at" when s.At is { } at => L.F("once at {0}", When(at)),
        _ => L.T("manual"),
    };

    /// <summary>Why a route failed, in words a person can act on.</summary>
    public static string Error(Exception e) => e switch
    {
        SpaceApiException { Kind: SpaceApiFailure.AuthenticationRequired } => L.T("The Space asks to sign in again."),
        SpaceApiException { Kind: SpaceApiFailure.Network } a => L.F("The Space does not answer: {0}", a.Message),
        SpaceApiException { Kind: SpaceApiFailure.InvalidResponse } => L.T("The Space answered with something this app cannot read."),
        _ => e.Message,
    };
}

/// <summary>
/// One part of a section that loads from one route: a heading, then its rows, a line that says it
/// is loading, or what failed with Retry. Reloading cancels a load still on its way, and only the
/// newest load may fill the part.
/// </summary>
internal sealed class Block
{
    private readonly Func<CancellationToken, Task<UIElement>> _load;
    private readonly ContentControl _host = new() { Focusable = false, IsTabStop = false, HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private CancellationTokenSource? _cts;
    private int _generation;

    public Block(string? title, Func<CancellationToken, Task<UIElement>> load, string? action = null, Action? click = null)
    {
        _load = load;
        var panel = new StackPanel();
        if (title is not null)
        {
            Heading = Ui.SectionHeader(title, action, click);
            panel.Children.Add(Heading);
        }
        panel.Children.Add(_host);
        View = panel;
    }

    public FrameworkElement View { get; }

    public FrameworkElement? Heading { get; }

    /// <summary>Hides the whole part (a group the Space does not have, such as speech on an older Space).</summary>
    public void Hide(bool hidden) => View.Visibility = hidden ? Visibility.Collapsed : Visibility.Visible;

    public async void Reload()
    {
        _cts?.Cancel();
        var cts = new CancellationTokenSource();
        _cts = cts;
        var generation = ++_generation;
        if (_host.Content is null || _host.Content is FrameworkElement { Tag: "state" }) _host.Content = SettingsKit.Loading();
        try
        {
            var content = await _load(cts.Token);
            if (generation == _generation) _host.Content = content;
        }
        catch (OperationCanceledException) when (cts.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            // Every failure is shown in place, never thrown out of the handler (which would end the app).
            if (generation == _generation) _host.Content = SettingsKit.Failed(SettingsWords.Error(e), Reload);
        }
    }

    public void Cancel() => _cts?.Cancel();
}

/// <summary>A section of the Settings page: its title, the Space it shows, and its parts, which load together.</summary>
internal abstract class SettingsPane
{
    private readonly StackPanel _body = new();
    private readonly List<Block> _blocks = [];
    private ScrollViewer? _view;

    protected SettingsPane(SpaceSettingsPage page)
    {
        Page = page;
    }

    protected SpaceSettingsPage Page { get; }

    protected PageContext Context => Page.Context;

    /// <summary>The Space's API; a Space removed meanwhile reads as not answering.</summary>
    protected SpaceApi Api => Context.Api ?? throw new SpaceApiException(SpaceApiFailure.Network, L.T("This Space is no longer saved."));

    public abstract string Title { get; }

    /// <summary>When the section last read the Space, to read it again when it is shown after a while.</summary>
    public DateTimeOffset? LoadedAt { get; private set; }

    public FrameworkElement View
    {
        get
        {
            if (_view is not null) return _view;
            var title = Ui.Text(Title, 26, bold: true);
            AutomationProperties.SetHeadingLevel(title, AutomationHeadingLevel.Level1);
            _body.Children.Add(title);
            if (Context.Connection is { } c)
            {
                var space = Ui.Text(c.DisplayNameOr(), 13, secondary: true);
                space.Margin = new Thickness(0, 2, 0, 4);
                _body.Children.Add(space);
            }
            Compose();
            _view = Ui.PageFrame(_body, 920);
            return _view;
        }
    }

    /// <summary>Adds the section's parts and rows, once.</summary>
    protected abstract void Compose();

    protected Block Add(Block block)
    {
        _blocks.Add(block);
        _body.Children.Add(block.View);
        return block;
    }

    protected void Add(UIElement element) => _body.Children.Add(element);

    public virtual void Reload()
    {
        _ = View;
        LoadedAt = DateTimeOffset.Now;
        foreach (var b in _blocks) b.Reload();
    }

    public void Cancel()
    {
        foreach (var b in _blocks) b.Cancel();
    }
}

/// <summary>The pieces the Settings page's sections are drawn with, on top of <see cref="Ui"/>'s.</summary>
internal static class SettingsKit
{
    public const string ChevronRight = "", Play = "", Stop = "", Restart = "";

    public static FrameworkElement Loading()
    {
        var bar = new ProgressBar { IsIndeterminate = true, Width = 120, Height = 4, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(bar, L.T("Loading…"));
        var row = Ui.Row(bar, Ui.Text(L.T("Loading…"), 13, secondary: true));
        row.Margin = new Thickness(4, 8, 0, 8);
        row.Tag = "state";
        return row;
    }

    /// <summary>A route that failed: its message and Retry, in place of the rows.</summary>
    public static FrameworkElement Failed(string message, Action retry)
    {
        var icon = Ui.Glyph(Ui.Warning, 16);
        icon.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        icon.VerticalAlignment = VerticalAlignment.Top;
        icon.Margin = new Thickness(0, 2, 10, 0);
        var text = Ui.Text(message, 13);
        var button = Ui.Button(L.T("Retry"), retry);
        button.Margin = new Thickness(12, 0, 0, 0);
        button.VerticalAlignment = VerticalAlignment.Center;
        var grid = Columns(icon, text, button);
        var card = Ui.Card(grid, 12);
        card.SetResourceReference(Border.BackgroundProperty, "SystemFillColorCriticalBackgroundBrush");
        card.Tag = "state";
        AutomationProperties.SetLiveSetting(card, AutomationLiveSetting.Polite);
        return card;
    }

    /// <summary>Three columns: something fixed, the text taking the rest, something fixed at the end.</summary>
    public static Grid Columns(UIElement? start, UIElement middle, UIElement? end)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (start is not null) grid.Children.Add(start);
        Grid.SetColumn(middle, 1);
        grid.Children.Add(middle);
        if (end is not null)
        {
            Grid.SetColumn(end, 2);
            grid.Children.Add(end);
        }
        return grid;
    }

    /// <summary>A status dot and its word, coloured from the theme.</summary>
    public static FrameworkElement Dot(StatusTone tone, string? text = null)
    {
        var dot = new Ellipse { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
        dot.SetResourceReference(Shape.FillProperty, tone switch
        {
            StatusTone.Ok => "SystemFillColorSuccessBrush",
            StatusTone.Down => "SystemFillColorCriticalBrush",
            StatusTone.Paused => "SystemFillColorCautionBrush",
            StatusTone.Running => "AccentFillColorDefaultBrush",
            _ => "SystemFillColorNeutralBrush",
        });
        if (string.IsNullOrEmpty(text)) return dot;
        var label = Ui.Text(text, 12, secondary: true, wrap: false);
        label.VerticalAlignment = VerticalAlignment.Center;
        var row = Ui.Row(dot, label);
        row.VerticalAlignment = VerticalAlignment.Center;
        return row;
    }

    public static FrameworkElement Note(string text, bool error = false)
    {
        var t = Ui.Text(text, 12, secondary: !error);
        if (error) t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        t.Margin = new Thickness(4, 6, 4, 6);
        return t;
    }

    public static FrameworkElement Subhead(string text)
    {
        var t = Ui.Text(text, 13, secondary: true, bold: true, wrap: false);
        t.Margin = new Thickness(4, 12, 0, 4);
        AutomationProperties.SetHeadingLevel(t, AutomationHeadingLevel.Level3);
        return t;
    }

    /// <summary>Rows in one card, a hairline between them; an empty list shows <paramref name="empty"/>.</summary>
    public static FrameworkElement List(IEnumerable<UIElement> rows, string? empty = null)
    {
        var panel = new StackPanel();
        foreach (var r in rows)
        {
            if (panel.Children.Count > 0)
            {
                var line = new Border { Height = 1, Margin = new Thickness(12, 0, 12, 0) };
                line.SetResourceReference(Border.BackgroundProperty, "DividerStrokeColorDefaultBrush");
                panel.Children.Add(line);
            }
            panel.Children.Add(r);
        }
        if (panel.Children.Count == 0) return Note(empty ?? "");
        return Ui.Card(panel, 4);
    }

    /// <summary>A row with a title, a secondary line and the state at its end; its <paramref name="tooltip"/> holds the details.</summary>
    public static FrameworkElement Row(string title, string? detail, UIElement? trailing, string? tooltip = null, FrameworkElement? icon = null)
    {
        var row = Ui.ListRow(icon, title, detail, trailing);
        if (!string.IsNullOrEmpty(tooltip)) row.ToolTip = tooltip;
        AutomationProperties.SetName(row, string.IsNullOrEmpty(detail) ? title : $"{title}, {detail}");
        return row;
    }

    /// <summary>A row that opens something: its title and line, and a chevron.</summary>
    public static FrameworkElement LinkRow(string glyph, string title, string? detail, Action click)
    {
        var chevron = Ui.Glyph(ChevronRight, 12);
        chevron.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        return Ui.ListRow(Ui.Glyph(glyph, 18), title, detail, chevron, click);
    }

    /// <summary>Label and value on one line, the value selectable as text for copying (an address, an id).</summary>
    public static FrameworkElement Pair(string label, string value)
    {
        var name = Ui.Text(label, 13, secondary: true, wrap: false);
        name.Width = 150;
        name.VerticalAlignment = VerticalAlignment.Center;
        var box = new TextBox
        {
            Text = value,
            IsReadOnly = true,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            Padding = new Thickness(0),
            FontSize = 13,
            TextWrapping = TextWrapping.Wrap,
            VerticalAlignment = VerticalAlignment.Center,
        };
        box.SetResourceReference(Control.ForegroundProperty, "TextFillColorPrimaryBrush");
        AutomationProperties.SetName(box, label);
        var grid = Columns(name, box, null);
        grid.Margin = new Thickness(12, 6, 12, 6);
        return grid;
    }

    /// <summary>Figures side by side, each a value over its label (the panel's usage cards).</summary>
    public static FrameworkElement Tiles(params (string Value, string Label)[] tiles)
    {
        var grid = new UniformGrid { Rows = 1, Margin = new Thickness(0, 4, 0, 4) };
        foreach (var (value, label) in tiles)
        {
            var v = Ui.Text(value, 20, bold: true, wrap: false);
            var l = Ui.Text(label, 12, secondary: true);
            var card = Ui.Card(Ui.Column(2, v, l), 12);
            card.Margin = new Thickness(0, 0, 8, 0);
            AutomationProperties.SetName(card, $"{label}: {value}");
            card.Focusable = false;
            grid.Children.Add(card);
        }
        return grid;
    }

    /// <summary>A table: a header row, then the rows; the columns from <paramref name="numericFrom"/> on are figures, right-aligned.</summary>
    public static FrameworkElement Table(IReadOnlyList<string> headers, IEnumerable<(string[] Cells, string? Tooltip, bool Dim)> rows, int numericFrom)
    {
        var grid = new Grid { Margin = new Thickness(12, 6, 12, 6) };
        for (var i = 0; i < headers.Count; i++)
        {
            grid.ColumnDefinitions.Add(i < numericFrom ? new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star), MinWidth = 60 } : new ColumnDefinition { Width = GridLength.Auto });
        }
        void Cell(string text, int row, int col, bool head, bool dim, string? tip)
        {
            var t = Ui.Text(text, head ? 12 : 13, secondary: head || dim, bold: head, wrap: false);
            t.Margin = new Thickness(col == 0 ? 0 : 12, 4, 0, 4);
            if (col >= numericFrom) t.HorizontalAlignment = HorizontalAlignment.Right;
            if (tip is not null) t.ToolTip = tip;
            Grid.SetRow(t, row);
            Grid.SetColumn(t, col);
            grid.Children.Add(t);
        }
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        for (var c = 0; c < headers.Count; c++) Cell(headers[c], 0, c, head: true, dim: false, null);
        var n = 0;
        foreach (var (cells, tip, dim) in rows)
        {
            n++;
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            for (var c = 0; c < Math.Min(cells.Length, headers.Count); c++) Cell(cells[c], n, c, head: false, dim, tip);
        }
        return Ui.Card(grid, 4);
    }

    /// <summary>Buttons of which one is chosen (a window of time, a kind): the panel's segmented control.</summary>
    public static FrameworkElement Segmented(string name, IReadOnlyList<string> values, string current, Func<string, string> label, Action<string> pick)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 4) };
        AutomationProperties.SetName(row, name);
        foreach (var v in values)
        {
            var b = new ToggleButton { Content = label(v), IsChecked = v == current, Padding = new Thickness(12, 4, 12, 4), Margin = new Thickness(0, 0, 4, 0), MinWidth = 48 };
            AutomationProperties.SetName(b, $"{name}: {label(v)}");
            var value = v;
            b.Click += (_, _) =>
            {
                foreach (var other in row.Children.OfType<ToggleButton>()) other.IsChecked = ReferenceEquals(other, b);
                if (value != current)
                {
                    current = value;
                    pick(value);
                }
            };
            row.Children.Add(b);
        }
        return row;
    }

    /// <summary>
    /// A model picker that saves only when Save is pressed: choosing with the keyboard moves through
    /// the entries, so saving on every selection would write the Space at each arrow key. Greyed
    /// entries cannot be chosen; the saved value stays shown even when no longer offered.
    /// </summary>
    public static FrameworkElement ModelPicker(string name, IReadOnlyList<ModelOption> options, string? current, string empty, bool withRuntime, Func<string, Task<bool>> save)
    {
        var combo = new ComboBox { MinWidth = 260, MaxWidth = 420, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(combo, name);
        var saved = current ?? "";
        void Fill()
        {
            combo.Items.Clear();
            foreach (var c in SettingsRules.ModelChoices(options, saved, withRuntime))
            {
                var item = new ComboBoxItem { Content = SettingsWords.Choice(c, empty), Tag = c.Value, IsEnabled = !c.Disabled };
                combo.Items.Add(item);
                if (c.Value == saved) combo.SelectedItem = item;
            }
        }
        Fill();
        var button = Ui.Button(L.T("Save"), () => { }, accent: true);
        button.IsEnabled = false;
        button.Margin = new Thickness(8, 0, 0, 0);
        AutomationProperties.SetName(button, L.F("Save {0}", name));
        string Chosen() => (combo.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
        combo.SelectionChanged += (_, _) => button.IsEnabled = Chosen() != saved && SettingsRules.CanPick(options, Chosen());
        button.Click += async (_, _) =>
        {
            var value = Chosen();
            combo.IsEnabled = button.IsEnabled = false;
            try
            {
                if (await save(value)) saved = value;
            }
            catch (Exception)
            {
                // save reports its own failure; the picker goes back to what is saved.
            }
            Fill();
            combo.IsEnabled = true;
            button.IsEnabled = false;
        };
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(combo);
        row.Children.Add(button);
        return row;
    }
}
