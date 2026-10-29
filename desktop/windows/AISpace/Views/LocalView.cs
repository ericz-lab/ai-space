using System.Windows;
using System.Windows.Controls;
using AISpace.Core;
using AISpace.Local;

namespace AISpace.Views;

/// <summary>
/// AI Space on this computer (docs/windows-desktop.md#this-computer, the Mac's <c>LocalSetupView</c>
/// and <c>LocalSettingsSection</c>): WSL first, then setting up the Space the app carries, or
/// taking over one this computer already has, then its service. Nothing is set up, taken over,
/// stopped or updated without one of these buttons, except an update the app carries, which waits
/// until the Space is idle.
/// </summary>
internal sealed class LocalView : ContentControl
{
    private readonly AppModel _model;
    private readonly LocalManager _local;
    private string? _defaultModel;

    public LocalView(AppModel model)
    {
        _model = model;
        _local = model.Local;
        _local.Changed += Render;
        Unloaded += (_, _) => _local.Changed -= Render;
        Loaded += (_, _) =>
        {
            _local.Changed -= Render;
            _local.Changed += Render;
            Render();
        };
        Render();
    }

    private void Render()
    {
        var parts = new List<UIElement>();
        if (!_local.Available)
        {
            parts.Add(Ui.Text(L.T("AI Space on This Computer"), 20, bold: true));
            parts.Add(Ui.Text(L.T("This copy is the Client edition: it opens Spaces that run elsewhere. To run a Space on this computer, install the Local edition of AI Space for Windows."), secondary: true));
            parts.Add(Ui.Button(L.T("Get the Local Edition"), () => AppModel.OpenOutside(new Uri("https://github.com/ericz-lab/ai-space/releases/latest"))));
        }
        else if (_local.Busy is { } busy)
        {
            parts.Add(Ui.Text(busy, 16, bold: true));
            parts.Add(new ProgressBar { IsIndeterminate = true, Height = 4, MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left });
            parts.Add(Ui.Text(L.T("This can take a few minutes the first time."), 12, secondary: true));
        }
        else
        {
            switch (_local.Wsl)
            {
                case WslReadiness.Checking:
                    parts.Add(Ui.Text(L.T("Checking this computer…"), secondary: true));
                    break;
                case WslReadiness.Missing:
                    Missing(parts);
                    break;
                default:
                    Ready(parts);
                    break;
            }
        }
        if ((_local.UpdateWaitingFor ?? _local.Failure?.Activity) is { } waiting) parts.Add(Ui.Text(L.F("Waiting for: {0}", waiting.Summary), 12, secondary: true));
        if (_local.Failure is { } failure)
        {
            var t = Ui.Text(failure.Message, 13);
            t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
            parts.Add(t);
        }
        var column = Ui.Column(12, [.. parts]);
        column.MaxWidth = 620;
        column.HorizontalAlignment = HorizontalAlignment.Left;
        Content = column;
    }

    private void Missing(List<UIElement> parts)
    {
        parts.Add(Ui.Text(L.T("AI Space on This Computer"), 20, bold: true));
        parts.Add(Ui.Text(L.T("AI Space runs on Windows inside WSL 2, the Windows Subsystem for Linux, as it runs on Linux. Your apps, agents and their data stay on this computer."), secondary: true));
        var wsl1 = _local.Distros.Where(d => d.Version == 1 && !Core.Wsl.IsInternal(d.Name)).Select(d => d.Name).ToList();
        if (wsl1.Count > 0) parts.Add(Ui.Text(L.F("{0} uses WSL 1. Convert it with \"wsl --set-version {0} 2\", or install Ubuntu below.", wsl1[0]), 13, secondary: true));
        parts.Add(Ui.Text(L.T("Install WSL opens Windows' installer: it asks for administrator approval, may restart the computer, and then asks for a Linux user name and password. Come back here when it is done."), 13, secondary: true));
        parts.Add(Ui.Row(Ui.Button(L.T("Install WSL"), _local.InstallWsl, accent: true), Ui.Button(L.T("Check Again"), () => _ = _local.Refresh())));
    }

    private void Ready(List<UIElement> parts)
    {
        var distros = _local.Distros.Where(d => d.Version == 2 && !Core.Wsl.IsInternal(d.Name)).ToList();
        if (distros.Count > 1)
        {
            var pick = new ComboBox { MinWidth = 200, HorizontalAlignment = HorizontalAlignment.Left };
            foreach (var d in distros) pick.Items.Add(d.Name);
            pick.SelectedItem = _local.Distro;
            pick.SelectionChanged += (_, _) =>
            {
                if (pick.SelectedItem is string name && name != _local.Distro) _local.ChooseDistro(name);
            };
            parts.Add(Ui.Row(Ui.Text(L.T("WSL distribution"), 13, bold: true), pick));
        }
        if (_local.Status is not { } s)
        {
            parts.Add(Ui.Text(L.T("Checking this computer…"), secondary: true));
            parts.Add(Ui.Button(L.T("Check Again"), () => _ = _local.Refresh()));
            return;
        }
        switch (s.State)
        {
            case "absent":
                parts.Add(Ui.Text(L.T("Set up AI Space on this computer"), 20, bold: true));
                parts.Add(Ui.Text(L.F("It runs in {0} in the background, also while this window is closed. Your apps, agents and their data stay on this computer.", _local.Distro ?? "WSL"), secondary: true));
                Runtimes(parts, s);
                ModelPicker(parts, s);
                var setUp = Ui.Button(L.T("Set Up"), () => _ = _local.Install(defaultModel: _defaultModel), accent: true);
                setUp.IsEnabled = s.Runtimes.Any && _defaultModel is not null;
                parts.Add(Ui.Row(setUp, Ui.Button(L.T("Check Again"), () => _ = _local.Refresh())));
                break;
            case "foreign":
                parts.Add(Ui.Text(L.T("This computer already has an AI Space"), 20, bold: true));
                parts.Add(Ui.Text(s.Reason ?? L.T("It was installed another way."), secondary: true));
                parts.Add(Ui.Text(L.T("Connect to it as it is, or let this app take it over. Taking over keeps its apps, data and settings; stop the running one first."), 13, secondary: true));
                Runtimes(parts, s);
                ModelPicker(parts, s);
                var connect = Ui.Button(L.T("Connect to It"), () =>
                {
                    if (Uri.TryCreate(s.Url, UriKind.Absolute, out var url)) _model.Add(L.T("This Computer"), url);
                });
                connect.IsEnabled = s.Running is not null;
                var takeOver = Ui.Button(L.T("Take It Over…"), () =>
                {
                    var ok = MessageBox.Show(Window.GetWindow(this), L.T("This app will run that workspace from now on, with its apps, data and settings as they are."), L.F("Take over {0}?", s.Workspace.Path), MessageBoxButton.OKCancel, MessageBoxImage.Question);
                    if (ok == MessageBoxResult.OK) _ = _local.Install(migrate: true, defaultModel: _defaultModel);
                });
                takeOver.IsEnabled = s.Running is null && !s.Workspace.Locked && s.Runtimes.Any && _defaultModel is not null;
                parts.Add(Ui.Row(connect, takeOver, Ui.Button(L.T("Check Again"), () => _ = _local.Refresh())));
                break;
            default:
                Managed(parts, s);
                break;
        }
    }

    private void Managed(List<UIElement> parts, LocalStatus s)
    {
        parts.Add(Ui.Text(L.T("AI Space on This Computer"), 20, bold: true));
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(140) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        void Line(string label, string value)
        {
            var row = grid.RowDefinitions.Count;
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var l = Ui.Text(label, 13, secondary: true);
            var v = new TextBox { Text = value, IsReadOnly = true, BorderThickness = new Thickness(0), Background = System.Windows.Media.Brushes.Transparent, Padding = new Thickness(0), TextWrapping = TextWrapping.Wrap };
            l.Margin = new Thickness(0, 2, 0, 2);
            v.Margin = new Thickness(0, 2, 0, 2);
            Grid.SetRow(l, row);
            Grid.SetRow(v, row);
            Grid.SetColumn(v, 1);
            grid.Children.Add(l);
            grid.Children.Add(v);
        }
        Line(L.T("State"), StateText(s));
        if (s.Installed is { } installed) Line(L.T("Installed"), $"{installed.Version} ({Short(installed.Commit)})");
        if (_local.Bundle is { } bundle) Line(L.T("In this app"), $"{bundle.Release.Version} ({Short(bundle.Release.Commit)})");
        Line(L.T("WSL distribution"), _local.Distro ?? "");
        Line(L.T("Workspace"), s.Workspace.Path);
        Line(L.T("Agents"), RuntimesText(s.Runtimes));
        Line(L.T("Address"), s.Url);
        parts.Add(grid);

        var actions = new List<UIElement>();
        if (s.UpdateAvailable)
        {
            actions.Add(Ui.Button(L.T("Update When Idle"), () => _ = _local.Install(whenBusy: WhenBusy.Wait), accent: true));
            actions.Add(Ui.Button(L.T("Update Now…"), () =>
            {
                var ok = MessageBox.Show(Window.GetWindow(this), L.T("Running work has up to 30 seconds to finish before the service restarts. Unfinished work may be interrupted."), L.T("Update the background service now?"), MessageBoxButton.OKCancel, MessageBoxImage.Warning);
                if (ok == MessageBoxResult.OK) _ = _local.Install(whenBusy: WhenBusy.Now);
            }));
        }
        if (s.Service.Running)
        {
            actions.Add(Ui.Button(L.T("Stop"), () => _ = _local.StopService()));
            actions.Add(Ui.Button(L.T("Restart"), () => _ = _local.RestartService()));
        }
        else if (s.Installed is not null)
        {
            actions.Add(Ui.Button(L.T("Start"), () => _ = _local.StartService(), accent: !s.UpdateAvailable));
        }
        actions.Add(Ui.Button(s.Installed is null ? L.T("Install Again") : L.T("Repair"), () => _ = _local.Install()));
        actions.Add(Ui.Button(L.T("Open Log"), _local.OpenLog));
        var row = new WrapPanel();
        foreach (var a in actions)
        {
            if (a is FrameworkElement f) f.Margin = new Thickness(0, 0, 8, 8);
            row.Children.Add(a);
        }
        parts.Add(row);
        if (s.Installed is not null)
        {
            parts.Add(Ui.Button(L.T("Remove Background Service…"), () =>
            {
                var ok = MessageBox.Show(Window.GetWindow(this), L.F("AI Space stops and no longer starts with Windows. Your apps, data and settings stay in {0}.", s.Workspace.Path), L.T("Remove the background service?"), MessageBoxButton.OKCancel, MessageBoxImage.Warning);
                if (ok == MessageBoxResult.OK) _ = _local.RemoveService();
            }));
        }
        parts.Add(Ui.Text(L.T("It runs in the background: closing or quitting this app leaves it running. Before uninstalling the app, remove the background service here; your workspace stays."), 12, secondary: true));
    }

    /// <summary>The agent CLIs in the distribution: setting up needs at least one, signed in.</summary>
    private static void Runtimes(List<UIElement> parts, LocalStatus s)
    {
        var lines = new List<UIElement> { Ui.Text(L.T("Agents in WSL"), 14, bold: true) };
        void One(string title, string? path) => lines.Add(Ui.Text(path is null ? $"{title}: {L.T("not found")}" : $"{title}: {path}", 13, secondary: path is null));
        One("Claude Code", s.Runtimes.Claude);
        One("Codex", s.Runtimes.Codex);
        One("DeepSeek Harness", s.Runtimes.Dsh);
        if (!s.Runtimes.Any) lines.Add(Ui.Text(L.T("Install Claude Code or Codex inside the WSL distribution and sign in to it there (open \"wsl\" in a terminal), then Check Again."), 12, secondary: true));
        parts.Add(Ui.Card(Ui.Column(6, [.. lines]), 16));
    }

    private void ModelPicker(List<UIElement> parts, LocalStatus s)
    {
        var options = s.Models ?? [];
        var lines = new List<UIElement> { Ui.Text(L.T("Default model"), 14, bold: true) };
        if (options.Count == 0)
        {
            lines.Add(Ui.Text(L.T("Available once an agent CLI is found."), 13, secondary: true));
        }
        else
        {
            var pick = new ComboBox { MinWidth = 280, HorizontalAlignment = HorizontalAlignment.Left };
            foreach (var o in options) pick.Items.Add(new ComboBoxItem { Content = $"{o.Runtime} · {o.Tier} ({o.Model})", Tag = o.Value });
            if (_defaultModel is null || options.All(o => o.Value != _defaultModel)) _defaultModel = options.FirstOrDefault(o => o.Tier == "intermediate")?.Value ?? options[0].Value;
            pick.SelectedItem = pick.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == _defaultModel);
            pick.SelectionChanged += (_, _) =>
            {
                if (pick.SelectedItem is ComboBoxItem { Tag: string v } && v != _defaultModel)
                {
                    _defaultModel = v;
                    Render();
                }
            };
            lines.Add(pick);
            lines.Add(Ui.Text(L.T("Space Assistant, other agents and apps use it when nothing chooses a model for them. You can change it later in Settings."), 12, secondary: true));
        }
        parts.Add(Ui.Card(Ui.Column(6, [.. lines]), 16));
    }

    private static string Short(string commit) => commit.Length > 7 ? commit[..7] : commit;

    private static string StateText(LocalStatus s)
    {
        if (s.Installed is null) return L.T("Background service removed");
        if (s.Service.Running) return s.OwnServiceRunning ? L.T("Running") : L.T("Starting…");
        if (s.Service.Disabled) return L.T("Stopped");
        return L.F("Not running ({0})", s.Service.Detail);
    }

    private static string RuntimesText(LocalStatus.RuntimesInfo r)
    {
        var found = new[] { r.Claude is null ? null : "Claude Code", r.Codex is null ? null : "Codex", r.Dsh is null ? null : "DeepSeek Harness" }.OfType<string>().ToList();
        return found.Count == 0 ? L.T("None found") : string.Join(", ", found);
    }
}
