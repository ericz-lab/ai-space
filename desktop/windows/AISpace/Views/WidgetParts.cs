using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>Where a card is drawn: on a screen (its controls respond), on a screen in edit mode or in the library and search results (drawn, inert).</summary>
internal enum CardMode
{
    Live,
    Editing,
    Preview,
}

/// <summary>
/// What a widget card remembers between drawings, by widget id: Home draws a whole screen anew when
/// the Space's answer changes, and the card's choices, typed text, pending action and the values it
/// last showed (for the change flash) must outlive that.
/// </summary>
internal sealed class CardState
{
    public string? View;
    public int Page;
    public string Draft = "";
    /// <summary>The action on its way; the others wait.</summary>
    public string? Busy;
    /// <summary>Checks ticked while their action is on its way, untouched once it answered.</summary>
    public readonly HashSet<string> Ticked = [];
    public CardMessage? Message;
    public CardQuestion? Asking;
    public bool Refreshing;
    /// <summary>The blocks last drawn and the view they were in: a change between two payloads of the same view flashes.</summary>
    public IReadOnlyList<WidgetBlock>? Drawn;
    public string? DrawnView;
    /// <summary>The view and page last shown: their entrance plays when they change, not on a plain refresh.</summary>
    public string? Shown;
    /// <summary>The size class the inner layout last followed, for the hysteresis.</summary>
    public string? SizeClass;
    /// <summary>The card as last drawn, which a timer or an answer redraws.</summary>
    public WidgetSlot? Slot;
}

internal sealed record CardMessage(bool Error, string Text);

/// <summary>An in-card confirmation of an action: its question, the action's label as the button, and the answer once given.</summary>
internal sealed record CardQuestion(string Text, string Label, TaskCompletionSource<bool> Answer);

/// <summary>What a card lets its blocks do (WidgetBlocks.tsx <c>BlockCtx</c>).</summary>
internal sealed record BlockCtx(bool Live, bool Acts, bool ActLive, string? Busy, IReadOnlySet<string> Ticked, Action<BlockAction> OnAction, bool Motion, IReadOnlyList<Change?>? Marks);

/// <summary>
/// One widget card's place in a grid or the widget area: it keeps its key, menu and size while its
/// content is drawn anew (<see cref="Rebuild"/>) after a choice, an action or a timer, so a change
/// inside one card redraws that card only.
/// </summary>
internal sealed class WidgetSlot(Func<WidgetSlot, FrameworkElement> build, HomeWidget widget, CardMode mode, bool framed, bool writes) : Border
{
    /// <summary>The widget drawn; a refresh whose answer changed nothing on the page but its time puts the new one here.</summary>
    public HomeWidget Widget { get; set; } = widget;
    public CardMode Mode { get; } = mode;
    /// <summary>Laid out by the widget area at its frame's box (rather than sized by its content).</summary>
    public bool Framed { get; } = framed;
    /// <summary>The Space has the widgets' writes (refresh, actions).</summary>
    public bool Writes { get; } = writes;
    /// <summary>The <c>W × H</c> in the head while the screen is edited.</summary>
    public TextBlock? Readout { get; set; }

    public void Rebuild()
    {
        // The focused control of this card gets the focus back on its new self.
        var focused = IsKeyboardFocusWithin && Keyboard.FocusedElement is FrameworkElement { Tag: string tag } ? tag : null;
        Child = build(this);
        if (focused is null) return;
        Dispatcher.BeginInvoke(() =>
        {
            if (HomeCards.FindTagged(this, focused) is { } again) again.Focus();
        }, DispatcherPriority.Input);
    }
}

/// <summary>
/// The compact rows of a card in pages (WidgetBlocks.tsx <c>Blocks</c> with <c>useFitRows</c>): in a
/// card of a fixed height as many rows per page as fit under the hero (<see cref="WidgetLayout.RowsThatFit"/>
/// with the rows' measured heights), else the size's table; the dots under them choose the page (a
/// click, Left and Right, a horizontal swipe or scroll). Every row is measured, so the height is the
/// tallest page's on every page; the rows of the other pages are hidden, not removed.
/// </summary>
internal sealed class PagedRows : Panel
{
    private const double RowGap = 10, PagerGap = 6;
    private readonly int _rows;
    private readonly StackPanel _pager = new() { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center };
    private int _per, _pages = 1, _drawnPages, _drawnPage = -1, _wheel;

    /// <param name="rows">The rows, in order.</param>
    /// <param name="table">Rows per page when the height is not fixed.</param>
    /// <param name="paged">False: no pages, only the rows that fit are shown (a list card).</param>
    public PagedRows(IReadOnlyList<UIElement> rows, int table, int page, bool paged, bool live, Action<int, bool> choose)
    {
        _rows = rows.Count;
        Table = Math.Max(1, table);
        Page = page;
        Paged = paged;
        Live = live;
        Choose = choose;
        foreach (var r in rows) Children.Add(r);
        Children.Add(_pager);
        AutomationProperties.SetName(_pager, L.T("Pages"));
        KeyboardNavigation.SetDirectionalNavigation(_pager, KeyboardNavigationMode.None);
        _pager.PreviewKeyDown += (_, e) =>
        {
            if (!Live || e.Key is not (Key.Left or Key.Right)) return;
            e.Handled = true;
            Go(Math.Clamp(Page + (e.Key == Key.Right ? 1 : -1), 0, _pages - 1), focus: true);
        };
        ClipToBounds = true;
        Loaded += (_, _) => WheelHook.Attach(this);
        TouchDown += OnTouchDown;
        TouchUp += OnTouchUp;
    }

    public int Table { get; }
    public int Page { get; private set; }
    public bool Paged { get; }
    public bool Live { get; }
    /// <summary>A page chosen, and whether its dot should take the focus (the keyboard chose it).</summary>
    private Action<int, bool> Choose { get; }
    public int Pages => _pages;

    private void Go(int page, bool focus)
    {
        if (page == Page || page < 0 || page >= _pages) return;
        Choose(page, focus);
    }

    /// <summary>A notch of a horizontal scroll (positive to the right): the next or previous page once a whole notch has come.</summary>
    public bool Scroll(int delta)
    {
        if (!Live || _pages < 2) return false;
        _wheel += delta;
        if (Math.Abs(_wheel) < 120) return true;
        var notches = _wheel / 120;
        _wheel = 0;
        Go(WidgetInteract.ScrollPage(Page, _pages, notches), focus: false);
        return true;
    }

    private Point? _touch;

    private void OnTouchDown(object? sender, TouchEventArgs e) => _touch = e.GetTouchPoint(this).Position;

    private void OnTouchUp(object? sender, TouchEventArgs e)
    {
        if (_touch is not { } start || !Live) return;
        _touch = null;
        var end = e.GetTouchPoint(this).Position;
        Go(WidgetInteract.SwipePage(Page, _pages, end.X - start.X, end.Y - start.Y), focus: false);
    }

    private IEnumerable<UIElement> Rows => Children.Cast<UIElement>().Take(_rows);

    protected override Size MeasureOverride(Size available)
    {
        var width = available.Width;
        var heights = new List<double>();
        foreach (var r in Rows)
        {
            r.Measure(new Size(width, double.PositiveInfinity));
            heights.Add(r.DesiredSize.Height);
        }
        _pager.Measure(new Size(width, double.PositiveInfinity));
        var pagerH = Paged ? _pager.DesiredSize.Height + PagerGap : 0;
        var fixedHeight = !double.IsInfinity(available.Height);
        // A pager with no dots yet measures nothing; the dots' own height is what it will take.
        if (Paged && pagerH <= PagerGap) pagerH = 14 + PagerGap;
        _per = _rows == 0 ? 1 : fixedHeight ? WidgetLayout.RowsThatFit(available.Height, heights, RowGap, 1, pagerH) : Math.Min(Table, _rows);
        _pages = Paged ? WidgetInteract.PagesOf(Enumerable.Range(0, _rows).ToList(), _per).Count : 1;
        if (Page >= _pages) Page = _pages - 1;
        if (Paged && (_pages != _drawnPages || Page != _drawnPage))
        {
            // The dots are children of the pager; they are made after this pass, not during it.
            var (pages, page) = (_pages, Page);
            Dispatcher.BeginInvoke(() => Dots(pages, page), DispatcherPriority.Render);
        }
        double tallest = 0;
        for (var k = 0; k < _rows; k += _per)
        {
            double h = 0;
            for (var j = k; j < Math.Min(_rows, k + _per); j++) h += heights[j] + (j > k ? RowGap : 0);
            tallest = Math.Max(tallest, h);
            if (!Paged) break;
        }
        var height = tallest + (_pages > 1 ? pagerH : 0);
        return new Size(double.IsInfinity(width) ? Rows.Select(r => r.DesiredSize.Width).DefaultIfEmpty(0).Max() : width, fixedHeight ? Math.Min(height, available.Height) : height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double y = 0;
        var i = 0;
        var first = Page * _per;
        foreach (var r in Rows)
        {
            var shown = i >= first && i < first + _per;
            // Hidden, not collapsed: the row keeps its measure (the page's height) and leaves the Tab order.
            r.Visibility = shown ? Visibility.Visible : Visibility.Hidden;
            if (shown)
            {
                r.Arrange(new Rect(0, y, final.Width, r.DesiredSize.Height));
                y += r.DesiredSize.Height + RowGap;
            }
            else
            {
                r.Arrange(new Rect(0, 0, final.Width, r.DesiredSize.Height));
            }
            i++;
        }
        var showPager = Paged && _pages > 1;
        _pager.Visibility = showPager ? Visibility.Visible : Visibility.Hidden;
        var ph = _pager.DesiredSize.Height;
        _pager.Arrange(showPager ? new Rect(0, final.Height - ph, final.Width, ph) : new Rect(0, 0, 0, 0));
        return final;
    }

    /// <summary>One dot per page, the current one filled: a button each, named "Page 2 of 3".</summary>
    private void Dots(int pages, int page)
    {
        if (pages == _drawnPages && page == _drawnPage) return;
        _drawnPages = pages;
        _drawnPage = page;
        _pager.Children.Clear();
        if (pages < 2) return;
        for (var p = 0; p < pages; p++)
        {
            var at = p;
            var dot = new System.Windows.Shapes.Ellipse { Width = 7, Height = 7 };
            dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, p == page ? "AccentFillColorDefaultBrush" : "ControlStrongFillColorDisabledBrush");
            var b = new Button
            {
                Content = dot,
                Padding = new Thickness(4),
                MinWidth = 0,
                MinHeight = 0,
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(0),
                IsEnabled = Live,
                Tag = $"page:{p}",
                // Tab reaches the current dot; Left and Right move between them.
                IsTabStop = p == page,
            };
            AutomationProperties.SetName(b, L.F("Page {0} of {1}", p + 1, pages));
            if (p == page) AutomationProperties.SetItemStatus(b, "current");
            b.Click += (_, e) =>
            {
                e.Handled = true;
                Go(at, focus: false);
            };
            _pager.Children.Add(b);
        }
    }
}

/// <summary>
/// A horizontal scroll (a touchpad's two-finger swipe, a tilted wheel) over a card's rows turns its
/// pages. WPF does not route <c>WM_MOUSEHWHEEL</c>, so each window's messages are watched once.
/// </summary>
internal static class WheelHook
{
    private const int WmMouseHWheel = 0x020E;
    private static readonly HashSet<HwndSource> Hooked = [];

    public static void Attach(Visual v)
    {
        if (PresentationSource.FromVisual(v) is not HwndSource source || !Hooked.Add(source)) return;
        source.AddHook(Hook);
        source.Disposed += (_, _) => Hooked.Remove(source);
    }

    private static IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WmMouseHWheel) return IntPtr.Zero;
        var delta = (short)((wParam.ToInt64() >> 16) & 0xFFFF);
        for (var d = Mouse.DirectlyOver as DependencyObject; d is not null; d = d is Visual ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d))
        {
            if (d is PagedRows rows && rows.Scroll(delta))
            {
                handled = true;
                break;
            }
        }
        return IntPtr.Zero;
    }
}

/// <summary>
/// A card's motion: the entrance of bars, gauges, tanks and the hero's number, and the flash of a
/// value that changed. All of it is left out when Windows is set to show fewer animations
/// (<see cref="SystemParameters.ClientAreaAnimation"/>, as the desk pet).
/// </summary>
internal static class Motion
{
    public static bool On => SystemParameters.ClientAreaAnimation;

    private static readonly IEasingFunction Out = new CubicEase { EasingMode = EasingMode.EaseOut };

    /// <summary>A drawing that grows into place over about 600 ms.</summary>
    public static void Enter(HomeChart chart)
    {
        if (!On) return;
        chart.Reveal = 0;
        chart.BeginAnimation(HomeChart.RevealProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(600)) { EasingFunction = Out }, HandoffBehavior.SnapshotAndReplace);
    }

    /// <summary>A number counting up from 0 over about 600 ms, whole numbers as whole numbers.</summary>
    public static void CountUp(TextBlock t, double target, Func<double, string> format)
    {
        if (!On || target == 0) return;
        var whole = Math.Abs(target % 1) < 1e-12;
        var start = DateTime.UtcNow;
        var timer = new DispatcherTimer(DispatcherPriority.Render) { Interval = TimeSpan.FromMilliseconds(16) };
        t.Text = format(0);
        timer.Tick += (_, _) =>
        {
            var k = Math.Min(1, (DateTime.UtcNow - start).TotalMilliseconds / 600);
            var x = target * (1 - Math.Pow(1 - k, 3));
            t.Text = format(k >= 1 ? target : whole ? Math.Round(x) : x);
            if (k >= 1 || !t.IsLoaded && k > 0.05) timer.Stop();
        };
        timer.Start();
    }

    /// <summary>
    /// A value that changed since the last payload: up in the positive tone, down in the negative one,
    /// fading back to <paramref name="restoreKey"/>; other text on a brief tint. About 1.2 s.
    /// </summary>
    public static void Flash(TextBlock t, Change change, string restoreKey)
    {
        if (!On) return;
        if (change == Change.Text)
        {
            var tint = new SolidColorBrush(((t.TryFindResource("TextFillColorPrimaryBrush") as SolidColorBrush)?.Color ?? Colors.Gray) with { A = 0x1F });
            t.Background = tint;
            var fade = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(780)) { BeginTime = TimeSpan.FromMilliseconds(420) };
            fade.Completed += (_, _) => t.Background = null;
            tint.BeginAnimation(Brush.OpacityProperty, fade);
            return;
        }
        var key = HomeCards.ToneKey(change == Change.Up ? Tone.Positive : Tone.Negative)!;
        var from = (t.TryFindResource(key) as SolidColorBrush)?.Color ?? (change == Change.Up ? Color.FromRgb(0x0F, 0x7B, 0x0F) : Color.FromRgb(0xC4, 0x2B, 0x1C));
        var to = (t.TryFindResource(restoreKey) as SolidColorBrush)?.Color ?? Colors.Gray;
        var brush = new SolidColorBrush(from);
        t.Foreground = brush;
        var back = new ColorAnimation(from, to, TimeSpan.FromMilliseconds(780)) { BeginTime = TimeSpan.FromMilliseconds(420) };
        back.Completed += (_, _) => t.SetResourceReference(TextBlock.ForegroundProperty, restoreKey);
        brush.BeginAnimation(SolidColorBrush.ColorProperty, back);
    }
}
