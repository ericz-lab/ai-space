using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Settings in the bar: the Space's own settings, natively (the Linux client's
/// <c>app/settings-space.ts</c> and <c>settings-pages.ts</c>, the Mac's <c>SettingsPage</c>, the web
/// panel's Settings window). The sections are listed on the left (icons only below
/// <see cref="SettingsRules.CollapseBelow"/> wide), the chosen one on the right; the last one chosen
/// is remembered on this computer (<see cref="SettingsMemory"/>). Each section reads its routes when
/// it is shown and again after a while, or on F5; a part whose route fails says so with Retry.
/// Feedback and Appearance lead to the web panel's Settings in its tab. This Computer leads to the
/// app's own preferences (<see cref="SettingsWindow"/>), which stays as it is, reached from the
/// notification area, the floating ball and here.
/// </summary>
internal sealed class SpaceSettingsPage : NativePage
{
    /// <summary>A section shown again after this long reads the Space again.</summary>
    private static readonly TimeSpan Stale = TimeSpan.FromSeconds(30);

    private readonly Grid _root = new();
    private readonly ListBox _nav = new();
    private readonly ContentControl _pane = new() { Focusable = false, IsTabStop = false };
    private readonly Dictionary<SettingsSection, SettingsPane> _panes = [];
    private readonly SettingsMemory _memory;
    private readonly List<(ListBoxItem Item, TextBlock Label)> _items = [];
    private SettingsSection _section;
    private LiveStatus _lastStatus = LiveStatus.Unknown;

    public SpaceSettingsPage(PageContext context) : base(context)
    {
        _memory = new SettingsMemory(Path.Combine(Path.GetDirectoryName(context.Model.Paths.Preferences) ?? ".", "space-settings.json"));
        _section = _memory.Load();

        _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        _nav.BorderThickness = new Thickness(0);
        _nav.Background = System.Windows.Media.Brushes.Transparent;
        _nav.Padding = new Thickness(8, 20, 8, 8);
        _nav.Width = 220;
        ScrollViewer.SetHorizontalScrollBarVisibility(_nav, ScrollBarVisibility.Disabled);
        AutomationProperties.SetName(_nav, L.T("Settings sections"));
        foreach (var s in SettingsRules.Sections)
        {
            var label = Ui.Text(Label(s), 14, wrap: false);
            label.VerticalAlignment = VerticalAlignment.Center;
            label.Margin = new Thickness(12, 0, 0, 0);
            var face = new StackPanel { Orientation = Orientation.Horizontal };
            face.Children.Add(Ui.Glyph(Glyph(s), 16));
            face.Children.Add(label);
            var item = new ListBoxItem { Content = face, Tag = s, Padding = new Thickness(10, 8, 10, 8) };
            AutomationProperties.SetName(item, Label(s));
            _nav.Items.Add(item);
            _items.Add((item, label));
        }
        _nav.SelectionChanged += (_, _) =>
        {
            if (_nav.SelectedItem is ListBoxItem { Tag: SettingsSection s } && s != _section) Pick(s);
        };
        var line = new Border { Width = 1 };
        line.SetResourceReference(Border.BackgroundProperty, "DividerStrokeColorDefaultBrush");
        line.HorizontalAlignment = HorizontalAlignment.Right;
        var navHost = new Grid();
        navHost.Children.Add(_nav);
        navHost.Children.Add(line);
        _root.Children.Add(navHost);
        Grid.SetColumn(_pane, 1);
        _root.Children.Add(_pane);
        Content = _root;
        SizeChanged += (_, e) => Collapse(SettingsRules.NavCollapsed(e.NewSize.Width));

        _nav.SelectedIndex = SettingsRules.Sections.ToList().IndexOf(_section);
        ShowPane(reload: false);
    }

    public override string Title => L.T("Settings");

    public override void Shown()
    {
        _lastStatus = Context.Live?.Status ?? LiveStatus.Unknown;
        var pane = Pane(_section);
        if (pane.LoadedAt is not { } at || DateTimeOffset.Now - at > Stale) pane.Reload();
    }

    public override void LiveChanged()
    {
        // A Space that comes back (online again, signed in again) is read again where it is shown;
        // otherwise the 30-second refresh leaves the page alone, so nothing moves under the pointer.
        var status = Context.Live?.Status ?? LiveStatus.Unknown;
        var back = status == LiveStatus.Ok && _lastStatus != LiveStatus.Ok && _lastStatus != LiveStatus.Unknown;
        _lastStatus = status;
        if (back && IsShown) Pane(_section).Reload();
    }

    public override void Refresh() => Pane(_section).Reload();

    public override void Close()
    {
        foreach (var p in _panes.Values) p.Cancel();
    }

    /// <summary>A short notice at the bottom of the page: what a change did, or why it failed.</summary>
    public void Toast(string text, bool error = false) => Ui.Toast(_root, text, error);

    /// <summary>The web panel's Settings, in its tab, for what this page leaves to it.</summary>
    public void OpenWebSettings()
    {
        if (Context.Connection is { } c) Context.OpenWebPanel(SpacePages.PageUrl(c.Uri, SpacePageKind.Settings));
    }

    /// <summary>Another section of this page (a row that leads there).</summary>
    public void Select(SettingsSection s) => _nav.SelectedIndex = SettingsRules.Sections.ToList().IndexOf(s);

    private void Pick(SettingsSection s)
    {
        _section = s;
        _memory.Save(s);
        ShowPane(reload: true);
    }

    private void ShowPane(bool reload)
    {
        var pane = Pane(_section);
        _pane.Content = pane.View;
        if (reload && (pane.LoadedAt is not { } at || DateTimeOffset.Now - at > Stale)) pane.Reload();
    }

    private SettingsPane Pane(SettingsSection s)
    {
        if (_panes.TryGetValue(s, out var p)) return p;
        p = s switch
        {
            SettingsSection.Overview => new OverviewPane(this),
            SettingsSection.Models => new ModelsPane(this),
            SettingsSection.Tasks => new TasksPane(this),
            SettingsSection.Events => new EventsPane(this),
            SettingsSection.Usage => new UsagePane(this),
            SettingsSection.Activity => new ActivityPane(this),
            SettingsSection.Packages => new PackagesPane(this),
            SettingsSection.Account => new AccountPane(this),
            SettingsSection.ThisComputer => new ThisComputerPane(this),
            _ => new WebPane(this, s),
        };
        _panes[s] = p;
        return p;
    }

    private void Collapse(bool collapsed)
    {
        _nav.Width = collapsed ? 60 : 220;
        _nav.Padding = collapsed ? new Thickness(4, 20, 4, 8) : new Thickness(8, 20, 8, 8);
        foreach (var (item, label) in _items)
        {
            label.Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible;
            item.ToolTip = collapsed ? label.Text : null;
        }
    }

    public static string Label(SettingsSection s) => s switch
    {
        SettingsSection.Overview => L.T("Overview"),
        SettingsSection.Models => L.T("Models"),
        SettingsSection.Tasks => L.T("Scheduled Tasks"),
        SettingsSection.Events => L.T("Events and Calls"),
        SettingsSection.Usage => L.T("Model Usage"),
        SettingsSection.Activity => L.T("App Usage"),
        SettingsSection.Packages => L.T("Packages"),
        SettingsSection.Feedback => L.T("Feedback"),
        SettingsSection.Appearance => L.T("Appearance"),
        SettingsSection.Account => L.T("Account"),
        _ => L.T("This Computer"),
    };

    // Segoe Fluent Icons: Diagnostic, Component, Recent, Message, AreaChart, History, Package,
    // Feedback, Color, Contact, and the shell's computer.
    public static string Glyph(SettingsSection s) => s switch
    {
        SettingsSection.Overview => "",
        SettingsSection.Models => "",
        SettingsSection.Tasks => "",
        SettingsSection.Events => "",
        SettingsSection.Usage => "",
        SettingsSection.Activity => "",
        SettingsSection.Packages => "",
        SettingsSection.Feedback => "",
        SettingsSection.Appearance => "",
        SettingsSection.Account => "",
        _ => Ui.Computer,
    };
}
