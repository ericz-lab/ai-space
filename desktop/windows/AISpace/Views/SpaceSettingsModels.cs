using System.Windows;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Models (the web panel's Settings › Models): the Space's default model, changed with Save; the
/// agent CLIs on each machine (src/web/MachineClis.tsx), checked again on request; and each app's
/// models (src/web/AppModels.tsx), the whole app and each purpose, each with its own Save. Apps on a
/// peer are set in the web panel.
/// </summary>
internal sealed class ModelsPane(SpaceSettingsPage page) : SettingsPane(page)
{
    private Block? _clis;
    private bool _recheck;

    public override string Title => L.T("Models");

    protected override void Compose()
    {
        Add(new Block(L.T("Default Model"), async ct => DefaultModel(await Api.DefaultModel(ct))));
        _clis = Add(new Block(L.T("AI CLIs by Machine"), async ct =>
        {
            // Check Again asks the Space to look at every machine once more; a plain reload reads what it found last.
            var recheck = _recheck;
            _recheck = false;
            return Clis(recheck ? await Api.Recheck(ct) : await Api.Inventory(ct));
        }, L.T("Check Again"), () =>
        {
            _recheck = true;
            _clis?.Reload();
        }));
        Add(new Block(L.T("App Models"), async ct => AppModels(await Api.AppModelList(ct))));
    }

    private FrameworkElement DefaultModel(ModelPreferences prefs)
    {
        var effective = Ui.Text(L.F("Apps: {0} · Space Assistant: {1}", prefs.AppDefault, prefs.BaseDefault), 12, secondary: true);
        var picker = SettingsKit.ModelPicker(L.T("Default model"), prefs.Options, prefs.DefaultModel, L.T("Environment defaults"), withRuntime: true, async value =>
        {
            if (!SettingsRules.CanPick(prefs.Options, value)) return false;
            try
            {
                var now = await Api.SetDefaultModel(value.Length == 0 ? null : value);
                effective.Text = L.F("Apps: {0} · Space Assistant: {1}", now.AppDefault, now.BaseDefault);
                Page.Toast(value.Length == 0 ? L.T("The Space's default model is the environment's again.") : L.F("The Space's default model is now {0}.", value));
                // New Space Assistant chats take the new default: the agents list carries it.
                if (Context.Live is { } live) _ = live.Refresh(catalogue: true);
                return true;
            }
            catch (Exception e)
            {
                Page.Toast(L.F("The default model was not changed: {0}", SettingsWords.Error(e)), error: true);
                return false;
            }
        });
        var help = Ui.Text(L.T("Shared by app requests and new Space Assistant chats. A model chosen for a call, and Space Assistant conversations already started, keep theirs. Changing it here changes the Space, for every device."), 12, secondary: true);
        var panel = Ui.Column(8, picker, effective, help);
        return Ui.Card(panel, 16);
    }

    private static FrameworkElement Clis(IReadOnlyList<MachineClis> machines)
    {
        var parts = new StackPanel();
        parts.Children.Add(SettingsKit.Note(L.T("The agent CLIs each machine has. A CLI that is missing is left out of every model choice; one that is not signed in is shown greyed until it is.")));
        foreach (var m in machines)
        {
            var note = m.Old ? L.T("older ai-space: no list") : m.Stale ? L.T("offline · last known") : m.Reachable == false ? L.T("unreachable") : m.Via switch { "ssh" => "ssh", "peer" => L.T("peer"), _ => "" };
            var name = m.Machine.Length > 0 ? m.Machine : L.T("this machine");
            parts.Children.Add(SettingsKit.Subhead(note.Length > 0 ? $"{name} · {note}" : name));
            parts.Children.Add(SettingsKit.List(m.Clis.Select(c =>
            {
                var state = SettingsRules.Cli(c);
                var detail = c.Installed == true
                    ? string.Join(" · ", new[] { c.Version ?? "", c.Configured ? L.F("runtime: {0}", string.Join(", ", c.Runtimes)) : L.T("not a runtime there") }.Where(s => s.Length > 0))
                    : c.Detail ?? "";
                var tip = string.Join("\n", new[] { c.Kind, c.Path ?? "", c.Detail ?? "" }.Where(s => s.Length > 0));
                return SettingsKit.Row(c.Cli, detail, SettingsKit.Dot(state.StatusTone, CliWord(state)), tip, Ui.Glyph(Ui.Terminal, 18));
            }), L.T("No agent CLI was found there.")));
        }
        if (machines.Count == 0) parts.Children.Add(SettingsKit.Note(L.T("No machine reported its agent CLIs.")));
        if (SettingsRules.LastChecked(machines) is { } at) parts.Children.Add(SettingsKit.Note(L.F("Checked {0}", SettingsWords.Ago(at))));
        return parts;
    }

    private static string CliWord(StateOf s) => s.Word switch
    {
        StateWord.Ready => L.T("signed in"),
        StateWord.NotSignedIn => L.T("not signed in"),
        StateWord.NotInstalled => L.T("not installed"),
        _ => L.T("not checked yet"),
    };

    private FrameworkElement AppModels(AppModelsView data)
    {
        var parts = new StackPanel();
        parts.Children.Add(SettingsKit.Note(L.T("The model an app's call uses when it names none: set for the whole app or for one purpose. Each saves on the Space.")));
        var live = Context.Live;
        string TitleOf(string app) => live?.App(app)?.DisplayTitle() ?? app;
        var apps = data.Apps.OrderBy(a => TitleOf(a.App), StringComparer.CurrentCultureIgnoreCase).ToList();
        foreach (var a in apps)
        {
            var info = live?.App(a.App);
            var head = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 14, 0, 6) };
            var icon = Context.Icons.View(info?.Icon, TitleOf(a.App), 20);
            icon.Margin = new Thickness(0, 0, 8, 0);
            head.Children.Add(icon);
            var title = Ui.Text(TitleOf(a.App), 14, bold: true, wrap: false);
            title.VerticalAlignment = VerticalAlignment.Center;
            head.Children.Add(title);
            parts.Children.Add(head);
            parts.Children.Add(SettingsKit.List(a.Rows.Select(r => AppModelRow(a.App, TitleOf(a.App), r, data.Options))));
        }
        if (apps.Count == 0) parts.Children.Add(SettingsKit.Note(L.T("No apps installed.")));
        if (live?.Apps.Any(x => x.Peer is not null) == true)
        {
            parts.Children.Add(SettingsKit.Subhead(L.T("Apps on peers")));
            parts.Children.Add(SettingsKit.List([SettingsKit.LinkRow(Ui.Web, L.T("Set Peers' App Models in the Web Panel"), L.T("Each is saved on its peer, with that peer's own choices."), Page.OpenWebSettings)]));
        }
        return parts;
    }

    private FrameworkElement AppModelRow(string app, string appTitle, AppModelRow r, IReadOnlyList<ModelOption> options)
    {
        var purpose = r.Tag ?? L.T("All purposes");
        var detail = Ui.Text(Detail(r), 12, secondary: true, wrap: false);
        var picker = SettingsKit.ModelPicker(L.F("Model of {0}, {1}", appTitle, purpose), options, r.Override, L.T("No override"), withRuntime: false, async value =>
        {
            try
            {
                var rows = await Api.SetAppModel(app, r.Tag, value);
                if (rows?.Rows.FirstOrDefault(x => x.Tag == r.Tag) is { } now) detail.Text = Detail(now);
                Page.Toast(value.Length == 0 ? L.F("{0}, {1}: the override is gone.", appTitle, purpose) : L.F("{0}, {1}: now {2}.", appTitle, purpose, value));
                return true;
            }
            catch (Exception e)
            {
                Page.Toast(L.F("{0} was not changed: {1}", appTitle, SettingsWords.Error(e)), error: true);
                return false;
            }
        });
        var text = Ui.Column(2, Ui.Text(purpose, 14, wrap: false), detail);
        text.VerticalAlignment = VerticalAlignment.Center;
        // Side by side when there is room; the picker goes under the name on a narrow window.
        var wrap = new WrapPanel { Margin = new Thickness(12, 8, 12, 8) };
        text.MinWidth = 220;
        text.Margin = new Thickness(0, 0, 16, 4);
        wrap.Children.Add(text);
        wrap.Children.Add(picker);
        return wrap;
    }

    private static string Detail(AppModelRow r) => string.Join(" · ", new[] { r.Model, Source(r.Source), r.Manifest is { } m ? L.F("space.yaml: {0}", m) : "" }.Where(s => s.Length > 0));

    /// <summary>The layer that chose a row's model (src/space/model/app-models.ts).</summary>
    private static string Source(string source) => source switch
    {
        "request" => L.T("named by the call"),
        "choice" => L.T("chosen in the app"),
        "override-tag" => L.T("set here for this purpose"),
        "override-app" => L.T("set here for the app"),
        "manifest-tag" => L.T("the app's choice for this purpose"),
        "manifest-default" => L.T("the app's choice"),
        _ => L.T("the Space's default"),
    };
}
