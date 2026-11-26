using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
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
/// out at its size, in the theme's colours as they are then. <see cref="Reveal"/> (0 to 1) is how
/// far its entrance has come; <see cref="Hover"/> the trend point under the pointer.
/// </summary>
internal sealed class HomeChart(Action<DrawingContext, Size, HomeChart> draw) : FrameworkElement
{
    public static readonly DependencyProperty RevealProperty = DependencyProperty.Register(nameof(Reveal), typeof(double), typeof(HomeChart),
        new FrameworkPropertyMetadata(1.0, FrameworkPropertyMetadataOptions.AffectsRender));

    public double Reveal
    {
        get => (double)GetValue(RevealProperty);
        set => SetValue(RevealProperty, value);
    }

    private int _hover = -1;

    public int Hover
    {
        get => _hover;
        set
        {
            if (_hover == value) return;
            _hover = value;
            InvalidateVisual();
        }
    }

    protected override void OnRender(DrawingContext dc)
    {
        if (ActualWidth <= 0 || ActualHeight <= 0) return;
        try
        {
            draw(dc, new Size(ActualWidth, ActualHeight), this);
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            // A throw here would stop every layout pass of the window: the drawing is left out instead.
            Shell.Log.Write($"Home chart not drawn: {e.Message}");
        }
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

    /// <summary>
    /// The brush's colour at <paramref name="opacity"/>, as a new frozen brush. Not a clone: the
    /// theme's brushes take their colour from a resource, a clone keeps that binding, and a brush
    /// bound so cannot be frozen; a throw while rendering stops every layout pass of the window.
    /// </summary>
    public static Brush Faded(Brush b, double opacity)
    {
        var faded = new SolidColorBrush(b is SolidColorBrush s ? s.Color : Colors.Gray) { Opacity = opacity };
        faded.Freeze();
        return faded;
    }
}

/// <summary>
/// A widget as a card, drawn as the panel draws it (docs/panel.md#widgets, src/web/Tiles.tsx
/// <c>Widget</c> and WidgetBlocks.tsx), the Mac and Linux do: the head opens the widget's page and
/// shows when it was read (a control that reads it again, on a Space that can); views switch what
/// the card shows; a block card leads with its first block (label, big value, change, chart or bar)
/// and lists the next ones as rows in pages; blocks may carry a copy control, a check or a button,
/// and the card's footer its text field and buttons (docs/app-spec.md#views-copy-and-actions). A
/// list card shows its items with their age. An <c>embed</c> widget's page is not drawn inside the
/// card here (a web view does not scroll with WPF content): the card opens it instead. Colour inside
/// a card is data, nothing else. A peer's card has no write-back controls, whatever it carries.
/// </summary>
internal sealed class HomeCards(PageContext context, Action<HomeWidget, string?> open, Action<HomeWidget> update, ViewStore views)
{
    public const double NarrowWidth = 252, Gap = 12;

    private readonly Dictionary<string, CardState> _states = [];

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
        KeyboardNavigation.SetDirectionalNavigation(p, KeyboardNavigationMode.Contained);
        return p;
    }

    /// <summary>The element under <paramref name="root"/> (logical tree) whose <c>Tag</c> is <paramref name="tag"/> and that can take the focus.</summary>
    public static FrameworkElement? FindTagged(DependencyObject root, string tag)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
        {
            if (child is FrameworkElement { Tag: string t, Focusable: true } f && t == tag) return f;
            if (FindTagged(child, tag) is { } found) return found;
        }
        return null;
    }

    public CardState State(string id) => _states.TryGetValue(id, out var s) ? s : _states[id] = new CardState();

    /// <summary>
    /// A widget's card. <paramref name="framed"/>: the widget area lays it out at its frame's box (it
    /// fills it and its rows fit it); otherwise it is as wide as its size and as tall as its content.
    /// <paramref name="writes"/>: the Space has the widgets' writes (an older one shows as before).
    /// </summary>
    public WidgetSlot Card(HomeWidget w, CardMode mode, bool framed, bool writes)
    {
        var slot = new WidgetSlot(Build, w, mode, framed, writes) { Tag = HomeKeys.Of(HomeKind.Widget, w.Id), Focusable = false };
        if (!framed)
        {
            slot.Width = w.Wide ? NarrowWidth * 2 + Gap : NarrowWidth;
            slot.Margin = new Thickness(0, 0, Gap, Gap);
            slot.VerticalAlignment = VerticalAlignment.Top;
        }
        AutomationProperties.SetName(slot, w.DisplayTitle());
        slot.Rebuild();
        return slot;
    }

    private FrameworkElement Build(WidgetSlot slot)
    {
        var w = slot.Widget;
        var st = State(w.Id);
        var onScreen = slot.Mode != CardMode.Preview;
        if (onScreen) st.Slot = slot;
        var title = w.DisplayTitle();
        var live = slot.Mode == CardMode.Live;
        var acts = w.Peer is null;
        var actLive = live && acts && slot.Writes && context.Api is not null;

        // The view shown: the one chosen here (kept per widget), else the first.
        var viewList = w.Ok != false && w.Views is { Count: > 1 } vs ? vs : null;
        string? viewId = null;
        if (viewList is not null)
        {
            var ids = viewList.Select(v => v.Id).ToList();
            viewId = st.View is { } chosen && ids.Contains(chosen) ? chosen : views.Load(w.Id, ids);
            st.View = viewId;
        }
        var body = WidgetBlocks.BodyOf(w);
        var blocks = body is CardBody.Error or CardBody.Embed ? null : WidgetInteract.BlocksOf(w, viewId);
        if (body is CardBody.Items or CardBody.Empty && blocks is { Count: > 0 }) body = CardBody.Blocks;
        if (body == CardBody.Blocks && blocks is not { Count: > 0 }) body = w.Items is { Count: > 0 } ? CardBody.Items : CardBody.Empty;

        // A value that changed between two payloads of the same view flashes; the entrance plays on
        // first appearance and on a view or page change, not on a plain refresh.
        IReadOnlyList<Change?>? marks = null;
        var motion = false;
        if (onScreen && blocks is { Count: > 0 })
        {
            var viewKey = viewId ?? "";
            if (st.Drawn is { } prev && st.DrawnView == viewKey && !ReferenceEquals(prev, blocks)) marks = WidgetInteract.BlockChanges(prev, blocks);
            st.Drawn = blocks;
            st.DrawnView = viewKey;
            var shown = $"{viewKey}|{st.Page}";
            motion = st.Shown != shown && Motion.On;
            st.Shown = shown;
        }

        var ctx = new BlockCtx(live, acts, actLive, st.Busy, st.Ticked, a => _ = Run(slot, a.Id, a.Kind, a.Label, a.Confirm, null), motion, marks);

        var dock = new DockPanel { LastChildFill = true };
        var head = Head(slot, title, live, acts);
        DockPanel.SetDock(head, Dock.Top);
        dock.Children.Add(head);
        if (viewList is not null)
        {
            var row = ViewSwitch(slot, viewList, viewId!, live);
            DockPanel.SetDock(row, Dock.Top);
            dock.Children.Add(row);
        }
        if (Foot(slot, st, actLive, acts) is { } foot)
        {
            DockPanel.SetDock(foot, Dock.Bottom);
            dock.Children.Add(foot);
        }
        dock.Children.Add(Body(slot, st, body, blocks, ctx));
        var card = Ui.Card(dock, 12);
        if (slot.Framed)
        {
            card.ClipToBounds = true;
            card.VerticalAlignment = VerticalAlignment.Stretch;
        }
        if (w.Stale) card.Opacity = 0.6;
        return card;
    }

    private FrameworkElement Body(WidgetSlot slot, CardState st, CardBody kind, IReadOnlyList<WidgetBlock>? blocks, BlockCtx ctx)
    {
        var w = slot.Widget;
        var title = w.DisplayTitle();
        var body = new DockPanel { Margin = new Thickness(4, 8, 4, 0), LastChildFill = true };
        void Top(UIElement e)
        {
            DockPanel.SetDock(e, Dock.Top);
            body.Children.Add(e);
        }
        void Bottom(UIElement e)
        {
            DockPanel.SetDock(e, Dock.Bottom);
            body.Children.Add(e);
        }
        if (w.Stale)
        {
            var t = Ui.Text(L.T("Last known; its machine is offline."), 11, secondary: true);
            t.Margin = new Thickness(0, 10, 0, 0);
            Bottom(t);
        }
        switch (kind)
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
                Top(row);
                break;
            }
            case CardBody.Embed:
            {
                Top(Ui.Text(L.T("This widget shows its app's own page."), 13, secondary: true));
                var b = Ui.Button(L.F("Open {0}", title), () => open(w, null));
                b.HorizontalAlignment = HorizontalAlignment.Left;
                b.Margin = new Thickness(0, 10, 0, 0);
                Top(b);
                break;
            }
            case CardBody.Blocks:
            {
                var list = blocks!;
                Top(Linked(Hero(list[0], ctx, ctx.Marks?.ElementAtOrDefault(0)), list[0].Url, w));
                // On a Space with the writes the head says how old the card is; an older one says it here.
                if (!slot.Writes && !w.Stale && WidgetBlocks.IsOutdated(w.AsOf, w.StaleAfterMs, DateTimeOffset.Now))
                {
                    var t = Ui.Text(L.F("Updated {0}", HomeText.Ago(w.AsOf)), 11, secondary: true);
                    t.Margin = new Thickness(0, 10, 0, 0);
                    Bottom(t);
                }
                var rows = list.Skip(1).Select((b, i) => (UIElement)Linked(Row(b, ctx, ctx.Marks?.ElementAtOrDefault(i + 1)), b.Url, w)).ToList();
                if (rows.Count > 0)
                {
                    var paged = new PagedRows(rows, WidgetBlocks.RowsFor(slot.Framed ? st.SizeClass ?? w.Size : w.Size), st.Page, paged: true, ctx.Live, (p, focus) =>
                    {
                        st.Page = p;
                        slot.Rebuild();
                        if (focus) slot.Dispatcher.BeginInvoke(() => FindTagged(slot, $"page:{p}")?.Focus(), DispatcherPriority.Input);
                    })
                    { Margin = new Thickness(0, 10, 0, 0) };
                    body.Children.Add(paged);
                }
                break;
            }
            case CardBody.Items:
            {
                var lines = new List<UIElement>();
                var cap = slot.Framed ? 14 : WidgetBlocks.ItemsFor(w.Size);
                foreach (var item in w.Items!.Take(cap))
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
                    lines.Add(Linked(line, item.Url, w));
                }
                if (slot.Framed)
                {
                    // In a box of a fixed height the items that fit, no pages (as the web's list).
                    body.Children.Add(new PagedRows(lines, cap, 0, paged: false, live: false, (_, _) => { }));
                }
                else
                {
                    var column = new StackPanel();
                    foreach (var l in lines)
                    {
                        if (l is FrameworkElement f) f.Margin = new Thickness(0, 0, 0, 6);
                        column.Children.Add(l);
                    }
                    Top(column);
                }
                break;
            }
            default:
                Top(Ui.Text(L.T("Nothing to show."), 13, secondary: true));
                break;
        }
        // The last child fills what is left; an empty one when the body ended with docked parts.
        if (body.Children.Count == 0 || body.Children[^1] is not PagedRows) body.Children.Add(new Border());
        return body;
    }

    // The head: the title that opens the widget, the peer, when it was read (a refresh control), the size while edited.

    private FrameworkElement Head(WidgetSlot slot, string title, bool live, bool acts)
    {
        var w = slot.Widget;
        var st = State(w.Id);
        var line = new DockPanel { LastChildFill = true };
        slot.Readout = null;
        if (slot.Mode == CardMode.Editing && slot.Framed)
        {
            var size = Ui.Text("", 11, secondary: true, wrap: false);
            size.VerticalAlignment = VerticalAlignment.Center;
            size.Margin = new Thickness(8, 0, 4, 0);
            size.FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI");
            DockPanel.SetDock(size, Dock.Right);
            line.Children.Add(size);
            slot.Readout = size;
        }
        if (slot.Writes && w.Ok != false && w.AsOf is { } asOf && HomeTime.Parse(asOf) is { } at)
        {
            var outdated = WidgetBlocks.IsOutdated(asOf, w.StaleAfterMs, DateTimeOffset.Now);
            var ago = outdated ? L.F("Out of date · {0}", HomeText.Ago(asOf)) : HomeText.Ago(asOf);
            var when = at.ToLocalTime().ToString("g", System.Globalization.CultureInfo.CurrentCulture);
            FrameworkElement stamp;
            if (acts)
            {
                var glyph = Ui.Glyph(Ui.Refresh, 10);
                glyph.Margin = new Thickness(0, 0, 4, 0);
                var text = Ui.Text(st.Refreshing ? L.T("Refreshing…") : ago, 11, secondary: true, wrap: false);
                if (outdated) text.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCautionBrush");
                glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
                var b = Flat(Ui.Row(glyph, text));
                b.Padding = new Thickness(4, 2, 4, 2);
                b.HorizontalAlignment = HorizontalAlignment.Right;
                b.IsEnabled = live && context.Api is not null && !st.Refreshing;
                b.ToolTip = $"{when} · {L.T("Refresh now")}";
                b.Tag = "refresh";
                AutomationProperties.SetName(b, $"{ago} · {(st.Refreshing ? L.T("Refreshing…") : L.T("Refresh now"))}");
                b.Click += (_, e) =>
                {
                    e.Handled = true;
                    _ = Refresh(slot);
                };
                stamp = b;
            }
            else
            {
                var text = Ui.Text(ago, 11, secondary: true, wrap: false);
                text.ToolTip = when;
                text.VerticalAlignment = VerticalAlignment.Center;
                text.Margin = new Thickness(4, 0, 4, 0);
                stamp = text;
            }
            DockPanel.SetDock(stamp, Dock.Right);
            line.Children.Add(stamp);
        }
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
        var head = Flat(row);
        head.ToolTip = L.F("Open {0}", title);
        head.Tag = HomeKeys.Of(HomeKind.Widget, w.Id);
        AutomationProperties.SetName(head, title);
        head.Click += (_, _) => open(w, null);
        line.Children.Add(head);
        return line;
    }

    /// <summary>The card's views as a segmented row under its head; Left and Right move between them.</summary>
    private FrameworkElement ViewSwitch(WidgetSlot slot, IReadOnlyList<WidgetView> list, string current, bool live)
    {
        var w = slot.Widget;
        var st = State(w.Id);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 6, 4, 0) };
        AutomationProperties.SetName(row, L.T("Views"));
        KeyboardNavigation.SetDirectionalNavigation(row, KeyboardNavigationMode.None);
        void Choose(string id, bool focus)
        {
            if (id == st.View) return;
            st.View = id;
            st.Page = 0;
            views.Save(w.Id, id);
            slot.Rebuild();
            if (focus) slot.Dispatcher.BeginInvoke(() => FindTagged(slot, "view:" + id)?.Focus(), DispatcherPriority.Input);
        }
        foreach (var v in list)
        {
            var on = v.Id == current;
            var label = v.Label.Pick(Lang);
            var b = new ToggleButton
            {
                Content = label,
                IsChecked = on,
                Padding = new Thickness(10, 2, 10, 3),
                MinWidth = 0,
                MinHeight = 0,
                FontSize = 12,
                Margin = new Thickness(0, 0, 4, 0),
                IsEnabled = live,
                Tag = "view:" + v.Id,
                // Tab reaches the chosen view; Left and Right the others.
                IsTabStop = on,
            };
            AutomationProperties.SetName(b, label);
            var id = v.Id;
            b.Click += (_, e) =>
            {
                e.Handled = true;
                // A toggle unticks itself on a second click: the chosen view stays chosen.
                b.IsChecked = true;
                Choose(id, focus: false);
            };
            row.Children.Add(b);
        }
        row.PreviewKeyDown += (_, e) =>
        {
            if (!live || e.Key is not (Key.Left or Key.Right)) return;
            e.Handled = true;
            var i = list.ToList().FindIndex(v => v.Id == current);
            var next = list[(i + (e.Key == Key.Right ? 1 : list.Count - 1)) % list.Count];
            Choose(next.Id, focus: true);
        };
        return row;
    }

    // The footer: the in-card confirmation, else the card's text field and buttons; the app's message under them.

    private FrameworkElement? Foot(WidgetSlot slot, CardState st, bool actLive, bool acts)
    {
        var w = slot.Widget;
        var cardActs = w.Ok != false && acts && slot.Writes ? w.Actions ?? [] : [];
        if (cardActs.Count == 0 && st.Asking is null && st.Message is null) return null;
        var foot = new StackPanel { Margin = new Thickness(4, 10, 4, 0) };
        if (st.Asking is { } q)
        {
            var text = Ui.Text(q.Text, 12.5);
            var cancel = Ui.Button(L.T("Cancel"), () => q.Answer.TrySetResult(false));
            var yes = Ui.Button(q.Label, () => q.Answer.TrySetResult(true), accent: true);
            cancel.Tag = "ask:no";
            yes.Tag = "ask:yes";
            cancel.MinWidth = yes.MinWidth = 0;
            var buttons = Ui.Row(cancel, yes);
            buttons.HorizontalAlignment = HorizontalAlignment.Right;
            buttons.Margin = new Thickness(0, 6, 0, 0);
            var group = new StackPanel();
            group.Children.Add(text);
            group.Children.Add(buttons);
            AutomationProperties.SetName(group, q.Text);
            group.PreviewKeyDown += (_, e) =>
            {
                if (e.Key != Key.Escape) return;
                e.Handled = true;
                q.Answer.TrySetResult(false);
            };
            foot.Children.Add(group);
            slot.Dispatcher.BeginInvoke(() => yes.Focus(), DispatcherPriority.Input);
        }
        else if (cardActs.Count > 0)
        {
            var controls = new WrapPanel();
            if (cardActs.FirstOrDefault(a => a.Kind == "input") is { } input)
            {
                var label = input.Label.Pick(Lang);
                var hintText = BlockText.Of(input.Placeholder, Lang) is { Length: > 0 } ph ? ph : label;
                var field = new TextBox { Text = st.Draft, MaxLength = WidgetBlocks.MaxActionValue, MinWidth = 120, Padding = new Thickness(8, 4, 8, 4), IsEnabled = actLive && st.Busy is null, Tag = "input" };
                AutomationProperties.SetName(field, label);
                var hint = Ui.Text(hintText, 12.5, secondary: true, wrap: false);
                hint.IsHitTestVisible = false;
                hint.Margin = new Thickness(10, 0, 0, 0);
                hint.VerticalAlignment = VerticalAlignment.Center;
                hint.Visibility = st.Draft.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                var send = new Button { Content = Ui.Glyph(st.Busy == input.Id ? Ui.Sync : "", 12), Padding = new Thickness(8, 4, 8, 4), MinWidth = 0, ToolTip = label, Tag = "send" };
                AutomationProperties.SetName(send, label);
                void Enable() => send.IsEnabled = actLive && st.Busy is null && st.Draft.Trim().Length > 0;
                Enable();
                field.TextChanged += (_, _) =>
                {
                    st.Draft = field.Text;
                    hint.Visibility = field.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
                    Enable();
                };
                async void Submit()
                {
                    var v = st.Draft.Trim();
                    if (v.Length == 0) return;
                    // On success the card is drawn anew from the answer; the text the person typed is kept on failure.
                    await Run(slot, input.Id, input.Kind, input.Label, input.Confirm, v);
                }
                field.KeyDown += (_, e) =>
                {
                    if (e.Key != Key.Enter) return;
                    e.Handled = true;
                    Submit();
                };
                send.Click += (_, e) =>
                {
                    e.Handled = true;
                    Submit();
                };
                var box = new Grid { Margin = new Thickness(0, 0, 6, 6), MinWidth = 160 };
                box.Children.Add(field);
                box.Children.Add(hint);
                var form = new DockPanel { LastChildFill = true };
                DockPanel.SetDock(send, Dock.Right);
                send.Margin = new Thickness(0, 0, 6, 6);
                form.Children.Add(send);
                form.Children.Add(box);
                foot.Children.Add(form);
            }
            foreach (var a in cardActs.Where(a => a.Kind == "button"))
            {
                var b = Pill(a.Label.Pick(Lang), st.Busy == a.Id);
                b.IsEnabled = actLive && st.Busy is null;
                b.Tag = "act:" + a.Id;
                var action = a;
                b.Click += (_, e) =>
                {
                    e.Handled = true;
                    _ = Run(slot, action.Id, action.Kind, action.Label, action.Confirm, null);
                };
                b.Margin = new Thickness(0, 0, 6, 6);
                controls.Children.Add(b);
            }
            if (controls.Children.Count > 0) foot.Children.Add(controls);
        }
        if (st.Message is { } m)
        {
            var t = Ui.Text(m.Text, 11.5, secondary: !m.Error);
            if (m.Error) t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
            t.Margin = new Thickness(0, 2, 0, 0);
            t.MaxHeight = 34;
            t.TextTrimming = TextTrimming.CharacterEllipsis;
            AutomationProperties.SetLiveSetting(t, AutomationLiveSetting.Polite);
            foot.Children.Add(t);
        }
        return foot;
    }

    private static Button Pill(string label, bool busy)
    {
        var b = new Button { Content = busy ? Ui.Row(Ui.Glyph(Ui.Sync, 10), Ui.Text(label, 12, wrap: false)) : label, Padding = new Thickness(10, 2, 10, 3), MinWidth = 0, MinHeight = 0, FontSize = 12 };
        AutomationProperties.SetName(b, label);
        return b;
    }

    // The writes: one action at a time, a check ticked while it is on its way and untouched once it answered.

    /// <param name="redraw">False when the card was just drawn with the message (from an answer): drawing it again would cut its flash short.</param>
    private void Show(CardState st, CardMessage? m, bool redraw = true)
    {
        st.Message = m;
        if (redraw) st.Slot?.Rebuild();
        if (m is null) return;
        var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(m.Error ? 6 : 4) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (st.Message != m) return;
            st.Message = null;
            st.Slot?.Rebuild();
        };
        timer.Start();
    }

    private async Task<bool> Run(WidgetSlot slot, string id, string kind, BlockText label, BlockText? confirm, string? value)
    {
        var w = slot.Widget;
        var st = State(w.Id);
        // Only an action the card's own payload declared, on a local widget, outside edit mode.
        if (slot.Mode != CardMode.Live || w.Peer is not null || st.Busy is not null || context.Api is not { } api || !WidgetActions.Declared(w).ContainsKey(id)) return false;
        st.Message = null;
        if (confirm is not null)
        {
            var q = new CardQuestion(confirm.Pick(Lang), label.Pick(Lang), new TaskCompletionSource<bool>());
            st.Asking = q;
            st.Slot?.Rebuild();
            var yes = await q.Answer.Task;
            st.Asking = null;
            st.Slot?.Rebuild();
            if (!yes) return false;
        }
        if (kind == "check") st.Ticked.Add(id);
        st.Busy = id;
        st.Slot?.Rebuild();
        var r = await api.WidgetAction(w, id, value);
        st.Busy = null;
        st.Ticked.Remove(id);
        if (!r.Ok)
        {
            Show(st, new CardMessage(true, L.F("Failed: {0}", r.Error)));
            return false;
        }
        if (r.MessageText(Lang) is { Length: > 0 } text) st.Message = new CardMessage(false, text);
        // The text sent is gone from the field in the card drawn from the answer.
        if (value is not null) st.Draft = "";
        update(r.Widget!);
        // An answer that changed nothing Home draws leaves the card as it was: it is drawn again here (not busy any more).
        if (st.Slot is { } s && ReferenceEquals(s.Widget, w))
        {
            s.Widget = r.Widget!;
            s.Rebuild();
        }
        if (st.Message is { } m) Show(st, m, redraw: false);
        return true;
    }

    private async Task Refresh(WidgetSlot slot)
    {
        var w = slot.Widget;
        var st = State(w.Id);
        if (slot.Mode != CardMode.Live || w.Peer is not null || st.Refreshing || context.Api is not { } api) return;
        st.Refreshing = true;
        st.Slot?.Rebuild();
        var r = await api.RefreshWidget(w);
        st.Refreshing = false;
        // The fresh card is drawn from the answer (when it changed nothing, the head is drawn again).
        if (r.Ok)
        {
            update(r.Widget!);
            if (st.Slot is { } s && ReferenceEquals(s.Widget, w))
            {
                s.Widget = r.Widget!;
                s.Rebuild();
            }
        }
        else
        {
            Show(st, new CardMessage(true, L.F("Failed: {0}", r.Error)));
        }
    }

    // Blocks.

    private static Button Flat(UIElement content) => new()
    {
        Content = content,
        Padding = new Thickness(4, 4, 4, 4),
        Background = Brushes.Transparent,
        BorderThickness = new Thickness(0),
        HorizontalAlignment = HorizontalAlignment.Stretch,
        HorizontalContentAlignment = HorizontalAlignment.Stretch,
    };

    /// <summary>
    /// A part of the card that opens a link when it has one. A control inside it (copy, a check, a
    /// button) marks its click handled, so it never follows the link.
    /// </summary>
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

    /// <summary>A round tick in place of the status dot: ticked at once, untouched again when the action failed.</summary>
    private static CheckBox Check(BlockAction a, BlockCtx ctx)
    {
        var on = ctx.Ticked.Contains(a.Id);
        var label = a.Label.Pick(Lang);
        var c = new CheckBox
        {
            IsChecked = on,
            MinWidth = 0,
            Padding = new Thickness(0),
            Margin = new Thickness(0, 0, 6, 0),
            VerticalAlignment = VerticalAlignment.Center,
            ToolTip = label,
            IsEnabled = ctx.ActLive && (ctx.Busy is null || on),
            Tag = "check:" + a.Id,
        };
        AutomationProperties.SetName(c, label);
        c.Click += (_, e) =>
        {
            e.Handled = true;
            if (!on) ctx.OnAction(a);
            else c.IsChecked = true;
        };
        return c;
    }

    /// <summary>The trailing controls of a block: copy, then a block button.</summary>
    private static FrameworkElement? Controls(WidgetBlock b, BlockCtx ctx)
    {
        var button = ctx.Acts && b.Action is { Kind: "button" } a ? a : null;
        if (b.Copy is null && button is null) return null;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Top };
        if (b.Copy is { } copy) row.Children.Add(CopyButton(copy, ctx.Live, b));
        if (button is not null)
        {
            var pill = Pill(button.Label.Pick(Lang), ctx.Busy == button.Id);
            pill.IsEnabled = ctx.ActLive && ctx.Busy is null;
            pill.Tag = "act:" + button.Id;
            pill.Margin = new Thickness(4, 0, 0, 0);
            pill.Click += (_, e) =>
            {
                e.Handled = true;
                ctx.OnAction(button);
            };
            row.Children.Add(pill);
        }
        return row;
    }

    /// <summary>Copies the block's <c>copy</c> text and says so in place for 1.5 s.</summary>
    private static Button CopyButton(string text, bool live, WidgetBlock b)
    {
        const string CopyGlyph = "";
        var glyph = Ui.Glyph(CopyGlyph, 12);
        glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        var button = new Button
        {
            Content = glyph,
            Padding = new Thickness(5, 3, 5, 3),
            MinWidth = 0,
            MinHeight = 0,
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            ToolTip = L.T("Copy"),
            IsEnabled = live,
            Tag = "copy:" + BlockText.Of(b.Label, "en"),
        };
        AutomationProperties.SetName(button, L.T("Copy"));
        DispatcherTimer? back = null;
        button.Click += (_, e) =>
        {
            e.Handled = true;
            try
            {
                Clipboard.SetText(text);
            }
            catch (System.Runtime.InteropServices.ExternalException)
            {
                // Another program holds the clipboard: no confirmation, the person can try again.
                return;
            }
            glyph.Text = Ui.Accept;
            glyph.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorSuccessBrush");
            button.ToolTip = L.T("Copied");
            AutomationProperties.SetName(button, L.T("Copied"));
            back?.Stop();
            back = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1.5) };
            back.Tick += (_, _) =>
            {
                back.Stop();
                glyph.Text = CopyGlyph;
                glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
                button.ToolTip = L.T("Copy");
                AutomationProperties.SetName(button, L.T("Copy"));
            };
            back.Start();
        };
        return button;
    }

    /// <summary>The label line of a block: a check before it (except a status hero's, whose check takes the dot's place), its controls after it.</summary>
    private static DockPanel LabelLine(WidgetBlock b, BlockCtx ctx, UIElement label, bool checkHere)
    {
        var line = new DockPanel { LastChildFill = true };
        if (Controls(b, ctx) is { } controls)
        {
            DockPanel.SetDock(controls, Dock.Right);
            line.Children.Add(controls);
        }
        if (checkHere && ctx.Acts && b.Action is { Kind: "check" } check) line.Children.Add(Check(check, ctx));
        line.Children.Add(label);
        return line;
    }

    /// <summary>The first block, drawn large.</summary>
    private static FrameworkElement Hero(WidgetBlock b, BlockCtx ctx, Change? flash)
    {
        var box = new StackPanel();
        var label = BlockText.Of(b.Label, Lang);
        var check = ctx.Acts && b.Action is { Kind: "check" } c ? c : null;
        box.Children.Add(LabelLine(b, ctx, Ui.Text(label, 12, secondary: true, wrap: false), checkHere: b is not StatusBlock));
        var value = WidgetBlocks.Shown(b, Lang);
        var tone = WidgetBlocks.ToneOf(b);
        TextBlock? valueText = null;
        TextBlock? caption = null;
        string restore = "TextFillColorPrimaryBrush";
        switch (b)
        {
            case StatusBlock s:
            {
                var line = new DockPanel { Margin = new Thickness(0, 6, 0, 0) };
                if (check is not null)
                {
                    line.Children.Add(Check(check, ctx));
                }
                else
                {
                    var dot = Dot(tone, 10);
                    dot.Margin = new Thickness(0, 0, 8, 0);
                    line.Children.Add(dot);
                }
                var v = Ui.Text(value ?? "", 18, bold: true);
                v.MaxHeight = 52;
                v.TextTrimming = TextTrimming.CharacterEllipsis;
                if (check is not null && ctx.Ticked.Contains(check.Id)) v.TextDecorations = TextDecorations.Strikethrough;
                line.Children.Add(v);
                box.Children.Add(line);
                valueText = v;
                if (s.Time is not null) box.Children.Add(Ui.Text(HomeText.Ago(s.Time), 11, secondary: true));
                break;
            }
            case TanksBlock t:
                box.Children.Add(Tanks(t, small: false, ctx.Motion));
                break;
            default:
            {
                var line = new WrapPanel { Margin = new Thickness(0, 2, 0, 0) };
                var v = Ui.Text(value ?? L.T("No data"), 28, secondary: value is null, bold: true, wrap: false);
                if (value is null) restore = "TextFillColorSecondaryBrush";
                if (value is not null && b is GaugeBlock && ToneKey(tone) is { } key)
                {
                    Toned(v, tone);
                    restore = key;
                }
                line.Children.Add(v);
                valueText = v;
                if (ctx.Motion && b is MetricBlock { Display: null, Value: { } target } metric) Motion.CountUp(v, target, x => NumberText.Format(x, metric.Style, Lang));
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
        if (flash is { } f && valueText is not null) Motion.Flash(valueText, f, restore);
        var captionText = BlockText.Of(b.Caption, Lang);
        if (captionText.Length > 0 || b is TrendBlock)
        {
            caption = Ui.Text(captionText, 11, secondary: true);
            caption.Margin = new Thickness(0, 6, 0, 0);
            caption.MaxHeight = 32;
            caption.TextTrimming = TextTrimming.CharacterEllipsis;
            caption.Visibility = captionText.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        if (Drawing(b, hero: true, ctx.Motion, valueText, caption) is { } chart)
        {
            chart.Margin = new Thickness(0, 6, 0, 0);
            box.Children.Add(chart);
        }
        if (caption is not null) box.Children.Add(caption);
        AutomationProperties.SetName(box, value is null ? label : $"{label}: {value}");
        return box;
    }

    /// <summary>A block after the first: label left, value right, its drawing below.</summary>
    private static FrameworkElement Row(WidgetBlock b, BlockCtx ctx, Change? flash)
    {
        var box = new StackPanel();
        var line = new DockPanel { LastChildFill = true };
        var tone = WidgetBlocks.ToneOf(b);
        var label = BlockText.Of(b.Label, Lang);
        var value = WidgetBlocks.Shown(b, Lang);
        var check = ctx.Acts && b.Action is { Kind: "check" } c ? c : null;
        if (Controls(b, ctx) is { } controls)
        {
            DockPanel.SetDock(controls, Dock.Right);
            line.Children.Add(controls);
        }
        if (check is not null)
        {
            line.Children.Add(Check(check, ctx));
        }
        else if (b is StatusBlock)
        {
            var dot = Dot(tone, 7);
            dot.Margin = new Thickness(0, 0, 6, 0);
            line.Children.Add(dot);
        }
        TextBlock? valueText = null;
        TextBlock? date = null;
        if (b is not TanksBlock)
        {
            var right = new StackPanel { Orientation = Orientation.Horizontal };
            var v = Ui.Text(value ?? L.T("No data"), 13, secondary: value is null, bold: value is not null, wrap: false);
            var restore = value is null ? "TextFillColorSecondaryBrush" : "TextFillColorPrimaryBrush";
            if (value is not null && b is GaugeBlock or MetricBlock && ToneKey(tone) is { } key)
            {
                Toned(v, tone);
                restore = key;
            }
            right.Children.Add(v);
            valueText = v;
            if (flash is { } f) Motion.Flash(v, f, restore);
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
            if (b is TrendBlock)
            {
                date = Ui.Text("", 11, secondary: true, wrap: false);
                date.Margin = new Thickness(6, 1, 0, 0);
                date.Visibility = Visibility.Collapsed;
                right.Children.Add(date);
            }
            right.Margin = new Thickness(8, 0, 0, 0);
            DockPanel.SetDock(right, Dock.Right);
            line.Children.Add(right);
        }
        var name = Ui.Text(label, 13, wrap: false);
        if (check is not null && ctx.Ticked.Contains(check.Id)) name.TextDecorations = TextDecorations.Strikethrough;
        line.Children.Add(name);
        box.Children.Add(line);
        if (b is TanksBlock t)
        {
            var tanks = Tanks(t, small: true, ctx.Motion);
            tanks.Margin = new Thickness(0, 4, 0, 0);
            box.Children.Add(tanks);
        }
        else if (Drawing(b, hero: false, ctx.Motion, valueText, date) is { } chart)
        {
            chart.Margin = new Thickness(0, 4, 0, 0);
            box.Children.Add(chart);
        }
        AutomationProperties.SetName(box, value is null ? label : $"{label}: {value}");
        return box;
    }

    /// <param name="valueText">The block's value, which a trend's readout replaces while the pointer is on a point.</param>
    /// <param name="dateText">Where the readout's date goes (the hero's caption, a row's date), restored when the pointer leaves.</param>
    private static FrameworkElement? Drawing(WidgetBlock b, bool hero, bool motion, TextBlock? valueText, TextBlock? dateText)
    {
        HomeChart? chart = b switch
        {
            TrendBlock t => WidgetBlocks.SparkOf(t) is { } s ? Spark(t, s, hero ? 48 : 22) : null,
            ProgressBlock p => Progress(p),
            GaugeBlock g => Gauge(g),
            _ => null,
        };
        if (b is TrendBlock && chart is null) return Ui.Text(L.T("No history yet"), 11, secondary: true);
        if (chart is null) return null;
        if (motion) Motion.Enter(chart);
        if (b is TrendBlock trend && valueText is not null) Readout(chart, trend, valueText, dateText);
        return chart;
    }

    /// <summary>
    /// The pointer over a trend picks the nearest point (<see cref="WidgetInteract.NearestIndex"/>): the
    /// block shows that point's value and date in place of the latest; leaving puts them back.
    /// </summary>
    private static void Readout(HomeChart chart, TrendBlock b, TextBlock valueText, TextBlock? dateText)
    {
        var value = valueText.Text;
        var date = dateText?.Text ?? "";
        var dateShown = dateText?.Visibility ?? Visibility.Collapsed;
        void Pick(Point at)
        {
            var i = WidgetInteract.NearestIndex(at.X, chart.ActualWidth, b.Points.Count);
            if (i < 0 || i == chart.Hover) return;
            chart.Hover = i;
            var p = b.Points[i];
            valueText.Text = WidgetInteract.PointValue(b, p, Lang) ?? L.T("No data");
            if (dateText is null) return;
            dateText.Text = WidgetInteract.PointDate(p.T, Lang);
            dateText.Visibility = Visibility.Visible;
        }
        void Leave()
        {
            if (chart.Hover < 0) return;
            chart.Hover = -1;
            valueText.Text = value;
            if (dateText is null) return;
            dateText.Text = date;
            dateText.Visibility = dateShown;
        }
        chart.MouseMove += (_, e) => Pick(e.GetPosition(chart));
        chart.MouseLeave += (_, _) => Leave();
        // A finger on the chart reads it; it does not turn the card's pages.
        chart.TouchDown += (_, e) =>
        {
            e.Handled = true;
            Pick(e.GetTouchPoint(chart).Position);
        };
        chart.TouchMove += (_, e) =>
        {
            e.Handled = true;
            Pick(e.GetTouchPoint(chart).Position);
        };
        chart.TouchUp += (_, e) =>
        {
            e.Handled = true;
            Leave();
        };
    }

    private static HomeChart Dot(Tone? tone, double size) => new((dc, s, c) =>
    {
        var brush = tone is null or Tone.Neutral ? HomeChart.Faded(c.Text, 0.45) : c.Tone(tone);
        dc.DrawEllipse(brush, null, new Point(s.Width / 2, s.Height / 2), size / 2, size / 2);
    })
    { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Center };

    /// <summary>
    /// A trend as a line (an area under each unbroken run) or bars, the latest at full strength (or the
    /// point under the pointer, marked by a rule and a dot on a line). Entering, a line wipes in from
    /// the left and bars grow from the zero line.
    /// </summary>
    private static HomeChart Spark(TrendBlock t, Spark s, double height) => new((dc, size, c) =>
    {
        double w = size.Width, h = size.Height;
        // The whole box takes the pointer, not only what is drawn.
        dc.DrawRectangle(Brushes.Transparent, null, new Rect(size));
        var reveal = Math.Clamp(c.Reveal, 0, 1);
        var n = Math.Max(t.Points.Count, 2);
        if (!s.Bars)
        {
            var accent = c.Accent;
            var pen = new Pen(accent, 2) { LineJoin = PenLineJoin.Round, StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round };
            var area = HomeChart.Faded(accent, 0.14);
            if (reveal < 1) dc.PushClip(new RectangleGeometry(new Rect(0, 0, w * reveal, h)));
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
            if (reveal < 1) dc.Pop();
            if (c.Hover >= 0 && c.Hover < t.Points.Count)
            {
                var x = (c.Hover + 0.5) / n * w;
                dc.DrawLine(new Pen(HomeChart.Faded(c.Text, 0.3), 1), new Point(Math.Round(x) + 0.5, 0), new Point(Math.Round(x) + 0.5, h));
                var point = s.Runs.SelectMany(r => r).Cast<(double X, double Y)?>().FirstOrDefault(p => Math.Abs(p!.Value.X * w - x) < 0.5);
                if (point is { } at)
                {
                    var y = at.Y * (h - 2) + 1;
                    dc.DrawEllipse(c.Find("CardBackgroundFillColorDefaultBrush", Colors.White), new Pen(accent, 2), new Point(x, y), 3.5, 3.5);
                }
            }
            return;
        }
        foreach (var bar in s.BarList)
        {
            var strong = c.Hover >= 0 ? bar.Index == c.Hover : bar.Latest;
            var baseBrush = bar.Negative ? c.Tone(Tone.Negative) : t.Signed ? c.Tone(Tone.Positive) : c.Accent;
            var bw = Math.Max(bar.Width * w, 1);
            // Growing from the zero line: down for a negative bar, up for the others.
            var top = bar.Top * h;
            var bottom = bar.Bottom * h;
            var zeroY = s.Zero * h;
            if (reveal < 1)
            {
                top = zeroY + (top - zeroY) * reveal;
                bottom = zeroY + (bottom - zeroY) * reveal;
            }
            var r = new Rect(bar.X * w, Math.Min(top, bottom), bw, Math.Max(Math.Abs(bottom - top), 1));
            var radius = Math.Min(bw * 0.17, 2);
            dc.DrawRoundedRectangle(strong ? baseBrush : HomeChart.Faded(baseBrush, 0.6), null, r, radius, radius);
        }
        var zero = Math.Round(s.Zero * h) + 0.5;
        dc.DrawLine(new Pen(HomeChart.Faded(c.Text, 0.18), 1), new Point(0, zero), new Point(w, zero));
    })
    { Height = height, HorizontalAlignment = HorizontalAlignment.Stretch };

    private static HomeChart Progress(ProgressBlock b) => new((dc, s, c) =>
    {
        var r = s.Height / 2;
        dc.DrawRoundedRectangle(HomeChart.Faded(c.Text, 0.12), null, new Rect(s), r, r);
        var f = WidgetBlocks.Fraction(b) * Math.Clamp(c.Reveal, 0, 1);
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
            // Entering, the marker slides in from the start of the scale.
            var reveal = Math.Clamp(c.Reveal, 0, 1);
            var x = Math.Clamp(WidgetBlocks.Position(b, v) * w * reveal, 6, Math.Max(6, w - 6));
            dc.PushOpacity(reveal);
            dc.DrawEllipse(Brushes.White, null, new Point(x, h / 2), 6.5, 6.5);
            dc.DrawEllipse(c.Text, null, new Point(x, h / 2), 5, 5);
            dc.Pop();
        }
    })
    { Height = 14 };

    /// <summary>Up to three tanks side by side, each with its name and a short value (WidgetBlocks.tsx <c>Tanks</c>).</summary>
    private static FrameworkElement Tanks(TanksBlock b, bool small, bool motion)
    {
        var grid = new UniformGrid { Rows = 1, Columns = b.Tanks.Count, Margin = new Thickness(0, small ? 0 : 6, 0, 0) };
        foreach (var k in b.Tanks)
        {
            var value = WidgetBlocks.TankValue(k, Lang);
            var name = Ui.Text(BlockText.Of(k.Label, Lang), 11, secondary: true, wrap: false);
            var v = Ui.Text(value ?? L.T("No data"), small ? 11 : 13, secondary: value is null, bold: !small && value is not null, wrap: false);
            var shape = Tank(k, small ? 18 : 40);
            if (motion) Motion.Enter(shape);
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

    /// <summary>One upright tank filled to value / max in its tone (the accent without one), spilling over its top past max; entering, it fills from the bottom.</summary>
    private static HomeChart Tank(Tank k, double width) => new((dc, s, c) =>
    {
        double w = s.Width, h = s.Height, top = h * 0.12, bottom = h * 0.94;
        var body = new Rect(w * 0.12, top, w * 0.76, bottom - top);
        var radius = w * 0.14;
        dc.DrawRoundedRectangle(HomeChart.Faded(c.Text, 0.09), new Pen(HomeChart.Faded(c.Text, 0.32), 1), body, radius, radius);
        var level = WidgetBlocks.TankLevel(k) * Math.Clamp(c.Reveal, 0, 1);
        var color = k.Tone is null or Tone.Neutral ? c.Accent : c.Tone(k.Tone);
        if (k.Value is not null && level > 0.002)
        {
            var fill = Math.Max(0, Math.Min(1, level) * (body.Height - 2));
            dc.PushClip(new RectangleGeometry(body, radius, radius));
            dc.DrawRectangle(color, null, new Rect(body.Left, body.Bottom - 1 - fill, body.Width, fill));
            dc.Pop();
        }
        if (level > 1) dc.DrawRoundedRectangle(color, null, new Rect(w * 0.3, 0, w * 0.4, top + 2), 2, 2);
    })
    { Width = width, Height = Math.Round(width * 84 / 64), VerticalAlignment = VerticalAlignment.Center };
}
