using System.Globalization;
using System.Text.Json;

namespace AISpace.Core;

// The shapes of the routes the Space's Settings page reads (src/web/api.ts has the full ones; the
// Linux client's core/settings.ts decodes the same). Every field the page can live without is
// optional and a malformed row is skipped, so an older or newer Space still decodes.

/// <summary><c>GET /api/space</c>: what the Space says it is (docs/editions.md#service-identity).</summary>
public sealed record SpaceIdentity(string Product, int? ApiLevel, string? Version, string? Edition, string? Installation, string? Id, string? Name);

/// <summary>One app process as <c>GET /api/services</c> lists it.</summary>
public sealed record ServiceRow(string App, string? Peer, string Title, IReadOnlyDictionary<string, LocalizedText>? I18n, string? Icon, int Port, string Health, string Status, bool Hidden, string? Supervisor, string? SupervisionAction, string? SupervisionError)
{
    public string DisplayTitle(string? lang = null) => Lang.Pick(Title, I18n, true, lang);
}

/// <summary>One peer machine as <c>GET /api/services</c> reports it (docs/peers.md).</summary>
public sealed record PeerRow(string Name, string Url, string Health, DateTimeOffset? AsOf, string? Error, bool Stale, int Apps, int Agents, int Widgets, int Services);

public sealed record ServicesView(IReadOnlyList<ServiceRow> Services, IReadOnlyList<PeerRow> Peers);

/// <summary>One app's backups as <c>GET /api/backups</c> reports them (docs/backup.md).</summary>
public sealed record BackupRow(string App, int Count, string? LastStatus, string? LastError, DateTimeOffset? LastOkAt, string? LastOkKey, DateTimeOffset? LastVerifiedAt, bool? LastVerifyOk, string? LastVerifyError, bool Stale, bool Retired, DateTimeOffset? NextRunAt);

public sealed record BackupsView(bool Enabled, IReadOnlyList<BackupRow> Backups);

/// <summary>One cell of the model status table (<c>GET /api/model/status</c>, docs/model-machines.md#status): a runtime on a machine ("" is the Space's own).</summary>
public sealed record RuntimeCell(string Machine, string Runtime, string Kind, bool? Reachable, bool? Installed, bool? SignedIn, string? Version, string? Detail, bool ProbeTimedOut, DateTimeOffset? CheckedAt, DateTimeOffset? LimitedUntil, string? RestKind, string? LastError, string? LastErrorKind, DateTimeOffset? LastOkAt, bool Used, string? Problem);

public sealed record ModelStatusView(IReadOnlyList<RuntimeCell> Cells, IReadOnlyList<(string Key, IReadOnlyList<string> List)> Fallback, IReadOnlyList<string> ServesPeers, int Running, int Waiting, int MaxConcurrency);

/// <summary>One speech provider as <c>GET /api/speech</c> reports it (docs/speech.md#status).</summary>
public sealed record SpeechCell(string Provider, string Kind, string Where, string? Off, bool Located, bool? Reachable, bool? SignedIn, DateTimeOffset? LimitedUntil, string? RestKind, string? Detail, DateTimeOffset? LastOkAt, IReadOnlyList<string> Roles, bool Used, string? Problem);

public sealed record SpeechView(string? ConfigError, IReadOnlyList<SpeechCell> Providers);

/// <summary>A model a picker offers: <c>runtime/tier</c> with the model it names; greyed when <see cref="Unavailable"/> (<c>signed-out</c>, <c>offline</c>).</summary>
public sealed record ModelOption(string Value, string Runtime, string Tier, string Model, bool Agent, bool Complete, string? Unavailable);

/// <summary><c>GET /api/model/preferences</c>: the Space's default model and what it falls back to.</summary>
public sealed record ModelPreferences(string? DefaultModel, string AppDefault, string BaseDefault, IReadOnlyList<ModelOption> Options);

/// <summary>One row of an app's models (<c>GET /api/model/apps</c>): the whole app (<see cref="Tag"/> null) or one purpose, the model in force and the layer that chose it.</summary>
public sealed record AppModelRow(string? Tag, string? Manifest, string? Override, string Model, string Source);

public sealed record AppModels(string App, IReadOnlyList<AppModelRow> Rows);

public sealed record AppModelsView(IReadOnlyList<AppModels> Apps, IReadOnlyList<ModelOption> Options);

/// <summary>One agent CLI on a machine (<c>GET /api/model/inventory</c>, docs/model-machines.md#inventory).</summary>
public sealed record CliRow(string Cli, string Kind, bool Configured, IReadOnlyList<string> Runtimes, bool? Installed, bool? SignedIn, string? Version, string? Path, string? Detail, DateTimeOffset? CheckedAt);

public sealed record MachineClis(string Machine, string Via, IReadOnlyList<CliRow> Clis, bool? Reachable, bool Stale, bool Old);

/// <summary>A task's schedule: <c>manual</c>, <c>at</c>, <c>every</c> or <c>cron</c>.</summary>
public sealed record TaskSchedule(string Kind, DateTimeOffset? At, long? EveryMs, string? Expr, string? Tz);

public sealed record TaskState(DateTimeOffset? NextRunAt, DateTimeOffset? RunningAt, DateTimeOffset? LastRunAt, string? LastStatus, string? LastError, long? LastDurationMs, int ConsecutiveErrors, int? PendingEvents);

/// <summary>One scheduled task as <c>GET /api/tasks</c> shows it (docs/scheduler.md).</summary>
public sealed record TaskRow(string Id, string App, string Name, string? Description, string Source, bool Orphaned, bool Enabled, TaskSchedule Schedule, string TargetKind, IReadOnlyList<string> Triggers, bool Overridden, string? Model, TaskState State);

/// <summary>One run of a task (<c>GET /api/tasks/:id/runs</c>; its times are epoch milliseconds).</summary>
public sealed record TaskRun(long Id, DateTimeOffset StartedAt, DateTimeOffset EndedAt, string Status, string? Error, string? Output, string Trigger, int Events);

/// <summary>One event on the bus (<c>GET /api/events</c>, docs/events.md), its data shortened to one line.</summary>
public sealed record EventRow(long Id, string Name, string App, DateTimeOffset? At, string Preview, string? Peer);

/// <summary>Who got an event and where its delivery stands (<c>GET /api/events/:id</c>).</summary>
public sealed record DeliveryRow(string App, string Kind, string? Method, string? Path, string Status, int Attempts, DateTimeOffset? NextAt, string? LastError);

public sealed record ProvidedCapability(string Name, string? Description, string Method, string Path, IReadOnlyList<string> Callers, int? Calls, int? Failures);

public sealed record PublishedEvent(string Name, string? Description);

public sealed record ConsumedEvent(string Event, string Kind, string? Task, string? Method, string? Path);

/// <summary>What an app provides, publishes and consumes on the bus (<c>GET /api/capabilities</c>).</summary>
public sealed record CapabilityApp(string App, string? Peer, IReadOnlyList<ProvidedCapability> Provides, IReadOnlyList<PublishedEvent> Publishes, IReadOnlyList<ConsumedEvent> Consumes);

public sealed record UsageTotals(long Calls, long Errors, long InputTokens, long CacheWriteTokens, long CacheReadTokens, long OutputTokens, long Tokens, double CostUsd, long DurationMs)
{
    public static readonly UsageTotals Zero = new(0, 0, 0, 0, 0, 0, 0, 0, 0);
}

public sealed record UsageByTag(string App, string Tag, string Model, string? Machine, UsageTotals Totals);

public sealed record UsageByModel(string Model, string? Machine, UsageTotals Totals);

public sealed record UsageByBackend(string Backend, string Origin, UsageTotals Totals);

public sealed record UsagePeer(string Name, bool Ok, DateTimeOffset? AsOf, string? Error);

public sealed record UsageDay(string Day, UsageTotals Totals);

/// <summary><c>GET /api/model/usage?window=…</c>: the model ledger's sums (docs/model.md).</summary>
public sealed record UsageReport(string Window, string Backend, string? Space, IReadOnlyList<UsagePeer> Peers, UsageTotals Totals, IReadOnlyList<UsageByTag> ByTag, IReadOnlyList<UsageByModel> ByModel, IReadOnlyList<UsageByBackend> ByBackend, DateTimeOffset? FirstAt, UsageTotals HistoryTotals, IReadOnlyList<UsageDay> Days);

/// <summary>One model call of the ledger (<c>GET /api/model/calls</c>).</summary>
public sealed record ModelCall(long Id, string App, string Tag, string Model, string? Machine, string? ModelSource, string Backend, string Status, string? Error, DateTimeOffset? StartedAt, long DurationMs, long? Tokens, double? CostUsd, string? FallbackFrom);

/// <summary>How often an app, agent or built-in page was opened and for how long (<c>GET /api/usage</c>, docs/usage.md).</summary>
public sealed record ActivityRow(string Kind, string Key, long Opens, long? ActiveMs, long Sessions, DateTimeOffset? LastAt);

/// <summary>One device's foreground time (<c>GET /api/usage/devices</c>).</summary>
public sealed record DeviceRow(string Client, string DeviceId, long Sessions, long ActiveMs, DateTimeOffset? LastAt);

/// <summary>An installed app package (<c>GET /api/panel/package-catalogue</c>, docs/app-packages.md).</summary>
public sealed record PackageApp(string App, string Title, string Version, string? Url, bool Page, string? State, bool SourceIncluded);

public sealed record PackageRemote(string ConnectionId, string SpaceId, bool Available, IReadOnlyList<PackageApp> Apps);

public sealed record PackageCatalogue(string SpaceId, IReadOnlyList<PackageApp> Apps, IReadOnlyList<PackageRemote> Remotes);

/// <summary><c>GET /api/auth/session</c>: whether the Space keeps its own password (<c>builtin</c>) and this app is signed in to it (docs/auth.md).</summary>
public sealed record AuthState(string Mode, bool SignedIn);

/// <summary>One signed-in session of the Space's own sign-in (<c>GET /api/auth/sessions</c>).</summary>
public sealed record AuthSessionRow(string Id, DateTimeOffset? CreatedAt, DateTimeOffset? LastSeenAt, string UserAgent, bool Current);

/// <summary>
/// Fix this (随手改; docs/feedback.md, whose routes and fields still say "feedback"): the button on
/// app pages and what happens to what is sent. <see cref="Apps"/> holds only the apps with a switch
/// of their own (<c>on</c> or <c>off</c>); <see cref="Mode"/> is <c>auto</c> (Fix now) or
/// <c>later</c> (Fix later); <see cref="Machine"/> is empty for the Space's own machine.
/// </summary>
public sealed record FixThisSettings(bool Enabled, bool AppsDefault, IReadOnlyDictionary<string, string> Apps, string Mode, string Machine, string Model, string Effort, bool Errors);

/// <summary>An app with a page, and whether its pages show the button now.</summary>
public sealed record FixThisApp(string App, string Title, string? Zh, bool Enabled);

/// <summary>A peer's apps, which follow the Space's settings; whether the peer answered and took them.</summary>
public sealed record FixThisPeer(string Name, bool Ok, string Error, bool Synced, IReadOnlyList<FixThisApp> Apps);

/// <summary>A machine the Fix Engineer may run on: <see cref="Value"/> empty for the Space's own.</summary>
public sealed record FixThisMachine(string Value, string Label);

/// <summary>
/// <c>GET /api/panel/feedback/settings</c>, as the web panel's Settings reads it (src/web/FeedbackSettings.tsx):
/// <see cref="Models"/> are the models of the machine the engineer runs on, <see cref="Later"/> how
/// many requests wait to be fixed.
/// </summary>
public sealed record FixThisView(FixThisSettings Settings, IReadOnlyList<FixThisApp> Apps, IReadOnlyList<FixThisPeer> Peers, IReadOnlyList<FixThisMachine> Machines, IReadOnlyList<ModelOption> Models, int Later, string Shortcut);

/// <summary>The decoders of the Settings page's routes: each takes the route's JSON as it came.</summary>
public static class SettingsJson
{
    /// <summary>An answer that says <c>"ok": false</c> is an error, whatever its status (src/web/api.ts's <c>getJson</c>).</summary>
    public static JsonElement Ok(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False)
        {
            throw new SpaceApiException(SpaceApiFailure.Http, Str(root, "error") ?? "the Space refused");
        }
        return root;
    }

    public static SpaceIdentity Identity(JsonElement r)
    {
        if (r.ValueKind != JsonValueKind.Object || Str(r, "product") is not { } product) throw new SpaceApiException(SpaceApiFailure.InvalidResponse, "not an AI Space");
        return new SpaceIdentity(product, Int(r, "api"), Str(r, "version"), Str(r, "edition"), Str(r, "installation"), Str(r, "id"), Str(r, "name"));
    }

    public static ServicesView Services(JsonElement root)
    {
        var services = Rows(root, "services", r =>
        {
            if (Str(r, "app") is not { } app) return null;
            var supervision = Obj(r, "supervision");
            return new ServiceRow(app, Str(r, "peer"), Str(r, "title") ?? app, I18n(r), Str(r, "icon"), Int(r, "port") ?? 0, Str(r, "health") ?? "unknown", Str(r, "status") ?? "active", Bool(r, "hidden"), Str(r, "supervisor"),
                supervision is { } s ? Str(s, "action") : null, supervision is { } e ? Str(e, "error") : null);
        });
        return new ServicesView(services, Peers(root));
    }

    public static IReadOnlyList<PeerRow> Peers(JsonElement root) => Rows(root, "peers", r =>
    {
        if (Str(r, "name") is not { } name) return null;
        return new PeerRow(name, Str(r, "url") ?? "", Str(r, "health") ?? "down", Time(r, "asOf"), Str(r, "error"), Bool(r, "stale"), Int(r, "apps") ?? 0, Int(r, "agents") ?? 0, Int(r, "widgets") ?? 0, Int(r, "services") ?? 0);
    });

    public static BackupsView Backups(JsonElement root)
    {
        var rows = Rows(root, "backups", r =>
        {
            if (Str(r, "app") is not { } app) return null;
            return new BackupRow(app, Int(r, "count") ?? 0, Str(r, "lastStatus"), Str(r, "lastError"), Time(r, "lastOkAt"), Str(r, "lastOkKey"), Time(r, "lastVerifiedAt"), OptBool(r, "lastVerifyOk"), Str(r, "lastVerifyError"), Bool(r, "stale"), Bool(r, "retired"), Time(r, "nextRunAt"));
        });
        var enabled = !(root.ValueKind == JsonValueKind.Object && root.TryGetProperty("enabled", out var e) && e.ValueKind == JsonValueKind.False);
        return new BackupsView(enabled, rows);
    }

    public static ModelStatusView ModelStatus(JsonElement root)
    {
        var cells = Rows(root, "machines", r =>
        {
            if (Str(r, "runtime") is not { } runtime) return null;
            return new RuntimeCell(Str(r, "machine") ?? "", runtime, Str(r, "kind") ?? "", OptBool(r, "reachable"), OptBool(r, "installed"), OptBool(r, "signedIn"), Str(r, "version"), Str(r, "detail"), Bool(r, "probeTimedOut"), Time(r, "checkedAt"), Time(r, "limitedUntil"),
                Str(r, "restKind"), Str(r, "lastError"), Str(r, "lastErrorKind"), Time(r, "lastOkAt"), Bool(r, "used"), Str(r, "problem"));
        });
        var fallback = new List<(string, IReadOnlyList<string>)>();
        if (Obj(root, "fallback") is { } f)
        {
            foreach (var p in f.EnumerateObject())
            {
                var list = Strings(p.Value);
                if (list.Count > 0) fallback.Add((p.Name, list));
            }
        }
        var serves = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("servesPeers", out var sp) ? Strings(sp) : [];
        return new ModelStatusView(cells, fallback, serves, Int(root, "running") ?? 0, Int(root, "waiting") ?? 0, Int(root, "maxConcurrency") ?? 0);
    }

    public static SpeechView Speech(JsonElement root)
    {
        var providers = Rows(root, "providers", r =>
        {
            if (Str(r, "provider") is not { } provider) return null;
            var roles = r.TryGetProperty("roles", out var ro) ? Strings(ro) : [];
            return new SpeechCell(provider, Str(r, "kind") ?? "", Str(r, "where") ?? "", Str(r, "off"), Bool(r, "located"), OptBool(r, "reachable"), OptBool(r, "signedIn"), Time(r, "limitedUntil"), Str(r, "restKind"), Str(r, "detail"), Time(r, "lastOkAt"), roles, Bool(r, "used"), Str(r, "problem"));
        });
        return new SpeechView(Str(root, "configError"), providers);
    }

    public static IReadOnlyList<ModelOption> Options(JsonElement root, string key = "options") => Rows(root, key, r =>
    {
        if (Str(r, "value") is not { } value) return null;
        var caps = Obj(r, "capabilities");
        return new ModelOption(value, Str(r, "runtime") ?? "", Str(r, "tier") ?? "", Str(r, "model") ?? value, caps is { } a && Bool(a, "agent"), caps is { } c && Bool(c, "complete"), Str(r, "unavailable"));
    });

    public static ModelPreferences Preferences(JsonElement root) =>
        new(Str(root, "defaultModel") is { Length: > 0 } d ? d : null, Str(root, "appDefault") ?? "", Str(root, "baseDefault") ?? "", Options(root));

    public static AppModels? AppModelsOf(JsonElement a)
    {
        if (a.ValueKind != JsonValueKind.Object || Str(a, "app") is not { } app) return null;
        var rows = Rows(a, "rows", r =>
        {
            if (Str(r, "model") is not { } model) return null;
            return new AppModelRow(Str(r, "tag"), Str(r, "manifest"), Str(r, "override"), model, Str(r, "source") ?? "default");
        });
        return new AppModels(app, rows);
    }

    public static AppModelsView AppModelList(JsonElement root) => new(Rows(root, "apps", AppModelsOf), Options(root));

    public static IReadOnlyList<MachineClis> Inventory(JsonElement root) => Rows(root, "machines", m =>
    {
        if (Str(m, "machine") is not { } machine) return null;
        var via = Str(m, "via") is "ssh" or "peer" ? Str(m, "via")! : "local";
        var clis = Rows(m, "clis", c =>
        {
            if (Str(c, "cli") is not { } cli || Str(c, "kind") is not { } kind) return null;
            var runtimes = c.TryGetProperty("runtimes", out var rt) ? Strings(rt) : [];
            return new CliRow(cli, kind, Bool(c, "configured"), runtimes, OptBool(c, "installed"), OptBool(c, "signedIn"), Str(c, "version"), Str(c, "path"), Str(c, "detail"), Time(c, "checkedAt"));
        });
        return new MachineClis(machine, via, clis, OptBool(m, "reachable"), Bool(m, "stale"), Bool(m, "old"));
    });

    public static IReadOnlyList<TaskRow> Tasks(JsonElement root) => Rows(root, "tasks", r =>
    {
        if (Str(r, "id") is not { } id || Obj(r, "state") is not { } s) return null;
        var app = Str(r, "app") ?? "";
        var schedule = Obj(r, "schedule") is { } sc
            ? new TaskSchedule(Str(sc, "kind") ?? "manual", Time(sc, "at"), Long(sc, "everyMs"), Str(sc, "expr"), Str(sc, "tz"))
            : new TaskSchedule("manual", null, null, null, null);
        var triggers = Rows(r, "triggers", t => Str(t, "event") is { } e ? new Box(e) : null).Select(b => b.Value).ToList();
        var overrides = Obj(r, "overrides");
        var overridden = overrides is { } o && (o.TryGetProperty("enabled", out var oe) && oe.ValueKind is JsonValueKind.True or JsonValueKind.False || Obj(o, "schedule") is not null || Str(o, "model") is not null);
        var pending = Obj(s, "pending") is { } p ? Int(p, "events") : null;
        var state = new TaskState(Time(s, "nextRunAt"), Time(s, "runningAt"), Time(s, "lastRunAt"), Str(s, "lastStatus"), Str(s, "lastError"), Long(s, "lastDurationMs"), Int(s, "consecutiveErrors") ?? 0, pending);
        return new TaskRow(id, app, Str(r, "name") ?? id, Str(r, "description"), Str(r, "source") ?? "manifest", Bool(r, "orphaned"), Bool(r, "enabled"), schedule, Obj(r, "target") is { } tg ? Str(tg, "kind") ?? "" : "", triggers, overridden, Str(r, "model"), state);
    });

    public static IReadOnlyList<TaskRun> Runs(JsonElement root) => Rows(root, "runs", r =>
    {
        if (Long(r, "id") is not { } id || Time(r, "startedAt") is not { } started) return null;
        var events = r.TryGetProperty("eventIds", out var e) && e.ValueKind == JsonValueKind.Array ? e.GetArrayLength() : 0;
        return new TaskRun(id, started, Time(r, "endedAt") ?? started, Str(r, "status") ?? "skipped", Str(r, "error"), Str(r, "output"), Str(r, "trigger") ?? "schedule", events);
    });

    public static IReadOnlyList<EventRow> Events(JsonElement root) => Rows(root, "events", r =>
    {
        if (Long(r, "id") is not { } id || Str(r, "name") is not { } name) return null;
        var data = r.TryGetProperty("data", out var d) ? d : default;
        return new EventRow(id, name, Str(r, "app") ?? "", Time(r, "at"), SettingsRules.PreviewData(data), Str(r, "peer"));
    });

    public static IReadOnlyList<DeliveryRow> Deliveries(JsonElement root) => Rows(root, "deliveries", r =>
    {
        if (Str(r, "app") is not { } app) return null;
        return new DeliveryRow(app, Str(r, "kind") ?? "", Str(r, "method"), Str(r, "path"), Str(r, "status") ?? "pending", Int(r, "attempts") ?? 0, Time(r, "nextAt"), Str(r, "lastError"));
    });

    public static IReadOnlyList<CapabilityApp> Capabilities(JsonElement root) => Rows(root, "apps", a =>
    {
        if (Str(a, "app") is not { } app) return null;
        var stats = Rows(a, "stats", s => Str(s, "capability") is { } c ? new Stat(c, Int(s, "calls") ?? 0, Int(s, "failures") ?? 0) : null);
        var provides = Rows(a, "provides", p =>
        {
            if (Str(p, "name") is not { } name) return null;
            var callers = p.TryGetProperty("callers", out var c) ? Strings(c) : [];
            var stat = stats.FirstOrDefault(s => s.Capability == name);
            return new ProvidedCapability(name, Str(p, "description"), Str(p, "method") ?? "POST", Str(p, "path") ?? "", callers, stat?.Calls, stat?.Failures);
        });
        var publishes = Rows(a, "publishes", p => Str(p, "name") is { } name ? new PublishedEvent(name, Str(p, "description")) : null);
        var consumes = Rows(a, "consumes", c => Str(c, "event") is { } e ? new ConsumedEvent(e, Str(c, "kind") ?? "", Str(c, "task"), Str(c, "method"), Str(c, "path")) : null);
        return new CapabilityApp(app, Str(a, "peer"), provides, publishes, consumes);
    });

    public static UsageTotals Totals(JsonElement o) => o.ValueKind != JsonValueKind.Object
        ? UsageTotals.Zero
        : new UsageTotals(Long(o, "calls") ?? 0, Long(o, "errors") ?? 0, Long(o, "inputTokens") ?? 0, Long(o, "cacheWriteTokens") ?? 0, Long(o, "cacheReadTokens") ?? 0, Long(o, "outputTokens") ?? 0, Long(o, "tokens") ?? 0, Num(o, "costUsd") ?? 0, Long(o, "durationMs") ?? 0);

    public static UsageReport Usage(JsonElement root)
    {
        var peers = Rows(root, "peers", p => Str(p, "name") is { } n ? new UsagePeer(n, Bool(p, "ok"), Time(p, "asOf"), Str(p, "error")) : null);
        var byTag = Rows(root, "byTag", r => Str(r, "app") is { } app ? new UsageByTag(app, Str(r, "tag") ?? "", Str(r, "model") ?? "", NonEmpty(Str(r, "machine")), Totals(r)) : null);
        var byModel = Rows(root, "byModel", r => Str(r, "model") is { } m ? new UsageByModel(m, NonEmpty(Str(r, "machine")), Totals(r)) : null);
        var byBackend = Rows(root, "byBackend", r => Str(r, "backend") is { } b ? new UsageByBackend(b, Str(r, "origin") ?? "run", Totals(r)) : null);
        var history = Obj(root, "history");
        var days = history is { } h ? Rows(h, "days", d => Str(d, "day") is { } day ? new UsageDay(day, Totals(d)) : null) : [];
        return new UsageReport(Str(root, "window") ?? "", Str(root, "backend") ?? "", NonEmpty(Str(root, "space")), peers, root.TryGetProperty("totals", out var t) ? Totals(t) : UsageTotals.Zero, byTag, byModel, byBackend,
            history is { } hf ? Time(hf, "firstAt") : null, history is { } ht && ht.TryGetProperty("totals", out var htt) ? Totals(htt) : UsageTotals.Zero, days);
    }

    public static IReadOnlyList<ModelCall> Calls(JsonElement root) => Rows(root, "calls", c =>
    {
        if (Long(c, "id") is not { } id) return null;
        long? tokens = Obj(c, "usage") is { } u ? (Long(u, "inputTokens") ?? 0) + (Long(u, "cacheWriteTokens") ?? 0) + (Long(u, "cacheReadTokens") ?? 0) + (Long(u, "outputTokens") ?? 0) : null;
        return new ModelCall(id, Str(c, "app") ?? "", Str(c, "tag") ?? "", Str(c, "model") ?? "", NonEmpty(Str(c, "machine")), Str(c, "modelSource"), Str(c, "backend") ?? "", Str(c, "status") ?? "ok", Str(c, "error"), Time(c, "startedAt"), Long(c, "durationMs") ?? 0, tokens, Num(c, "costUsd"), Str(c, "fallbackFrom"));
    });

    public static IReadOnlyList<ActivityRow> Activity(JsonElement root) => Rows(root, "usage", r =>
    {
        if (Str(r, "kind") is not { } kind || Str(r, "key") is not { } key) return null;
        return new ActivityRow(kind, key, Long(r, "opens") ?? 0, Long(r, "activeMs"), Long(r, "sessions") ?? 0, Time(r, "lastAt"));
    });

    public static IReadOnlyList<DeviceRow> Devices(JsonElement root) => Rows(root, "devices", r =>
    {
        if (Str(r, "deviceId") is not { } id) return null;
        return new DeviceRow(Str(r, "client") ?? "", id, Long(r, "sessions") ?? 0, Long(r, "activeMs") ?? 0, Time(r, "lastAt"));
    });

    private static PackageApp? PackageAppOf(JsonElement a)
    {
        if (Str(a, "app") is not { } app) return null;
        return new PackageApp(app, Str(a, "title") is { Length: > 0 } t ? t : app, Str(a, "version") ?? "", Str(a, "url"), !(a.TryGetProperty("page", out var p) && p.ValueKind == JsonValueKind.False), Str(a, "state"), Bool(a, "sourceIncluded"));
    }

    public static PackageCatalogue Packages(JsonElement root)
    {
        var remotes = Rows(root, "remotes", r => new PackageRemote(Str(r, "connectionId") ?? "", Str(r, "spaceId") ?? "", Bool(r, "available"), Rows(r, "apps", PackageAppOf)));
        return new PackageCatalogue(Str(root, "spaceId") ?? "", Rows(root, "apps", PackageAppOf), remotes);
    }

    public static AuthState Auth(JsonElement root) => new(Str(root, "mode") ?? "external", Bool(root, "signedIn"));

    public static IReadOnlyList<AuthSessionRow> Sessions(JsonElement root) => Rows(root, "sessions", s =>
    {
        var id = s.TryGetProperty("id", out var v) ? v.ValueKind switch
        {
            JsonValueKind.Number => v.GetRawText(),
            JsonValueKind.String => v.GetString(),
            _ => null,
        } : null;
        return id is null ? null : new AuthSessionRow(id, Time(s, "createdAt"), Time(s, "lastSeenAt"), Str(s, "userAgent") ?? "", Bool(s, "current"));
    });

    /// <summary>Fix this' settings view; a field that is missing or odd reads as the Space's default (src/space/feedback/types.ts).</summary>
    public static FixThisView FixThis(JsonElement root)
    {
        var own = new Dictionary<string, string>();
        var s = Obj(root, "settings") ?? default;
        if (Obj(s, "apps") is { } map)
        {
            foreach (var p in map.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.String && p.Value.GetString() is "on" or "off") own[p.Name] = p.Value.GetString()!;
            }
        }
        var effort = Str(s, "effort") ?? "";
        var settings = new FixThisSettings(Bool(s, "enabled"), OptBool(s, "appsDefault") != false, own, Str(s, "mode") == "later" ? "later" : "auto", Str(s, "machine") ?? "",
            Str(s, "model") ?? "", SettingsRules.FixThisEfforts.Contains(effort) ? effort : "xhigh", OptBool(s, "errors") != false);
        // The machine the engineer runs on decides what it can run on: a hub's own runtimes are not a peer's.
        var models = Obj(root, "machineModels") is { } byMachine ? Options(byMachine, settings.Machine) : Options(root, "models");
        var peers = Rows(root, "peers", p => Str(p, "name") is { } name ? new FixThisPeer(name, Bool(p, "ok"), Str(p, "error") ?? "", Bool(p, "synced"), FixThisApps(p)) : null);
        var machines = Rows(root, "machines", m => new FixThisMachine(Str(m, "value") ?? "", Str(m, "label") ?? ""));
        var later = Obj(root, "counts") is { } counts ? Int(counts, "later") ?? 0 : 0;
        return new FixThisView(settings, FixThisApps(root), peers, machines, models, Math.Max(0, later), Str(root, "shortcut") ?? "Alt+Shift+F");
    }

    private static List<FixThisApp> FixThisApps(JsonElement o) => Rows(o, "apps", a => Str(a, "app") is { } app ? new FixThisApp(app, Str(a, "title") ?? app, Str(a, "zh"), Bool(a, "enabled")) : null);

    // Reading helpers: a field of the wrong type reads as missing.

    private sealed record Box(string Value);

    private sealed record Stat(string Capability, int Calls, int Failures);

    private static List<T> Rows<T>(JsonElement root, string key, Func<JsonElement, T?> map) where T : class
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(key, out var list) || list.ValueKind != JsonValueKind.Array) return [];
        var rows = new List<T>();
        foreach (var r in list.EnumerateArray())
        {
            if (r.ValueKind == JsonValueKind.Object && map(r) is { } row) rows.Add(row);
        }
        return rows;
    }

    private static List<string> Strings(JsonElement v) => v.ValueKind == JsonValueKind.Array ? v.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToList() : [];

    private static JsonElement? Obj(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    private static string? Str(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static string? NonEmpty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    private static bool Bool(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;

    private static bool? OptBool(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) ? v.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    } : null;

    private static double? Num(JsonElement o, string key) => o.ValueKind == JsonValueKind.Object && o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var d) ? d : null;

    private static long? Long(JsonElement o, string key) => Num(o, key) is { } d && !double.IsNaN(d) && Math.Abs(d) < 9e15 ? (long)Math.Round(d) : null;

    private static int? Int(JsonElement o, string key) => Long(o, key) is { } l && l is >= int.MinValue and <= int.MaxValue ? (int)l : null;

    /// <summary>A time as an ISO string or as epoch milliseconds (the backups' and runs' form).</summary>
    private static DateTimeOffset? Time(JsonElement o, string key)
    {
        if (o.ValueKind != JsonValueKind.Object || !o.TryGetProperty(key, out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var ms) && ms is > 0 and < 1e15) return DateTimeOffset.FromUnixTimeMilliseconds((long)ms);
        if (v.ValueKind == JsonValueKind.String && DateTimeOffset.TryParse(v.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t)) return t;
        return null;
    }

    private static Dictionary<string, LocalizedText>? I18n(JsonElement o)
    {
        if (Obj(o, "i18n") is not { } v) return null;
        var d = new Dictionary<string, LocalizedText>();
        foreach (var p in v.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.Object) d[p.Name] = new LocalizedText(Str(p.Value, "title"), Str(p.Value, "description"));
        }
        return d;
    }
}
