using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using AISpace.Core;
using Frame = AISpace.Core.Frame;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// A screen's widget area in the stepless layout (docs/panel.md#resize-a-widget, src/web/WidgetArea.tsx):
/// the cards at their frames (<see cref="WidgetFlowPanel"/>), and in edit mode a handle on each
/// card's right edge, bottom edge and corner, and a toolbar (Align, Center, Split evenly, Reset, Undo).
/// A drag changes the boundary with the next card of the row (Shift: this card only, the rest re-flow),
/// the row's height, or both; it snaps unless Alt is held, with a guide where it snapped. Each gesture
/// or action is one write of the Space's layout (<c>PUT /api/panel/layout</c>, frames with the nearest
/// classic sizes), drawn at once and put back with a message when it fails; the last one can be undone
/// for eight seconds. Frames are the Space's, global by widget, as the web panel's: the screens stay
/// this computer's. A Space from before the stepless layout draws its cards as before.
/// </summary>
internal sealed partial class HomePage
{
    private static readonly Dictionary<string, ViewStore> ViewStores = [];

    private WidgetFlowPanel? _flow;
    private ContentControl? _toolbarHost;
    private List<HomeWidget> _areaWidgets = [];
    private readonly List<WidgetSlot> _areaSlots = [];
    private readonly List<Thumb> _handles = [];
    private (LayoutWrite Undo, LayoutWrite Redo)? _undoable;
    private DispatcherTimer? _undoTimer, _errorTimer;
    private string? _layoutError;
    private bool _confirmReset;
    /// <summary>The Space refused <c>frames</c> once (an older one): only sizes are written to it, as said once.</summary>
    private bool _sizesOnly;
    private ResizeDrag? _drag;
    private Thumb? _dragThumb;
    private Point _dragFrom;
    private KeyResize? _keys;
    private bool _drawAfterDrag;

    private sealed class KeyResize(Frame[] start, DispatcherTimer timer)
    {
        public Frame[] Start { get; } = start;
        public Frame[] Frames { get; set; } = start;
        public DispatcherTimer Timer { get; } = timer;
    }

    private static ViewStore ViewsFor(string file)
    {
        if (!ViewStores.TryGetValue(file, out var store)) ViewStores[file] = store = new ViewStore(file);
        return store;
    }

    private bool Resizing => _drag is not null || _keys is not null;

    /// <summary>A card an action or a refresh answered with, in its entry's place.</summary>
    private void ReplaceWidget(HomeWidget next)
    {
        if (_catalogue is null) return;
        _catalogue = _catalogue.ReplaceWidget(next);
        Draw();
    }

    /// <summary>A screen's cards: the stepless area on a Space that has it, else the grid as before.</summary>
    private FrameworkElement CardArea(IReadOnlyList<HomeWidget> widgets, string screen)
    {
        if (_catalogue is not { Stepless: true } c) return CardGrid(widgets, screen);
        var editing = EditingHere(screen);
        var flow = new WidgetFlowPanel { Cards = HomeCatalogue.LayoutCards(widgets), Align = c.WidgetAlign ?? WidgetAlign.Start, Viewport = () => ActualWidth };
        KeyboardNavigation.SetDirectionalNavigation(flow, KeyboardNavigationMode.Contained);
        _flow = flow;
        _areaWidgets = widgets.ToList();
        _areaSlots.Clear();
        _handles.Clear();
        foreach (var w in widgets)
        {
            var slot = _cards.Card(w, editing ? CardMode.Editing : CardMode.Live, framed: true, c.WidgetWrites);
            var entry = HomeCatalogue.WidgetEntry(w);
            slot.ContextMenu = new ContextMenu();
            slot.ContextMenuOpening += (_, _) => FillEntryMenu(slot.ContextMenu, entry, screen);
            if (flow.Children.Count == 0) _first ??= FirstButton(slot);
            _areaSlots.Add(slot);
            if (!editing)
            {
                flow.Children.Add(slot);
                continue;
            }
            var host = (Grid)Editable(slot, entry.Key, entry.DisplayTitle(), screen, card: true);
            host.VerticalAlignment = VerticalAlignment.Stretch;
            foreach (var (edge, name) in new[] { (ResizeEdge.X, L.T("Width: drag, or Left and Right arrows (8px, Shift for 1px). Shift-drag re-flows the cards after it; hold Alt to stop snapping")), (ResizeEdge.Y, L.T("Row height: drag, or Up and Down arrows (8px, Shift for 1px); hold Alt to stop snapping")), (ResizeEdge.XY, L.T("Width and height: drag, or the arrow keys (8px, Shift for 1px); hold Alt to stop snapping")) })
            {
                var handle = Handle(w.Id, edge, name);
                host.Children.Add(handle);
                _handles.Add(handle);
            }
            flow.Children.Add(host);
        }
        flow.Arranged = (i, box) =>
        {
            if (i >= _areaSlots.Count) return;
            var slot = _areaSlots[i];
            var st = _cards.State(slot.Widget.Id);
            st.SizeClass = WidgetLayout.SizeClass(st.SizeClass, box.Width, box.Height);
            if (slot.Readout is not { } r) return;
            var text = $"{Math.Round(box.Width, MidpointRounding.AwayFromZero)} × {Math.Round(box.Height, MidpointRounding.AwayFromZero)}";
            if (r.Text != text) r.Text = text;
            var active = i == flow.Active;
            if (r.Tag is bool was && was == active) return;
            r.Tag = active;
            r.SetResourceReference(TextBlock.ForegroundProperty, active ? "AccentTextFillColorPrimaryBrush" : "TextFillColorSecondaryBrush");
        };
        flow.FreeChanged += () =>
        {
            foreach (var h in _handles) h.Visibility = flow.Free ? Visibility.Visible : Visibility.Collapsed;
            UpdateToolbar();
        };
        if (!editing) return flow;
        var column = new StackPanel();
        _toolbarHost = new ContentControl { Focusable = false, IsTabStop = false };
        column.Children.Add(_toolbarHost);
        column.Children.Add(flow);
        UpdateToolbar();
        return column;
    }

    /// <summary>
    /// After a read that drew nothing new: frames, sizes and the alignment changed elsewhere (a browser,
    /// another computer) are put on the area in place, not by drawing the screen anew.
    /// </summary>
    private void SyncFlow()
    {
        if (_flow is null || Resizing || _catalogue is not { } c) return;
        var widgets = _areaWidgets.Select(w => c.Widget(w.Id) ?? w).ToList();
        var cards = HomeCatalogue.LayoutCards(widgets);
        _areaWidgets = widgets;
        if (!cards.SequenceEqual(_flow.Cards)) _flow.Cards = cards;
        _flow.Align = c.WidgetAlign ?? WidgetAlign.Start;
        UpdateToolbar();
    }

    /// <summary>Leaves the layout's edit state (the undo, the reset question) with edit mode.</summary>
    private void ForgetLayoutEdit()
    {
        _undoable = null;
        _undoTimer?.Stop();
        _confirmReset = false;
    }

    // Dragging an edge, and the arrow keys on a focused handle.

    private Thumb Handle(string id, ResizeEdge edge, string name)
    {
        var t = WidgetFlowPanel.Handle(edge, name);
        t.Tag = $"handle:{id}:{edge}";
        t.Visibility = _flow?.Free == true ? Visibility.Visible : Visibility.Collapsed;
        t.DragStarted += (_, _) => StartResize(t, id, edge);
        t.DragDelta += (_, _) => MoveResize();
        t.DragCompleted += (_, e) => EndResize(e.Canceled);
        t.PreviewKeyDown += (_, e) =>
        {
            // Alt or Shift pressed or let go mid-drag changes the snapping at once; Alt must not open the window's menu.
            if (_drag is not null && (e.Key is Key.System or Key.LeftShift or Key.RightShift))
            {
                e.Handled = true;
                MoveResize();
                return;
            }
            KeyStep(id, edge, e);
        };
        t.PreviewKeyUp += (_, e) =>
        {
            if (_drag is null || e.Key is not (Key.System or Key.LeftShift or Key.RightShift)) return;
            e.Handled = true;
            MoveResize();
        };
        t.LostKeyboardFocus += (_, _) => FinishKeys();
        return t;
    }

    private int IndexOf(string id) => _areaWidgets.FindIndex(w => w.Id == id);

    private void StartResize(Thumb t, string id, ResizeEdge edge)
    {
        var i = IndexOf(id);
        if (_flow is not { Free: true } flow || i < 0)
        {
            t.CancelDrag();
            return;
        }
        FinishKeys();
        _dragFrom = Mouse.GetPosition(flow);
        _drag = new ResizeDrag(flow.Frames, flow.AreaWidth, flow.Align, i, edge);
        _dragThumb = t;
        flow.Active = i;
        t.Focus();
    }

    private (Frame[] Frames, Guides Guides)? DragAt()
    {
        if (_drag is null || _flow is null) return null;
        var p = Mouse.GetPosition(_flow);
        var mods = Keyboard.Modifiers;
        return _drag.At(p.X - _dragFrom.X, p.Y - _dragFrom.Y, mods.HasFlag(ModifierKeys.Shift), mods.HasFlag(ModifierKeys.Alt));
    }

    private void MoveResize()
    {
        if (DragAt() is not { } r || _flow is null) return;
        _flow.Live = r.Frames;
        _flow.Guides = r.Guides.Any ? r.Guides : null;
    }

    private void EndResize(bool canceled)
    {
        if (_drag is not { } drag) return;
        var end = canceled ? null : DragAt();
        _drag = null;
        _dragThumb = null;
        if (_flow is { } flow)
        {
            flow.Live = null;
            flow.Guides = null;
            flow.Active = -1;
        }
        if (end is { } r) Commit(drag.Base, r.Frames);
        if (_drawAfterDrag)
        {
            _drawAfterDrag = false;
            Draw();
        }
    }

    /// <summary>The arrows on a focused handle: 8px a press, 1px with Shift; saved once the keys rest or the focus leaves.</summary>
    private void KeyStep(string id, ResizeEdge edge, KeyEventArgs e)
    {
        if (_flow is not { Free: true } flow || _drag is not null) return;
        var mods = Keyboard.Modifiers;
        if (mods is not (ModifierKeys.None or ModifierKeys.Shift)) return;
        var (dx, dy) = e.Key switch { Key.Left => (-1, 0), Key.Right => (1, 0), Key.Up => (0, -1), Key.Down => (0, 1), _ => (0, 0) };
        var i = IndexOf(id);
        if (i < 0 || dx == 0 && dy == 0) return;
        var from = _keys?.Frames ?? flow.Frames;
        if (WidgetLayout.KeyStep(from, flow.AreaWidth, flow.Align, i, edge, dx, dy, mods == ModifierKeys.Shift) is not { } f) return;
        e.Handled = true;
        if (_keys is null)
        {
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(700) };
            timer.Tick += (_, _) => FinishKeys();
            _keys = new KeyResize(from, timer);
        }
        _keys.Frames = f;
        flow.Live = f;
        flow.Active = i;
        _keys.Timer.Stop();
        _keys.Timer.Start();
    }

    private void FinishKeys()
    {
        if (_keys is not { } k) return;
        k.Timer.Stop();
        _keys = null;
        if (_flow is { } flow)
        {
            flow.Live = null;
            flow.Active = -1;
        }
        Commit(k.Start, k.Frames);
        if (_drawAfterDrag)
        {
            _drawAfterDrag = false;
            Draw();
        }
    }

    // Writes.

    private void Commit(IReadOnlyList<Frame> before, IReadOnlyList<Frame> after, bool animate = false)
    {
        if (WidgetLayout.FramesWrite(HomeCatalogue.LayoutCards(_areaWidgets), before, after) is { } r) RunLayout(r.Write, r.Undo, animate);
    }

    /// <summary>A write drawn at once and in the catalogue, so a read meanwhile does not undo it.</summary>
    private void ApplyLayout(LayoutWrite write)
    {
        if (_catalogue is null) return;
        _catalogue = _catalogue.ApplyLayout(write);
        var c = _catalogue;
        _areaWidgets = _areaWidgets.Select(w => c.Widget(w.Id) ?? w).ToList();
        if (_flow is { } flow)
        {
            flow.Cards = HomeCatalogue.LayoutCards(_areaWidgets);
            flow.Align = c.WidgetAlign ?? WidgetAlign.Start;
        }
        UpdateToolbar();
    }

    private async void RunLayout(LayoutWrite write, LayoutWrite undo, bool animate, bool undoing = false)
    {
        try
        {
            if (animate) _flow?.Animate();
            ApplyLayout(write);
            _layoutError = null;
            SetUndo(undoing ? null : (undo, write));
            if (await SaveLayout(write)) return;
            _flow?.Animate();
            ApplyLayout(undo);
            SetUndo(null);
            ShowLayoutError(L.T("The layout could not be saved, so the change was undone"));
        }
        catch (Exception e) when (e is InvalidOperationException or ArgumentException)
        {
            // Never out of an async void: the layout stays as drawn and the next read corrects it.
            Log.Write($"Home could not apply a layout write: {e}");
        }
    }

    /// <summary>
    /// Stores a write. A Space that refuses <c>frames</c> (one from before the stepless layout that
    /// still said it had one) gets the nearest classic sizes instead, from then on, and that is said once.
    /// </summary>
    private async Task<bool> SaveLayout(LayoutWrite write)
    {
        if (Context.Api is not { } api) return false;
        var sending = _sizesOnly ? write.SizesOnly() : write;
        // Only the alignment, to a Space that keeps sizes only: nothing it can store.
        if (sending is null) return true;
        try
        {
            await api.PutLayout(sending);
            return true;
        }
        catch (SpaceApiException e) when (!_sizesOnly && SpaceApi.LayoutRefused(e) && write.SizesOnly() is { } sizes)
        {
            try
            {
                await api.PutLayout(sizes);
                _sizesOnly = true;
                Ui.Toast(_root, L.T("This Space keeps only the classic sizes, so the nearest size was saved."));
                return true;
            }
            catch (SpaceApiException again)
            {
                Log.Write($"Home could not save the widget sizes: {again.Message}");
                return false;
            }
        }
        catch (SpaceApiException e)
        {
            Log.Write($"Home could not save the widget layout: {e.Message}");
            return false;
        }
    }

    private void SetUndo((LayoutWrite Undo, LayoutWrite Redo)? undo)
    {
        _undoable = undo;
        _undoTimer?.Stop();
        if (undo is not null)
        {
            _undoTimer ??= new DispatcherTimer { Interval = TimeSpan.FromSeconds(8) };
            _undoTimer.Tick -= UndoExpired;
            _undoTimer.Tick += UndoExpired;
            _undoTimer.Start();
        }
        UpdateToolbar();
    }

    private void UndoExpired(object? sender, EventArgs e)
    {
        _undoTimer?.Stop();
        _undoable = null;
        UpdateToolbar();
    }

    private void ShowLayoutError(string text)
    {
        _layoutError = text;
        _errorTimer?.Stop();
        _errorTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(6) };
        _errorTimer.Tick += (_, _) =>
        {
            _errorTimer?.Stop();
            _layoutError = null;
            UpdateToolbar();
        };
        _errorTimer.Start();
        UpdateToolbar();
    }

    // The toolbar.

    private void UpdateToolbar()
    {
        if (_toolbarHost is not { } host) return;
        var shown = _flow is { Free: true } && _areaWidgets.Count > 0;
        host.Visibility = shown ? Visibility.Visible : Visibility.Collapsed;
        var focused = host.IsKeyboardFocusWithin && Keyboard.FocusedElement is FrameworkElement { Tag: string tag } ? tag : null;
        host.Content = shown ? Toolbar() : null;
        if (focused is not null && HomeCards.FindTagged(host, focused) is { } again) Dispatcher.BeginInvoke(() => again.Focus(), DispatcherPriority.Input);
    }

    private FrameworkElement Toolbar()
    {
        var bar = new WrapPanel { Margin = new Thickness(0, 0, 0, 12) };
        AutomationProperties.SetName(bar, L.T("Widget layout"));
        Button Tool(string label, string hint, string tag, Action click, bool accent = false)
        {
            var b = Ui.Button(label, click, accent);
            b.ToolTip = hint;
            b.Tag = tag;
            b.MinWidth = 0;
            b.Margin = new Thickness(0, 0, 8, 4);
            return b;
        }
        var align = _catalogue?.WidgetAlign ?? WidgetAlign.Start;
        bar.Children.Add(Tool(L.T("Align"), L.T("Move every edge to the nearest twelfth of the width and even out row heights that are close"), "tool:align", () =>
        {
            if (_flow is { Free: true } f) Commit(f.Frames, WidgetLayout.AlignTwelfths(f.Frames, f.AreaWidth), animate: true);
        }));
        var center = new ToggleButton { Content = L.T("Center"), IsChecked = align == WidgetAlign.Center, ToolTip = L.T("Center rows that do not fill the width"), Padding = new Thickness(14, 6, 14, 6), Margin = new Thickness(0, 0, 8, 4), Tag = "tool:center" };
        AutomationProperties.SetName(center, L.T("Center"));
        center.Click += (_, _) =>
        {
            var (write, undo) = WidgetLayout.CenterWrite(_catalogue?.WidgetAlign ?? WidgetAlign.Start);
            RunLayout(write, undo, animate: true);
        };
        bar.Children.Add(center);
        bar.Children.Add(Tool(L.T("Split evenly"), L.T("Give the cards of every row equal widths and every row the same height"), "tool:split", () =>
        {
            if (_flow is { Free: true } f) Commit(f.Frames, WidgetLayout.SplitEvenly(f.Frames), animate: true);
        }));
        var cards = HomeCatalogue.LayoutCards(_areaWidgets);
        if (_confirmReset)
        {
            var group = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 8, 4) };
            AutomationProperties.SetName(group, L.T("Return every card on this screen to its default size?"));
            var ask = Ui.Text(L.T("Return every card on this screen to its default size?"), 13, wrap: false);
            ask.VerticalAlignment = VerticalAlignment.Center;
            ask.Margin = new Thickness(0, 0, 8, 0);
            var cancel = Tool(L.T("Cancel"), L.T("Cancel"), "tool:reset-no", () =>
            {
                _confirmReset = false;
                UpdateToolbar();
            });
            var reset = Tool(L.T("Reset"), L.T("Return every card on this screen to its default size"), "tool:reset-yes", () =>
            {
                _confirmReset = false;
                if (WidgetLayout.ResetWrite(HomeCatalogue.LayoutCards(_areaWidgets)) is { } r) RunLayout(r.Write, r.Undo, animate: true);
                else UpdateToolbar();
            }, accent: true);
            group.PreviewKeyDown += (_, e) =>
            {
                if (e.Key != Key.Escape) return;
                e.Handled = true;
                _confirmReset = false;
                UpdateToolbar();
            };
            group.Children.Add(ask);
            group.Children.Add(cancel);
            group.Children.Add(reset);
            bar.Children.Add(group);
            Dispatcher.BeginInvoke(() => reset.Focus(), DispatcherPriority.Input);
        }
        else
        {
            var reset = Tool(L.T("Reset"), L.T("Return every card on this screen to its default size"), "tool:reset", () =>
            {
                _confirmReset = true;
                UpdateToolbar();
            });
            reset.IsEnabled = cards.Any(c => c.Frame is not null);
            bar.Children.Add(reset);
        }
        if (_undoable is { } u)
        {
            bar.Children.Add(Tool("↶ " + L.T("Undo"), L.T("Undo"), "tool:undo", () =>
            {
                _undoable = null;
                RunLayout(u.Undo, u.Redo, animate: true, undoing: true);
            }));
        }
        if (_layoutError is { } error)
        {
            var t = Ui.Text(error, 12.5, wrap: false);
            t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
            t.VerticalAlignment = VerticalAlignment.Center;
            AutomationProperties.SetLiveSetting(t, AutomationLiveSetting.Assertive);
            bar.Children.Add(t);
        }
        return bar;
    }
}
