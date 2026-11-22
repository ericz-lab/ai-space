using System.Windows;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Model usage (src/web/Usage.tsx): the ledger of the Space's model calls over 5 hours to 30 days,
/// its totals, by app and purpose, by model and backend, and the last 30 calls. The year's grid of
/// days stays in the web panel; here its totals.
/// </summary>
internal sealed class UsagePane(SpaceSettingsPage page) : SettingsPane(page)
{
    private string _window = "24h";
    private Block? _report;

    public override string Title => L.T("Model Usage");

    protected override void Compose()
    {
        Add(SettingsKit.Segmented(L.T("Window"), SettingsRules.ModelWindows, _window, w => w, w =>
        {
            _window = w;
            _report?.Reload();
        }));
        _report = Add(new Block(null, async ct => Report(await Api.Usage(_window, ct))));
        Add(new Block(L.T("Last Calls"), async ct => Calls(await Api.Calls(30, ct))));
    }

    private string AppTitle(string app) => Context.Live?.App(app)?.DisplayTitle() ?? app;

    private UIElement Report(UsageReport u)
    {
        var parts = new StackPanel();
        var head = u.Space is { } space ? L.F("Space {0} · backend {1}", space, u.Backend) : L.F("backend {0}", u.Backend);
        parts.Children.Add(SettingsKit.Note(head));
        foreach (var p in u.Peers.Where(p => !p.Ok))
        {
            parts.Children.Add(SettingsKit.Note(p.AsOf is { } at ? L.F("{0}: its figures are from {1} ({2}).", p.Name, SettingsWords.When(at), p.Error ?? "") : L.F("{0}: its figures are missing ({1}).", p.Name, p.Error ?? ""), error: true));
        }
        var t = u.Totals;
        parts.Children.Add(SettingsKit.Tiles(
            (SettingsWords.Number(t.Calls), t.Errors > 0 ? L.F("calls · {0} failed", t.Errors) : L.T("calls")),
            (SettingsRules.Tokens(t.Tokens), L.T("tokens")),
            (SettingsRules.Cost(t.CostUsd), L.T("cost")),
            (SettingsWords.Duration(t.DurationMs), L.T("model time"))));
        parts.Children.Add(SettingsKit.Note(L.T("Costs include estimates at standard API rates, not subscription charges. Unknown costs are left out of the totals.")));
        if (t.Calls == 0)
        {
            parts.Children.Add(Ui.EmptyState(SpaceSettingsPage.Glyph(SettingsSection.Usage), L.T("No model calls in this window"), L.T("Apps send them through POST /api/model/run; agent tasks are recorded as they run.")));
            return parts;
        }
        string Tip(UsageTotals x) => L.F("input {0} · cache write {1} · cache read {2} · output {3}", SettingsRules.Tokens(x.InputTokens), SettingsRules.Tokens(x.CacheWriteTokens), SettingsRules.Tokens(x.CacheReadTokens), SettingsRules.Tokens(x.OutputTokens));
        string CallsText(UsageTotals x) => x.Errors > 0 ? $"{SettingsWords.Number(x.Calls)} ({x.Errors})" : SettingsWords.Number(x.Calls);
        if (u.ByTag.Count > 0)
        {
            parts.Children.Add(SettingsKit.Subhead(L.T("By app and purpose")));
            parts.Children.Add(SettingsKit.Table(
                [L.T("App"), L.T("Purpose"), L.T("Model"), L.T("Calls"), L.T("Tokens"), L.T("Cost")],
                u.ByTag.Select(r => (new[] { AppTitle(r.App), r.Tag, SettingsRules.ModelOn(r.Model, r.Machine), CallsText(r.Totals), SettingsRules.Tokens(r.Totals.Tokens), SettingsRules.Cost(r.Totals.CostUsd) }, (string?)$"{r.App}\n{Tip(r.Totals)}", false)),
                numericFrom: 3));
        }
        if (u.ByModel.Count > 0 || u.ByBackend.Count > 0)
        {
            parts.Children.Add(SettingsKit.Subhead(L.T("By model and backend")));
            var rows = u.ByModel.Select(r => (new[] { SettingsRules.ModelOn(r.Model, r.Machine), CallsText(r.Totals), SettingsRules.Tokens(r.Totals.Tokens), SettingsRules.Cost(r.Totals.CostUsd) }, (string?)Tip(r.Totals), false))
                .Concat(u.ByBackend.Select(r => (new[] { $"{r.Backend} · {Origin(r.Origin)}", CallsText(r.Totals), SettingsRules.Tokens(r.Totals.Tokens), SettingsRules.Cost(r.Totals.CostUsd) }, (string?)Tip(r.Totals), true)));
            parts.Children.Add(SettingsKit.Table([L.T("Model"), L.T("Calls"), L.T("Tokens"), L.T("Cost")], rows, numericFrom: 1));
        }
        if (u.HistoryTotals.Calls > 0 && u.FirstAt is { } first)
        {
            var days = Math.Max(1, (int)Math.Ceiling((DateTimeOffset.Now - first).TotalDays));
            var h = u.HistoryTotals;
            parts.Children.Add(SettingsKit.Subhead(L.T("Since the first call")));
            parts.Children.Add(SettingsKit.Tiles(
                (SettingsWords.Number(days), L.T("days recorded")),
                (SettingsWords.Number(h.Calls), L.T("calls")),
                (SettingsRules.Tokens(h.Tokens), L.T("tokens")),
                (SettingsRules.Cost(h.CostUsd), L.F("cost · {0} a day", SettingsRules.Cost(h.CostUsd / days)))));
        }
        return parts;
    }

    private static string Origin(string o) => o switch
    {
        "task" => L.T("tasks"),
        "import" => L.T("imported"),
        "peer" => L.T("for peers"),
        _ => L.T("calls"),
    };

    private UIElement Calls(IReadOnlyList<ModelCall> calls)
    {
        if (calls.Count == 0) return SettingsKit.Note(L.T("No calls yet."));
        return SettingsKit.List(calls.Select(c =>
        {
            var detail = string.Join(" · ", new[]
            {
                $"{AppTitle(c.App)} · {c.Tag}",
                c.FallbackFrom is { } from ? L.F("instead of {0}", from) : "",
                SettingsWords.Ago(c.StartedAt),
                c.Error ?? "",
            }.Where(s => s.Length > 0));
            var figures = string.Join(" · ", new[] { c.Tokens is { } n ? SettingsRules.Tokens(n) : "", c.CostUsd is { } usd ? SettingsRules.Cost(usd) : "", SettingsWords.Duration(c.DurationMs) }.Where(s => s.Length > 0));
            var end = Ui.Row(SettingsKit.Dot(c.Status == "ok" ? StatusTone.Ok : StatusTone.Down), Ui.Text(figures, 12, secondary: true, wrap: false));
            var tip = c.Error ?? $"{c.App}/{c.Tag} · {c.Backend}{(c.ModelSource is { } s ? " · " + s : "")}";
            return SettingsKit.Row(SettingsRules.ModelOn(c.Model, c.Machine), detail, end, tip);
        }));
    }
}

/// <summary>
/// App usage (src/web/Activity.tsx): how often each app, agent and built-in page was opened and for
/// how long, over 7 days to all time, and each device's time in the foreground.
/// </summary>
internal sealed class ActivityPane(SpaceSettingsPage page) : SettingsPane(page)
{
    private string _window = "30d";
    private string _kind = "all";
    private Block? _rows;
    private Block? _devices;

    public override string Title => L.T("App Usage");

    protected override void Compose()
    {
        Add(SettingsKit.Note(L.T("How often each app, agent and panel window was opened, and for how long. An app's time comes from its heartbeat script; one without it shows a dash. An agent's opens are chat turns.")));
        var bar = new WrapPanel();
        bar.Children.Add(SettingsKit.Segmented(L.T("Window"), SettingsRules.ActivityWindows, _window, w => w == "all" ? L.T("All time") : w, w =>
        {
            _window = w;
            _rows?.Reload();
            _devices?.Reload();
        }));
        var kinds = SettingsKit.Segmented(L.T("Kind"), SettingsRules.ActivityKinds, _kind, Kind, k =>
        {
            _kind = k;
            _rows?.Reload();
        });
        kinds.Margin = new Thickness(16, 4, 0, 4);
        bar.Children.Add(kinds);
        Add(bar);
        _rows = Add(new Block(null, async ct => Rows(await Api.Activity(_window, _kind, ct))));
        _devices = Add(new Block(L.T("Devices"), async ct => Devices(await Api.Devices(_window, ct))));
    }

    private static string Kind(string k) => k switch
    {
        "app" => L.T("Apps"),
        "agent" => L.T("Agents"),
        "builtin" => L.T("Built-in"),
        _ => L.T("All"),
    };

    private string NameOf(ActivityRow r)
    {
        var live = Context.Live;
        return r.Kind switch
        {
            "builtin" => r.Key switch
            {
                "inbox" => L.T("Inbox"),
                "shortcuts" => L.T("Shortcuts"),
                "terminal" => L.T("Terminal"),
                "settings" => L.T("Settings"),
                "chat" => L.T("Chat"),
                _ => r.Key,
            },
            "app" => live?.App(r.Key)?.DisplayTitle() ?? r.Key,
            _ => live?.Agents.FirstOrDefault(a => a.Id == r.Key || $"{a.App}/{a.Name}" == r.Key)?.DisplayTitle() ?? r.Key,
        };
    }

    private UIElement Rows(IReadOnlyList<ActivityRow> rows)
    {
        var parts = new StackPanel();
        var (opens, timeMs, top) = SettingsRules.ActivityTotals(rows);
        parts.Children.Add(SettingsKit.Tiles(
            (SettingsWords.Number(opens), L.T("Opens")),
            (timeMs > 0 ? SettingsWords.Duration(timeMs) : "—", L.T("Time in use")),
            (top is null ? "—" : NameOf(top), L.T("Most used"))));
        if (rows.Count == 0)
        {
            parts.Children.Add(SettingsKit.Note(L.T("Nothing recorded in this window yet.")));
            return parts;
        }
        parts.Children.Add(SettingsKit.Table(
            [L.T("Name"), L.T("Opens"), L.T("Time in use"), L.T("Average"), L.T("Last used")],
            rows.Select(r => (new[]
            {
                NameOf(r),
                SettingsWords.Number(r.Opens),
                r.ActiveMs is { } ms ? SettingsWords.Duration(ms) : "—",
                r.ActiveMs is { } total && r.Sessions > 0 ? SettingsWords.Duration((double)total / r.Sessions) : "—",
                r.LastAt is { } at ? SettingsWords.Ago(at) : "—",
            }, (string?)$"{r.Kind} · {r.Key}", false)),
            numericFrom: 1));
        return parts;
    }

    private static UIElement Devices(IReadOnlyList<DeviceRow>? devices)
    {
        if (devices is null) return SettingsKit.Note(L.T("The Space keeps no device figures."));
        if (devices.Count == 0) return SettingsKit.Note(L.T("No device has reported its time in this window."));
        return SettingsKit.List(devices.Select(d => SettingsKit.Row(SettingsRules.DeviceLabel(d),
            L.F("{0} sessions · {1} in the foreground · {2}", d.Sessions, SettingsWords.Duration(d.ActiveMs), SettingsWords.Ago(d.LastAt)), null, d.DeviceId, Ui.Glyph(Ui.Computer, 18))));
    }
}
