using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;
using AISpace.Core;
using static AISpace.Core.FloatingBallRules;
using Section = AISpace.Core.Section;
using OfferKind = AISpace.Core.Offer;

namespace AISpace.Windows;

/// <summary>What the dial draws in one section, worked out by the app from the Space's catalogue.</summary>
sealed record DialSectionView(string Title, ImageSource? Icon, string? Emoji, bool Round, bool Usable, bool Hidden);

/// <summary>
/// The floating ball (the Mac's FloatingBall.swift): a small round topmost tool window over every
/// app that never takes the keyboard. Resting the pointer on it opens a glass dial of four
/// sections; a click on one opens Quick Chat on its agent, a picture dropped on one opens it with
/// the picture attached, and one dropped on the hub goes to Space Assistant. Drag it to move it;
/// right-click for Quick Chat, Settings and Hide. The rules are Core's FloatingBallRules.
/// </summary>
sealed class BallWindow : Window
{
    public event Action<Section>? OpenSection;
    public event Action<Section?, byte[], string>? Dropped;
    public event Action<string>? Refused;
    public event Action<Pt>? Moved;
    public event Action? QuickChatRequested, SettingsRequested, HideRequested;

    readonly Canvas canvas = new();
    readonly DispatcherTimer openTimer = new() { Interval = TimeSpan.FromMilliseconds(150) };
    readonly DispatcherTimer closeTimer = new() { Interval = TimeSpan.FromMilliseconds(350) };
    readonly BitmapImage mark = new(new Uri("pack://application:,,,/AppMark.png"));
    Dictionary<Section, DialSectionView> sections = [];
    Pt? saved;
    bool expanded, dragging, hover;
    Section? highlighted;
    Point? pressed;

    public BallWindow(Pt? saved)
    {
        this.saved = saved;
        Title = "AI Space Floating Ball";
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        AllowDrop = true;
        Width = Height = Diameter;
        Content = canvas;
        SourceInitialized += (_, _) => Native.MakeToolWindow(this, noActivate: true);
        Loaded += (_, _) => { Place(); Draw(); };
        openTimer.Tick += (_, _) => { openTimer.Stop(); if (pressed is null) Expand(); };
        closeTimer.Tick += (_, _) => { closeTimer.Stop(); Collapse(); };
        WatchDisplays();
    }

    /// <summary>Monitors added or removed: back inside what is left.</summary>
    void WatchDisplays() =>
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (_, _) => Dispatcher.Invoke(() => { Collapse(); Place(); });

    public void SetSections(Dictionary<Section, DialSectionView> next)
    {
        sections = next;
        Draw();
    }

    bool Usable(Section s) => sections.TryGetValue(s, out var v) && v.Usable;

    // Geometry

    Pt BallCenter => new(Left + Width / 2, Top + Height / 2);

    /// <summary>The ball at its saved place, on the monitor that still has it.</summary>
    void Place()
    {
        var at = saved is { } p ? new Point(p.X + Diameter / 2, p.Y + Diameter / 2) : new Point(SystemParameters.WorkArea.Right - 1, SystemParameters.WorkArea.Top + 1);
        var o = Origin(saved, Diameter, Diameter, Native.WorkArea(this, at));
        Width = Height = Diameter;
        Left = o.X;
        Top = o.Y;
    }

    void Expand()
    {
        closeTimer.Stop();
        if (expanded || !IsVisible) return;
        var c = DialCenter(BallCenter, Native.WorkArea(this, new Point(BallCenter.X, BallCenter.Y)));
        expanded = true;
        highlighted = null;
        Width = Height = DialWindow;
        Left = c.X - DialWindow / 2;
        Top = c.Y - DialWindow / 2;
        Draw(animate: true);
    }

    /// <summary>Back to the ball: at its saved place, or centred on <paramref name="center"/> when the dial is dragged away.</summary>
    void Collapse(Point? center = null)
    {
        openTimer.Stop();
        closeTimer.Stop();
        if (!expanded) return;
        expanded = false;
        dragging = false;
        highlighted = null;
        if (center is { } c)
        {
            Width = Height = Diameter;
            Left = c.X - Diameter / 2;
            Top = c.Y - Diameter / 2;
        }
        else Place();
        Draw();
    }

    /// <summary>After the person moved the ball: back inside the monitor it was left on, and remembered.</summary>
    void Settle()
    {
        var o = Origin(new Pt(Left, Top), Diameter, Diameter, Native.WorkArea(this, new Point(BallCenter.X, BallCenter.Y)));
        Left = o.X;
        Top = o.Y;
        saved = o;
        Moved?.Invoke(o);
    }

    Section? SectionUnder(Point p) => expanded ? SectionAt(new Pt(p.X, p.Y), new Pt(DialWindow / 2, DialWindow / 2)) : null;

    void Highlight(Section? s)
    {
        if (s == highlighted) return;
        highlighted = s;
        Draw();
    }

    // Pointer

    protected override void OnMouseEnter(MouseEventArgs e)
    {
        closeTimer.Stop();
        // A short rest, so a pointer passing over the ball does not open the dial.
        if (!expanded && pressed is null) openTimer.Start();
    }

    protected override void OnMouseLeave(MouseEventArgs e)
    {
        openTimer.Stop();
        if (expanded && pressed is null && !dragging) closeTimer.Start();
        Highlight(null);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (pressed is { } start && e.LeftButton == MouseButtonState.Pressed)
        {
            var now = Native.Cursor(this);
            if (Math.Abs(now.X - start.X) + Math.Abs(now.Y - start.Y) <= 3) return;
            // Moving the open dial moves the ball: it closes under the pointer and follows from there.
            pressed = null;
            ReleaseMouseCapture();
            if (expanded) Collapse(now);
            DragMove();
            Settle();
            return;
        }
        Highlight(SectionUnder(e.GetPosition(this)));
    }

    protected override void OnMouseLeftButtonDown(MouseButtonEventArgs e)
    {
        openTimer.Stop();
        pressed = Native.Cursor(this);
        CaptureMouse();
        e.Handled = true;
    }

    protected override void OnMouseLeftButtonUp(MouseButtonEventArgs e)
    {
        if (pressed is null) return;
        pressed = null;
        ReleaseMouseCapture();
        // A click on the closed ball opens the dial at once; the hub does nothing; a section opens.
        if (!expanded) { Expand(); return; }
        if (SectionUnder(e.GetPosition(this)) is not { } s) return;
        Collapse();
        if (Usable(s)) OpenSection?.Invoke(s);
        else if (sections.TryGetValue(s, out var v) && v.Hidden) SettingsRequested?.Invoke();
    }

    protected override void OnMouseRightButtonUp(MouseButtonEventArgs e)
    {
        Collapse();
        var menu = new ContextMenu();
        void Item(string text, Action run)
        {
            var item = new MenuItem { Header = text };
            item.Click += (_, _) => run();
            menu.Items.Add(item);
        }
        Item(Strings.T("quickChat"), () => QuickChatRequested?.Invoke());
        Item(Strings.T("settings"), () => SettingsRequested?.Invoke());
        menu.Items.Add(new Separator());
        Item(Strings.T("hideBall"), () => HideRequested?.Invoke());
        menu.PlacementTarget = this;
        menu.IsOpen = true;
        e.Handled = true;
    }

    // Drop: one picture from another app, as a file or as image data.

    static OfferKind OfferOf(IDataObject data)
    {
        var formats = data.GetFormats(false);
        var files = data.GetDataPresent(DataFormats.FileDrop) && data.GetData(DataFormats.FileDrop) is string[] paths
            ? paths.Select(p => System.IO.Path.GetExtension(p)).ToList()
            : [];
        // A browser's picture comes as a virtual file (FileGroupDescriptorW): not taken unless it also carries the data.
        return FloatingBallRules.Offer(formats, files, IsPicture, promised: formats.Contains("FileGroupDescriptorW"));
    }

    void Over(DragEventArgs e)
    {
        closeTimer.Stop();
        var offer = OfferOf(e.Data);
        if (offer is OfferKind.Nothing or OfferKind.Promise)
        {
            e.Effects = DragDropEffects.None;
            e.Handled = true;
            return;
        }
        if (!expanded) Expand();
        dragging = hover = true;
        var s = SectionUnder(e.GetPosition(this));
        Highlight(s);
        // A section that cannot take the picture refuses it; the hub takes it.
        e.Effects = s is { } section && !Usable(section) ? DragDropEffects.None : DragDropEffects.Copy;
        e.Handled = true;
    }

    protected override void OnDragEnter(DragEventArgs e) => Over(e);
    protected override void OnDragOver(DragEventArgs e) => Over(e);

    protected override void OnDragLeave(DragEventArgs e)
    {
        hover = false;
        Highlight(null);
        closeTimer.Start();
    }

    protected override void OnDrop(DragEventArgs e)
    {
        closeTimer.Stop();
        hover = dragging = false;
        var s = SectionUnder(e.GetPosition(this));
        e.Handled = true;
        if (s is { } section && !Usable(section)) { Collapse(); return; }
        try
        {
            switch (OfferOf(e.Data))
            {
                case OfferKind.File:
                    var file = ((string[])e.Data.GetData(DataFormats.FileDrop))[0];
                    if (new FileInfo(file).Length > 40 * 1024 * 1024) throw new IOException("too large");
                    Dropped?.Invoke(s, File.ReadAllBytes(file), System.IO.Path.GetFileName(file));
                    break;
                case OfferKind.Picture:
                    Dropped?.Invoke(s, PictureBytes(e.Data) ?? throw new IOException("no picture"), "Image");
                    break;
                default:
                    var files = e.Data.GetData(DataFormats.FileDrop) as string[];
                    Refused?.Invoke(files is { Length: > 1 } ? "onePicture" : "notAPicture");
                    break;
            }
        }
        catch (Exception)
        {
            Refused?.Invoke("unreadable");
        }
        Collapse();
    }

    /// <summary>Picture data: PNG as it is, anything else (a bitmap) as PNG.</summary>
    static byte[]? PictureBytes(IDataObject data)
    {
        if (data.GetData("PNG") is MemoryStream png) return png.ToArray();
        if (data.GetData(DataFormats.Bitmap) is BitmapSource bitmap)
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var output = new MemoryStream();
            encoder.Save(output);
            return output.ToArray();
        }
        return null;
    }

    // Drawing

    static bool Dark => Theme.Dark;
    static Brush Line => new SolidColorBrush(Dark ? Color.FromArgb(31, 255, 255, 255) : Color.FromArgb(20, 0, 0, 0));
    static Color Ink => Dark ? Color.FromRgb(235, 235, 245) : Color.FromRgb(60, 60, 67);
    static readonly Color Accent = Color.FromRgb(10, 132, 255);

    void Draw(bool animate = false)
    {
        canvas.Children.Clear();
        if (expanded) DrawDial(animate);
        else DrawBall();
    }

    void DrawBall()
    {
        var disc = new Ellipse
        {
            Width = Diameter - 6,
            Height = Diameter - 6,
            Fill = new SolidColorBrush(Dark ? Color.FromArgb(240, 40, 40, 44) : Color.FromArgb(245, 248, 248, 250)),
            Stroke = hover ? new SolidColorBrush(Accent) : new SolidColorBrush(Dark ? Color.FromArgb(41, 255, 255, 255) : Color.FromArgb(36, 0, 0, 0)),
            StrokeThickness = hover ? 2 : 1,
            Effect = new DropShadowEffect { BlurRadius = 6, ShadowDepth = 1, Direction = 270, Opacity = 0.2 },
        };
        Put(disc, 3, 3);
        Put(new Image { Source = mark, Width = 28, Height = 28 }, Diameter / 2 - 14, Diameter / 2 - 14);
        ToolTip = Strings.T("app");
    }

    void DrawDial(bool animate)
    {
        double c = DialWindow / 2, outer = DialDiameter / 2, inner = HubDiameter / 2;
        var dial = new Canvas { Width = DialWindow, Height = DialWindow };
        var scale = new ScaleTransform(1, 1, c, c);
        dial.RenderTransform = scale;
        canvas.Children.Add(dial);
        void Add(UIElement e, double x, double y) { Canvas.SetLeft(e, x); Canvas.SetTop(e, y); dial.Children.Add(e); }

        Add(new Ellipse
        {
            Width = outer * 2,
            Height = outer * 2,
            Fill = new SolidColorBrush(Dark ? Color.FromArgb(242, 40, 40, 44) : Color.FromArgb(242, 255, 255, 255)),
            Stroke = Line,
            Effect = new DropShadowEffect { BlurRadius = 32, ShadowDepth = 12, Direction = 270, Opacity = 0.18 },
        }, c - outer, c - outer);
        if (highlighted is { } h && (Usable(h) || (sections.TryGetValue(h, out var hv) && hv.Hidden)))
            dial.Children.Add(new System.Windows.Shapes.Path { Data = Wedge(c, Angle(h), inner, outer), Fill = new SolidColorBrush(Color.FromArgb(Dark ? (byte)56 : (byte)36, Accent.R, Accent.G, Accent.B)) });
        for (var d = 45.0; d < 360; d += 90)
        {
            var a = d * Math.PI / 180;
            dial.Children.Add(new System.Windows.Shapes.Line { X1 = c + Math.Cos(a) * inner, Y1 = c - Math.Sin(a) * inner, X2 = c + Math.Cos(a) * outer, Y2 = c - Math.Sin(a) * outer, Stroke = Line, StrokeThickness = 1 });
        }
        foreach (var s in Sections)
        {
            var a = Angle(s) * Math.PI / 180;
            double r = (inner + outer) / 2, x = c + Math.Cos(a) * r, y = c - Math.Sin(a) * r;
            Add(SectionIcon(s), x - 14, y - 14);
        }
        Add(new Ellipse
        {
            Width = inner * 2,
            Height = inner * 2,
            Fill = new SolidColorBrush(Dark ? Color.FromArgb(250, 52, 52, 57) : Color.FromArgb(250, 255, 255, 255)),
            Stroke = Line,
        }, c - inner, c - inner);
        if (HubLabel() is { } label)
        {
            var text = new TextBlock
            {
                Text = label,
                Width = inner * 2 - 8,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxHeight = 30,
                FontSize = 11,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Dark ? Colors.White : Color.FromRgb(26, 26, 30)),
            };
            text.Measure(new Size(inner * 2 - 8, 30));
            Add(text, c - inner + 4, c - text.DesiredSize.Height / 2);
        }
        if (animate)
        {
            // Only the disc's scale and fade animate, never the window's place.
            var grow = new DoubleAnimation(0.35, 1, TimeSpan.FromMilliseconds(220)) { EasingFunction = new BackEase { Amplitude = 0.25, EasingMode = EasingMode.EaseOut } };
            scale.BeginAnimation(ScaleTransform.ScaleXProperty, grow);
            scale.BeginAnimation(ScaleTransform.ScaleYProperty, grow);
            dial.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(160)));
        }
    }

    /// <summary>One section: the ring between the hub and the rim, a quarter wide around its angle.</summary>
    static Geometry Wedge(double c, double angle, double inner, double outer)
    {
        Point At(double degrees, double r) => new(c + Math.Cos(degrees * Math.PI / 180) * r, c - Math.Sin(degrees * Math.PI / 180) * r);
        var figure = new PathFigure { StartPoint = At(angle + 45, outer), IsClosed = true };
        figure.Segments.Add(new ArcSegment(At(angle - 45, outer), new Size(outer, outer), 0, false, SweepDirection.Clockwise, true));
        figure.Segments.Add(new LineSegment(At(angle - 45, inner), true));
        figure.Segments.Add(new ArcSegment(At(angle + 45, inner), new Size(inner, inner), 0, false, SweepDirection.Counterclockwise, true));
        return new PathGeometry([figure]);
    }

    /// <summary>The section's picture: its icon (round for an agent), an emoji, else its first letter; an empty one a dashed circle with a plus.</summary>
    UIElement SectionIcon(Section s)
    {
        const double size = 28;
        var ink = new SolidColorBrush(Ink);
        if (!sections.TryGetValue(s, out var v) || v.Hidden)
        {
            var empty = new Grid { Width = size, Height = size, Opacity = 0.3 };
            empty.Children.Add(new Ellipse { Stroke = ink, StrokeThickness = 1, StrokeDashArray = [3, 2.6] });
            empty.Children.Add(new TextBlock { Text = "+", Foreground = ink, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            return empty;
        }
        FrameworkElement element;
        if (v.Icon is { } source)
        {
            element = new Image
            {
                Source = source,
                Width = size,
                Height = size,
                Clip = v.Round ? new EllipseGeometry(new Point(size / 2, size / 2), size / 2, size / 2) : new RectangleGeometry(new System.Windows.Rect(0, 0, size, size), size * 0.225, size * 0.225),
            };
        }
        else if (v.Emoji is { } emoji)
        {
            element = new TextBlock { Text = emoji, FontFamily = new FontFamily("Segoe UI Emoji"), FontSize = 18, Width = size, Height = size, TextAlignment = TextAlignment.Center };
        }
        else
        {
            var letter = new Grid { Width = size, Height = size };
            letter.Children.Add(v.Round
                ? new Ellipse { Fill = new SolidColorBrush(Color.FromArgb(Dark ? (byte)82 : (byte)41, 120, 120, 128)) }
                : new Border { CornerRadius = new CornerRadius(size * 0.225), Background = new SolidColorBrush(Color.FromArgb(Dark ? (byte)82 : (byte)41, 120, 120, 128)) });
            letter.Children.Add(new TextBlock { Text = v.Title.Trim().FirstOrDefault('?').ToString().ToUpperInvariant(), Foreground = ink, FontWeight = FontWeights.Bold, FontSize = 13, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center });
            element = letter;
        }
        // A section that cannot act now (no agent, or a drag it cannot take) is faded.
        if (!v.Usable) element.Opacity = 0.3;
        return element;
    }

    /// <summary>What the hub says: the section under the pointer ("Send to …" during a drag, "Add in Settings…" for an empty one).</summary>
    string? HubLabel()
    {
        if (highlighted is not { } h) return null;
        if (!sections.TryGetValue(h, out var v) || v.Hidden) return Strings.T("addInSettings");
        return dragging && v.Usable ? Strings.T("sendTo", v.Title) : v.Title;
    }

    void Put(UIElement e, double x, double y)
    {
        Canvas.SetLeft(e, x);
        Canvas.SetTop(e, y);
        canvas.Children.Add(e);
    }
}

/// <summary>Windows' app mode: dark or light (Settings › Personalization › Colors).</summary>
static class Theme
{
    public static bool Dark
    {
        get
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        }
    }
}
