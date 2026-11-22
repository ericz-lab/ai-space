using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Overview: the Space itself (its name, address, version and edition), then the web panel's
/// Status (src/web/SettingsStatus.tsx): one line that counts what is wrong, the peers, the runtimes
/// on each machine, the speech providers, the services (started, stopped and restarted here when the
/// Space runs them) and the backups. Each part reads its own route, so one that fails leaves the rest.
/// </summary>
internal sealed class OverviewPane(SpaceSettingsPage page) : SettingsPane(page)
{
    private readonly TextBlock _summary = Ui.Text(L.T("Loading…"), 13, secondary: true);
    private readonly ContentControl _summaryDot = new() { Focusable = false, IsTabStop = false, VerticalAlignment = VerticalAlignment.Center };
    private ServicesView? _services;
    private BackupsView? _backups;
    private ModelStatusView? _models;
    private SpeechView? _speech;
    private Block? _speechBlock;

    public override string Title => L.T("Overview");

    protected override void Compose()
    {
        Add(new Block(L.T("This Space"), async ct => SpaceCard(await Api.Identity(ct))));
        var summary = SettingsKit.Columns(null, _summary, _summaryDot);
        summary.Margin = new Thickness(12, 10, 12, 10);
        AutomationProperties.SetLiveSetting(_summary, AutomationLiveSetting.Polite);
        // One card for the page's life: an element may have one parent only, so each reload hands back the same.
        var card = Ui.Card(summary, 0);
        Add(new Block(L.T("Status"), _ => Task.FromResult<UIElement>(card)));
        Add(new Block(L.T("Runtimes by Machine"), async ct =>
        {
            _models = await Api.ModelStatus(ct);
            Summarize();
            return Runtimes(_models);
        }));
        _speechBlock = Add(new Block(L.T("Speech"), async ct =>
        {
            _speech = await Api.Speech(ct);
            Summarize();
            _speechBlock!.Hide(_speech is null || (_speech.Providers.Count == 0 && _speech.ConfigError is null));
            return _speech is null ? new Border() : Speech(_speech);
        }));
        Add(new Block(L.T("Services"), async ct =>
        {
            _services = await Api.Services(ct);
            Summarize();
            return Services(_services);
        }));
        Add(new Block(L.T("Backups"), async ct =>
        {
            _backups = await Api.Backups(ct);
            Summarize();
            return Backups(_backups);
        }));
    }

    public override void Reload()
    {
        _services = null;
        _backups = null;
        _models = null;
        _speech = null;
        _summary.Text = L.T("Loading…");
        _summaryDot.Content = null;
        base.Reload();
    }

    private FrameworkElement SpaceCard(SpaceIdentity id)
    {
        var c = Context.Connection;
        var rows = new List<UIElement>
        {
            SettingsKit.Pair(L.T("Name"), id.Name ?? c?.DisplayNameOr() ?? ""),
        };
        if (c is not null) rows.Add(SettingsKit.Pair(L.T("Address"), c.Uri.ToString()));
        rows.Add(SettingsKit.Pair(L.T("Version"), id.Version ?? "?"));
        rows.Add(SettingsKit.Pair(L.T("Edition"), id.Edition switch
        {
            "server" => L.T("Server"),
            "local" => L.T("Local"),
            null => "?",
            var e => e,
        }));
        if (id.Id is { } spaceId) rows.Add(SettingsKit.Pair(L.T("Space ID"), spaceId));
        var live = Context.Live;
        var state = live?.Status switch
        {
            LiveStatus.Ok => SettingsKit.Dot(StatusTone.Ok, live.LastRefresh is { } at ? L.F("Connected · checked {0}", SettingsWords.Ago(at)) : L.T("Connected")),
            LiveStatus.Offline => SettingsKit.Dot(StatusTone.Down, L.T("Offline")),
            LiveStatus.SignInNeeded => SettingsKit.Dot(StatusTone.Paused, L.T("Sign-in needed")),
            _ => null,
        };
        if (state is not null)
        {
            state.Margin = new Thickness(12, 6, 12, 8);
            state.HorizontalAlignment = HorizontalAlignment.Left;
            rows.Add(state);
        }
        var panel = new StackPanel();
        foreach (var r in rows) panel.Children.Add(r);
        return Ui.Card(panel, 4);
    }

    /// <summary>The one line that counts the Space's parts and what is wrong with them (SettingsStatus.tsx's summary).</summary>
    private void Summarize()
    {
        if (_services is null || _backups is null)
        {
            _summary.Text = L.T("Loading…");
            return;
        }
        var parts = new List<string> { L.F("{0} services", _services.Services.Count) };
        if (_backups.Enabled || _backups.Backups.Count > 0) parts.Add(L.F("{0} backups", _backups.Backups.Count));
        if (_services.Peers.Count > 0) parts.Add(L.F("{0} peers", _services.Peers.Count));
        if (_models is { Cells.Count: > 0 }) parts.Add(L.F("{0} runtimes", _models.Cells.Count));
        if (_speech is { Providers.Count: > 0 }) parts.Add(L.F("{0} speech providers", _speech.Providers.Count));
        _summary.Text = string.Join(" · ", parts);
        var n = SettingsRules.Problems(_services, _backups, _models, _speech);
        _summaryDot.Content = SettingsKit.Dot(n > 0 ? StatusTone.Down : StatusTone.Ok, n > 0 ? L.F("{0} issues", n) : L.T("all ok"));
    }

    private static FrameworkElement PeerRow(PeerRow p)
    {
        var tip = string.Join("\n", new[]
        {
            p.Url,
            L.F("{0} apps · {1} agents · {2} widgets · {3} services", p.Apps, p.Agents, p.Widgets, p.Services),
            p.AsOf is { } at ? L.F("snapshot {0}", SettingsWords.Ago(at)) : "",
            p.Error ?? "",
        }.Where(s => s.Length > 0));
        var state = SettingsRules.Peer(p);
        var detail = p.Health != "ok" && p.AsOf is { } seen ? $"{p.Url} · {SettingsWords.Ago(seen)}" : p.Url;
        return SettingsKit.Row(p.Name, detail, SettingsKit.Dot(state.StatusTone, SettingsWords.State(state)), tip, Ui.Glyph(Ui.Globe, 18));
    }

    private static FrameworkElement Runtimes(ModelStatusView m)
    {
        var parts = new StackPanel();
        parts.Children.Add(SettingsKit.List(m.Cells.Select(c =>
        {
            var state = SettingsRules.Runtime(c);
            var word = state.Word == StateWord.Limited && c.RestKind is { } rest ? Rest(rest) : SettingsWords.State(state);
            var tip = string.Join("\n", new[]
            {
                c.Kind,
                c.Detail ?? "",
                c.LastOkAt is { } ok ? L.F("last answer {0}", SettingsWords.Ago(ok)) : "",
                c.LimitedUntil is { } until ? c.RestKind is { } kind ? L.F("resting until {0}: {1}", SettingsWords.When(until), Rest(kind)) : L.F("limited until {0}", SettingsWords.When(until)) : "",
                c.LastError ?? "",
                c.Used ? "" : L.T("not in use"),
            }.Where(s => s.Length > 0));
            var detail = string.Join(" · ", new[] { c.Machine.Length > 0 ? c.Machine : L.T("this machine"), c.Version ?? "", c.LastOkAt is { } at ? SettingsWords.Ago(at) : "" }.Where(s => s.Length > 0));
            return SettingsKit.Row(c.Runtime, detail, SettingsKit.Dot(state.StatusTone, word), tip, Ui.Glyph(Ui.Agent, 18));
        }), L.T("No runtimes are configured.")));
        if (m.Fallback.Count > 0) parts.Children.Add(SettingsKit.Note(L.F("Fallback: {0}", string.Join("; ", m.Fallback.Select(f => $"{f.Key} → {string.Join(", ", f.List)}")))));
        if (m.ServesPeers.Count > 0) parts.Children.Add(SettingsKit.Note(L.F("Offered to other spaces: {0}", string.Join(", ", m.ServesPeers))));
        if (m.MaxConcurrency > 0) parts.Children.Add(SettingsKit.Note(L.F("{0} calls running, {1} waiting, at most {2} at once.", m.Running, m.Waiting, m.MaxConcurrency)));
        return parts;
    }

    /// <summary>Why a runtime or a speech provider rests (src/web/call-trace.ts's <c>failureText</c>).</summary>
    private static string Rest(string kind) => kind switch
    {
        "credit" => L.T("out of credit"),
        "quota" => L.T("quota used up"),
        "rate" => L.T("rate limited"),
        "transport" => L.T("connection failing"),
        "auth" => L.T("not signed in"),
        _ => L.T("limited"),
    };

    private static FrameworkElement Speech(SpeechView s)
    {
        var parts = new StackPanel();
        if (s.ConfigError is { } error) parts.Children.Add(SettingsKit.Note(L.F("The speech configuration does not load: {0}", error), error: true));
        parts.Children.Add(SettingsKit.List(s.Providers.Select(c =>
        {
            var state = SettingsRules.Speech(c);
            var word = state.Word == StateWord.Limited && c.RestKind is { } rest ? Rest(rest) : SettingsWords.State(state);
            var tip = string.Join("\n", new[] { c.Kind, c.Roles.Count > 0 ? L.F("used for {0}", string.Join(", ", c.Roles)) : L.T("not in use"), c.Off ?? "", c.Detail ?? "" }.Where(x => x.Length > 0));
            var detail = string.Join(" · ", new[] { c.Where.Length > 0 ? c.Where : L.T("this machine"), c.LastOkAt is { } at ? SettingsWords.Ago(at) : "" }.Where(x => x.Length > 0));
            return SettingsKit.Row(c.Provider, detail, SettingsKit.Dot(state.StatusTone, word), tip);
        })));
        return parts;
    }

    private FrameworkElement Services(ServicesView v)
    {
        var lang = Lang.Current;
        var parts = new StackPanel();
        if (v.Peers.Count > 0)
        {
            parts.Children.Add(SettingsKit.Subhead(L.T("Peers")));
            parts.Children.Add(SettingsKit.List(v.Peers.Select(PeerRow)));
            parts.Children.Add(SettingsKit.Subhead(L.T("Apps")));
        }
        parts.Children.Add(SettingsKit.List(v.Services.Select(s =>
        {
            var (state, supervised) = SettingsRules.Service(s);
            var tip = string.Join(" · ", new[]
            {
                $"{(s.Peer is null ? "" : s.Peer + "/")}{s.App} · 127.0.0.1:{s.Port}",
                s.Supervisor switch { "space" => L.T("run by ai-space"), "operator" => L.T("run by the operator's unit"), _ => "" },
                s.SupervisionAction ?? "",
                s.Hidden ? L.T("hidden") : "",
            }.Where(x => x.Length > 0)) + (s.SupervisionError is { } err ? "\n" + err : "");
            var trailing = new StackPanel { Orientation = Orientation.Horizontal };
            if (supervised)
            {
                foreach (var (action, glyph, label) in new[] { ("start", SettingsKit.Play, L.T("Start")), ("stop", SettingsKit.Stop, L.T("Stop until the next sync")), ("restart", SettingsKit.Restart, L.T("Restart")) })
                {
                    var b = Ui.IconButton(glyph, $"{label}: {s.DisplayTitle(lang)}", () => { });
                    b.ToolTip = label;
                    b.Click += async (_, _) => await Control(s, action, trailing);
                    trailing.Children.Add(b);
                }
            }
            var dot = SettingsKit.Dot(state.StatusTone, SettingsWords.State(state));
            dot.Margin = new Thickness(8, 0, 0, 0);
            trailing.Children.Add(dot);
            var detail = s.Peer is null ? $":{s.Port}" : $"{s.Peer} · :{s.Port}";
            return SettingsKit.Row(s.DisplayTitle(lang), detail, trailing, tip, Context.Icons.View(s.Icon, s.DisplayTitle(lang), 24));
        }), L.T("No services are registered.")));
        return parts;
    }

    /// <summary>Start, stop or restart a unit the Space runs: the person's explicit act, then the row shows what it did.</summary>
    private async Task Control(ServiceRow s, string action, Panel buttons)
    {
        buttons.IsEnabled = false;
        try
        {
            await Api.ControlService(s.App, action);
            Page.Toast(action switch
            {
                "start" => L.F("Started {0}.", s.DisplayTitle()),
                "stop" => L.F("Stopped {0}.", s.DisplayTitle()),
                _ => L.F("Restarted {0}.", s.DisplayTitle()),
            });
        }
        catch (Exception e)
        {
            Page.Toast($"{s.DisplayTitle()}: {SettingsWords.Error(e)}", error: true);
        }
        Reload();
    }

    private static FrameworkElement Backups(BackupsView v)
    {
        if (v.Backups.Count == 0) return SettingsKit.Note(v.Enabled ? L.T("No backups yet.") : L.T("Backups are off. Set a backup target (SPACE_BACKUP_URL) to turn them on."));
        return SettingsKit.List(v.Backups.Select(b =>
        {
            var tip = string.Join("\n", new[]
            {
                b.LastOkKey ?? "",
                b.LastStatus == "error" && b.LastError is { } err ? L.F("last run failed: {0}", err) : "",
                b.LastVerifiedAt is { } at ? b.LastVerifyOk == true ? L.F("verified {0}", SettingsWords.Ago(at)) : L.F("verification failed: {0}", b.LastVerifyError ?? "") : "",
                b.NextRunAt is { } next && !b.Retired ? L.F("next run {0}", SettingsWords.Ago(next)) : "",
                b.Retired ? L.T("No backup task runs for it any more; the snapshots are kept.") : "",
            }.Where(x => x.Length > 0));
            var state = SettingsRules.Backup(b);
            return SettingsKit.Row(b.App, b.LastOkAt is { } ok ? SettingsWords.Ago(ok) : L.T("never"), SettingsKit.Dot(state.StatusTone, SettingsWords.State(state)), tip, Ui.Glyph("", 18));
        }));
    }
}
