using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Small pieces the Inbox and Shortcuts pages share, beside <see cref="Ui"/>'s: a coloured dot, a
/// tag, a group of filter buttons, the times as the lists say them, and the page's way of running
/// its calls on the UI thread without an exception escaping.
/// </summary>
internal static class InboxParts
{
    /// <summary>A round dot of the level's colour (none: a faint one, so rows stay aligned).</summary>
    public static System.Windows.Shapes.Ellipse Dot(InboxTone tone, double size = 8)
    {
        var e = new System.Windows.Shapes.Ellipse { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };
        e.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, tone switch
        {
            InboxTone.Critical => "SystemFillColorCriticalBrush",
            InboxTone.Caution => "SystemFillColorCautionBrush",
            InboxTone.Success => "SystemFillColorSuccessBrush",
            _ => "ControlStrokeColorDefaultBrush",
        });
        return e;
    }

    /// <summary>A small rounded tag: an app's name, a count, a run's status.</summary>
    public static Border Tag(string text, string background = "SubtleFillColorSecondaryBrush", string foreground = "TextFillColorSecondaryBrush")
    {
        var t = new TextBlock { Text = text, FontSize = 11, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        t.SetResourceReference(TextBlock.ForegroundProperty, foreground);
        var b = new Border { Child = t, CornerRadius = new CornerRadius(4), Padding = new Thickness(6, 1, 6, 2), VerticalAlignment = VerticalAlignment.Center };
        b.SetResourceReference(Border.BackgroundProperty, background);
        return b;
    }

    /// <summary>
    /// Buttons of which exactly one is on, as the web's filter pills: <paramref name="changed"/> runs
    /// with the index chosen. Each is a toggle button, so the keyboard reaches it and a screen reader
    /// says whether it is on.
    /// </summary>
    public static (Panel Panel, Action<int> Select) Choice(string name, IReadOnlyList<string> labels, int selected, Action<int> changed)
    {
        var panel = new WrapPanel { Orientation = Orientation.Horizontal };
        System.Windows.Automation.AutomationProperties.SetName(panel, name);
        var buttons = new List<ToggleButton>();
        void Select(int index)
        {
            for (var i = 0; i < buttons.Count; i++) buttons[i].IsChecked = i == index;
        }
        for (var i = 0; i < labels.Count; i++)
        {
            var index = i;
            var b = new ToggleButton { Content = labels[i], Padding = new Thickness(12, 4, 12, 5), Margin = new Thickness(0, 0, 6, 6), IsChecked = i == selected, MinWidth = 64 };
            b.Click += (_, _) =>
            {
                Select(index);
                changed(index);
            };
            buttons.Add(b);
            panel.Children.Add(b);
        }
        return (panel, Select);
    }

    /// <summary>When a thread or a run happened, as the other clients say it: just now, minutes, hours or days ago, else its date.</summary>
    public static string When(DateTimeOffset? at)
    {
        if (at is not { } t) return "";
        var (unit, n) = InboxRules.Relative(t, DateTimeOffset.Now);
        return unit switch
        {
            RelativeUnit.JustNow => L.T("just now"),
            RelativeUnit.Minutes => L.F("{0} min ago", n),
            RelativeUnit.Hours => L.F("{0} h ago", n),
            RelativeUnit.Days => L.F("{0} d ago", n),
            _ => t.ToLocalTime().ToString("d", CultureInfo.CurrentCulture),
        };
    }

    /// <summary>A date and time in full, in this computer's zone (a tooltip, a thread's detail).</summary>
    public static string Full(DateTimeOffset? at) => at is { } t ? t.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) : "";

    /// <summary>
    /// Runs one of a page's calls from an event handler: the failure of a call is handed to
    /// <paramref name="failed"/>, so nothing escapes into the dispatcher.
    /// </summary>
    public static async void Run(Func<Task> work, Action<SpaceApiException> failed)
    {
        try
        {
            await work();
        }
        catch (SpaceApiException e)
        {
            failed(e);
        }
        catch (OperationCanceledException)
        {
        }
    }

    /// <summary>What a failed call says on the page: a sign-in, the network, or the Space's own words.</summary>
    public static string Message(SpaceApiException e) => e.Kind switch
    {
        SpaceApiFailure.AuthenticationRequired => L.T("Sign-in needed"),
        SpaceApiFailure.Network => L.F("The Space did not answer: {0}", e.Message),
        _ => e.Message,
    };

    /// <summary>The language of the Space's texts (manifests' <c>i18n</c>, the pet's line): <c>zh</c> or <c>en</c> in practice.</summary>
    public static string Lang => AISpace.Core.Lang.Current;
}
