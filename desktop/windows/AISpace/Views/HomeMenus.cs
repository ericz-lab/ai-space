using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Home's menus: a tile's or a card's (open it, put it on a screen or take it off, move it, open
/// its page in the browser, copy its address), opened by a right click, Shift+F10 or the menu key;
/// and the screen's own (the ⋯ button: new, rename, copy the web panel's layout, delete). Every
/// change is this computer's own (<see cref="ScreenStore"/>).
/// </summary>
internal sealed partial class HomePage
{
    private static MenuItem Item(string header, Action click)
    {
        var m = new MenuItem { Header = header };
        m.Click += (_, _) => click();
        return m;
    }

    private void EditScreens(Func<IReadOnlyList<HomeScreen>, IEnumerable<HomeScreen>> change)
    {
        _store.Edit(SpaceKey, change);
        Draw();
    }

    private void Toggle(string screen, string key) => EditScreens(all =>
        all.FirstOrDefault(s => s.Id == screen)?.Items.Contains(key) == true ? HomeScreens.Unpin(all, screen, key) : HomeScreens.Pin(all, screen, key));

    /// <summary>Fills a tile's or card's menu as it opens, from the screens as they are then.</summary>
    private void FillEntryMenu(ContextMenu menu, HomeEntry e, string? screen)
    {
        menu.Items.Clear();
        menu.Items.Add(Item(L.F("Open {0}", e.DisplayTitle()), () => Open(e)));
        menu.Items.Add(new Separator());
        var screens = Screens();
        var key = e.Key;
        if (screen is not null && screens.FirstOrDefault(s => s.Id == screen) is { } here)
        {
            menu.Items.Add(Item(L.T("Remove from This Screen"), () => EditScreens(all => HomeScreens.Unpin(all, screen, key))));
            // Tiles and cards are drawn apart, so each moves among its own kind (what the screen shows).
            var byKey = _catalogue?.ByKey() ?? new Dictionary<string, HomeEntry>();
            bool IsCard(string k) => byKey.TryGetValue(k, out var x) && x.Kind == HomeKind.Widget;
            var group = here.Items.Where(k => (k.StartsWith("builtin:", StringComparison.Ordinal) && HomeBuiltin.Of(k["builtin:".Length..]) is not null) || byKey.ContainsKey(k))
                .Where(k => IsCard(k) == (e.Kind == HomeKind.Widget)).ToList();
            var i = group.IndexOf(key);
            if (i > 0) menu.Items.Add(Item(L.T("Move Earlier"), () => EditScreens(all => HomeScreens.Move(all, screen, group, i, i - 1))));
            if (i >= 0 && i < group.Count - 1) menu.Items.Add(Item(L.T("Move Later"), () => EditScreens(all => HomeScreens.Move(all, screen, group, i, i + 1))));
        }
        if (screens.Count <= 1)
        {
            if (screen is null)
            {
                var on = screens.Count > 0 && screens[0].Items.Contains(key);
                menu.Items.Add(Item(on ? L.T("Remove from Main Screen") : L.T("Add to Main Screen"), () => Toggle(HomeScreens.Home, key)));
            }
        }
        else
        {
            var onScreens = new MenuItem { Header = L.T("On Screens") };
            for (var n = 0; n < screens.Count; n++)
            {
                var s = screens[n];
                var check = new MenuItem { Header = ScreenTitle(screens, n), IsCheckable = true, IsChecked = s.Items.Contains(key) };
                check.Click += (_, _) => Toggle(s.Id, key);
                onScreens.Items.Add(check);
            }
            menu.Items.Add(onScreens);
        }
        var url = e.Kind is HomeKind.App or HomeKind.Widget && Context.Connection is { } c ? HomeCatalogue.PageUrl(e.Link, c.Uri) : null;
        if (url is not null)
        {
            menu.Items.Add(new Separator());
            menu.Items.Add(Item(L.T("Open in Browser"), () => PageContext.OpenInBrowser(url)));
            menu.Items.Add(Item(L.T("Copy Link"), () => CopyText(url.ToString())));
        }
    }

    private void CopyText(string text)
    {
        try
        {
            Clipboard.SetText(text);
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            // Another program holds the clipboard.
            Ui.Toast(_root, L.T("The clipboard is busy. Try again."), error: true);
        }
    }

    /// <summary>
    /// The menu of a screen's tab in the main window's bar (right click, Shift+F10), filled as it
    /// opens: a new screen; for a screen, rename it, copy the web panel's layout again, delete it.
    /// The Library's tab offers a new screen only.
    /// </summary>
    public void FillPlaceMenu(ContextMenu menu, string id)
    {
        menu.Items.Clear();
        var screens = Screens();
        var add = Item(L.T("New Screen"), () =>
        {
            if (HomeScreens.NewScreen(Screens()) is not { } made) return;
            EditScreens(_ => made.Screens);
            ShowPlace(made.Id);
        });
        add.IsEnabled = screens.Count < HomeScreens.Limit;
        menu.Items.Add(add);
        var index = screens.ToList().FindIndex(s => s.Id == id);
        if (index < 0) return;
        menu.Items.Add(Item(L.T("Rename Screen…"), () => RenameScreen(id)));
        menu.Items.Add(Item(L.T("Copy the Web Panel's Layout…"), () =>
        {
            if (_catalogue is not { } c) return;
            if (!Confirm(L.T("Replace this computer's screens?"), L.T("The screens here become a copy of the web panel's as it is now. The web panel does not change."))) return;
            _store.Reset(SpaceKey, c.PanelScreens());
            Draw();
        }));
        if (id != HomeScreens.Home)
        {
            menu.Items.Add(new Separator());
            menu.Items.Add(Item(L.T("Delete Screen…"), () =>
            {
                if (!Confirm(L.T("Delete this screen?"), L.T("Its apps, agents and widgets stay in the Library."))) return;
                if (_shownId == id) _shownId = index > 0 ? screens[index - 1].Id : HomeScreens.Home;
                EditScreens(all => HomeScreens.Remove(all, id));
            }));
        }
    }

    /// <summary>The window the page is in, else the app's main window (a menu of the bar may act while Home is not shown).</summary>
    private Window? OwnerWindow => Window.GetWindow(this) ?? Application.Current?.MainWindow;

    private bool Confirm(string title, string text)
    {
        var owner = OwnerWindow;
        var answer = owner is null
            ? MessageBox.Show(text, title, MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel)
            : MessageBox.Show(owner, text, title, MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel);
        return answer == MessageBoxResult.OK;
    }

    private void RenameScreen(string id)
    {
        var screens = Screens();
        var index = screens.ToList().FindIndex(s => s.Id == id);
        if (index < 0) return;
        var unnamed = screens.Select(s => s with { Name = "" }).ToList();
        var dialog = new HomeRenameDialog(screens[index].Name, ScreenTitle(unnamed, index)) { Owner = OwnerWindow };
        if (dialog.ShowDialog() == true) EditScreens(all => HomeScreens.Rename(all, id, dialog.ScreenName));
    }
}

/// <summary>Names a screen; an empty name gives it back its number.</summary>
internal sealed class HomeRenameDialog : Window
{
    private readonly TextBox _name = new() { MinWidth = 320 };

    public HomeRenameDialog(string name, string placeholder)
    {
        Title = L.T("Rename Screen");
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        Shell.Native.KeepOnScreen(this);
        _name.Text = name;
        _name.MaxLength = 60;
        System.Windows.Automation.AutomationProperties.SetName(_name, L.T("Screen name"));
        var save = Ui.Button(L.T("Save"), () => DialogResult = true, accent: true);
        save.IsDefault = true;
        var cancel = Ui.Button(L.T("Cancel"), () => DialogResult = false);
        cancel.IsCancel = true;
        var buttons = Ui.Row(save, cancel);
        buttons.HorizontalAlignment = HorizontalAlignment.Right;
        var body = Ui.Column(8,
            Ui.Text(L.T("Screen name"), 13, bold: true), _name,
            Ui.Text(L.F("Leave it empty for the screen's number ({0}).", placeholder), 12, secondary: true), buttons);
        body.Margin = new Thickness(24);
        body.MaxWidth = 420;
        Content = body;
        // The window, not the panel: else the margin around the panel shows the window's own colour.
        Ui.Background(this);
        Loaded += (_, _) =>
        {
            _name.Focus();
            _name.SelectAll();
        };
    }

    public string ScreenName => _name.Text;
}
