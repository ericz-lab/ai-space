using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>Ages in the interface's words ("5 minutes ago", "yesterday"), in the steps of <see cref="HomeTime.Ago"/>.</summary>
internal static class HomeText
{
    public static string Ago(DateTimeOffset t)
    {
        var (unit, n) = HomeTime.Ago(t, DateTimeOffset.Now);
        return unit switch
        {
            AgoUnit.Now => L.T("just now"),
            AgoUnit.Minutes when n == -1 => L.T("1 minute ago"),
            AgoUnit.Minutes when n < 0 => L.F("{0} minutes ago", -n),
            AgoUnit.Minutes when n == 1 => L.T("in 1 minute"),
            AgoUnit.Minutes => L.F("in {0} minutes", n),
            AgoUnit.Hours when n == -1 => L.T("1 hour ago"),
            AgoUnit.Hours when n < 0 => L.F("{0} hours ago", -n),
            AgoUnit.Hours when n == 1 => L.T("in 1 hour"),
            AgoUnit.Hours => L.F("in {0} hours", n),
            AgoUnit.Days when n == -1 => L.T("yesterday"),
            AgoUnit.Days when n < 0 => L.F("{0} days ago", -n),
            AgoUnit.Days when n == 1 => L.T("tomorrow"),
            AgoUnit.Days => L.F("in {0} days", n),
            _ => HomeTime.DateText(t, Lang.Current),
        };
    }

    public static string Ago(string? iso) => HomeTime.Parse(iso) is { } t ? Ago(t) : "";
}

/// <summary>
/// A drawing of a widget block (a trend, a bar, a gauge, a tank, a dot), drawn each time it is laid
/// out at its size, in the theme's colours as they are then.
/// </summary>
internal sealed class HomeChart(Action<DrawingContext, Size, HomeChart> draw) : FrameworkElement
{
    protected override void OnRender(DrawingContext dc)
    {
        if (ActualWidth > 0 && ActualHeight > 0) draw(dc, new Size(ActualWidth, ActualHeight), this);
    }

    public Brush Find(string key, Color fallback) => TryFindResource(key) as Brush ?? new SolidColorBrush(fallback);

    public Brush Accent => Find("AccentFillColorDefaultBrush", Color.FromRgb(0x00, 0x67, 0xC0));

    public Brush Text => Find("TextFillColorPrimaryBrush", Colors.Gray);

    public Brush Tone(Tone? tone) => tone switch
    {
        Core.Tone.Positive => Find(HomeCards.ToneKey(Core.Tone.Positive)!, Color.FromRgb(0x0F, 0x7B, 0x0F)),
        Core.Tone.Negative => Find(HomeCards.ToneKey(Core.Tone.Negative)!, Color.FromRgb(0xC4, 0x2B, 0x1C)),
        Core.Tone.Warning => Find(HomeCards.ToneKey(Core.Tone.Warning)!, Color.FromRgb(0x9D, 0x5D, 0x00)),
        _ => Accent,
    };

    public static Brush Faded(Brush b, double opacity)
    {
        var c = b.Clone();
        c.Opacity = opacity;
        c.Freeze();
        return c;
    }
}

/// <summary>
/// A widget as a card, drawn as the panel draws it (docs/panel.md#widgets), the Mac and Linux do:
/// the head opens the widget's page; a block card leads with its first block (label, big value,
/// change, chart or bar) and lists the next ones as rows, as many as its size holds; a list card
/// shows its items with their age. An <c>embed</c> widget's page is not drawn inside the card here
/// (a web view does not scroll with WPF content): the card opens it instead. Colour inside a card
/// is data, nothing else.
/// </summary>
internal sealed class HomeCards(PageContext context, Action<HomeWidget, string?> open)
{
    public const double NarrowWidth = 252, Gap = 12;

    private static string Lang => Core.Lang.Current;

    public static string? ToneKey(Tone? tone) => tone switch
    {
        Tone.Positive => "SystemFillColorSuccessBrush",
        Tone.Negative => "SystemFillColorCriticalBrush",
        Tone.Warning => "SystemFillColorCautionBrush",
        _ => null,
    };

    /// <summary>A row of cards that Tab enters once and the arrow keys move through.</summary>
    public static WrapPanel Grid()
    {
        var p = new WrapPanel { Orientation = Orientation.Horizontal };
        System.Windows.Input.KeyboardNavigation.SetDirectionalNavigation(p, System.Windows.Input.KeyboardNavigationMode.Contained);
        return p;
    }

    public FrameworkElement Card(HomeWidget w)
    {
        var title = w.DisplayTitle();
        var column = new StackPanel();
        column.Children.Add(Head(w, title));
        var body = new StackPanel { Margin = new Thickness(4, 8, 4, 0) };
        switch (WidgetBlocks.BodyOf(w))
        {
            case CardBody.Error:
            {
                var g = Ui.Glyph(Ui.Warning, 14);
                g.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
                g.VerticalAlignment = VerticalAlignment.Top;
                g.Margin = new Thickness(0, 2, 8, 0);
                var row = new DockPanel();
                row.Children.Add(g);
                row.Children.Add(Ui.Text(string.IsNullOrEmpty(w.Error) ? L.T("Not answering") : w.Error, 13, secondary: true));
                body.Children.Add(row);
                break;
            }
            case CardBody.Embed:
            {
                body.Children.Add(Ui.Text(L.T("This widget shows its app's own page."), 13, secondary: true));
                var b = Ui.Button(L.F("Open {0}", title), () => open(w, null));
                b.HorizontalAlignment = HorizontalAlignment.Left;
                b.Margin = new Thickness(0, 10, 0, 0);
                body.Children.Add(b);
                break;
            }
            case CardBody.Blocks:
            {
                var blocks = w.Blocks!;
                body.Children.Add(Linked(Hero(blocks[0]), blocks[0].Url, w));
                foreach (var b in blocks.Skip(1).Take(WidgetBlocks.RowsFor(w.Size)))
                {
                    var r = Linked(Row(b), b.Url, w);
                    r.Margin = new Thickness(r.Margin.Left, 10, r.Margin.Right, 0);
                    body.Children.Add(r);
                }
                if (!w.Stale && WidgetBlocks.IsOutdated(w.AsOf, w.StaleAfterMs, DateTimeOffset.Now))
                {
                    var t = Ui.Text(L.F("Updated {0}", HomeText.Ago(w.AsOf)), 11, secondary: true);
                    t.Margin = new Thickness(0, 10, 0, 0);
                    body.Children.Add(t);
                }
                break;
            }
            case CardBody.Items:
                foreach (var item in w.Items!.Take(WidgetBlocks.ItemsFor(w.Size)))
                {
                    var line = new DockPanel { LastChildFill = true };
                    if (HomeTime.Parse(item.Time) is not null)
                    {
                        var age = Ui.Text(HomeText.Ago(item.Time), 11, secondary: true, wrap: false);
                        age.Margin = new Thickness(8, 1, 0, 0);
                        DockPanel.SetDock(age, Dock.Right);
                        line.Children.Add(age);
                    }
                    var text = Ui.Text(item.Text, 13);
                    text.MaxHeight = 40;
                    text.TextTrimming = TextTrimming.CharacterEllipsis;
                    line.Children.Add(text);
                    var linked = Linked(line, item.Url, w);
                    linked.Margin = new Thickness(0, 0, 0, 6);
                    body.Children.Add(linked);
                }
                break;
            default:
                body.Children.Add(Ui.Text(L.T("Nothing to show."), 13, secondary: true));
                break;
        }
        if (w.Stale)
        {
            var t = Ui.Text(L.T("Last known; its machine is offline."), 11, secondary: true);
            t.Margin = new Thickness(0, 10, 0, 0);
            body.Children.Add(t);
        }
        column.Children.Add(body);
        var card = Ui.Card(column, 12);
        card.Width = w.Wide ? NarrowWidth * 2 + Gap : NarrowWidth;
        card.Margin = new Thickness(0, 0, Gap, Gap);
        card.VerticalAlignment = VerticalAlignment.Top;
        if (w.Stale) card.Opacity = 0.6;
        AutomationProperties.SetName(card, title);
        card.Tag = HomeKeys.Of(HomeKind.Widget, w.Id);
        return card;
    }

    private Button Head(HomeWidget w, string title)
    {
        var row = new DockPanel { LastChildFill = true };
        var icon = context.Icons.View(w.Icon, title, 20);
        icon.Margin = new Thickness(0, 0, 8, 0);
        DockPanel.SetDock(icon, Dock.Left);
        row.Children.Add(icon);
        var chevron = Ui.Glyph(HomeTiles.Chevron, 10);
        chevron.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        chevron.Margin = new Thickness(8, 0, 0, 0);
        DockPanel.SetDock(chevron, Dock.Right);
        row.Children.Add(chevron);
        if (w.Peer is { } peer)
        {
            var p = Ui.Text(peer, 11, secondary: true, wrap: false);
            p.Margin = new Thickness(8, 0, 0, 0);
            p.VerticalAlignment = VerticalAlignment.Center;
            DockPanel.SetDock(p, Dock.Right);
            row.Children.Add(p);
        }
        var t = Ui.Text(title, 13, secondary: true, bold: true, wrap: false);
        t.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(t);
        var b = Flat(row);
        b.ToolTip = L.F("Open {0}", title);
        b.Tag = HomeKeys.Of(HomeKind.Widget, w.Id);
        AutomationProperties.SetName(b, title);
        b.Click += (_, _) => open(w, null);
        return b;
    }

    private static Button Flat(UIElement content) => new()
    {
        Content = content,
        Padding = new Thickness(4, 4, 4, 4),
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        HorizontalAlignment = HorizontalAlignment.Stretch,
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
    };

    /// <summary>A part of the card that opens a link when it has one.</summary>
    private FrameworkElement Linked(FrameworkElement child, string? link, HomeWidget w)
    {
        if (string.IsNullOrEmpty(link)) return child;
        var b = Flat(child);
        b.Padding = new Thickness(0);
        b.Click += (_, _) => open(w, link);
        if (AutomationProperties.GetName(child) is { Length: > 0 } name) AutomationProperties.SetName(b, name);
        return b;
    }

    private static TextBlock Toned(TextBlock t, Tone? tone)
    {
        if (ToneKey(tone) is { } key) t.SetResourceReference(TextBlock.ForegroundProperty, key);
        return t;
    }

    /// <summary>The first block, drawn large.</summary>
    private static FrameworkElement Hero(WidgetBlock b)
    {
        var box = new StackPanel();
        var label = BlockText.Of(b.Label, Lang);
        box.Children.Add(Ui.Text(label, 12, secondary: true, wrap: false));
        var value = WidgetBlocks.Shown(b, Lang);
        var tone = WidgetBlocks.ToneOf(b);
        switch (b)
        {
            case StatusBlock s:
            {
                var line = new DockPanel { Margin = new Thickness(0, 6, 0, 0) };
                var dot = Dot(tone, 10);
                dot.Margin = new Thickness(0, 0, 8, 0);
                line.Children.Add(dot);
                var v = Ui.Text(value ?? "", 18, bold: true);
                v.MaxHeight = 52;
                v.TextTrimming = TextTrimming.CharacterEllipsis;
                line.Children.Add(v);
                box.Children.Add(line);
                if (s.Time is not null) box.Children.Add(Ui.Text(HomeText.Ago(s.Time), 11, secondary: true));
                break;
            }
            case TanksBlock t:
                box.Children.Add(Tanks(t, small: false));
                break;
            default:
            {
                var line = new WrapPanel { Margin = new Thickness(0, 2, 0, 0) };
                var v = Ui.Text(value ?? L.T("No data"), 28, secondary: value is null, bold: true, wrap: false);
                if (value is not null && b is GaugeBlock) Toned(v, tone);
                line.Children.Add(v);
                if (WidgetBlocks.DeltaText(b, Lang, true) is { } d)
                {
                    var dl = Toned(Ui.Text(d.Text, 12, secondary: d.Tone is null, wrap: false), d.Tone);
                    dl.VerticalAlignment = VerticalAlignment.Bottom;
                    dl.Margin = new Thickness(8, 0, 0, 7);
                    line.Children.Add(dl);
                }
                box.Children.Add(line);
                break;
            }
        }
        if (Drawing(b, hero: true) is { } chart)
        {
            chart.Margin = new Thickness(0, 6, 0, 0);
            box.Children.Add(chart);
        }
        if (BlockText.Of(b.Caption, Lang) is { Length: > 0 } caption)
        {
            var c = Ui.Text(caption, 11, secondary: true);
            c.Margin = new Thickness(0, 6, 0, 0);
            c.MaxHeight = 32;
            c.TextTrimming = TextTrimming.CharacterEllipsis;
            box.Children.Add(c);
        }
        AutomationProperties.SetName(box, value is null ? label : $"{label}: {value}");
        return box;
    }

    /// <summary>A block after the first: label left, value right, its drawing below.</summary>
    private static FrameworkElement Row(WidgetBlock b)
    {
        var box = new StackPanel();
        var line = new DockPanel { LastChildFill = true };
        var tone = WidgetBlocks.ToneOf(b);
        var label = BlockText.Of(b.Label, Lang);
        var value = WidgetBlocks.Shown(b, Lang);
        if (b is StatusBlock)
        {
            var dot = Dot(tone, 7);
            dot.Margin = new Thickness(0, 0, 6, 0);
            line.Children.Add(dot);
        }
        if (b is not TanksBlock)
        {
            var right = new StackPanel { Orientation = Orientation.Horizontal };
            var v = Ui.Text(value ?? L.T("No data"), 13, secondary: value is null, bold: value is not null, wrap: false);
            if (value is not null && b is GaugeBlock or MetricBlock) Toned(v, tone);
            right.Children.Add(v);
            if (WidgetBlocks.DeltaText(b, Lang, false) is { } d)
            {
                var dl = Toned(Ui.Text(d.Text, 11, secondary: d.Tone is null, wrap: false), d.Tone);
                dl.Margin = new Thickness(6, 1, 0, 0);
                right.Children.Add(dl);
            }
            if (b is StatusBlock { Time: { } time })
            {
                var age = Ui.Text(HomeText.Ago(time), 11, secondary: true, wrap: false);
                age.Margin = new Thickness(6, 1, 0, 0);
                right.Children.Add(age);
            }
            right.Margin = new Thickness(8, 0, 0, 0);
            DockPanel.SetDock(right, Dock.Right);
            line.Children.Add(right);
        }
        line.Children.Add(Ui.Text(label, 13, wrap: false));
        box.Children.Add(line);
        if (b is TanksBlock t)
        {
            var tanks = Tanks(t, small: true);
            tanks.Margin = new Thickness(0, 4, 0, 0);
            box.Children.Add(tanks);
        }
        else if (Drawing(b, hero: false) is { } chart)
        {
            chart.Margin = new Thickness(0, 4, 0, 0);
            box.Children.Add(chart);
        }
        AutomationProperties.SetName(box, value is null ? label : $"{label}: {value}");
        return box;
    }

    private static FrameworkElement? Drawing(WidgetBlock b, bool hero) => b switch
    {
        TrendBlock t => WidgetBlocks.SparkOf(t) is { } s ? Spark(t, s, hero ? 48 : 22) : Ui.Text(L.T("No history yet"), 11, secondary: true),
        ProgressBlock p => Progress(p),
        GaugeBlock g => Gauge(g),
        _ => null,
    };

    private static HomeChart Dot(Tone? tone, double size) => new((dc, s, c) =>
    {
        var brush = tone is null or Tone.Neutral ? HomeChart.Faded(c.Text, 0.45) : c.Tone(tone);
        dc.DrawEllipse(brush, null, new Point(s.Width / 2, s.Height / 2), size / 2, size / 2);
    })
    { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };

    /// <summary>A trend as a line (an area under each unbroken run) or bars, the latest at full strength.</summary>
    private static HomeChart Spark(TrendBlock t, Spark s, double height) => new((dc, size, c) =>
    {
        double w = size.Width, h = size.Height;
        if (!s.Bars)
        {
            var accent = c.Accent;
            var pen = new Pen(accent, 2) { LineJoin = PenLineJoin.Round, StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round };
            var area = HomeChart.Faded(accent, 0.14);
            foreach (var run in s.Runs)
            {
                Point P((double X, double Y) p) => new(p.X * w, p.Y * (h - 2) + 1);
                if (run.Count == 1)
                {
                    dc.DrawEllipse(accent, null, P(run[0]), 1.5, 1.5);
                    continue;
                }
                var fill = new StreamGeometry();
                using (var g = fill.Open())
                {
                    g.BeginFigure(new Point(run[0].X * w, h), true, true);
                    foreach (var p in run) g.LineTo(P(p), false, false);
                    g.LineTo(new Point(run[^1].X * w, h), false, false);
                }
                fill.Freeze();
                dc.DrawGeometry(area, null, fill);
                var line = new StreamGeometry();
                using (var g = line.Open())
                {
                    g.BeginFigure(P(run[0]), false, false);
                    foreach (var p in run.Skip(1)) g.LineTo(P(p), true, true);
                }
                line.Freeze();
                dc.DrawGeometry(null, pen, line);
            }
            return;
        }
        foreach (var bar in s.BarList)
        {
            var baseBrush = bar.Negative ? c.Tone(Tone.Negative) : t.Signed ? c.Tone(Tone.Positive) : c.Accent;
            var bw = Math.Max(bar.Width * w, 1);
            var r = new Rect(bar.X * w, bar.Top * h, bw, Math.Max((bar.Bottom - bar.Top) * h, 1));
            var radius = Math.Min(bw * 0.17, 2);
            dc.DrawRoundedRectangle(bar.Latest ? baseBrush : HomeChart.Faded(baseBrush, 0.6), null, r, radius, radius);
        }
        var zero = Math.Round(s.Zero * h) + 0.5;
        dc.DrawLine(new Pen(HomeChart.Faded(c.Text, 0.18), 1), new Point(0, zero), new Point(w, zero));
    })
    { Height = height, HorizontalAlignment = HorizontalAlignment.Stretch };

    private static HomeChart Progress(ProgressBlock b) => new((dc, s, c) =>
    {
        var r = s.Height / 2;
        dc.DrawRoundedRectangle(HomeChart.Faded(c.Text, 0.12), null, new Rect(s), r, r);
        var f = WidgetBlocks.Fraction(b);
        if (f > 0) dc.DrawRoundedRectangle(b.Tone is null or Tone.Neutral ? c.Accent : c.Tone(b.Tone), null, new Rect(0, 0, s.Width * f, s.Height), r, r);
    })
    { Height = 6 };

    private static HomeChart Gauge(GaugeBlock b) => new((dc, s, c) =>
    {
        double w = s.Width, h = s.Height, y = (h - 6) / 2;
        var track = new Rect(0, y, w, 6);
        dc.PushClip(new RectangleGeometry(track, 3, 3));
        var segments = WidgetBlocks.GaugeSegments(b);
        if (segments.Count == 0) dc.DrawRectangle(HomeChart.Faded(c.Text, 0.12), null, track);
        foreach (var (start, end, tone) in segments)
        {
            var brush = tone == Tone.Neutral ? HomeChart.Faded(c.Text, 0.4) : HomeChart.Faded(c.Tone(tone), 0.85);
            dc.DrawRectangle(brush, null, new Rect(start * w, y, Math.Max((end - start) * w, 0), 6));
        }
        dc.Pop();
        if (b.Value is { } v)
        {
            var x = Math.Clamp(WidgetBlocks.Position(b, v) * w, 6, Math.Max(6, w - 6));
            dc.DrawEllipse(Brushes.White, null, new Point(x, h / 2), 6.5, 6.5);
            dc.DrawEllipse(c.Text, null, new Point(x, h / 2), 5, 5);
        }
    })
    { Height = 14 };

    /// <summary>Up to three tanks side by side, each with its name and a short value (WidgetBlocks.tsx <c>Tanks</c>).</summary>
    private static FrameworkElement Tanks(TanksBlock b, bool small)
    {
        var grid = new UniformGrid { Rows = 1, Columns = b.Tanks.Count, Margin = new Thickness(0, small ? 0 : 6, 0, 0) };
        foreach (var k in b.Tanks)
        {
            var value = WidgetBlocks.TankValue(k, Lang);
            var name = Ui.Text(BlockText.Of(k.Label, Lang), 11, secondary: true, wrap: false);
            var v = Ui.Text(value ?? L.T("No data"), small ? 11 : 13, secondary: value is null, bold: !small && value is not null, wrap: false);
            var shape = Tank(k, small ? 18 : 40);
            if (small)
            {
                var cell = new DockPanel { Margin = new Thickness(0, 0, 8, 0) };
                shape.Margin = new Thickness(0, 0, 6, 0);
                cell.Children.Add(shape);
                cell.Children.Add(Ui.Column(0, name, v));
                grid.Children.Add(cell);
            }
            else
            {
                shape.HorizontalAlignment = HorizontalAlignment.Center;
                name.HorizontalAlignment = HorizontalAlignment.Center;
                v.HorizontalAlignment = HorizontalAlignment.Center;
                grid.Children.Add(Ui.Column(2, shape, name, v));
            }
        }
        return grid;
    }

    /// <summary>One upright tank filled to value / max in its tone (the accent without one), spilling over its top past max.</summary>
    private static HomeChart Tank(Tank k, double width) => new((dc, s, c) =>
    {
        double w = s.Width, h = s.Height, top = h * 0.12, bottom = h * 0.94;
        var body = new Rect(w * 0.12, top, w * 0.76, bottom - top);
        var radius = w * 0.14;
        dc.DrawRoundedRectangle(HomeChart.Faded(c.Text, 0.09), new Pen(HomeChart.Faded(c.Text, 0.32), 1), body, radius, radius);
        var level = WidgetBlocks.TankLevel(k);
        var color = k.Tone is null or Tone.Neutral ? c.Accent : c.Tone(k.Tone);
        if (k.Value is not null && level > 0.002)
        {
            var fill = Math.Min(1, level) * (body.Height - 2);
            dc.PushClip(new RectangleGeometry(body, radius, radius));
            dc.DrawRectangle(color, null, new Rect(body.Left, body.Bottom - 1 - fill, body.Width, fill));
            dc.Pop();
        }
        if (level > 1) dc.DrawRoundedRectangle(color, null, new Rect(w * 0.3, 0, w * 0.4, top + 2), 2, 2);
    })
    { Width = width, Height = Math.Round(width * 84 / 64), VerticalAlignment = VerticalAlignment.Center };
}
