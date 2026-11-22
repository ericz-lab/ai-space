using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace;

internal static class ConnectionNames
{
    /// <summary>The name the person gave the Space, else its host.</summary>
    public static string DisplayNameOr(this Connection c) => Connection.DisplayName(c.Name, c.Uri);
}

/// <summary>
/// The few building blocks the native windows are made of, drawn in WPF's Fluent theme so they
/// follow the system's light or dark mode and accent colour. Colours come from the theme's own
/// resources by name; a name it lacks falls back to the control's default instead of failing.
/// </summary>
internal static class Ui
{
    public static readonly FontFamily Icons = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    // Segoe Fluent Icons glyphs.
    public const string Home = "", Inbox = "", Chat = "", Refresh = "", OpenOutside = "",
        Settings = "", Back = "", Forward = "", Close = "", Add = "", More = "",
        Computer = "", Globe = "", Warning = "", Lock = "";

    // More glyphs, written as escapes: Terminal (CommandPrompt), Shortcuts (LightningBolt), Search,
    // Apps (AllApps), Web (the web panel: Globe), Agent (Robot), Pin, Delete, Accept, Edit, Sync.
    public const string Terminal = "\uE756", Shortcuts = "\uE945", Search = "\uE721", Apps = "\uE71D",
        Web = "\uE774", Agent = "\uE99A", Pin = "\uE718", Delete = "\uE74D", Accept = "\uE8FB", Edit = "\uE70F", Sync = "\uE895";

    public static TextBlock Text(string text, double size = 14, bool secondary = false, bool bold = false, bool wrap = true)
    {
        var t = new TextBlock { Text = text, FontSize = size, TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap, TextTrimming = wrap ? TextTrimming.None : TextTrimming.CharacterEllipsis };
        if (bold) t.FontWeight = FontWeights.SemiBold;
        t.SetResourceReference(TextBlock.ForegroundProperty, secondary ? "TextFillColorSecondaryBrush" : "TextFillColorPrimaryBrush");
        return t;
    }

    public static TextBlock Glyph(string glyph, double size = 16) => new() { Text = glyph, FontFamily = Icons, FontSize = size, VerticalAlignment = VerticalAlignment.Center };

    public static Button Button(string label, Action click, bool accent = false)
    {
        var b = new Button { Content = label, Padding = new Thickness(14, 6, 14, 6), MinWidth = 88 };
        if (accent) b.SetResourceReference(FrameworkElement.StyleProperty, "AccentButtonStyle");
        b.Click += (_, _) => click();
        return b;
    }

    /// <summary>A borderless icon button for the window's bar, with its label as the tooltip and for screen readers.</summary>
    public static Button IconButton(string glyph, string label, Action click)
    {
        var b = new Button { Content = Glyph(glyph), ToolTip = label, Padding = new Thickness(8, 6, 8, 6), Background = Brushes.Transparent, BorderThickness = new Thickness(0) };
        System.Windows.Automation.AutomationProperties.SetName(b, label);
        b.Click += (_, _) => click();
        return b;
    }

    public static StackPanel Row(params UIElement[] children)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal };
        foreach (var c in children)
        {
            if (c is FrameworkElement f && p.Children.Count > 0) f.Margin = new Thickness(8, 0, 0, 0);
            p.Children.Add(c);
        }
        return p;
    }

    public static StackPanel Column(double gap, params UIElement[] children)
    {
        var p = new StackPanel();
        foreach (var c in children)
        {
            if (c is FrameworkElement f && p.Children.Count > 0) f.Margin = new Thickness(f.Margin.Left, gap, f.Margin.Right, f.Margin.Bottom);
            p.Children.Add(c);
        }
        return p;
    }

    public static Border Card(UIElement child, double padding = 20)
    {
        var b = new Border { Child = child, Padding = new Thickness(padding), CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1) };
        b.SetResourceReference(Border.BackgroundProperty, "CardBackgroundFillColorDefaultBrush");
        b.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        return b;
    }

    public static void Background(FrameworkElement e) => e.SetResourceReference(e switch
    {
        Control => Control.BackgroundProperty,
        Border => Border.BackgroundProperty,
        _ => Panel.BackgroundProperty,
    }, "ApplicationBackgroundBrush");

    /// <summary>Whether Windows draws apps dark, for what the theme does not reach (a web view's first paint).</summary>
    public static bool SystemDark()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return k?.GetValue("AppsUseLightTheme") is int v && v == 0;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    // The pieces of the native pages (Views/*Page.cs). Each takes its colours from the theme, so
    // it is right in light and dark mode.

    /// <summary>
    /// A page's scrolling frame: <paramref name="content"/> in a column at most
    /// <paramref name="maxWidth"/> wide, centred, with the page's margins, scrolling vertically.
    /// </summary>
    public static ScrollViewer PageFrame(UIElement content, double maxWidth = 1100)
    {
        var column = new Border { Child = content, MaxWidth = maxWidth, Padding = new Thickness(32, 24, 32, 32), HorizontalAlignment = HorizontalAlignment.Stretch };
        var scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Focusable = false };
        Background(scroll);
        return scroll;
    }

    /// <summary>A section's heading, with an optional action (a link-like button) at its end.</summary>
    public static FrameworkElement SectionHeader(string title, string? action = null, Action? click = null)
    {
        var row = new DockPanel { Margin = new Thickness(0, 16, 0, 8), LastChildFill = true };
        if (action is not null && click is not null)
        {
            var b = new Button { Content = action, Padding = new Thickness(8, 2, 8, 2), Background = Brushes.Transparent, BorderThickness = new Thickness(0), Cursor = System.Windows.Input.Cursors.Hand };
            b.SetResourceReference(Control.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
            b.Click += (_, _) => click();
            DockPanel.SetDock(b, Dock.Right);
            row.Children.Add(b);
        }
        row.Children.Add(Text(title, 16, bold: true, wrap: false));
        return row;
    }

    /// <summary>
    /// A tile of a library or a screen: <paramref name="icon"/> (from <see cref="IconStore.View"/> or
    /// a <see cref="Glyph"/>) over its title, clickable, with an optional badge (an unread count).
    /// </summary>
    public static Button Tile(FrameworkElement icon, string title, Action click, string? tooltip = null, int badge = 0, double width = 96)
    {
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        var name = Text(title, 12, wrap: false);
        name.HorizontalAlignment = HorizontalAlignment.Center;
        name.TextAlignment = TextAlignment.Center;
        name.MaxWidth = width - 8;
        var face = new Grid();
        face.Children.Add(Column(6, icon, name));
        if (badge > 0) face.Children.Add(Badge(badge, HorizontalAlignment.Right, VerticalAlignment.Top));
        var b = new Button { Content = face, Width = width, Padding = new Thickness(4, 10, 4, 8), Background = Brushes.Transparent, BorderThickness = new Thickness(0), ToolTip = tooltip ?? title, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        System.Windows.Automation.AutomationProperties.SetName(b, title);
        b.Click += (_, _) => click();
        return b;
    }

    /// <summary>A small round count, as on the Inbox entry (99+ past 99).</summary>
    public static Border Badge(int count, HorizontalAlignment h = HorizontalAlignment.Left, VerticalAlignment v = VerticalAlignment.Center)
    {
        var t = new TextBlock { Text = count > 99 ? "99+" : count.ToString(System.Globalization.CultureInfo.CurrentCulture), FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        return new Border { Child = t, MinWidth = 18, Height = 18, CornerRadius = new CornerRadius(9), Padding = new Thickness(5, 0, 5, 0), HorizontalAlignment = h, VerticalAlignment = v, Background = new SolidColorBrush(Color.FromRgb(0xD1, 0x34, 0x38)) };
    }

    /// <summary>
    /// A row of a list: an optional leading <paramref name="icon"/>, a title and a secondary
    /// <paramref name="detail"/>, optional <paramref name="trailing"/> content (a time, buttons),
    /// clickable as a whole when <paramref name="click"/> is given. <paramref name="strong"/> sets
    /// the title in bold (an unread thread).
    /// </summary>
    public static FrameworkElement ListRow(FrameworkElement? icon, string title, string? detail = null, UIElement? trailing = null, Action? click = null, bool strong = false)
    {
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        if (icon is not null)
        {
            icon.Margin = new Thickness(0, 0, 12, 0);
            icon.VerticalAlignment = VerticalAlignment.Center;
            grid.Children.Add(icon);
        }
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(Text(title, 14, bold: strong, wrap: false));
        if (!string.IsNullOrEmpty(detail))
        {
            var d = Text(detail, 12, secondary: true, wrap: false);
            d.Margin = new Thickness(0, 2, 0, 0);
            text.Children.Add(d);
        }
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        if (trailing is not null)
        {
            if (trailing is FrameworkElement f)
            {
                f.Margin = new Thickness(12, 0, 0, 0);
                f.VerticalAlignment = VerticalAlignment.Center;
            }
            Grid.SetColumn(trailing, 2);
            grid.Children.Add(trailing);
        }
        if (click is null) return new Border { Child = grid, Padding = new Thickness(12, 8, 12, 8) };
        var b = new Button { Content = grid, Padding = new Thickness(12, 8, 12, 8), Background = Brushes.Transparent, BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        System.Windows.Automation.AutomationProperties.SetName(b, title);
        b.Click += (_, _) => click();
        return b;
    }

    /// <summary>
    /// A search field: <paramref name="placeholder"/> shows while it is empty, <paramref name="changed"/>
    /// runs with the text as it is typed, <paramref name="submit"/> on Enter. Escape clears it.
    /// </summary>
    public static FrameworkElement SearchBox(string placeholder, Action<string> changed, Action<string>? submit = null)
    {
        var box = new TextBox { Padding = new Thickness(30, 6, 8, 6), MinWidth = 240, VerticalContentAlignment = VerticalAlignment.Center };
        System.Windows.Automation.AutomationProperties.SetName(box, placeholder);
        var icon = Glyph(Search, 14);
        icon.Margin = new Thickness(10, 0, 0, 0);
        icon.HorizontalAlignment = HorizontalAlignment.Left;
        icon.IsHitTestVisible = false;
        icon.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        var hint = Text(placeholder, 14, secondary: true, wrap: false);
        hint.Margin = new Thickness(32, 0, 0, 0);
        hint.VerticalAlignment = VerticalAlignment.Center;
        hint.IsHitTestVisible = false;
        box.TextChanged += (_, _) =>
        {
            hint.Visibility = box.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
            changed(box.Text);
        };
        box.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Escape && box.Text.Length > 0)
            {
                box.Text = "";
                e.Handled = true;
            }
            else if (e.Key == System.Windows.Input.Key.Enter && submit is not null)
            {
                e.Handled = true;
                submit(box.Text);
            }
        };
        var host = new Grid { Tag = box };
        host.Children.Add(box);
        host.Children.Add(hint);
        host.Children.Add(icon);
        return host;
    }

    /// <summary>The text field inside a <see cref="SearchBox"/>, to focus it or set its text.</summary>
    public static TextBox SearchField(FrameworkElement searchBox) => (TextBox)searchBox.Tag;

    /// <summary>A centred empty or placeholder state: a large glyph, a title, a line of text and an optional action.</summary>
    public static FrameworkElement EmptyState(string glyph, string title, string? text = null, UIElement? action = null)
    {
        var g = Glyph(glyph, 40);
        g.HorizontalAlignment = HorizontalAlignment.Center;
        g.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        var parts = new List<UIElement> { g };
        var t = Text(title, 20, bold: true);
        t.TextAlignment = TextAlignment.Center;
        parts.Add(t);
        if (!string.IsNullOrEmpty(text))
        {
            var d = Text(text, 13, secondary: true);
            d.TextAlignment = TextAlignment.Center;
            parts.Add(d);
        }
        if (action is FrameworkElement a)
        {
            a.HorizontalAlignment = HorizontalAlignment.Center;
            parts.Add(a);
        }
        var p = Column(12, [.. parts]);
        p.MaxWidth = 480;
        p.HorizontalAlignment = HorizontalAlignment.Center;
        p.VerticalAlignment = VerticalAlignment.Center;
        return p;
    }

    /// <summary>
    /// A short notice at the bottom of <paramref name="host"/> (a page's root Grid) that goes by
    /// itself after <paramref name="seconds"/>: "Marked as done", "Could not save: …".
    /// <paramref name="error"/> draws it in the theme's critical colour.
    /// </summary>
    public static void Toast(Grid host, string text, bool error = false, double seconds = 4)
    {
        var b = new Border
        {
            Child = Text(text, 13),
            Padding = new Thickness(16, 10, 16, 10),
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1),
            Margin = new Thickness(24),
            MaxWidth = 520,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
        };
        b.SetResourceReference(Border.BackgroundProperty, error ? "SystemFillColorCriticalBackgroundBrush" : "SolidBackgroundFillColorTertiaryBrush");
        b.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        Grid.SetRowSpan(b, Math.Max(1, host.RowDefinitions.Count));
        Grid.SetColumnSpan(b, Math.Max(1, host.ColumnDefinitions.Count));
        Panel.SetZIndex(b, 1000);
        host.Children.Add(b);
        var timer = new System.Windows.Threading.DispatcherTimer { Interval = TimeSpan.FromSeconds(seconds) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            host.Children.Remove(b);
        };
        timer.Start();
    }

    /// <summary>A banner across the top of a page (a warning, a state): its text and an optional action button.</summary>
    public static Border Banner(string text, string? action = null, Action? click = null, bool warning = true)
    {
        var row = new DockPanel();
        if (action is not null && click is not null)
        {
            var b = Button(action, click);
            DockPanel.SetDock(b, Dock.Right);
            b.Margin = new Thickness(12, 0, 0, 0);
            row.Children.Add(b);
        }
        var t = Text(text, 13);
        t.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(t);
        var banner = new Border { Child = row, Padding = new Thickness(16, 8, 16, 8), BorderThickness = new Thickness(0, 0, 0, 1) };
        banner.SetResourceReference(Border.BackgroundProperty, warning ? "SystemFillColorCautionBackgroundBrush" : "SystemFillColorAttentionBackgroundBrush");
        banner.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");
        return banner;
    }
}
