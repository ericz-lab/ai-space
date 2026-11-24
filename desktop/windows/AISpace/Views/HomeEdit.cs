using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Home's edit mode (the web panel's, docs/panel.md#arranging-hiding-and-uninstalling-apps): one
/// screen at a time, entered from its tab's menu or a tile's, left with Done, Escape or another
/// place. Every tile and card gets an ✕ that takes it off the screen, and can be dragged onto
/// another of its kind to take that one's place (tiles and cards are drawn apart, so each moves
/// among its own). The keyboard does the same on the focused entry: Delete removes it,
/// Ctrl+arrow moves it. As the menus, it changes this computer's screens only (<see cref="ScreenStore"/>).
/// </summary>
internal sealed partial class HomePage
{
    private const string DragFormat = "AISpace.HomeScreenEntry";
    private const string EditTag = "edit:";

    /// <summary>The screen in edit mode, if any; always the one shown.</summary>
    private string? _editing;
    private Point? _pressAt;
    private string? _pressKey;

    private sealed record Dragged(string Key, bool Card);

    private bool EditingHere(string? screen) => screen is not null && _editing == screen;

    /// <summary>Home on that screen, in edit mode.</summary>
    public void EditScreen(string id)
    {
        if (Screens().All(s => s.Id != id)) return;
        ShowPlace(id);
        _editing = id;
        if (_query.Length > 0) ClearQuery();
        else Draw();
        Dispatcher.BeginInvoke(() => _first?.Focus(), DispatcherPriority.Input);
    }

    private void StopEditing()
    {
        if (_editing is null) return;
        _editing = null;
        Draw();
        Dispatcher.BeginInvoke(() =>
        {
            if (IsShown) _field.Focus();
        }, DispatcherPriority.Input);
    }

    /// <summary>
    /// The entries of the screen a tile or a card moves among: those of its kind the screen draws,
    /// in the screen's order (a key the Space no longer has is skipped, as the screen skips it).
    /// </summary>
    private List<string> Group(HomeScreen screen, bool cards)
    {
        var byKey = _catalogue?.ByKey() ?? new Dictionary<string, HomeEntry>();
        bool IsCard(string k) => byKey.TryGetValue(k, out var x) && x.Kind == HomeKind.Widget;
        return screen.Items.Where(k => (k.StartsWith("builtin:", StringComparison.Ordinal) && HomeBuiltin.Of(k["builtin:".Length..]) is not null) || byKey.ContainsKey(k))
            .Where(k => IsCard(k) == cards).ToList();
    }

    private void Unpin(string screen, string key) => EditScreens(all => HomeScreens.Unpin(all, screen, key));

    /// <summary>Moves the entry by one place (-1 earlier, 1 later) among its kind, or onto another entry's place.</summary>
    private void MoveEntry(string screen, string key, bool card, Func<List<string>, int> to)
    {
        if (Screens().FirstOrDefault(s => s.Id == screen) is not { } here) return;
        var group = Group(here, card);
        var from = group.IndexOf(key);
        var target = to(group);
        if (from < 0 || target < 0 || target >= group.Count || target == from) return;
        EditScreens(all => HomeScreens.Move(all, screen, group, from, target));
    }

    /// <summary>The bar above a screen in edit mode: what can be done, Rename, Delete (not the Main screen) and Done.</summary>
    private FrameworkElement EditBar(IReadOnlyList<HomeScreen> screens, HomeScreen screen)
    {
        var index = screens.ToList().FindIndex(s => s.Id == screen.Id);
        var title = ScreenTitle(screens, Math.Max(index, 0));
        var done = Ui.Button(L.T("Done"), StopEditing, accent: true);
        var buttons = new List<UIElement> { Ui.Button(L.T("Rename…"), () => RenameScreen(screen.Id)) };
        if (screen.Id != HomeScreens.Home) buttons.Add(Ui.Button(L.T("Delete Screen…"), () => DeleteScreen(screen.Id)));
        buttons.Add(done);
        var row = Ui.Row([.. buttons]);
        row.VerticalAlignment = VerticalAlignment.Center;
        var glyph = Ui.Glyph(Ui.Edit, 16);
        glyph.SetResourceReference(TextBlock.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
        glyph.Margin = new Thickness(0, 2, 12, 0);
        glyph.VerticalAlignment = VerticalAlignment.Top;
        var words = Ui.Column(2,
            Ui.Text(L.F("Editing {0}", title), 15, bold: true),
            Ui.Text(L.T("Drag a tile or a widget onto another to move it; ✕ takes it off this screen. Only this computer's screens change."), 12.5, secondary: true));
        var dock = new DockPanel { LastChildFill = true };
        DockPanel.SetDock(row, Dock.Right);
        DockPanel.SetDock(glyph, Dock.Left);
        row.Margin = new Thickness(16, 0, 0, 0);
        dock.Children.Add(row);
        dock.Children.Add(glyph);
        dock.Children.Add(words);
        var card = Ui.Card(dock, 14);
        card.Margin = new Thickness(0, 8, 0, 8);
        AutomationProperties.SetName(card, L.F("Editing {0}", title));
        return card;
    }

    /// <summary>
    /// A tile or a card in edit mode: on a tinted ground, with its ✕ at the corner, dragged by the
    /// mouse and a drop target for the others of its kind.
    /// </summary>
    private FrameworkElement Editable(FrameworkElement item, string key, string title, string screen, bool card)
    {
        var host = new Grid { Margin = item.Margin, AllowDrop = true, Tag = EditTag + key, VerticalAlignment = VerticalAlignment.Top };
        item.Margin = new Thickness(0);
        var ground = new Border { CornerRadius = new CornerRadius(8), IsHitTestVisible = false };
        ground.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorTertiaryBrush");
        var target = new Border { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(2), IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        target.SetResourceReference(Border.BorderBrushProperty, "AccentFillColorDefaultBrush");
        // The keyboard removes with Delete, so the ✕ stays out of the arrow keys' way; UI Automation still invokes it.
        var remove = new Button
        {
            Content = Ui.Glyph(Ui.Close, 9),
            Width = 22,
            Height = 22,
            MinWidth = 0,
            MinHeight = 0,
            Padding = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, -7, -7, 0),
            Focusable = false,
            ToolTip = L.T("Remove from This Screen"),
            Tag = "remove:" + key,
        };
        remove.SetResourceReference(Control.BackgroundProperty, "SolidBackgroundFillColorTertiaryBrush");
        AutomationProperties.SetName(remove, L.F("Remove {0} from This Screen", title));
        remove.Click += (_, _) => Unpin(screen, key);
        host.Children.Add(ground);
        host.Children.Add(item);
        host.Children.Add(target);
        host.Children.Add(remove);
        // A transparent ground, so the whole of it takes a drop and not only what is drawn on it.
        host.Background = Brushes.Transparent;

        item.PreviewMouseLeftButtonDown += (_, a) =>
        {
            _pressAt = a.GetPosition(host);
            _pressKey = key;
        };
        item.PreviewMouseMove += (_, a) =>
        {
            if (_pressKey != key || _pressAt is not { } p || a.LeftButton != MouseButtonState.Pressed) return;
            var now = a.GetPosition(host);
            if (Math.Abs(now.X - p.X) < SystemParameters.MinimumHorizontalDragDistance && Math.Abs(now.Y - p.Y) < SystemParameters.MinimumVerticalDragDistance) return;
            _pressAt = null;
            // The tile is a button that took the mouse: let go of it, or it stays pressed after the drop.
            Mouse.Captured?.ReleaseMouseCapture();
            host.Opacity = 0.45;
            try
            {
                DragDrop.DoDragDrop(host, new DataObject(DragFormat, new Dragged(key, card)), DragDropEffects.Move);
            }
            finally
            {
                host.Opacity = 1;
                _pressKey = null;
            }
        };
        item.PreviewMouseLeftButtonUp += (_, _) =>
        {
            _pressAt = null;
            _pressKey = null;
        };

        bool Takes(DragEventArgs a) => a.Data.GetData(DragFormat) is Dragged d && d.Card == card && d.Key != key;
        host.DragEnter += (_, a) =>
        {
            if (Takes(a)) target.Visibility = Visibility.Visible;
        };
        host.DragOver += (_, a) =>
        {
            a.Effects = Takes(a) ? DragDropEffects.Move : DragDropEffects.None;
            a.Handled = true;
        };
        host.DragLeave += (_, _) => target.Visibility = Visibility.Collapsed;
        host.Drop += (_, a) =>
        {
            target.Visibility = Visibility.Collapsed;
            a.Handled = true;
            if (a.Data.GetData(DragFormat) is not Dragged d || d.Card != card || d.Key == key) return;
            // After the drag has ended: drawing anew now would take the dragged element away under it.
            Dispatcher.BeginInvoke(() => MoveEntry(screen, d.Key, card, group => group.IndexOf(key)));
        };
        return host;
    }

    /// <summary>Delete, and Ctrl with an arrow, on the focused entry of the screen in edit mode.</summary>
    private bool EditKey(KeyEventArgs e)
    {
        if (_editing is not { } screen || Keyboard.FocusedElement is not DependencyObject focused) return false;
        var host = focused;
        while (host is not null && !(host is FrameworkElement { Tag: string t } && t.StartsWith(EditTag, StringComparison.Ordinal)))
        {
            host = host is Visual or System.Windows.Media.Media3D.Visual3D ? VisualTreeHelper.GetParent(host) : LogicalTreeHelper.GetParent(host);
        }
        if (host is not FrameworkElement { Tag: string tag }) return false;
        var key = tag[EditTag.Length..];
        var card = _catalogue?.ByKey().TryGetValue(key, out var entry) == true && entry.Kind == HomeKind.Widget;
        var ctrl = Keyboard.Modifiers == ModifierKeys.Control;
        if (Keyboard.Modifiers == ModifierKeys.None && e.Key is Key.Delete or Key.Back)
        {
            // The focus goes to the next entry, else the one before, so the keyboard can go on.
            var group = Screens().FirstOrDefault(s => s.Id == screen) is { } here ? Group(here, card) : [];
            var i = group.IndexOf(key);
            var next = i + 1 < group.Count ? group[i + 1] : i > 0 ? group[i - 1] : null;
            Unpin(screen, key);
            if (next is not null && Find(_body, next) is { } again) again.Focus();
            else _field.Focus();
            return true;
        }
        if (ctrl && e.Key is Key.Left or Key.Up)
        {
            MoveEntry(screen, key, card, group => group.IndexOf(key) - 1);
            return true;
        }
        if (ctrl && e.Key is Key.Right or Key.Down)
        {
            MoveEntry(screen, key, card, group => group.IndexOf(key) + 1);
            return true;
        }
        return false;
    }
}
