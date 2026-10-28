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
}
