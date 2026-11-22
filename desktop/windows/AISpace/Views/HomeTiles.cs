using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>One of the panel's own pages as a Home tile: its <c>builtin:</c> name, its Fluent glyph and its label.</summary>
internal sealed record HomeBuiltin(string Name, string Glyph, string English, Func<string> Label)
{
    public static readonly HomeBuiltin[] All =
    [
        new("inbox", Ui.Inbox, "Inbox", () => L.T("Inbox")),
        new("shortcuts", Ui.Shortcuts, "Shortcuts", () => L.T("Shortcuts")),
        new("terminal", Ui.Terminal, "Terminal", () => L.T("Terminal")),
        new("settings", Ui.Settings, "Settings", () => L.T("Settings")),
        new("panel", Ui.Web, "Web Panel", () => L.T("Web Panel")),
    ];

    public static HomeBuiltin? Of(string name) => All.FirstOrDefault(b => b.Name == name);

    /// <summary>As a catalogue entry, so the search finds it by its label in the interface's language, in English, and by its name.</summary>
    public HomeEntry Entry() => new(HomeKind.Builtin, Name, Label()) { I18n = new Dictionary<string, LocalizedText> { ["en"] = new(English, null) } };
}

/// <summary>What a tile marks at its icon's corner: an unread count, an agent at work, or why it will not answer.</summary>
internal enum TileMark
{
    None,
    Count,
    Working,
    Down,
    Paused,
    Offline,
}

/// <summary>Home's tiles: an icon over a name and, when it has one, a short note (its machine, or why it will not answer).</summary>
internal static class HomeTiles
{
    public const double Width = 108, IconSize = 48;

    // Segoe Fluent Icons: Pause, Warning (its machine is offline), ChevronRight.
    public const string PauseGlyph = "", OfflineGlyph = "", Chevron = "";

    /// <summary>
    /// A clickable tile. <paramref name="help"/> is what a screen reader adds to its name (its state);
    /// <paramref name="tooltip"/> what the pointer shows (the library's details). Its key is in
    /// <see cref="FrameworkElement.Tag"/>, so Home can find it again after drawing anew.
    /// </summary>
    public static Button Tile(string key, FrameworkElement icon, string title, string? note, string? help, TileMark mark, int count, bool dimmed, string? tooltip, Action click)
    {
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        icon.VerticalAlignment = VerticalAlignment.Center;
        if (dimmed) icon.Opacity = 0.5;
        var iconHost = new Grid { Width = IconSize + 8, Height = IconSize + 8, HorizontalAlignment = HorizontalAlignment.Center };
        iconHost.Children.Add(icon);
        if (Mark(mark, count) is { } m) iconHost.Children.Add(m);

        var name = Ui.Text(title, 12.5);
        name.TextAlignment = TextAlignment.Center;
        name.TextTrimming = TextTrimming.CharacterEllipsis;
        name.MaxHeight = 36;
        name.Margin = new Thickness(0, 4, 0, 0);
        name.HorizontalAlignment = HorizontalAlignment.Center;
        var face = new StackPanel();
        face.Children.Add(iconHost);
        face.Children.Add(name);
        if (!string.IsNullOrEmpty(note))
        {
            var n = Ui.Text(note, 11, secondary: true, wrap: false);
            n.HorizontalAlignment = HorizontalAlignment.Center;
            n.MaxWidth = Width - 12;
            face.Children.Add(n);
        }
        var plate = new Border { Child = face, CornerRadius = new CornerRadius(8), Padding = new Thickness(6, 8, 6, 8), Background = Brushes.Transparent };
        var b = new Button
        {
            Content = plate,
            Width = Width,
            Padding = new Thickness(0),
            Margin = new Thickness(0, 0, 4, 4),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            VerticalContentAlignment = VerticalAlignment.Top,
            VerticalAlignment = VerticalAlignment.Top,
            ToolTip = tooltip,
            Tag = key,
        };
        AutomationProperties.SetName(b, title);
        if (!string.IsNullOrEmpty(help)) AutomationProperties.SetHelpText(b, help);
        b.MouseEnter += (_, _) => plate.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorSecondaryBrush");
        b.MouseLeave += (_, _) => plate.Background = Brushes.Transparent;
        b.Click += (_, _) => click();
        return b;
    }

    private static FrameworkElement? Mark(TileMark mark, int count)
    {
        FrameworkElement? m = mark switch
        {
            TileMark.Count when count > 0 => Ui.Badge(count, HorizontalAlignment.Right, VerticalAlignment.Top),
            TileMark.Working => Dot("AccentFillColorDefaultBrush", 12),
            TileMark.Down => Dot("SystemFillColorCriticalBrush", 12),
            TileMark.Paused => GlyphDot(PauseGlyph),
            TileMark.Offline => GlyphDot(OfflineGlyph),
            _ => null,
        };
        if (m is null) return null;
        m.HorizontalAlignment = HorizontalAlignment.Right;
        m.VerticalAlignment = VerticalAlignment.Top;
        m.IsHitTestVisible = false;
        return m;
    }

    private static FrameworkElement Dot(string brush, double size)
    {
        var e = new System.Windows.Shapes.Ellipse { Width = size, Height = size, StrokeThickness = 2, Margin = new Thickness(0, 2, 2, 0) };
        e.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, brush);
        e.SetResourceReference(System.Windows.Shapes.Shape.StrokeProperty, "SolidBackgroundFillColorBaseBrush");
        return e;
    }

    private static FrameworkElement GlyphDot(string glyph)
    {
        var g = Ui.Glyph(glyph, 9);
        g.Foreground = Brushes.White;
        g.HorizontalAlignment = HorizontalAlignment.Center;
        var b = new Border { Child = g, Width = 18, Height = 18, CornerRadius = new CornerRadius(9), Background = Brushes.Gray, BorderThickness = new Thickness(2) };
        b.SetResourceReference(Border.BorderBrushProperty, "SolidBackgroundFillColorBaseBrush");
        return b;
    }

    /// <summary>A built-in page's icon: its glyph on a tinted rounded square, the size of an app's icon.</summary>
    public static FrameworkElement BuiltinIcon(string glyph, double size = IconSize)
    {
        var g = Ui.Glyph(glyph, size * 0.46);
        g.HorizontalAlignment = HorizontalAlignment.Center;
        g.SetResourceReference(TextBlock.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
        var tile = new Border { Child = g, Width = size, Height = size, CornerRadius = new CornerRadius(size * 0.22) };
        tile.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorSecondaryBrush");
        return tile;
    }

    /// <summary>A row of tiles that Tab enters once and the arrow keys move through.</summary>
    public static WrapPanel Grid()
    {
        var p = new WrapPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(-6, 0, 0, 0) };
        KeyboardNavigation.SetDirectionalNavigation(p, KeyboardNavigationMode.Contained);
        KeyboardNavigation.SetTabNavigation(p, KeyboardNavigationMode.Once);
        return p;
    }
}
