using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// The app's own settings (the Mac's Settings window): General, the saved Spaces and AI Space on
/// this computer. A Space's own settings stay in its panel.
/// </summary>
internal sealed class SettingsWindow : Window
{
    private readonly AppModel _model;
    private readonly App _app;
    private readonly ListBox _spaces = new() { MinHeight = 220 };
    private readonly TextBlock _shortcutNote = Ui.Text("", 12, secondary: true);

    public SettingsWindow(AppModel model, App app, int tab = 0)
    {
        _model = model;
        _app = app;
        Title = L.T("AI Space Settings");
        Width = 760;
        Height = 620;
        MinWidth = 560;
        MinHeight = 420;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        Icon = System.Windows.Media.Imaging.BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico"));
        var tabs = new TabControl { Margin = new Thickness(12) };
        tabs.Items.Add(new TabItem { Header = L.T("General"), Content = Scroll(General()) });
        tabs.Items.Add(new TabItem { Header = L.T("Spaces"), Content = Scroll(Spaces()) });
        tabs.Items.Add(new TabItem { Header = L.T("This Computer"), Content = Scroll(new LocalView(model)) });
        tabs.SelectedIndex = tab;
        tabs.SelectionChanged += (_, e) =>
        {
            if (e.Source == tabs && tabs.SelectedIndex == 2) _ = _model.Local.Refresh();
        };
        Content = tabs;
        Ui.Background(tabs);
        _model.Changed += FillSpaces;
        Closed += (_, _) => _model.Changed -= FillSpaces;
        FillSpaces();
    }

    public void ShowTab(int index)
    {
        if (Content is TabControl t) t.SelectedIndex = index;
    }

    private static ScrollViewer Scroll(UIElement content)
    {
        if (content is FrameworkElement f) f.Margin = new Thickness(16);
        return new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }

    private UIElement General()
    {
        var p = _model.Prefs;
        CheckBox Check(string label, bool value, Action<bool> set)
        {
            var c = new CheckBox { Content = label, IsChecked = value };
            c.Click += (_, _) => set(c.IsChecked == true);
            return c;
        }
        var notifications = Check(L.T("Show new inbox messages as Windows notifications"), p.Notifications, v =>
        {
            p.Notifications = v;
            _model.SavePrefs();
        });
        var keep = Check(L.T("Keep AI Space in the notification area when its window closes"), p.KeepRunning, v =>
        {
            p.KeepRunning = v;
            _model.SavePrefs();
        });
        var login = Check(L.T("Start AI Space when I sign in to Windows"), Registration.StartsAtSignIn(), Registration.SetStartAtSignIn);

        var shortcut = new ComboBox { MinWidth = 200, HorizontalAlignment = HorizontalAlignment.Left };
        foreach (var s in Enum.GetValues<QuickChatShortcut>()) shortcut.Items.Add(new ComboBoxItem { Content = s == QuickChatShortcut.Off ? L.T("Off") : Shortcuts.Label(s), Tag = s });
        shortcut.SelectedItem = shortcut.Items.OfType<ComboBoxItem>().First(i => (QuickChatShortcut)i.Tag == p.QuickChat);
        shortcut.SelectionChanged += (_, _) =>
        {
            if (shortcut.SelectedItem is not ComboBoxItem { Tag: QuickChatShortcut s }) return;
            p.QuickChat = s;
            _model.SavePrefs();
            ShortcutNote(_app.ApplyShortcut());
        };
        ShortcutNote(_app.ShortcutRegistered);

        var install = new List<UIElement> { Ui.Text(L.T("Installation"), 14, bold: true) };
        if (Registration.IsInstalled)
        {
            install.Add(Ui.Text(L.F("Installed for this user in {0}. Remove it from Settings → Apps → Installed apps.", Registration.InstallDirectory), 13, secondary: true));
        }
        else
        {
            install.Add(Ui.Text(L.T("This copy runs from where it was unpacked. Installing copies it under your user folder, adds it to the Start menu and to Installed apps; no administrator is needed."), 13, secondary: true));
            install.Add(Ui.Button(L.T("Install for This User"), () => _app.InstallAndRestart()));
        }

        var about = Ui.Text(L.F("AI Space for Windows {0} · WebView2 {1}", AppModel.Version, Web.WebProfiles.RuntimeVersion() ?? L.T("not installed")), 12, secondary: true);
        var logs = Ui.Button(L.T("Open Log Folder"), () =>
        {
            Directory.CreateDirectory(_model.Paths.Logs);
            Process.Start(new ProcessStartInfo(_model.Paths.Logs) { UseShellExecute = true });
        });

        return Ui.Column(12,
            notifications, keep, login,
            Ui.Text(L.T("Quick Chat"), 14, bold: true),
            Ui.Text(L.T("A small chat window over every app, from anywhere with this shortcut, the notification area or the jump list."), 13, secondary: true),
            shortcut, _shortcutNote,
            Ui.Column(8, [.. install]),
            Ui.Row(logs), about);
    }

    private void ShortcutNote(bool registered)
    {
        var s = _model.Prefs.QuickChat;
        _shortcutNote.Text = s == QuickChatShortcut.Off ? "" : registered ? L.F("{0} opens Quick Chat.", Shortcuts.Label(s)) : L.F("{0} is taken by another program. Choose another.", Shortcuts.Label(s));
    }

    private UIElement Spaces()
    {
        var add = Ui.Button(L.T("Add…"), () => AddSpace(this, _model));
        var edit = Ui.Button(L.T("Edit…"), () =>
        {
            if (Chosen() is { } c) EditSpace(this, _model, c.Id);
        });
        var makeDefault = Ui.Button(L.T("Make Default"), () =>
        {
            if (Chosen() is { } c) _model.SetDefault(c.Id);
        });
        var signOut = Ui.Button(L.T("Sign Out…"), () =>
        {
            if (Chosen() is not { } c) return;
            var ok = MessageBox.Show(this, L.T("Its pages close, and the next visit asks you to sign in again. The Space itself is not changed."), L.F("Sign out of {0} on this computer?", c.DisplayNameOr()), MessageBoxButton.OKCancel, MessageBoxImage.Question);
            if (ok == MessageBoxResult.OK) _ = _model.SignOut(c.Id);
        });
        var remove = Ui.Button(L.T("Remove…"), () =>
        {
            if (Chosen() is not { } c) return;
            var ok = MessageBox.Show(this, L.T("This computer forgets it and its sign-in. The Space itself, its agents and its data are not changed."), L.F("Remove {0}?", c.DisplayNameOr()), MessageBoxButton.OKCancel, MessageBoxImage.Warning);
            if (ok == MessageBoxResult.OK) _ = _model.Remove(c.Id, clearSignIn: true);
        });
        _spaces.MouseDoubleClick += (_, _) =>
        {
            if (Chosen() is { } c) EditSpace(this, _model, c.Id);
        };
        var buttons = new WrapPanel();
        foreach (var b in new[] { add, edit, makeDefault, signOut, remove })
        {
            b.Margin = new Thickness(0, 0, 8, 8);
            buttons.Children.Add(b);
        }
        return Ui.Column(12,
            Ui.Text(L.T("Spaces on this computer"), 14, bold: true),
            Ui.Text(L.T("Each keeps its own sign-in. Removing one here never changes the Space."), 13, secondary: true),
            _spaces, buttons);
    }

    private Connection? Chosen() => _spaces.SelectedItem is ListBoxItem { Tag: Guid id } ? _model.Store.Get(id) : null;

    private void FillSpaces()
    {
        var selected = Chosen()?.Id;
        _spaces.Items.Clear();
        foreach (var c in _model.Store.Connections)
        {
            var notes = new List<string>();
            if (c.IsDefault) notes.Add(L.T("default"));
            if (c.Managed) notes.Add(L.T("this computer"));
            var status = _model.Lives.TryGetValue(c.Id, out var l) ? l.Status : LiveStatus.Unknown;
            notes.Add(MainWindow.StatusText(status));
            var item = new ListBoxItem
            {
                Tag = c.Id,
                Content = Ui.Column(2, Ui.Text(c.DisplayNameOr(), 14, bold: true, wrap: false), Ui.Text($"{c.Url} · {string.Join(" · ", notes)}", 12, secondary: true, wrap: false)),
                Padding = new Thickness(8, 6, 8, 6),
            };
            _spaces.Items.Add(item);
            if (c.Id == selected) _spaces.SelectedItem = item;
        }
        if (_spaces.SelectedItem is null && _spaces.Items.Count > 0) _spaces.SelectedIndex = 0;
    }

    public static void AddSpace(Window? owner, AppModel model)
    {
        var d = new ConnectionDialog(null) { Owner = owner is { IsVisible: true } ? owner : null };
        if (d.ShowDialog() == true && d.SpaceUrl is { } url) model.Add(d.SpaceName, url);
    }

    public static void EditSpace(Window? owner, AppModel model, Guid id)
    {
        if (model.Store.Get(id) is not { } c) return;
        var d = new ConnectionDialog(c) { Owner = owner is { IsVisible: true } ? owner : null };
        if (d.ShowDialog() == true && d.SpaceUrl is { } url) model.Update(id, d.SpaceName, url);
    }
}
