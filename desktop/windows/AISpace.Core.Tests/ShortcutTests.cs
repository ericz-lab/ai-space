using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

public class ShortcutTests
{
    // Part of the catalogue a Space answers (GET /api/shortcuts/actions), with one action on a peer and a malformed one.
    private const string Catalogue = """
        { "ok": true, "actions": [
          { "title": "Calculator", "description": "Arithmetic", "keywords": ["calc", "math"], "effect": "read", "result": "value", "template": "calc",
            "inputs": [{ "name": "expression", "type": "text", "label": "Expression", "required": true, "query": true }],
            "i18n": { "zh": { "title": "计算器", "keywords": ["计算"], "inputs": { "expression": "算式" } } }, "id": "space/calc", "app": "space", "builtin": true, "available": true },
          { "title": "Convert currency", "keywords": ["fx"], "effect": "read", "result": "value",
            "inputs": [{ "name": "amount", "type": "number", "label": "Amount", "required": true, "default": 100 }, { "name": "from", "type": "text", "label": "From", "required": true, "default": "USD" }],
            "id": "space/convert", "app": "space", "builtin": true, "available": false, "reason": "no fx-desk/rates capability" },
          { "title": "Create todo", "keywords": ["todo"], "effect": "write", "result": "receipt", "idempotent": true,
            "inputs": [{ "name": "title", "type": "text", "label": "Title", "required": true }, { "name": "dueDate", "type": "date", "label": "Date" },
                       { "name": "list", "type": "choice", "label": "List", "options": [{ "value": "inbox", "label": "Inbox" }, "work"] }],
            "i18n": { "zh-CN": { "title": "新建待办", "options": { "inbox": "收件箱" } } }, "id": "ai-todo/create", "app": "ai-todo", "peer": "laptop", "available": true },
          { "title": "no id" }
        ] }
        """;

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    private static IReadOnlyList<ShortcutAction> Actions() => ShortcutJson.Actions(Json(Catalogue));

    [Fact]
    public void TheCatalogueDecodesAndAMalformedActionIsSkipped()
    {
        var a = Actions();
        Assert.Equal(["space/calc", "space/convert", "laptop:ai-todo/create"], a.Select(x => x.Key));
        Assert.False(a[1].Available);
        Assert.Equal("100", a[1].Inputs[0].Default);
        Assert.Equal([new ShortcutOption("inbox", "Inbox"), new ShortcutOption("work", "work")], a[2].Inputs[2].Options);
        Assert.Equal("计算器", ShortcutRules.Title(a[0], "zh"));
        Assert.Equal("算式", ShortcutRules.InputLabel(a[0], a[0].Inputs[0], "zh"));
        // A tag with a region serves its language.
        Assert.Equal("新建待办", ShortcutRules.Title(a[2], "zh"));
        Assert.Equal("收件箱", ShortcutRules.OptionLabel(a[2], a[2].Inputs[2].Options[0], "zh"));
        Assert.Equal("Create todo", ShortcutRules.Title(a[2], "en"));
    }

    [Fact]
    public void SearchFindsEveryLanguagesWordsAndLeavesOutWhatCannotRun()
    {
        var a = Actions();
        Assert.Equal(["space/calc", "laptop:ai-todo/create"], ShortcutRules.Search(a, "", "en").Select(x => x.Key));
        Assert.Empty(ShortcutRules.Search(a, "convert", "en"));
        Assert.Equal(["space/calc"], ShortcutRules.Search(a, "计算", "en").Select(x => x.Key));
        Assert.Equal(["space/calc"], ShortcutRules.Search(a, " MATH ", "en").Select(x => x.Key));
        Assert.Equal(["laptop:ai-todo/create"], ShortcutRules.Search(a, "ai-todo", "en").Select(x => x.Key));
        Assert.Empty(ShortcutRules.Search(a, "nothing like it", "en"));
    }

    [Fact]
    public void AFormOpensWithItsDefaultsAndSendsWhatIsFilled()
    {
        var todo = Actions()[2];
        var values = ShortcutRules.InitialValues(todo);
        Assert.Equal("", values["title"]);
        Assert.Equal("inbox", values["list"]);
        Assert.Equal(["title"], ShortcutRules.Missing(todo, values).Select(i => i.Name));
        values["title"] = "Write the report";
        Assert.Empty(ShortcutRules.Missing(todo, values));
        var body = ShortcutRules.RunBody(todo, values, "Asia/Shanghai", "r1");
        Assert.Equal("laptop", body["peer"]);
        Assert.Equal("""{"action":"ai-todo/create","args":{"title":"Write the report","list":"inbox"},"timezone":"Asia/Shanghai","requestId":"r1","peer":"laptop"}""",
            JsonSerializer.Serialize(body, SpaceApi.Json));
        var convert = Actions()[1];
        var amount = ShortcutRules.InitialValues(convert);
        amount["amount"] = "1,234.5";
        Assert.Equal(1234.5, ShortcutRules.Payload(convert, amount)["amount"]);
        amount["amount"] = "lots";
        Assert.Equal("lots", ShortcutRules.Payload(convert, amount)["amount"]);
    }

    [Fact]
    public void RunsDecodeWithTheirResults()
    {
        var value = ShortcutJson.Run(Json("""
            { "ok": true, "duplicate": false, "run": { "id": 7, "requestId": "r", "action": "space/calc", "title": "Calculator", "effect": "read", "args": { "expression": "128*3+56" },
              "timezone": "Asia/Shanghai", "status": "ok", "result": { "kind": "value", "value": 440, "text": "440" }, "attempts": 1, "createdAt": "2026-11-21T10:00:00.000Z" } }
            """))!;
        Assert.Equal(7, value.Id);
        Assert.Equal("440", value.Result!.Value);
        Assert.Equal("440", ShortcutRules.CopyText(value.Result));
        Assert.Equal("128*3+56", ShortcutRules.Summary(value));
        var runs = ShortcutJson.Runs(Json("""
            { "runs": [
              { "id": 9, "action": "finance-news-feed/news", "title": "News", "effect": "read", "args": {}, "status": "ok", "createdAt": "2026-11-21T10:00:00.000Z",
                "result": { "kind": "list", "items": [{ "title": "Fed holds", "url": "https://example.com/a", "at": "2026-11-21T08:00:00Z", "source": "Wire" }, { "nope": 1 }], "asOf": "2026-11-21T09:00:00Z" } },
              { "id": 10, "action": "space/run-task", "title": "Run task", "effect": "run", "args": { "task": "t1" }, "status": "running",
                "result": { "kind": "task", "taskId": "t1", "task": "daily-report", "startedAt": "2026-11-21T10:00:00Z", "runId": 4, "status": "running" } },
              { "id": 11, "action": "ai-todo/create", "title": "Create todo", "effect": "write", "args": { "title": "x" }, "status": "ok",
                "result": { "kind": "receipt", "items": [{ "id": 42, "title": "x", "url": "/apps/ai-todo/#42" }] } },
              { "action": "no id" }
            ] }
            """));
        Assert.Equal(3, runs.Count);
        Assert.Single(runs[0].Result!.Items);
        Assert.Equal("Wire", runs[0].Result!.Items[0].Source);
        Assert.NotNull(runs[0].Result!.AsOf);
        Assert.Equal("daily-report", ShortcutRules.Summary(runs[1]));
        Assert.Equal(4, runs[1].Result!.RunId);
        Assert.Equal(new ShortcutReceiptItem("42", "x", "/apps/ai-todo/#42", null), runs[2].Result!.Receipt[0]);
        Assert.Equal(TimeSpan.FromSeconds(2), ShortcutRules.RecentEvery(runs));
        Assert.Equal(TimeSpan.FromSeconds(15), ShortcutRules.RecentEvery([runs[0]]));
        Assert.Null(ShortcutRules.ActionOf(runs[2], Actions()));
    }

    [Fact]
    public void AFinishedWriteOrTaskIsNotOfferedAgainAndRetryFollowsTheProvider()
    {
        var todo = Actions()[2];
        ShortcutRun Run(string status, string effect) => new(1, todo.Id, "laptop", "", effect, [], null, status, null, null, 1, null);
        Assert.True(ShortcutRules.OffersSubmit(null, "write"));
        Assert.False(ShortcutRules.OffersSubmit(Run("ok", "write"), "write"));
        Assert.False(ShortcutRules.OffersSubmit(Run("unknown", "write"), "write"));
        Assert.True(ShortcutRules.OffersSubmit(Run("error", "write"), "write"));
        Assert.True(ShortcutRules.OffersSubmit(Run("ok", "read"), "read"));
        Assert.True(ShortcutRules.Retryable(Run("error", "write"), todo));
        Assert.False(ShortcutRules.Retryable(Run("error", "run"), null));
        Assert.True(ShortcutRules.Retryable(Run("unknown", "write"), todo));
        Assert.False(ShortcutRules.Retryable(Run("unknown", "write"), Actions()[0]));
        Assert.False(ShortcutRules.Retryable(Run("ok", "write"), todo));
        Assert.Equal(todo.Key, ShortcutRules.ActionOf(Run("ok", "write"), Actions())?.Key);
        Assert.Equal(ShortcutSubmit.Create, ShortcutRules.SubmitKind("write"));
        Assert.Equal(ShortcutSubmit.Run, ShortcutRules.SubmitKind("run"));
        Assert.Equal(ShortcutSubmit.Show, ShortcutRules.SubmitKind("read"));
        Assert.True(ShortcutRules.Zoned(todo));
        Assert.False(ShortcutRules.Zoned(Actions()[0]));
    }

    [Fact]
    public void RelativeDatesReadAsTheServerResolvesThem()
    {
        // A Saturday.
        var today = new DateOnly(2026, 11, 21);
        Assert.Equal("2026-11-22", ShortcutRules.ResolvedDate("tomorrow", today));
        Assert.Equal("2026-11-20", ShortcutRules.ResolvedDate("yesterday", today));
        Assert.Null(ShortcutRules.ResolvedDate("2026-12-01", today));
        Assert.Equal("2026-11-16 – 2026-11-22", ShortcutRules.ResolvedPeriodText("this-week", today));
        Assert.Equal("2026-11-23 – 2026-11-29", ShortcutRules.ResolvedPeriodText("next-week", today));
        Assert.Equal("2026-11-01 – 2026-11-30", ShortcutRules.ResolvedPeriodText("this-month", today));
        Assert.Equal("2026-11-15 – 2026-11-21", ShortcutRules.ResolvedPeriodText("last-7-days", today));
        Assert.Equal("2026-11-21", ShortcutRules.ResolvedPeriodText("today", today));
        Assert.Equal("2026-01-01 – 2026-01-31", ShortcutRules.ResolvedPeriodText("2026-01-01..2026-01-31", today));
        Assert.Null(ShortcutRules.ResolvedPeriodText("2026-02-01..2026-01-31", today));
        // On a Monday the week starts that day.
        Assert.Equal("2026-11-23 – 2026-11-29", ShortcutRules.ResolvedPeriodText("this-week", new DateOnly(2026, 11, 23)));
    }

    [Fact]
    public void TheZoneIsSentAsAnIanaName()
    {
        Assert.Equal("Asia/Shanghai", ShortcutRules.IanaZone(TimeZoneInfo.FindSystemTimeZoneById("China Standard Time")));
        Assert.Equal("Europe/Berlin", ShortcutRules.IanaZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Berlin")));
        Assert.Contains('/', ShortcutRules.IanaZone().Replace("UTC", "Etc/UTC", StringComparison.Ordinal));
    }

    // What POST /api/shortcuts/resolve answers for "待办 明天 写周报", with an intent of a kind this client does not know.
    private const string Resolved = """
        { "ok": true, "intents": [
          { "kind": "action", "key": "ai-todo/create", "strong": true, "args": { "title": "写周报", "dueDate": "tomorrow", "count": 2 },
            "action": { "id": "ai-todo/create", "app": "ai-todo", "title": "Create todo", "effect": "write", "available": true,
              "inputs": [{ "name": "title", "type": "text", "label": "Title", "required": true, "query": true }, { "name": "dueDate", "type": "date", "label": "Date" }],
              "i18n": { "zh": { "title": "新建待办", "inputs": { "title": "标题", "dueDate": "日期" } } } } },
          { "kind": "action", "key": "no-descriptor", "strong": true },
          { "kind": "later", "key": "x" }
        ], "agentIntents": [], "ambiguous": false }
        """;

    [Fact]
    public void AResolveAnswerDecodesAndAStrongActionTakesEnter()
    {
        var r = ShortcutJson.Resolution(Json(Resolved));
        var todo = Assert.Single(r.Intents);
        Assert.Equal("ai-todo/create", todo.Action!.Id);
        Assert.Equal("2", todo.Args["count"]);
        Assert.Same(todo, ShortcutRules.EnterIntent(r));
        var values = ShortcutRules.IntentValues(todo, todo.Action);
        Assert.Equal("写周报", values["title"]);
        Assert.Equal("tomorrow", values["dueDate"]);
        // An argument the form has no input for is not sent.
        Assert.False(values.ContainsKey("count"));
        Assert.False(ShortcutRules.RunsAtOnce(todo.Action, values));
        Assert.Equal("标题: 写周报 · 日期: 2026-11-25", ShortcutRules.IntentSummary(todo, todo.Action, "zh", new DateOnly(2026, 11, 24)));

        // A matched agent skill, an ambiguous text, a weak match or an action that cannot run leaves Enter to the box.
        Assert.Null(ShortcutRules.EnterIntent(r with { AgentIntents = 1 }));
        Assert.Null(ShortcutRules.EnterIntent(r with { Ambiguous = true }));
        Assert.Null(ShortcutRules.EnterIntent(r with { Intents = [todo with { Strong = false }] }));
        Assert.Null(ShortcutRules.EnterIntent(r with { Intents = [todo with { Action = todo.Action with { Available = false } }] }));
    }

    [Fact]
    public void ArithmeticRunsTheCataloguesCalculatorAtOnce()
    {
        var r = ShortcutJson.Resolution(Json("""{ "intents": [{ "kind": "calc", "key": "calc", "expression": "1+2*3" }] }"""));
        var calc = Assert.Single(r.Intents);
        Assert.Same(calc, ShortcutRules.EnterIntent(r));
        var action = ShortcutRules.ActionOf(calc, Actions());
        Assert.Equal("space/calc", action!.Id);
        var values = ShortcutRules.IntentValues(calc, action);
        Assert.Equal("1+2*3", values["expression"]);
        Assert.True(ShortcutRules.RunsAtOnce(action, values));
        Assert.Null(ShortcutRules.ActionOf(calc, []));
    }
}
