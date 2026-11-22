using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>An expanding row whose content loads when it is first opened (a task's runs, an event's deliveries).</summary>
internal static class Unfold
{
    public static Expander Row(FrameworkElement header, string name, Func<CancellationToken, Task<UIElement>>? load, UIElement? body = null)
    {
        var content = new StackPanel { Margin = new Thickness(28, 0, 8, 8) };
        if (body is not null) content.Children.Add(body);
        var e = new Expander { Header = header, Content = content, Padding = new Thickness(8, 4, 8, 4), HorizontalContentAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetName(e, name);
        if (load is not null)
        {
            var block = new Block(null, load);
            content.Children.Add(block.View);
            var loaded = false;
            e.Expanded += (_, _) =>
            {
                if (loaded) return;
                loaded = true;
                block.Reload();
            };
        }
        return e;
    }

    /// <summary>The header of a row: a dot, a title over a line, something at the end.</summary>
    public static FrameworkElement Header(StatusTone tone, string title, string detail, string? end, string? tooltip)
    {
        var dot = SettingsKit.Dot(tone);
        dot.Margin = new Thickness(0, 0, 10, 0);
        var text = Ui.Column(2, Ui.Text(title, 14, wrap: false), Ui.Text(detail, 12, secondary: true, wrap: false));
        FrameworkElement? tail = null;
        if (!string.IsNullOrEmpty(end))
        {
            var t = Ui.Text(end, 12, secondary: true, wrap: false);
            t.MaxWidth = 220;
            t.Margin = new Thickness(12, 0, 0, 0);
            t.VerticalAlignment = VerticalAlignment.Center;
            tail = t;
        }
        var grid = SettingsKit.Columns(dot, text, tail);
        if (!string.IsNullOrEmpty(tooltip)) grid.ToolTip = tooltip;
        return grid;
    }
}

/// <summary>
/// Scheduled tasks (src/web/Tasks.tsx, the Linux client's tasks page): grouped by app, each with
/// its state, schedule and triggers, its last and next run; opening one shows its last 20 runs.
/// Read-only here: a task's model is chosen in the web panel.
/// </summary>
internal sealed class TasksPane(SpaceSettingsPage page) : SettingsPane(page)
{
    public override string Title => L.T("Scheduled Tasks");

    protected override void Compose()
    {
        Add(new Block(null, async ct => Tasks(await Api.Tasks(ct))));
        Add(SettingsKit.Subhead(L.T("More")));
        Add(SettingsKit.List([SettingsKit.LinkRow(Ui.Web, L.T("Choose a Task's Model in the Web Panel"), L.T("Settings › Automation › Scheduled tasks"), Page.OpenWebSettings)]));
    }

    private FrameworkElement Tasks(IReadOnlyList<TaskRow> tasks)
    {
        var parts = new StackPanel();
        var (total, active, failing) = SettingsRules.TaskCounts(tasks);
        parts.Children.Add(SettingsKit.Note(failing > 0 ? L.F("{0} of {1} active · {2} failing", active, total, failing) : L.F("{0} of {1} active", active, total)));
        if (tasks.Count == 0)
        {
            parts.Children.Add(Ui.EmptyState(SpaceSettingsPage.Glyph(SettingsSection.Tasks), L.T("No scheduled tasks"), L.T("Apps declare them under tasks: in their space.yaml.")));
            return parts;
        }
        var live = Context.Live;
        foreach (var (app, title, rows) in SettingsRules.ByApp(tasks, t => t.App, a => live?.App(a)?.DisplayTitle() ?? a, t => t.Name))
        {
            parts.Children.Add(SettingsKit.Subhead($"{title} · {rows.Count}"));
            parts.Children.Add(SettingsKit.List(rows.Select(TaskItem)));
        }
        return parts;
    }

    private UIElement TaskItem(TaskRow t)
    {
        var state = SettingsRules.Task(t);
        var meta = new[]
        {
            SettingsWords.State(state),
            t.State.LastDurationMs is { } d ? SettingsWords.Duration(d) : "",
            t.State.LastRunAt is { } last ? SettingsWords.Ago(last) : "",
            t.Enabled && !t.Orphaned && t.State.NextRunAt is { } next ? L.F("next {0}", SettingsWords.Ago(next)) : "",
            t.State.PendingEvents is > 0 and var n ? L.F("{0} event(s) queued", n) : "",
            t.TargetKind,
            t.Model ?? "",
        }.Where(s => s.Length > 0);
        var schedule = string.Join(" · ", t.Triggers.Select(e => L.F("on {0}", e)).Concat(t.Schedule.Kind != "manual" || t.Triggers.Count == 0 ? new[] { SettingsWords.Schedule(t.Schedule) } : Array.Empty<string>()));
        var badges = new[] { t.Source == "api" ? "[api]" : "", t.Overridden ? "[override]" : "" }.Where(s => s.Length > 0);
        var title = string.Join(" ", new[] { t.Name }.Concat(badges));
        var header = Unfold.Header(state.StatusTone, title, string.Join(" · ", meta), schedule, t.Description ?? $"{t.App}/{t.Name}");
        var body = new StackPanel();
        if (t.Description is { Length: > 0 } desc) body.Children.Add(SettingsKit.Note(desc));
        if (t.State.LastError is { Length: > 0 } err && t.State.LastStatus == "error") body.Children.Add(SettingsKit.Note(L.F("Last error: {0}", err), error: true));
        return Unfold.Row(header, $"{t.Name}, {SettingsWords.State(state)}", async ct => Runs(await Api.TaskRuns(t.Id, 20, ct)), body);
    }

    private static UIElement Runs(IReadOnlyList<TaskRun> runs)
    {
        if (runs.Count == 0) return SettingsKit.Note(L.T("No runs yet."));
        var panel = new StackPanel();
        foreach (var r in runs)
        {
            var state = SettingsRules.Run(r);
            var tags = new[] { r.Trigger == "manual" ? L.T("manual") : "", r.Events > 0 ? L.F("{0} event(s)", r.Events) : "" }.Where(s => s.Length > 0);
            var title = string.Join(" · ", new[] { SettingsWords.Ago(r.StartedAt) }.Concat(tags));
            var detail = string.Join(" · ", new[] { SettingsWords.Duration((r.EndedAt - r.StartedAt).TotalMilliseconds), r.Error ?? "" }.Where(s => s.Length > 0));
            var row = SettingsKit.Row(title, detail, SettingsKit.Dot(state.StatusTone, SettingsWords.State(state)), SettingsWords.When(r.StartedAt));
            panel.Children.Add(row);
            if (r.Output is { Length: > 0 } output)
            {
                var text = new TextBox
                {
                    Text = output.Length > 4000 ? output[..4000] + "…" : output,
                    IsReadOnly = true,
                    TextWrapping = TextWrapping.Wrap,
                    FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
                    FontSize = 12,
                    MaxHeight = 160,
                    Margin = new Thickness(12, 0, 12, 8),
                };
                ScrollViewer.SetVerticalScrollBarVisibility(text, ScrollBarVisibility.Auto);
                AutomationProperties.SetName(text, L.T("Output"));
                panel.Children.Add(text);
            }
        }
        return panel;
    }
}

/// <summary>
/// Events and calls (src/web/Events.tsx): what each app provides, publishes and consumes on the bus,
/// then the last 100 events, each opening to its deliveries. Read-only.
/// </summary>
internal sealed class EventsPane(SpaceSettingsPage page) : SettingsPane(page)
{
    private readonly TextBlock _summary = Ui.Text("", 12, secondary: true);
    private IReadOnlyList<CapabilityApp>? _apps;
    private int? _events;

    public override string Title => L.T("Events and Calls");

    protected override void Compose()
    {
        _summary.Margin = new Thickness(4, 6, 4, 6);
        Add(_summary);
        Add(new Block(L.T("Catalogue"), async ct =>
        {
            _apps = await Api.Capabilities(ct);
            Summarize();
            return Catalogue(_apps);
        }));
        Add(new Block(L.T("Recent Events"), async ct =>
        {
            var events = await Api.Events(100, ct);
            _events = events.Count;
            Summarize();
            return Recent(events);
        }));
    }

    public override void Reload()
    {
        _apps = null;
        _events = null;
        _summary.Text = "";
        base.Reload();
    }

    private void Summarize()
    {
        if (_apps is null || _events is null) return;
        _summary.Text = L.F("{0} recent · {1} providers · {2} publishers", _events, _apps.Count(a => a.Provides.Count > 0), _apps.Count(a => a.Publishes.Count > 0));
    }

    private UIElement Catalogue(IReadOnlyList<CapabilityApp> all)
    {
        var apps = SettingsRules.CatalogueApps(all);
        if (apps.Count == 0) return SettingsKit.Note(L.T("No app declares events: or provides: yet."));
        var live = Context.Live;
        return SettingsKit.List(apps.Select(a =>
        {
            var title = live?.App(a.App)?.DisplayTitle() ?? a.App;
            var rows = new List<UIElement>();
            foreach (var c in a.Provides)
            {
                var tip = $"{c.Method} {c.Path}" + (c.Callers.Count > 0 ? " · " + string.Join(", ", c.Callers) : "");
                rows.Add(SettingsKit.Row($"{L.T("provides")} · {c.Name}", c.Description, c.Calls is { } n ? Ui.Text(L.F("{0} calls · {1} failed", n, c.Failures ?? 0), 12, secondary: true, wrap: false) : null, tip));
            }
            foreach (var p in a.Publishes) rows.Add(SettingsKit.Row($"{L.T("publishes")} · {p.Name}", p.Description, null));
            foreach (var c in a.Consumes)
            {
                var how = c.Kind switch
                {
                    "task" => L.F("task {0}", c.Task ?? ""),
                    "http" => $"{c.Method} {c.Path}",
                    _ => L.T("stream"),
                };
                rows.Add(SettingsKit.Row($"{L.T("consumes")} · {c.Event}", how, null));
            }
            var counts = L.F("{0} provided · {1} published · {2} consumed", a.Provides.Count, a.Publishes.Count, a.Consumes.Count);
            var header = Unfold.Header(StatusTone.Off, a.Peer is null ? title : $"{title} · {a.Peer}", counts, null, a.App);
            var body = new StackPanel();
            foreach (var r in rows) body.Children.Add(r);
            return (UIElement)Unfold.Row(header, title, null, body);
        }));
    }

    private UIElement Recent(IReadOnlyList<EventRow> events)
    {
        if (events.Count == 0) return Ui.EmptyState(SpaceSettingsPage.Glyph(SettingsSection.Events), L.T("No events yet"), L.T("Apps publish them with POST /api/events; subscriptions live in space.yaml."));
        return SettingsKit.List(events.Select(e =>
        {
            var title = e.Peer is null ? e.Name : $"{e.Name} · {e.Peer}";
            var detail = string.Join(" · ", new[] { SettingsWords.Ago(e.At), e.Preview }.Where(s => s.Length > 0));
            var header = Unfold.Header(StatusTone.Off, title, detail, null, e.At is { } at ? SettingsWords.When(at) : null);
            return (UIElement)Unfold.Row(header, title, async ct => Deliveries(await Api.Deliveries(e.Id, ct)));
        }));
    }

    private static UIElement Deliveries(IReadOnlyList<DeliveryRow> rows)
    {
        if (rows.Count == 0) return SettingsKit.Note(L.T("No http or stream deliveries (task triggers show under Scheduled Tasks)."));
        var panel = new StackPanel();
        foreach (var d in rows)
        {
            var state = SettingsRules.Delivery(d);
            var where = d.Path is { Length: > 0 } p ? $"{d.App} · {d.Kind} {p}" : $"{d.App} · {d.Kind}";
            var word = $"{SettingsWords.State(state)} · {L.F("{0} attempt(s)", d.Attempts)}";
            panel.Children.Add(SettingsKit.Row(where, d.LastError, SettingsKit.Dot(state.StatusTone, word), d.NextAt is { } next ? SettingsWords.When(next) : null));
        }
        return panel;
    }
}
