using System.Net;
using System.Text;
using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

/// <summary>The Space's Settings page: its routes' shapes (real answers of an AI Space 0.2.1) and the rules behind its rows.</summary>
public class SettingsDecodingTests
{
    private static JsonElement J(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public void TheIdentityNamesTheSpace()
    {
        var id = SettingsJson.Identity(J("""{"product":"ai-space","api":1,"version":"0.2.1","edition":"server","installation":"external","id":"44896a93-1218-4d50-90eb-b4ebacac1b0d","name":"LAPTOP-SHJ0NN82"}"""));
        Assert.Equal(new SpaceIdentity("ai-space", 1, "0.2.1", "server", "external", "44896a93-1218-4d50-90eb-b4ebacac1b0d", "LAPTOP-SHJ0NN82"), id);
        // Without the operator's view there is no id or name, and that is not an error.
        Assert.Null(SettingsJson.Identity(J("""{"product":"ai-space","api":1,"version":"0.2.1","edition":"local"}""")).Name);
        Assert.Throws<SpaceApiException>(() => SettingsJson.Identity(J("""{"hello":"world"}""")));
    }

    [Fact]
    public void AnAnswerThatSaysNotOkIsAnError()
    {
        var e = Assert.Throws<SpaceApiException>(() => SettingsJson.Ok(J("""{"ok":false,"error":"no such task"}""")));
        Assert.Equal("no such task", e.Message);
        Assert.Equal(SpaceApiFailure.Http, e.Kind);
        SettingsJson.Ok(J("""{"ok":true}"""));
    }

    [Fact]
    public void ServicesAndPeersDecode()
    {
        var v = SettingsJson.Services(J("""
            {"ok":true,"services":[
              {"app":"ai-todo","title":"Todo","i18n":{"zh":{"title":"待办"}},"icon":"/icons/todo.png","port":60766,"health":"ok","status":"active","hidden":false,"supervisor":"space","supervision":{"action":"unchanged"}},
              {"app":"notes","peer":"david","title":"Notes","port":4100,"health":"down","status":"active"},
              {"title":"no app"}, 7],
             "peers":[{"name":"david","url":"https://david.example.com","health":"down","asOf":"2026-11-22T03:00:00Z","error":"timeout","stale":true,"apps":3,"agents":2,"widgets":1,"services":4}]}
            """));
        Assert.Equal(2, v.Services.Count);
        Assert.Equal("待办", v.Services[0].DisplayTitle("zh"));
        Assert.Equal("Todo", v.Services[0].DisplayTitle("en"));
        Assert.Equal("unchanged", v.Services[0].SupervisionAction);
        Assert.Equal("david", v.Services[1].Peer);
        var p = Assert.Single(v.Peers);
        Assert.Equal(new DateTimeOffset(2026, 11, 22, 3, 0, 0, TimeSpan.Zero), p.AsOf);
        Assert.Equal(4, p.Services);
        // The real Space has none.
        Assert.Empty(SettingsJson.Services(J("""{"ok":true,"services":[],"peers":[],"supervisor":"operator","asOf":"2026-11-22T03:42:50.089Z"}""")).Services);
    }

    [Fact]
    public void BackupsDecodeTheirEpochTimes()
    {
        var off = SettingsJson.Backups(J("""{"ok":true,"enabled":false,"target":null,"maxAgeHours":48,"backups":[],"asOf":"2026-11-22T03:42:50.535Z"}"""));
        Assert.False(off.Enabled);
        Assert.Empty(off.Backups);
        var on = SettingsJson.Backups(J("""{"ok":true,"backups":[{"app":"ai-todo","count":3,"lastOkAt":1763780000000,"lastStatus":"ok","stale":false,"retired":false,"nextRunAt":1763790000000,"lastVerifiedAt":1763781000000,"lastVerifyOk":true}]}"""));
        Assert.True(on.Enabled);
        var b = Assert.Single(on.Backups);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1763780000000), b.LastOkAt);
        Assert.True(b.LastVerifyOk);
    }

    [Fact]
    public void TheModelStatusDecodes()
    {
        var s = SettingsJson.ModelStatus(J("""
            {"ok":true,"backend":"local","runtimes":[{"name":"claude","kind":"claude-code"}],"fallback":{"claude":["codex","dsh"],"empty":[]},
             "machines":[{"machine":"","runtime":"claude","kind":"claude-code","lastOkAt":"2026-11-21T14:49:09.183Z","installed":true,"signedIn":true,"version":"2.1.330","checkedAt":"2026-11-22T02:55:51.490Z","used":true}],
             "servesPeers":["david"],"maxConcurrency":4,"running":1,"waiting":0}
            """));
        var c = Assert.Single(s.Cells);
        Assert.Equal("", c.Machine);
        Assert.Equal("2.1.330", c.Version);
        Assert.True(c.Used);
        Assert.Null(c.Reachable);
        var f = Assert.Single(s.Fallback);
        Assert.Equal("claude", f.Key);
        Assert.Equal(["codex", "dsh"], f.List);
        Assert.Equal(["david"], s.ServesPeers);
        Assert.Equal(1, s.Running);
    }

    [Fact]
    public void SpeechDecodes()
    {
        var s = SettingsJson.Speech(J("""{"ok":true,"configured":true,"source":"builtin","warnings":[],"default":{"asr":"voice-studio"},"fallback":{},"voices":{},"providers":[{"provider":"voice-studio","kind":"voice-studio","capabilities":["transcribe","live","speak"],"selfHosted":true,"where":"","located":false,"reachable":false,"detail":"voice-studio: no voice-studio/transcribe on this space or its peers","roles":["asr","tts","live"],"used":true,"problem":"unreachable"}],"usage24h":{"calls":0}}"""));
        var p = Assert.Single(s.Providers);
        Assert.False(p.Located);
        Assert.Equal("unreachable", p.Problem);
        Assert.Equal(["asr", "tts", "live"], p.Roles);
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.NotFound), SettingsRules.Speech(p));
    }

    [Fact]
    public void PreferencesAndAppModelsDecode()
    {
        var p = SettingsJson.Preferences(J("""{"ok":true,"defaultModel":null,"appDefault":"sonnet","baseDefault":"sonnet","options":[{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku","capabilities":{"complete":true,"agent":true,"chat":true}},{"value":"claude/junior","runtime":"claude","tier":"junior","model":"sonnet","capabilities":{"complete":true,"agent":true,"chat":true}},{"value":"codex/advanced","runtime":"codex","tier":"advanced","model":"astra","unavailable":"signed-out"},{"runtime":"x"}]}"""));
        Assert.Null(p.DefaultModel);
        Assert.Equal("sonnet", p.AppDefault);
        Assert.Equal(3, p.Options.Count);
        Assert.True(p.Options[0].Agent);
        Assert.Equal("signed-out", p.Options[2].Unavailable);
        Assert.Equal("claude/junior", SettingsJson.Preferences(J("""{"ok":true,"defaultModel":"claude/junior","options":[]}""")).DefaultModel);

        var m = SettingsJson.AppModelList(J("""{"ok":true,"apps":[{"app":"ai-todo","rows":[{"tag":null,"model":"sonnet","source":"default"},{"tag":"chat","model":"opus","source":"override-tag","override":"claude/intermediate","manifest":"haiku"}]}],"options":[{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku"}]}"""));
        var a = Assert.Single(m.Apps);
        Assert.Null(a.Rows[0].Tag);
        Assert.Equal("chat", a.Rows[1].Tag);
        Assert.Equal("claude/intermediate", a.Rows[1].Override);
        Assert.Equal("haiku", a.Rows[1].Manifest);
        Assert.Single(m.Options);
    }

    [Fact]
    public void TheInventoryDecodes()
    {
        var m = SettingsJson.Inventory(J("""{"ok":true,"machines":[{"machine":"","via":"local","clis":[{"cli":"claude","kind":"claude-code","configured":true,"runtimes":["claude"],"installed":true,"signedIn":true,"version":"2.1.330","checkedAt":"2026-11-22T02:55:51.490Z","path":"C:\\Users\\me\\.local\\bin\\claude.exe"},{"cli":"codex","kind":"codex-cli","configured":false,"runtimes":[],"installed":false,"detail":"codex was not found on this machine","checkedAt":"2026-11-22T02:55:50.730Z"}]},{"machine":"david","via":"peer","clis":[],"stale":true}]}"""));
        Assert.Equal(2, m.Count);
        Assert.Equal(["claude"], m[0].Clis[0].Runtimes);
        Assert.Equal(new StateOf(StatusTone.Ok, StateWord.Ready), SettingsRules.Cli(m[0].Clis[0]));
        Assert.Equal(new StateOf(StatusTone.Off, StateWord.NotInstalled), SettingsRules.Cli(m[0].Clis[1]));
        Assert.Equal("peer", m[1].Via);
        Assert.True(m[1].Stale);
        Assert.Equal(DateTimeOffset.Parse("2026-11-22T02:55:51.490Z", System.Globalization.CultureInfo.InvariantCulture), SettingsRules.LastChecked(m));
    }

    private const string TaskJson = """
        {"ok":true,"tasks":[{"id":"ai-todo/digest","app":"ai-todo","name":"digest","description":"Morning digest","source":"manifest","orphaned":false,"enabled":true,
          "schedule":{"kind":"cron","expr":"0 8 * * *","tz":"Asia/Shanghai"},"target":{"kind":"agent"},"timeoutMs":600000,"triggers":[{"event":"ai-todo/done"}],
          "overrides":{"model":"claude/basic"},"model":"claude/basic","modelSelectable":true,
          "state":{"nextRunAt":"2026-11-23T00:00:00Z","lastRunAt":"2026-11-22T00:00:00Z","lastStatus":"error","lastError":"timeout","lastDurationMs":600000,"consecutiveErrors":3,"pending":{"events":2}}},
          {"id":"x/y","app":"x","name":"y","enabled":false,"schedule":{"kind":"manual"},"target":{"kind":"http"},"overrides":{},"state":{"consecutiveErrors":0}},
          {"id":"broken"}]}
        """;

    [Fact]
    public void TasksAndRunsDecode()
    {
        var tasks = SettingsJson.Tasks(J(TaskJson));
        Assert.Equal(2, tasks.Count);
        var t = tasks[0];
        Assert.Equal("cron", t.Schedule.Kind);
        Assert.Equal("Asia/Shanghai", t.Schedule.Tz);
        Assert.Equal("agent", t.TargetKind);
        Assert.Equal(["ai-todo/done"], t.Triggers);
        Assert.True(t.Overridden);
        Assert.Equal(2, t.State.PendingEvents);
        Assert.Equal(600000, t.State.LastDurationMs);
        Assert.False(tasks[1].Overridden);
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.TaskError, 3), SettingsRules.Task(t));
        Assert.Equal(new StateOf(StatusTone.Off, StateWord.TaskOff), SettingsRules.Task(tasks[1]));
        Assert.Equal((2, 1, 1), SettingsRules.TaskCounts(tasks));

        var runs = SettingsJson.Runs(J("""{"ok":true,"runs":[{"id":4,"taskId":"ai-todo/digest","startedAt":1763769600000,"endedAt":1763769660000,"status":"ok","trigger":"event","eventIds":[1,2],"output":"done"},{"id":5}]}"""));
        var r = Assert.Single(runs);
        Assert.Equal(TimeSpan.FromMinutes(1), r.EndedAt - r.StartedAt);
        Assert.Equal(2, r.Events);
        Assert.Equal(new StateOf(StatusTone.Ok, StateWord.TaskOk), SettingsRules.Run(r));
    }

    [Fact]
    public void ATaskStateFollowsItsLastOutcome()
    {
        var t = SettingsJson.Tasks(J(TaskJson))[0];
        Assert.Equal(StateWord.TaskOrphaned, SettingsRules.Task(t with { Orphaned = true }).Word);
        Assert.Equal(StateWord.TaskRunning, SettingsRules.Task(t with { State = t.State with { RunningAt = DateTimeOffset.UnixEpoch } }).Word);
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.TaskError), SettingsRules.Task(t with { State = t.State with { ConsecutiveErrors = 1 } }));
        Assert.Equal(StateWord.TaskSkipped, SettingsRules.Task(t with { State = t.State with { LastStatus = "skipped" } }).Word);
        Assert.Equal(new StateOf(StatusTone.Unknown, StateWord.TaskNeverRan), SettingsRules.Task(t with { State = t.State with { LastStatus = null } }));
    }

    [Fact]
    public void EventsDeliveriesAndTheCatalogueDecode()
    {
        var events = SettingsJson.Events(J("""{"ok":true,"events":[{"id":9,"name":"ai-todo/done","app":"ai-todo","at":"2026-11-22T01:00:00Z","data":{"id":"t1","title":"Buy milk","tags":["a"],"n":2,"extra":true}}]}"""));
        var e = Assert.Single(events);
        Assert.Equal("id: t1 · title: Buy milk · tags: [\"a\"] · n: 2", e.Preview);
        Assert.Empty(SettingsJson.Events(J("""{"ok":true,"events":[]}""")));

        var d = Assert.Single(SettingsJson.Deliveries(J("""{"ok":true,"event":{},"deliveries":[{"id":1,"eventId":9,"event":"ai-todo/done","app":"keep","kind":"http","method":"POST","path":"/hook","status":"dead","attempts":5,"lastError":"HTTP 500","createdAt":"2026-11-22T01:00:00Z"}]}""")));
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.DeliveryDead), SettingsRules.Delivery(d));

        var apps = SettingsJson.Capabilities(J("""{"ok":true,"apps":[{"app":"ai-todo","provides":[{"name":"add","description":"Add a todo","method":"POST","path":"/api/add","timeoutMs":5000,"callers":["keep"]}],"publishes":[{"name":"done"}],"consumes":[],"stats":[{"capability":"add","calls":12,"failures":1,"meanMs":30}]},{"app":"quiet","provides":[],"publishes":[],"consumes":[]}]}"""));
        Assert.Equal(2, apps.Count);
        Assert.Equal(12, apps[0].Provides[0].Calls);
        Assert.Equal(["keep"], apps[0].Provides[0].Callers);
        Assert.Equal("ai-todo", Assert.Single(SettingsRules.CatalogueApps(apps)).App);
    }

    [Fact]
    public void ALongEventPreviewIsCut()
    {
        var data = J("""{"text":"%"}""".Replace("%", new string('x', 200), StringComparison.Ordinal));
        var p = SettingsRules.PreviewData(data);
        Assert.Equal(120, p.Length);
        Assert.EndsWith("…", p, StringComparison.Ordinal);
        Assert.Equal("", SettingsRules.PreviewData(J("[1]")));
    }

    [Fact]
    public void UsageCallsAndActivityDecode()
    {
        var u = SettingsJson.Usage(J("""
            {"ok":true,"space":"LAPTOP-SHJ0NN82","window":"24h","since":"2026-11-21T03:42:53.237Z","backend":"local",
             "totals":{"calls":1,"errors":0,"inputTokens":2,"cacheWriteTokens":4341,"cacheReadTokens":0,"outputTokens":61,"tokens":4404,"costUsd":0.017978,"durationMs":6141},
             "byTag":[{"calls":1,"errors":0,"inputTokens":2,"cacheWriteTokens":4341,"cacheReadTokens":0,"outputTokens":61,"tokens":4404,"costUsd":0.017978,"durationMs":6141,"app":"ai-todo","tag":"chat","model":"sonnet","machine":""}],
             "byModel":[{"calls":1,"tokens":4404,"costUsd":0.017978,"model":"sonnet","machine":"david"}],
             "byBackend":[{"calls":1,"tokens":4404,"backend":"local","origin":"run"}],
             "history":{"firstAt":"2026-11-21T14:49:09.183Z","totals":{"calls":1,"tokens":4404},"days":[{"day":"2026-11-21","calls":1,"tokens":4404}]},
             "peers":[{"name":"david","ok":false,"error":"timeout"}]}
            """));
        Assert.Equal("LAPTOP-SHJ0NN82", u.Space);
        Assert.Equal(4404, u.Totals.Tokens);
        Assert.Equal(0.017978, u.Totals.CostUsd, 6);
        Assert.Null(Assert.Single(u.ByTag).Machine);
        Assert.Equal("david:sonnet", SettingsRules.ModelOn(u.ByModel[0].Model, u.ByModel[0].Machine));
        Assert.Equal("run", u.ByBackend[0].Origin);
        Assert.Equal(1, u.HistoryTotals.Calls);
        Assert.Single(u.Days);
        Assert.False(Assert.Single(u.Peers).Ok);

        var c = Assert.Single(SettingsJson.Calls(J("""{"ok":true,"calls":[{"id":1,"app":"ai-todo","tag":"chat","model":"sonnet","runtime":"claude","modelSource":"default","backend":"local","origin":"run","status":"ok","startedAt":"2026-11-21T14:49:09.183Z","durationMs":6141,"usage":{"inputTokens":2,"cacheWriteTokens":4341,"cacheReadTokens":0,"outputTokens":61},"costUsd":0.017978,"tries":1}]}""")));
        Assert.Equal(4404, c.Tokens);
        Assert.Null(SettingsJson.Calls(J("""{"ok":true,"calls":[{"id":2,"status":"error","error":"x"}]}"""))[0].Tokens);

        var rows = SettingsJson.Activity(J("""{"ok":true,"window":"30d","usage":[{"kind":"app","key":"ai-todo","opens":3,"activeMs":259346,"sessions":10,"lastAt":"2026-11-22T02:56:39.645Z","daily":[]},{"kind":"builtin","key":"inbox","opens":4,"activeMs":null,"sessions":0,"lastAt":"2026-11-22T03:34:00.328Z","daily":[]}]}"""));
        Assert.Equal(2, rows.Count);
        Assert.Null(rows[1].ActiveMs);
        Assert.Equal((7L, 259346L, rows[0]), SettingsRules.ActivityTotals(rows));

        var dev = Assert.Single(SettingsJson.Devices(J("""{"ok":true,"devices":[{"client":"windows","deviceId":"abcdef0123456789","sessions":2,"activeMs":1000,"lastAt":"2026-11-22T02:56:39.645Z"}]}""")));
        Assert.Equal("Windows · 23456789", SettingsRules.DeviceLabel(dev));
    }

    [Fact]
    public void PackagesAndTheAccountDecode()
    {
        var p = SettingsJson.Packages(J("""{"ok":true,"spaceId":"44896a93","apps":[{"app":"ai-todo","title":"Todo","version":"0.1.1","page":true,"state":"running","sourceIncluded":true,"url":"/_space/apps/ai-todo"},{"app":"headless","version":"1.0.0","page":false}],"remotes":[{"connectionId":"c1","spaceId":"s2","available":true,"apps":[{"app":"notes","title":"Notes","version":"2.0.0"}]}]}"""));
        Assert.Equal("44896a93", p.SpaceId);
        Assert.Equal(2, p.Apps.Count);
        Assert.Equal("headless", p.Apps[1].Title);
        Assert.False(p.Apps[1].Page);
        Assert.Equal("Notes", Assert.Single(Assert.Single(p.Remotes).Apps).Title);

        Assert.False(SettingsRules.HasAccount(SettingsJson.Auth(J("""{"ok":true,"mode":"external"}"""))));
        Assert.True(SettingsRules.HasAccount(SettingsJson.Auth(J("""{"ok":true,"mode":"builtin","initialized":true,"signedIn":true}"""))));
        Assert.False(SettingsRules.HasAccount(SettingsJson.Auth(J("""{"ok":true,"mode":"builtin","signedIn":false}"""))));
        var s = SettingsJson.Sessions(J("""{"ok":true,"sessions":[{"id":3,"createdAt":"2026-11-20T00:00:00Z","lastSeenAt":"2026-11-22T00:00:00Z","userAgent":"ai-space-windows/0.2.1","current":true},{"id":"7","userAgent":""}]}"""));
        Assert.Equal(["3", "7"], s.Select(x => x.Id));
        Assert.True(s[0].Current);
    }
}

public class SettingsRulesTests
{
    private static ServiceRow Service(string status = "active", string health = "ok", string? supervisor = "space", string? action = null, string? peer = null) =>
        new("ai-todo", peer, "Todo", null, null, 4000, health, status, false, supervisor, action, null);

    [Fact]
    public void AServiceShowsItsHealthAndWhetherTheSpaceRunsIt()
    {
        Assert.Equal((new StateOf(StatusTone.Ok, StateWord.Up), true), SettingsRules.Service(Service()));
        Assert.Equal((new StateOf(StatusTone.Down, StateWord.Down), false), SettingsRules.Service(Service(health: "down", supervisor: "operator")));
        Assert.Equal(new StateOf(StatusTone.Unknown, StateWord.Unknown), SettingsRules.Service(Service(health: "unknown")).State);
        Assert.Equal(new StateOf(StatusTone.Paused, StateWord.Paused), SettingsRules.Service(Service(status: "paused")).State);
        Assert.False(SettingsRules.Service(Service(status: "paused")).Supervised);
        Assert.Equal(new StateOf(StatusTone.Off, StateWord.Archived), SettingsRules.Service(Service(status: "archived")).State);
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.UnitProblem), SettingsRules.Service(Service(action: "conflict")).State);
        // A peer's service is only shown: its Space runs it.
        Assert.False(SettingsRules.Service(Service(peer: "david")).Supervised);
    }

    [Fact]
    public void BackupsAndPeersHaveTheirDot()
    {
        var b = new BackupRow("x", 1, "ok", null, null, null, null, null, null, false, false, null);
        Assert.Equal(new StateOf(StatusTone.Ok, StateWord.Fresh), SettingsRules.Backup(b));
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.Stale), SettingsRules.Backup(b with { Stale = true }));
        Assert.Equal(new StateOf(StatusTone.Off, StateWord.Retired), SettingsRules.Backup(b with { Stale = true, Retired = true }));
        var p = new PeerRow("david", "", "ok", null, null, false, 0, 0, 0, 0);
        Assert.Equal(StatusTone.Ok, SettingsRules.Peer(p).StatusTone);
        Assert.Equal(StatusTone.Down, SettingsRules.Peer(p with { Health = "down" }).StatusTone);
    }

    private static RuntimeCell Cell(string? problem = null) => new("", "claude", "claude-code", null, true, true, "2.1", null, false, DateTimeOffset.UnixEpoch, null, null, null, null, null, true, problem);

    [Fact]
    public void ARuntimeIsRedOnlyWhenSomethingUsesItAndItCannotAnswer()
    {
        Assert.Equal(new StateOf(StatusTone.Ok, StateWord.Ready), SettingsRules.Runtime(Cell()));
        Assert.Equal(new StateOf(StatusTone.Down, StateWord.NotSignedIn), SettingsRules.Runtime(Cell("not signed in") with { SignedIn = false }));
        Assert.Equal(new StateOf(StatusTone.Off, StateWord.NotSignedIn), SettingsRules.Runtime(Cell() with { SignedIn = false, Used = false }));
        Assert.Equal(new StateOf(StatusTone.Paused, StateWord.Limited), SettingsRules.Runtime(Cell("limited") with { LimitedUntil = DateTimeOffset.UnixEpoch }));
        Assert.Equal(StateWord.Unreachable, SettingsRules.Runtime(Cell("unreachable") with { Reachable = false }).Word);
        Assert.Equal(StateWord.Unchecked, SettingsRules.Runtime(Cell() with { CheckedAt = null }).Word);
        Assert.Equal(StateWord.ProbeTimedOut, SettingsRules.Runtime(Cell() with { ProbeTimedOut = true }).Word);
    }

    [Fact]
    public void TheOverviewCountsItsProblems()
    {
        var services = new ServicesView([Service(health: "down"), Service(), Service(status: "paused", health: "down")], [new PeerRow("d", "", "down", null, null, true, 0, 0, 0, 0)]);
        var backups = new BackupsView(true, [new BackupRow("x", 1, "ok", null, null, null, null, null, null, true, false, null), new BackupRow("y", 1, "ok", null, null, null, null, null, null, true, true, null)]);
        var models = new ModelStatusView([Cell("unreachable"), Cell()], [], [], 0, 0, 4);
        var speech = new SpeechView("bad yaml", [new SpeechCell("v", "v", "", null, false, false, null, null, null, null, null, [], true, "unreachable")]);
        Assert.Equal(1 + 1 + 1 + 1 + 1 + 1, SettingsRules.Problems(services, backups, models, speech));
        Assert.Equal(0, SettingsRules.Problems(null, null, null, null));
    }

    private static readonly ModelOption Haiku = new("claude/basic", "claude", "basic", "haiku", true, true, null);
    private static readonly ModelOption Sonnet = new("claude/junior", "claude", "junior", "sonnet", true, true, null);
    private static readonly ModelOption Astra = new("codex/advanced", "codex", "advanced", "astra", true, true, "signed-out");

    [Fact]
    public void AModelPickerKeepsASavedChoiceNoLongerOffered()
    {
        var c = SettingsRules.ModelChoices([Haiku, Sonnet], "magpie/x", withRuntime: false);
        Assert.Equal([ChoiceKind.Empty, ChoiceKind.Missing, ChoiceKind.Option, ChoiceKind.Option], c.Select(x => x.Kind));
        Assert.True(c[1].Disabled);
        Assert.False(c[2].Disabled);
        Assert.False(c[2].ShowRuntime);
        Assert.Equal(3, SettingsRules.ModelChoices([Haiku, Sonnet], "claude/basic").Count);
        Assert.Equal(3, SettingsRules.ModelChoices([Haiku, Sonnet], null).Count);
    }

    [Fact]
    public void AModelPickerGroupsByRuntimeAndGreysWhatCannotAnswer()
    {
        var c = SettingsRules.ModelChoices([Haiku, Astra, Sonnet], null, withRuntime: false);
        Assert.Equal(["", "claude/basic", "claude/junior", "codex/advanced"], c.Select(x => x.Value));
        // Two runtimes: each entry names its runtime.
        Assert.True(c[1].ShowRuntime);
        Assert.True(c[3].Disabled);
        Assert.True(SettingsRules.CanPick([Haiku, Astra], ""));
        Assert.True(SettingsRules.CanPick([Haiku, Astra], "claude/basic"));
        Assert.False(SettingsRules.CanPick([Haiku, Astra], "codex/advanced"));
        Assert.False(SettingsRules.CanPick([Haiku, Astra], "nothing/here"));
    }

    [Fact]
    public void FiguresReadAsThePanelWritesThem()
    {
        Assert.Equal("–", SettingsRules.Tokens(null));
        Assert.Equal("999", SettingsRules.Tokens(999));
        Assert.Equal("1.2K", SettingsRules.Tokens(1234));
        Assert.Equal("44K", SettingsRules.Tokens(44_040));
        Assert.Equal("1.23M", SettingsRules.Tokens(1_234_567));
        Assert.Equal("12.3M", SettingsRules.Tokens(12_345_678));
        Assert.Equal("2.69B", SettingsRules.Tokens(2_689_400_000));
        Assert.Equal("–", SettingsRules.Cost(null));
        Assert.Equal("$0.018", SettingsRules.Cost(0.017978));
        Assert.Equal("$1.50", SettingsRules.Cost(1.5));
        Assert.Equal("$123", SettingsRules.Cost(123.4));
        Assert.Equal("sonnet", SettingsRules.ModelOn("sonnet", null));
        Assert.Equal("sonnet", SettingsRules.ModelOn("sonnet", ""));
    }

    [Fact]
    public void DurationsPickTheirUnitsAsFmtDuration()
    {
        Assert.Equal((DurationUnit.Milliseconds, 640L, 0L), SettingsRules.Duration(640));
        Assert.Equal((DurationUnit.Seconds, 6L, 0L), SettingsRules.Duration(6141));
        Assert.Equal((DurationUnit.MinutesSeconds, 4L, 19L), SettingsRules.Duration(259_346));
        Assert.Equal((DurationUnit.Minutes, 10L, 0L), SettingsRules.Duration(600_000));
        Assert.Equal((DurationUnit.HoursMinutes, 1L, 30L), SettingsRules.Duration(90 * 60_000));
        Assert.Equal((DurationUnit.Hours, 2L, 0L), SettingsRules.Duration(2 * 3_600_000));
        Assert.Equal((DurationUnit.DaysHours, 1L, 2L), SettingsRules.Duration(26 * 3_600_000.0));
        Assert.Equal((DurationUnit.Days, 3L, 0L), SettingsRules.Duration(72 * 3_600_000.0));
    }

    [Fact]
    public void TimesReadAsAgoOrAhead()
    {
        var now = new DateTimeOffset(2026, 11, 22, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal((RelUnit.JustNow, 0L), SettingsRules.Relative(now.AddSeconds(-20), now));
        Assert.Equal((RelUnit.MinutesAgo, 5L), SettingsRules.Relative(now.AddMinutes(-5), now));
        Assert.Equal((RelUnit.HoursAgo, 3L), SettingsRules.Relative(now.AddHours(-3), now));
        Assert.Equal((RelUnit.DaysAgo, 2L), SettingsRules.Relative(now.AddDays(-2), now));
        Assert.Equal((RelUnit.Now, 0L), SettingsRules.Relative(now.AddSeconds(10), now));
        Assert.Equal((RelUnit.InMinutes, 15L), SettingsRules.Relative(now.AddMinutes(15), now));
        Assert.Equal((RelUnit.InHours, 5L), SettingsRules.Relative(now.AddHours(5), now));
        Assert.Equal((RelUnit.InDays, 3L), SettingsRules.Relative(now.AddDays(3), now));
    }

    [Fact]
    public void SectionsAreKeptByName()
    {
        Assert.Equal(SettingsSection.Overview, SettingsRules.Sections[0]);
        Assert.Equal(SettingsSection.ThisComputer, SettingsRules.Sections[^1]);
        foreach (var s in SettingsRules.Sections) Assert.Equal(s, SettingsRules.Parse(SettingsRules.Key(s)));
        Assert.Equal(SettingsSection.Overview, SettingsRules.Parse("general"));
        Assert.Equal(SettingsSection.Overview, SettingsRules.Parse(null));
        Assert.False(SettingsRules.IsNative(SettingsSection.Feedback));
        Assert.False(SettingsRules.IsNative(SettingsSection.Appearance));
        Assert.True(SettingsRules.IsNative(SettingsSection.Models));
        Assert.True(SettingsRules.NavCollapsed(640));
        Assert.False(SettingsRules.NavCollapsed(1280));
        Assert.False(SettingsRules.NavCollapsed(0));
    }

    [Fact]
    public void TheLastSectionIsRemembered()
    {
        var dir = Path.Combine(Path.GetTempPath(), "ai-space-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var memory = new SettingsMemory(Path.Combine(dir, "space-settings.json"));
            Assert.Equal(SettingsSection.Overview, memory.Load());
            memory.Save(SettingsSection.Tasks);
            Assert.Equal(SettingsSection.Tasks, new SettingsMemory(Path.Combine(dir, "space-settings.json")).Load());
            File.WriteAllText(Path.Combine(dir, "space-settings.json"), "not json");
            Assert.Equal(SettingsSection.Overview, memory.Load());
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void TasksGroupByAppTitle()
    {
        var titles = new Dictionary<string, string> { ["b"] = "Alpha", ["a"] = "Zulu" };
        var g = SettingsRules.ByApp(new[] { ("a", "y"), ("b", "q"), ("a", "x") }, r => r.Item1, app => titles[app], r => r.Item2);
        Assert.Equal(["Alpha", "Zulu"], g.Select(x => x.Title));
        Assert.Equal(["x", "y"], g[1].Rows.Select(r => r.Item2));
    }

    [Fact]
    public void APasswordChangeIsReadFromItsStatus()
    {
        Assert.Equal(PasswordOutcome.Changed, SettingsRules.Password(200, """{"ok":true,"revoked":2}""").Outcome);
        Assert.Equal(PasswordOutcome.WrongCurrent, SettingsRules.Password(401, """{"ok":false,"error":"wrong current password"}""").Outcome);
        Assert.Equal((PasswordOutcome.Rejected, "too short"), SettingsRules.Password(400, """{"ok":false,"error":"too short"}"""));
        Assert.Equal(PasswordOutcome.NotSignedIn, SettingsRules.Password(403, "").Outcome);
        Assert.Equal((PasswordOutcome.Failed, "HTTP 500"), SettingsRules.Password(500, "oops"));
        Assert.False(SettingsRules.CanChangePassword("", "longenough"));
        Assert.False(SettingsRules.CanChangePassword("old", "short"));
        Assert.True(SettingsRules.CanChangePassword("old", "longenough"));
    }
}

public class SettingsApiTests
{
    private static readonly Uri Base = new("https://space.example.com/");

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    [Fact]
    public async Task TheDefaultModelIsSetAndClearedWithTheSpacesOrigin()
    {
        var handler = new ScriptedHandler(_ => Json("""{"ok":true,"defaultModel":null,"appDefault":"sonnet","baseDefault":"sonnet","options":[]}"""));
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        await api.SetDefaultModel("claude/basic");
        var cleared = await api.SetDefaultModel(null);
        Assert.Equal(HttpMethod.Put, handler.Requests[0].Method);
        Assert.Equal("https://space.example.com/api/model/preferences", handler.Requests[0].RequestUri!.AbsoluteUri);
        Assert.Equal("https://space.example.com", string.Join("", handler.Requests[0].Headers.GetValues("Origin")));
        Assert.Equal("""{"defaultModel":"claude/basic"}""", handler.Bodies[0]);
        // Null must be sent, not left out: it means the environment's defaults.
        Assert.Equal("""{"defaultModel":null}""", handler.Bodies[1]);
        Assert.Equal("sonnet", cleared.AppDefault);
    }

    [Fact]
    public async Task AnAppsModelIsPatchedForTheAppOrOnePurpose()
    {
        var handler = new ScriptedHandler(_ => Json("""{"ok":true,"app":"ai-todo","rows":[{"tag":null,"model":"haiku","source":"override-app","override":"claude/basic"}]}"""));
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        var rows = await api.SetAppModel("ai-todo", null, "claude/basic");
        await api.SetAppModel("ai todo", "chat", "");
        Assert.Equal(HttpMethod.Patch, handler.Requests[0].Method);
        Assert.Equal("/api/panel/apps/ai-todo/model", handler.Requests[0].RequestUri!.AbsolutePath);
        Assert.Equal("""{"model":"claude/basic"}""", handler.Bodies[0]);
        Assert.Equal("/api/panel/apps/ai%20todo/model", handler.Requests[1].RequestUri!.AbsolutePath);
        Assert.Equal("""{"tag":"chat","model":null}""", handler.Bodies[1]);
        Assert.Equal("override-app", Assert.Single(rows!.Rows).Source);
    }

    [Fact]
    public async Task APasswordChangeIsNotTakenForASignIn()
    {
        var handler = new ScriptedHandler(_ => Json("""{"ok":false,"error":"wrong current password"}""", HttpStatusCode.Unauthorized));
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        var (outcome, message) = await api.ChangePassword("old", "newpassword");
        Assert.Equal(PasswordOutcome.WrongCurrent, outcome);
        Assert.Equal("wrong current password", message);
        Assert.Equal("""{"current":"old","next":"newpassword"}""", handler.Bodies[0]);
    }

    [Fact]
    public async Task AnOlderSpaceWithoutSpeechOrDevicesStillShowsTheRest()
    {
        var handler = new ScriptedHandler(_ => Json("""{"ok":false,"error":"not found"}""", HttpStatusCode.NotFound));
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        Assert.Null(await api.Speech());
        Assert.Null(await api.Devices("30d"));
        Assert.Empty(await api.Capabilities());
        var e = await Assert.ThrowsAsync<SpaceApiException>(() => api.Services());
        Assert.Equal("not found", e.Message);
    }

    [Fact]
    public async Task TheRoutesAreTheWebPanels()
    {
        var handler = new ScriptedHandler(_ => Json("""{"ok":true}"""));
        var api = new SpaceApi(Base, _ => Task.FromResult<string?>(null), handler);
        await api.TaskRuns("ai-todo/digest");
        await api.Activity("30d", "all");
        await api.Activity("7d", "app");
        await api.Usage("24h");
        await api.Deliveries(9);
        await api.ControlService("ai-todo", "restart");
        Assert.Equal("/api/tasks/ai-todo%2Fdigest/runs?limit=20", handler.Requests[0].RequestUri!.PathAndQuery);
        Assert.Equal("/api/usage?window=30d", handler.Requests[1].RequestUri!.PathAndQuery);
        Assert.Equal("/api/usage?window=7d&kind=app", handler.Requests[2].RequestUri!.PathAndQuery);
        Assert.Equal("/api/model/usage?window=24h", handler.Requests[3].RequestUri!.PathAndQuery);
        Assert.Equal("/api/events/9", handler.Requests[4].RequestUri!.PathAndQuery);
        Assert.Equal("/api/apps/ai-todo/service", handler.Requests[5].RequestUri!.PathAndQuery);
        Assert.Equal("""{"action":"restart"}""", handler.Bodies[5]);
    }
}
