using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using AISpace.Core;
using Frame = AISpace.Core.Frame;

namespace AISpace.Views;

/// <summary>
/// A screen's widget area in the stepless layout (src/web/WidgetArea.tsx, docs/panel.md#resize-a-widget):
/// every child at the box <see cref="WidgetLayout.Place"/> gives its card, in rows with the fixed
/// gap, as tall as its rows. The arithmetic is all in <see cref="WidgetLayout"/>; this only measures
/// and arranges. At a page width of 700 or less it is one column of cards sized by their content,
/// as before; the frames are kept and not applied. Children are the cards, in <see cref="Cards"/>' order.
/// </summary>
internal sealed class WidgetFlowPanel : Panel
{
    /// <summary>How far a move (a toolbar action, an undo) has come, 0 to 1: the cards slide from their previous boxes.</summary>
    public static readonly DependencyProperty TweenProperty = DependencyProperty.Register(nameof(Tween), typeof(double), typeof(WidgetFlowPanel),
        new FrameworkPropertyMetadata(1.0, FrameworkPropertyMetadataOptions.AffectsArrange));

    private IReadOnlyList<LayoutCard> _cards = [];
    private WidgetAlign _align;
    private Frame[]? _live;
    private Guides? _guides;
    private readonly GuideAdorner _adorner;
    private Dictionary<string, Rect> _last = [], _from = [];

    public WidgetFlowPanel()
    {
        _adorner = new GuideAdorner(this);
        Loaded += (_, _) =>
        {
            if (AdornerLayer.GetAdornerLayer(this) is { } layer && VisualTreeHelper.GetParent(_adorner) is null) layer.Add(_adorner);
        };
        Unloaded += (_, _) => AdornerLayer.GetAdornerLayer(this)?.Remove(_adorner);
    }

    public double Tween
    {
        get => (double)GetValue(TweenProperty);
        set => SetValue(TweenProperty, value);
    }

    /// <summary>The cards as the layout knows them (id, size, frame), one per child.</summary>
    public IReadOnlyList<LayoutCard> Cards
    {
        get => _cards;
        set
        {
            _cards = value;
            InvalidateMeasure();
        }
    }

    public WidgetAlign Align
    {
        get => _align;
        set
        {
            if (_align == value) return;
            _align = value;
            InvalidateMeasure();
        }
    }

    /// <summary>While an edge is dragged or moved with the keys: the frames shown instead of the stored ones.</summary>
    public Frame[]? Live
    {
        get => _live;
        set
        {
            _live = value;
            InvalidateMeasure();
        }
    }

    /// <summary>The snap lines shown over the cards while an edge is dragged.</summary>
    public Guides? Guides
    {
        get => _guides;
        set
        {
            _guides = value;
            _adorner.InvalidateVisual();
        }
    }

    /// <summary>The card whose edge is being moved, -1 for none (its size in the head is highlighted).</summary>
    public int Active { get; set; } = -1;

    /// <summary>The page's width, which decides the one-column layout (the web's viewport).</summary>
    public Func<double> Viewport { get; set; } = () => double.PositiveInfinity;

    /// <summary>The cards are drawn at their frames (not one column); known after a measure.</summary>
    public bool Free { get; private set; }

    /// <summary>The area's width at the last measure.</summary>
    public double AreaWidth { get; private set; }

    /// <summary>Raised (after the layout pass) when <see cref="Free"/> changes: the toolbar and handles show only then.</summary>
    public event Action? FreeChanged;

    /// <summary>Each card's box after it is arranged (its index, the box): its size in the head, its size class.</summary>
    public Action<int, Box>? Arranged { get; set; }

    /// <summary>The frames as drawn now: the live ones, else the stored ones with defaults from the sizes.</summary>
    public Frame[] Frames => _live ?? WidgetLayout.ResolveFrames(_cards, AreaWidth);

    public Placed? Placed { get; private set; }

    /// <summary>The next arrangement slides every card from where it is now (not under reduced motion).</summary>
    public void Animate()
    {
        if (!Motion.On || !Free) return;
        _from = new Dictionary<string, Rect>(_last);
        BeginAnimation(TweenProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(240)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } }, HandoffBehavior.SnapshotAndReplace);
    }

    private IEnumerable<UIElement> Cells => InternalChildren.Cast<UIElement>();

    protected override Size MeasureOverride(Size available)
    {
        // The area sits in the page's column, whose width is always bounded; the fallback is that column's widest.
        AreaWidth = double.IsInfinity(available.Width) ? 1036 : available.Width;
        var free = !WidgetLayout.OneColumn(Viewport()) && AreaWidth > 0 && _cards.Count == InternalChildren.Count && _cards.Count > 0;
        if (free != Free)
        {
            Free = free;
            Dispatcher.BeginInvoke(() => FreeChanged?.Invoke());
        }
        if (!free)
        {
            Placed = null;
            double y = 0;
            foreach (var c in Cells)
            {
                c.Measure(new Size(AreaWidth, double.PositiveInfinity));
                y += c.DesiredSize.Height + WidgetLayout.Gap;
            }
            return new Size(AreaWidth, Math.Max(0, y - WidgetLayout.Gap));
        }
        var placed = WidgetLayout.Place(Frames, AreaWidth, _align);
        Placed = placed;
        var i = 0;
        foreach (var c in Cells)
        {
            var b = placed.Boxes[i++];
            c.Measure(new Size(b.Width, b.Height));
        }
        return new Size(AreaWidth, placed.Height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        if (!Free || Placed is not { } placed)
        {
            double y = 0;
            foreach (var c in Cells)
            {
                c.Arrange(new Rect(0, y, final.Width, c.DesiredSize.Height));
                y += c.DesiredSize.Height + WidgetLayout.Gap;
            }
            _last.Clear();
            return final;
        }
        var t = Math.Clamp(Tween, 0, 1);
        var next = new Dictionary<string, Rect>();
        var i = 0;
        foreach (var c in Cells)
        {
            var b = placed.Boxes[i];
            var target = new Rect(b.X, b.Y, b.Width, b.Height);
            var id = _cards[i].Id;
            var rect = t < 1 && _from.TryGetValue(id, out var from)
                ? new Rect(from.X + (target.X - from.X) * t, from.Y + (target.Y - from.Y) * t, from.Width + (target.Width - from.Width) * t, from.Height + (target.Height - from.Height) * t)
                : target;
            c.Arrange(rect);
            next[id] = target;
            Arranged?.Invoke(i, b);
            i++;
        }
        _last = next;
        _adorner.InvalidateVisual();
        return final;
    }

    /// <summary>
    /// A handle of a card in edit mode (WidgetArea.tsx <c>wl-handle</c>): its right edge, bottom edge
    /// or corner, with the resize cursor, a thin accent bar under the pointer or the focus, focusable
    /// and named for screen readers. What dragging or the arrow keys do is the page's (HomeLayout.cs).
    /// </summary>
    public static Thumb Handle(ResizeEdge edge, string name)
    {
        var template = new ControlTemplate(typeof(Thumb));
        var root = new FrameworkElementFactory(typeof(Border));
        root.SetValue(Border.BackgroundProperty, Brushes.Transparent);
        var bar = new FrameworkElementFactory(typeof(Border)) { Name = "bar" };
        bar.SetValue(Border.CornerRadiusProperty, new CornerRadius(2));
        bar.SetResourceReference(Border.BackgroundProperty, "AccentFillColorDefaultBrush");
        bar.SetValue(UIElement.OpacityProperty, 0.0);
        bar.SetValue(FrameworkElement.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        bar.SetValue(FrameworkElement.VerticalAlignmentProperty, VerticalAlignment.Center);
        switch (edge)
        {
            case ResizeEdge.X:
                bar.SetValue(FrameworkElement.WidthProperty, 4.0);
                bar.SetValue(FrameworkElement.HeightProperty, 40.0);
                break;
            case ResizeEdge.Y:
                bar.SetValue(FrameworkElement.WidthProperty, 40.0);
                bar.SetValue(FrameworkElement.HeightProperty, 4.0);
                break;
            default:
                bar.SetValue(FrameworkElement.WidthProperty, 10.0);
                bar.SetValue(FrameworkElement.HeightProperty, 10.0);
                bar.SetValue(Border.CornerRadiusProperty, new CornerRadius(0, 0, 4, 0));
                break;
        }
        root.AppendChild(bar);
        template.VisualTree = root;
        foreach (var p in new[] { UIElement.IsMouseOverProperty, UIElement.IsKeyboardFocusedProperty, Thumb.IsDraggingProperty })
        {
            var trigger = new Trigger { Property = p, Value = true };
            trigger.Setters.Add(new Setter(UIElement.OpacityProperty, 1.0, "bar"));
            template.Triggers.Add(trigger);
        }
        var thumb = new Thumb
        {
            Template = template,
            Focusable = true,
            IsTabStop = true,
            ToolTip = name,
            Cursor = edge switch { ResizeEdge.X => Cursors.SizeWE, ResizeEdge.Y => Cursors.SizeNS, _ => Cursors.SizeNWSE },
        };
        AutomationProperties.SetName(thumb, name);
        // Half over the card, half over the gap, clear of the ✕ and of each other (the web's 14px bands).
        switch (edge)
        {
            case ResizeEdge.X:
                thumb.Width = 14;
                thumb.HorizontalAlignment = HorizontalAlignment.Right;
                thumb.VerticalAlignment = VerticalAlignment.Stretch;
                thumb.Margin = new Thickness(0, 14, -10, 22);
                break;
            case ResizeEdge.Y:
                thumb.Height = 14;
                thumb.HorizontalAlignment = HorizontalAlignment.Stretch;
                thumb.VerticalAlignment = VerticalAlignment.Bottom;
                thumb.Margin = new Thickness(14, 0, 22, -10);
                break;
            default:
                thumb.Width = 20;
                thumb.Height = 20;
                thumb.HorizontalAlignment = HorizontalAlignment.Right;
                thumb.VerticalAlignment = VerticalAlignment.Bottom;
                thumb.Margin = new Thickness(0, 0, -6, -6);
                break;
        }
        return thumb;
    }
}

/// <summary>The thin accent lines over the area that show what a dragged edge snapped to.</summary>
internal sealed class GuideAdorner : Adorner
{
    private readonly WidgetFlowPanel _panel;

    public GuideAdorner(WidgetFlowPanel panel) : base(panel)
    {
        _panel = panel;
        IsHitTestVisible = false;
    }

    protected override void OnRender(DrawingContext dc)
    {
        if (_panel.Guides is not { } g) return;
        var brush = _panel.TryFindResource("AccentFillColorDefaultBrush") as Brush ?? Brushes.DodgerBlue;
        // A brush of the theme takes its colour from a resource and cannot be frozen; a copy of its colour can.
        var pen = new Pen(HomeChart.Faded(brush, 1), 1.5);
        double w = _panel.ActualWidth, h = _panel.ActualHeight;
        foreach (var x in g.X) dc.DrawLine(pen, new Point(x, 0), new Point(x, h));
        foreach (var y in g.Y) dc.DrawLine(pen, new Point(0, y), new Point(w, y));
    }
}
