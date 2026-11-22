using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Fix this (随手改; the web panel's Settings section, src/web/FeedbackSettings.tsx, and
/// docs/feedback.md, whose routes still say "feedback"): the button on app pages, whether a request
/// is fixed now or later, where the Fix Engineer runs and on which model and effort, and which apps
/// show the button. It reads <c>GET /api/panel/feedback/settings</c> and each change is one
/// <c>PUT</c> there, the web panel's own patch, so both show the same settings. A switch or a
/// segment saves when it is pressed; a list saves with its Save button, as the model pickers do.
/// The recent requests stay in the web panel, one row away.
/// </summary>
internal sealed class FixThisPane(SpaceSettingsPage page) : SettingsPane(page)
{
    private readonly ContentControl _host = new() { Focusable = false, IsTabStop = false, HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private FixThisView? _view;

    public override string Title => L.T("Fix this");

    protected override void Compose()
    {
        Add(SettingsKit.Note(L.T("Fix this puts a small button in the corner of each app page (Alt+Shift+F): describe what is wrong, pick the element, add a picture, and it becomes an ai-todo task the Fix Engineer works on. Off until you turn it on. These are the Space's own settings, the same ones the web panel shows.")));
        Add(new Block(null, async ct =>
        {
            Show(await Api.FixThis(ct));
            return _host;
        }));
        Add(SettingsKit.Subhead(L.T("Requests")));
        Add(SettingsKit.List([SettingsKit.LinkRow(Ui.Web, L.T("Recent Requests in the Web Panel"), L.T("Each request's state and task, with Fix now and Fix again."), Page.OpenWebSettings)]));
    }

    private void Show(FixThisView view)
    {
        _view = view;
        _host.Content = Draw(view);
        _host.IsEnabled = true;
    }

    /// <summary>
    /// One change: the controls wait for the Space's answer, which is the settings as they now are
    /// and is drawn in their place. A change the Space refuses says why, and the controls go back to
    /// what is saved.
    /// </summary>
    private async Task<bool> Save(Func<SpaceApi, Task<FixThisView>> change, string done)
    {
        _host.IsEnabled = false;
        try
        {
            Show(await change(Api));
            Page.Toast(done);
            return true;
        }
        catch (Exception e)
        {
            Page.Toast(L.F("Not saved: {0}", SettingsWords.Error(e)), error: true);
            if (_view is { } last) Show(last);
            _host.IsEnabled = true;
            return false;
        }
    }

    private UIElement Draw(FixThisView view)
    {
        var s = view.Settings;
        var parts = new StackPanel();

        var rows = new List<UIElement>
        {
            Switch(L.T("Show the Fix this button on app pages"), null, s.Enabled, on => Save(api => api.SetFixThis("enabled", on), on ? L.T("Fix this is on.") : L.T("Fix this is off."))),
            Choice(L.T("When a request is sent"), L.T("Fix now: the Fix Engineer starts at once. Fix later: requests are recorded and fixed together when you say so."),
                SettingsRules.FixThisModes, s.Mode, Mode, v => Save(api => api.SetFixThis("mode", v), L.T("Saved."))),
        };
        if (view.Machines.Count > 1)
        {
            rows.Add(Labelled(L.T("Fix on"), Picker(L.T("Fix on"), view.Machines.Select(m => (m.Value, m.Value.Length == 0 ? L.F("{0} (this machine)", m.Label) : m.Label)).ToList(), s.Machine,
                v => Save(api => api.SetFixThis("machine", v), L.T("Saved.")))));
        }
        rows.Add(Labelled(L.T("Fix Engineer's model"), SettingsKit.ModelPicker(L.T("Fix Engineer's model"), view.Models, s.Model, L.T("The machine's default model"), withRuntime: true,
            v => Save(api => api.SetFixThis("model", v), L.T("Saved.")))));
        rows.Add(Choice(L.T("Effort"), null, SettingsRules.FixThisEfforts, s.Effort, Effort, v => Save(api => api.SetFixThis("effort", v), L.T("Saved."))));
        rows.Add(Switch(L.T("Attach recent script errors"), null, s.Errors, on => Save(api => api.SetFixThis("errors", on), L.T("Saved."))));
        rows.Add(SettingsKit.Pair(L.T("Shortcut"), view.Shortcut));
        parts.Children.Add(SettingsKit.List(rows));

        if (view.Later > 0)
        {
            var fix = Ui.Button(L.F("Fix {0} Waiting Now", view.Later), () => { });
            fix.Click += async (_, _) =>
            {
                fix.IsEnabled = false;
                try
                {
                    var queued = await Api.FixWaiting();
                    Page.Toast(L.F("Sent {0} to the Fix Engineer.", queued));
                    Reload();
                }
                catch (Exception e)
                {
                    Page.Toast(SettingsWords.Error(e), error: true);
                    fix.IsEnabled = true;
                }
            };
            parts.Children.Add(SettingsKit.List([SettingsKit.Row(L.F("{0} waiting to be fixed", view.Later), null, fix)]));
        }

        parts.Children.Add(SettingsKit.Subhead(L.T("Apps")));
        parts.Children.Add(SettingsKit.Note(L.T("An app shows the button when the main switch is on and the app is on, by its own setting or by the default.")));
        var apps = new List<UIElement> { Switch(L.T("Show on apps by default"), null, s.AppsDefault, on => Save(api => api.SetFixThis("appsDefault", on), L.T("Saved."))) };
        apps.AddRange(view.Apps.Select(a => AppRow(a, s)));
        parts.Children.Add(SettingsKit.List(apps));
        if (view.Apps.Count == 0) parts.Children.Add(SettingsKit.Note(L.T("No app has a page yet.")));

        // Apps on a peer follow these settings too: the Space sends them there (docs/feedback.md#apps-on-a-peer).
        foreach (var p in view.Peers)
        {
            parts.Children.Add(SettingsKit.Subhead(L.F("Apps on {0}", p.Name)));
            if (!p.Ok) parts.Children.Add(SettingsKit.Note(L.F("{0} cannot be reached: {1}", p.Name, p.Error), error: true));
            else if (!p.Synced) parts.Children.Add(SettingsKit.Note(L.F("Not sent to {0} yet: {1}", p.Name, p.Error), error: true));
            else parts.Children.Add(SettingsKit.Note(L.F("These apps run on {0}; the choices here are sent there each time they are read or changed.", p.Name)));
            if (p.Apps.Count > 0) parts.Children.Add(SettingsKit.List(p.Apps.Select(a => AppRow(a, s))));
        }

        parts.Children.Add(SettingsKit.Note(L.T("The button sends what the person types, the page's address, client, screen size, theme, language and the picked elements; passwords, tokens and form values are left out. The Fix Engineer changes only that app's source. Turn it on only where app pages need a sign-in.")));
        return parts;
    }

    private UIElement AppRow(FixThisApp a, FixThisSettings s)
    {
        var info = Context.Live?.App(a.App);
        var title = info?.DisplayTitle() ?? (Lang.Current == "zh" && a.Zh is { Length: > 0 } zh ? zh : a.Title);
        var state = a.Enabled ? L.T("Button shown") : L.T("Button hidden");
        string Word(string v) => v switch
        {
            "on" => L.T("On"),
            "off" => L.T("Off"),
            _ => L.F("Default ({0})", s.AppsDefault ? L.T("On") : L.T("Off")),
        };
        var pick = SettingsKit.Segmented(title, SettingsRules.FixThisSwitches, SettingsRules.FixThisSwitch(s, a.App), Word, v => _ = Save(api => api.SetFixThisApp(a.App, v), L.T("Saved.")));
        return SettingsKit.Row(title, state, pick, a.App, Context.Icons.View(info?.Icon, title, 24));
    }

    private static string Mode(string v) => v == "later" ? L.T("Fix later") : L.T("Fix now");

    private static string Effort(string v) => v switch
    {
        "high" => L.T("High"),
        "max" => L.T("Max"),
        _ => L.T("Extra high"),
    };

    /// <summary>A row with a switch at its end, saved when it is pressed.</summary>
    private static FrameworkElement Switch(string title, string? detail, bool on, Func<bool, Task<bool>> save)
    {
        var box = new CheckBox { IsChecked = on, VerticalAlignment = VerticalAlignment.Center, MinWidth = 0, Padding = new Thickness(0) };
        AutomationProperties.SetName(box, title);
        box.Click += (_, _) => _ = save(box.IsChecked == true);
        return SettingsKit.Row(title, detail, box);
    }

    /// <summary>A row with a few choices side by side, saved when one is pressed.</summary>
    private static FrameworkElement Choice(string title, string? detail, IReadOnlyList<string> values, string current, Func<string, string> label, Func<string, Task<bool>> save) =>
        SettingsKit.Row(title, detail, SettingsKit.Segmented(title, values, current, label, v => _ = save(v)), detail);

    /// <summary>A name over a picker that has its own Save button; the picker goes under the name on a narrow window.</summary>
    private static FrameworkElement Labelled(string title, FrameworkElement picker)
    {
        var name = Ui.Text(title, 14, wrap: false);
        name.VerticalAlignment = VerticalAlignment.Center;
        name.MinWidth = 220;
        name.Margin = new Thickness(0, 0, 16, 4);
        var wrap = new WrapPanel { Margin = new Thickness(12, 8, 12, 8) };
        wrap.Children.Add(name);
        wrap.Children.Add(picker);
        return wrap;
    }

    /// <summary>A list of choices that saves only when Save is pressed, as <see cref="SettingsKit.ModelPicker"/> does: the arrow keys move through it.</summary>
    private static FrameworkElement Picker(string name, IReadOnlyList<(string Value, string Label)> choices, string current, Func<string, Task<bool>> save)
    {
        var combo = new ComboBox { MinWidth = 260, MaxWidth = 420, VerticalAlignment = VerticalAlignment.Center };
        AutomationProperties.SetName(combo, name);
        // A saved choice that is no longer offered (a peer that left) stays shown.
        var all = choices.ToList();
        if (all.All(c => c.Value != current)) all.Add((current, L.F("{0} (not available)", current)));
        foreach (var (value, label) in all)
        {
            var item = new ComboBoxItem { Content = label, Tag = value };
            combo.Items.Add(item);
            if (value == current) combo.SelectedItem = item;
        }
        var button = Ui.Button(L.T("Save"), () => { }, accent: true);
        button.IsEnabled = false;
        button.Margin = new Thickness(8, 0, 0, 0);
        AutomationProperties.SetName(button, L.F("Save {0}", name));
        string Chosen() => (combo.SelectedItem as ComboBoxItem)?.Tag as string ?? "";
        combo.SelectionChanged += (_, _) => button.IsEnabled = Chosen() != current;
        button.Click += (_, _) => _ = save(Chosen());
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(combo);
        row.Children.Add(button);
        return row;
    }
}
