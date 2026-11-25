using System.Runtime.CompilerServices;
using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

/// <summary>The Mac's ChatStreamTests (desktop/macos/AISpaceTests/ChatStreamTests.swift), with the status-row rule of the web and Mac fix.</summary>
public class ChatStreamTests
{
    [Fact]
    public void ParsesTheRunStream()
    {
        var p = new SseParser();
        Assert.Null(p.Feed(": keepalive"));
        Assert.Null(p.Feed("id: 7"));
        Assert.Equal(new SseMessage(7, """{"type":"done"}"""), p.Feed("""data: {"type":"done"}"""));
        Assert.Equal(new SseMessage(null, "no-space"), p.Feed("data:no-space"));
        Assert.Null(p.Feed("event: other"));
    }

    [Fact]
    public void BuildsAReplyFromClaudeStyleEvents()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"system","subtype":"init","session_id":"s1","model":"sol"}""");
        Assert.Equal("s1", r.SessionId);
        Assert.Equal(ChatActivity.Thinking("sol"), r.Activity);
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}""");
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}""");
        Assert.Equal("Hello", r.Text);
        Assert.Null(r.Activity);
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}""");
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}""");
        Assert.Equal("Hello", r.Text);
        Assert.Equal(["Bash"], r.Tools);
        Assert.Equal(ChatActivity.Running("Bash"), r.Activity);
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}""");
        r.Apply("""{"type":"result","session_id":"s2"}""");
        r.Apply("""{"type":"done"}""");
        Assert.Equal("Hello\n\nDone.", r.Text);
        Assert.Equal("s2", r.SessionId);
        Assert.True(r.Finished);
        Assert.Null(r.Activity);
    }

    [Fact]
    public void AFinishedParagraphKeepsTheTurnVisible()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Plan:"}}}""");
        Assert.Null(r.Activity);
        // The paragraph is done but the turn goes on: the row says so until the next step.
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Plan:"}]}}""");
        Assert.Equal(ChatActivity.Thinking(), r.Activity);
        // Text and a new tool call in one message: the tool wins.
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Writing it."},{"type":"tool_use","id":"w1","name":"Write","input":{}}]}}""");
        Assert.Equal(ChatActivity.Running("Write"), r.Activity);
        r.Apply("""{"type":"done"}""");
        Assert.Null(r.Activity);
    }

    [Fact]
    public void AToolCallShowsWhileItsInputIsWritten()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"stream_event","event":{"type":"message_start","message":{}}}""");
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}""");
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Now the file."}}}""");
        Assert.Null(r.Activity);
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_stop","index":0}}""");
        Assert.Equal(ChatActivity.Thinking(), r.Activity);
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"w1","name":"Write","input":{}}}}""");
        Assert.Equal(ChatActivity.Running("Write"), r.Activity);
        // A late copy of the paragraph does not hide the call being written.
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Now the file."}]}}""");
        Assert.Equal(ChatActivity.Running("Write"), r.Activity);
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\""}}}""");
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_stop","index":1}}""");
        Assert.Equal(ChatActivity.Running("Write"), r.Activity);
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"a.md"}}]}}""");
        Assert.Equal(ChatActivity.Running("Write"), r.Activity);
        Assert.Equal("a.md", r.Steps[^1].Text);
        r.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"w1","content":"ok"}]}}""");
        Assert.Equal(ChatActivity.Thinking(), r.Activity);
    }

    [Fact]
    public void AnAnsweredApprovalResumesTheTurn()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"make"}}]}}""");
        r.Apply("""{"type":"approval_request","id":"req-1","tool":"Bash","title":"make"}""");
        r.Apply("""{"type":"approval_request","id":"req-2","tool":"Bash","title":"make test"}""");
        Assert.Null(r.Activity);
        r.Apply("""{"type":"approval_resolved","id":"req-1","decision":"allow"}""");
        // Still waiting for the other answer.
        Assert.Null(r.Activity);
        r.Apply("""{"type":"approval_resolved","id":"req-2","decision":"allow"}""");
        Assert.Equal(ChatActivity.Running("Bash"), r.Activity);
        var q = new ChatReply();
        q.Apply("""{"type":"approval_request","id":"ask","tool":"AskUserQuestion","questions":[{"id":"q","question":"Which?"}]}""");
        q.Apply("""{"type":"approval_resolved","id":"ask","decision":"allow","answers":{"q":["A"]}}""");
        Assert.Equal(ChatActivity.Thinking(), q.Activity);
    }

    [Fact]
    public void ErrorsAndStops()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"error","error":"timeout","status":"timeout"}""");
        Assert.Equal("⚠️ timeout", r.Text);
        Assert.Equal("timeout", r.Failure);
        Assert.Empty(r.Body);
        var s = new ChatReply();
        s.Apply("""{"type":"error","error":"stopped","status":"stopped"}""");
        Assert.True(s.Stopped);
        Assert.Empty(s.Text);
        Assert.Null(s.Failure);
        var junk = new ChatReply();
        junk.Apply("not json");
        Assert.Empty(junk.Steps);
        Assert.Equal(ChatActivity.Starting, junk.Activity);
    }

    [Fact]
    public void KeepsTheWrittenReplyApartFromTheFailure()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Half"}]}}""");
        r.Apply("""{"type":"error","error":"runtime exited with 1","status":"error"}""");
        Assert.Equal("Half", r.Body);
        Assert.Equal("Half\n\n⚠️ runtime exited with 1", r.Text);
        Assert.Equal("runtime exited with 1", r.Failure);
    }

    [Fact]
    public void PermissionRefusalsMatchWebToolResultsAndSurviveReplay()
    {
        var reply = new ChatReply();
        reply.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"shell","name":"Bash"},{"type":"tool_use","id":"edit","name":"Edit"}]}}""");
        const string denied = """{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"shell","is_error":true,"content":"This command requires approval"}]}}""";
        reply.Apply(denied);
        reply.Apply(denied);
        reply.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"edit","is_error":true,"content":[{"type":"text","text":"Permission denied"}]}]}}""");
        reply.Apply("""{"type":"done"}""");
        Assert.Equal(["Bash", "Edit"], reply.Denied);
        Assert.True(reply.Finished);
        Assert.Null(reply.Failure);
        Assert.Empty(reply.Body);
    }

    [Fact]
    public void OrdinaryToolErrorsAndSuccessfulPermissionTextAreNotRefusals()
    {
        var reply = new ChatReply();
        reply.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","is_error":true,"content":"File not found"},{"type":"tool_result","tool_use_id":"y","is_error":false,"content":"permission granted"}]}}""");
        Assert.Empty(reply.Denied);
        reply.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","is_error":true,"content":"permission denied"}]}}""");
        Assert.Equal(["tool"], reply.Denied);
    }

    [Fact]
    public void GrantUsesWebTiersAndNeverLowersAnExistingGrant()
    {
        Assert.Equal(ChatPermission.EditFiles, ChatPermission.ReadOnly.Granting(["Edit"]));
        Assert.Equal(ChatPermission.All, ChatPermission.ReadOnly.Granting(["Bash"]));
        Assert.Equal(ChatPermission.All, ChatPermission.EditFiles.Granting(["Edit"]));
        Assert.Equal(ChatPermission.All, ChatPermission.All.Granting(["Edit"]));
        Assert.Null(ChatPermissions.Parse("unrecognized"));
        Assert.Equal(ChatPermission.EditFiles, ChatPermissions.Parse("acceptEdits"));
    }

    [Fact]
    public void RequestCapturesPermissionAndResumesTheSameSession()
    {
        var original = new ChatTurnRequest("Check status", ChatPermission.ReadOnly, []);
        Assert.False(original.Body(null).ContainsKey("permissionMode"));
        Assert.Equal(true, original.Body(null)["interactive"]);
        Assert.False(original.Body(null).ContainsKey("model"));
        var retry = new ChatTurnRequest("Finish the refused step", ChatPermission.All, [], "codex/advanced");
        var body = retry.Body("same-session");
        Assert.Equal("bypassPermissions", body["permissionMode"]);
        Assert.Equal("same-session", body["sessionId"]);
        Assert.Equal("Finish the refused step", body["message"]);
        Assert.Equal("codex/advanced", body["model"]);
        Assert.Equal("acceptEdits", new ChatTurnRequest("edit", ChatPermission.EditFiles, []).Body(null)["permissionMode"]);
        // The read-only tier keeps its old wire value: a Space without live chat reads it as before.
        Assert.Equal("", ChatPermission.ReadOnly.Wire());
        var image = new ChatImage("a.png", "image/png", [1, 2, 3]);
        var withImage = (List<Dictionary<string, string>>)new ChatTurnRequest("", ChatPermission.ReadOnly, [image]).Body(null)["images"];
        Assert.Equal("AQID", withImage[0]["data"]);
        Assert.Equal("image/png", withImage[0]["mediaType"]);
    }

    [Fact]
    public void ReconnectsBackOffToTenSeconds()
    {
        Assert.Equal(TimeSpan.FromSeconds(2), ChatReconnect.Delay(1));
        Assert.Equal(TimeSpan.FromSeconds(8), ChatReconnect.Delay(4));
        Assert.Equal(TimeSpan.FromSeconds(10), ChatReconnect.Delay(ChatReconnect.MaxFailures));
    }

    [Fact]
    public void ApprovalsBecomeWaitingStepsAndResolve()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"approval_request","id":"req-1","tool":"Bash","title":"rm -rf build","detail":"wants to delete the build output"}""");
        var step = Assert.Single(r.Steps);
        Assert.Equal(ChatStepKind.Approval, step.Kind);
        Assert.Equal(ChatStepState.Waiting, step.State);
        Assert.Equal(("Bash", "rm -rf build", "wants to delete the build output"), (step.Title, step.Text, step.Output));
        Assert.Equal("req-1", step.RequestId);
        Assert.Null(r.Activity);
        r.Apply("""{"type":"approval_resolved","id":"req-1","decision":"allow"}""");
        Assert.Equal(ChatStepState.Allowed, r.Steps[0].State);
        r.Apply("""{"type":"approval_request","id":"req-2","tool":"Edit","title":"notes.txt"}""");
        r.Apply("""{"type":"approval_resolved","id":"req-2","decision":"deny"}""");
        Assert.Equal(ChatStepState.Denied, r.Steps[1].State);
        r.Apply("""{"type":"done"}""");
        Assert.All(r.Steps, s => Assert.NotEqual(ChatStepState.Waiting, s.State));
    }

    [Fact]
    public void AnUnansweredApprovalIsCancelledWhenTheTurnEnds()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"approval_request","id":"req-1","tool":"Bash","title":"make"}""");
        r.EndSteps();
        Assert.Equal(ChatStepState.Cancelled, r.Steps[0].State);
    }

    [Fact]
    public void SteerEventsReportTheMessagesTheAgentRead()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"steer","text":"check the logs"}""");
        Assert.Equal(["check the logs"], r.ConsumedSteers);
        Assert.Equal(ChatStepKind.Steer, r.Steps[^1].Kind);
        Assert.Equal("check the logs", r.Steps[^1].Text);
        // An image-only message replays with no text: the reply reports it without a title.
        r.Apply("""{"type":"steer","text":""}""");
        Assert.Equal(["check the logs", ""], r.ConsumedSteers);
    }

    [Fact]
    public void TellsWhyATurnFailed()
    {
        // What Seoul's codex said on 2026-10-14, and what the Space passed on.
        Assert.Equal(ChatFailureKind.Busy, ChatFailure.Classify("exceeded retry limit, last status: 429 Too Many Requests").Kind);
        Assert.Equal(new ChatFailure(ChatFailureKind.Exited, "runtime exited with 1", 1), ChatFailure.Classify("runtime exited with 1"));
        Assert.Equal("runtime exited with 137", ChatFailure.Classify("  runtime exited with 137\n").Detail);
        Assert.Equal(137, ChatFailure.Classify("runtime exited with 137").Code);
        Assert.Equal(ChatFailureKind.Busy, ChatFailure.Classify("Overloaded").Kind);
        Assert.Equal(ChatFailureKind.Busy, ChatFailure.Classify("You've hit your usage limit.").Kind);
        Assert.Equal(ChatFailureKind.SignedOut, ChatFailure.Classify("Not logged in · Please run /login").Kind);
        Assert.Equal(ChatFailureKind.TimedOut, ChatFailure.Classify("timed out after 600s").Kind);
        Assert.Equal(ChatFailureKind.Unavailable, ChatFailure.Classify("could not run Codex: spawn codex ENOENT").Kind);
        Assert.Equal(ChatFailureKind.Other, ChatFailure.Classify("something odd").Kind);
        Assert.True(ChatFailure.Classify("runtime exited with 1").Retryable && ChatFailure.Classify("429").Retryable);
        Assert.False(ChatFailure.Classify("Not logged in").Retryable || ChatFailure.Classify("could not run Codex: x").Retryable);
    }
}

/// <summary>The Mac's CodexWorkStepsTests: the work steps every runtime's events become.</summary>
public class ChatWorkStepTests
{
    [Fact]
    public void PreservesMessagesAndMatchesResultsWithoutDuplicatingSteps()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Checking the workspace."}]}}""");
        const string start = """{"type":"assistant","message":{"content":[{"type":"tool_use","id":"shell-1","name":"Bash","input":{"command":"pwd"}}]}}""";
        r.Apply(start);
        r.Apply(start);
        Assert.Equal(2, r.Steps.Count);
        Assert.Equal("pwd", r.Steps[1].Text);
        Assert.Equal(ChatStepState.Running, r.Steps[1].State);
        r.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"shell-1","is_error":false,"content":"/workspace"}]}}""");
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Workspace checked."}]}}""");
        r.Apply("""{"type":"done"}""");
        Assert.Equal([ChatStepKind.Text, ChatStepKind.Tool, ChatStepKind.Text], r.Steps.Select(s => s.Kind));
        Assert.Equal(ChatStepState.Succeeded, r.Steps[1].State);
        Assert.Equal("/workspace", r.Steps[1].Output);
        Assert.Equal("Workspace checked.", r.Steps[2].Text);
    }

    [Fact]
    public void StreamedTextBecomesOneStepThatTheFinalTextCompletes()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}""");
        r.Apply("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}""");
        Assert.Equal(ChatStepState.Running, Assert.Single(r.Steps).State);
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"text","text":"Hello."}]}}""");
        var step = Assert.Single(r.Steps);
        Assert.Equal(("Hello.", ChatStepState.Succeeded), (step.Text, step.State));
    }

    [Fact]
    public void FailedAndInterruptedWorkNeverLooksSuccessful()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash","input":{"command":"false"}},{"type":"tool_use","id":"b","name":"Edit","input":{"file_path":"notes.txt"}}]}}""");
        r.Apply("""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"a","is_error":true,"content":"command failed"}]}}""");
        r.Apply("""{"type":"error","status":"stopped"}""");
        r.Apply("""{"type":"done"}""");
        Assert.Equal(ChatStepState.Failed, r.Steps[0].State);
        Assert.Equal(ChatStepState.Incomplete, r.Steps[1].State);
        Assert.Empty(r.Denied);
    }

    [Fact]
    public void CapsLargeResultsAndKeepsParallelStepsIndependent()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Bash"},{"type":"tool_use","id":"b","name":"Bash"}]}}""");
        r.Apply(JsonSerializer.Serialize(new { type = "user", message = new { content = new[] { new { type = "tool_result", tool_use_id = "b", content = new string('x', 20000) } } } }));
        Assert.Equal(ChatStepState.Running, r.Steps[0].State);
        Assert.Equal(ChatStepState.Succeeded, r.Steps[1].State);
        Assert.Equal(12000, r.Steps[1].Output.Length);
    }

    [Fact]
    public void ToolRowsPickAKindAcrossRuntimesAndSummarizeToOneLine()
    {
        Assert.All(new[] { "Bash", "bash", "command_execution", "exec" }, n => Assert.Equal(ChatToolKind.Bash, ChatTools.KindOf(n)));
        Assert.Equal(
            [ChatToolKind.Read, ChatToolKind.Edit, ChatToolKind.Edit, ChatToolKind.Write, ChatToolKind.Search, ChatToolKind.Search, ChatToolKind.Web, ChatToolKind.Web, ChatToolKind.Code, ChatToolKind.Task, ChatToolKind.Plan],
            new[] { "Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "WebFetch", "web_search", "run_code", "Task", "TodoWrite" }.Select(ChatTools.KindOf));
        Assert.Equal(ChatToolKind.Search, ChatTools.KindOf("mcp__github__search"));
        Assert.Equal(ChatToolKind.Other, ChatTools.KindOf("mcp__github__create_issue"));
        Assert.Equal("github · create_issue", ChatTools.OtherTitle("mcp__github__create_issue"));
        Assert.Equal("git status", ChatTools.Summary("\n  \n  git status\n  git diff"));
        Assert.Equal("", ChatTools.Summary(""));
    }

    [Fact]
    public void ConsecutiveToolCallsStackAsOneGroup()
    {
        ChatStep S(string id, ChatStepKind k) => new(id, k);
        var steps = new[] { S("a", ChatStepKind.Text), S("b", ChatStepKind.Tool), S("c", ChatStepKind.Tool), S("d", ChatStepKind.Text), S("e", ChatStepKind.Tool) };
        var groups = ChatTools.Groups(steps);
        Assert.Equal([["a"], ["b", "c"], ["d"], ["e"]], groups.Select(g => g.Select(s => s.Id).ToArray()));
    }

    [Fact]
    public void AFoldedRunNamesCommandsOnlyWhenEveryCallInItIsOne()
    {
        IReadOnlyList<ChatStep> Run(params string[] names) => names.Select((n, i) => new ChatStep($"{i}", ChatStepKind.Tool) { Title = n }).ToList();
        Assert.True(ChatTools.AllCommands(Run("Bash", "exec_command", "run_command")));
        Assert.False(ChatTools.AllCommands(Run("Bash", "Read")));
        Assert.False(ChatTools.AllCommands(Run("Read")));
        Assert.False(ChatTools.AllCommands([]));
        Assert.False(ChatTools.AllCommands([new ChatStep("t", ChatStepKind.Text) { Title = "Bash" }]));
    }

    [Fact]
    public void AnAgentsQuestionKeepsItsOptionsAndOnceAnsweredTheAnswers()
    {
        var r = new ChatReply();
        r.Apply("""{"type":"approval_request","id":"q1","tool":"AskUserQuestion","title":"Which one?","questions":[{"id":"pick","header":"Asset","question":"Which one?","options":[{"label":"Contract","description":"the signed one"},{"label":"Draft"}],"multiSelect":false}]}""");
        var step = Assert.Single(r.Steps);
        Assert.Equal((ChatStepKind.Approval, ChatStepState.Waiting), (step.Kind, step.State));
        var q = Assert.Single(step.Questions);
        Assert.Equal(("pick", "Asset", "Which one?", false), (q.Id, q.Header, q.Question, q.MultiSelect));
        Assert.Equal([new ChatQuestionOption("Contract", "the signed one"), new ChatQuestionOption("Draft")], q.Options);
        r.Apply("""{"type":"approval_resolved","id":"q1","decision":"allow","answers":{"pick":["Contract"]}}""");
        Assert.Equal(ChatStepState.Allowed, r.Steps[0].State);
        Assert.Equal(["Contract"], r.Steps[0].Answers["pick"]);
        var plain = new ChatReply();
        plain.Apply("""{"type":"approval_request","id":"a1","tool":"Bash","title":"rm x"}""");
        Assert.Empty(plain.Steps[0].Questions);
    }

    [Fact]
    public void AQuestionsAnswerIsTheTypedTextOrThePickedOptions()
    {
        var one = new ChatQuestion("q", "", "?", [new("A"), new("B")], false);
        Assert.Equal(["A"], one.Answer(["A"], ""));
        Assert.Equal(["mine"], one.Answer(["A"], "  mine "));
        Assert.Empty(one.Answer([], " "));
        var many = one with { MultiSelect = true };
        Assert.Equal(["A", "B", "C"], many.Answer(["A", "B"], "C"));
    }

    [Fact]
    public void ARestoredTranscriptsStepsDrawAsFinishedTextAndToolRowsInOrder()
    {
        const string json = """{"messages":[{"role":"user","text":"hi"},{"role":"ai","text":"Checking.","tools":[{"name":"Bash","hint":"ls"}],"steps":[{"kind":"text","text":"Checking."},{"kind":"tool","name":"Bash","input":"ls","output":"a","failed":false},{"kind":"tool","name":"Bash","input":"false","output":"","failed":true}]},{"role":"ai","text":"old","tools":[]}]}""";
        var messages = ChatHistoryMessage.Decode(JsonDocument.Parse(json).RootElement);
        Assert.Equal(3, messages.Count);
        Assert.True(messages[0].IsUser);
        Assert.Empty(messages[0].Steps);
        Assert.Equal([("", "Checking.", ""), ("Bash", "ls", "a"), ("Bash", "false", "")], messages[1].Steps.Select(s => (s.Title, s.Text, s.Output)));
        Assert.Equal([ChatStepKind.Text, ChatStepKind.Tool, ChatStepKind.Tool], messages[1].Steps.Select(s => s.Kind));
        Assert.Equal([ChatStepState.Succeeded, ChatStepState.Succeeded, ChatStepState.Failed], messages[1].Steps.Select(s => s.State));
        Assert.Equal(["Bash"], messages[1].Tools);
        Assert.Empty(messages[2].Steps);
    }

    [Fact]
    public void PicturesAreKnownByTheirBytesAndKeptWithinTheSpacesLimits()
    {
        Assert.Equal("image/png", ChatImage.TypeOf(new byte[] { 0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10 }));
        Assert.Equal("image/jpeg", ChatImage.TypeOf(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0 }));
        Assert.Equal("image/gif", ChatImage.TypeOf("GIF89a"u8));
        Assert.Equal("image/webp", ChatImage.TypeOf("RIFF\0\0\0\0WEBPVP8 "u8));
        Assert.Null(ChatImage.TypeOf("BM\0\0"u8));
        ChatImage Of(int size) => new("x.png", "image/png", new byte[size]);
        Assert.True(ChatImage.Validate([Of(10), Of(10), Of(10), Of(10)]));
        Assert.False(ChatImage.Validate([Of(10), Of(10), Of(10), Of(10), Of(10)]));
        Assert.False(ChatImage.Validate([Of(ChatImage.MaxBytes + 1)]));
        Assert.False(ChatImage.Validate([Of(ChatImage.MaxBytes), Of(ChatImage.MaxBytes), Of(1)]));
        Assert.False(ChatImage.Validate([Of(0)]));
    }
}

public class ChatModelTests
{
    private static readonly ChatModelWords Words = new("default model", "no longer offered", t => t, u => u, m => m);

    private static AgentInfo Agent(string app, string name, IReadOnlyList<ChatModelChoice>? options = null, string? runtime = null) =>
        new($"{app}/{name}", app, name, name, null, null, null, null, false) { ModelOptions = options, Runtime = runtime };

    [Fact]
    public void AgentsListTheirModelsAndPeersAgentsGoThroughThePeer()
    {
        const string json = """{"agents":[{"id":"todo/planner","app":"todo","name":"planner","title":"Planner","runtime":"codex","modelOptions":[{"value":"codex/advanced","runtime":"codex","tier":"advanced","model":"astra"},{"value":"claude/basic","runtime":"claude","tier":"basic","model":"haiku","unavailable":"signed-out"}]},{"id":"mac/news/reader","app":"news","name":"reader","title":"Reader","peer":"mac"}]}""";
        var agents = SpaceJson.Agents(JsonDocument.Parse(json).RootElement);
        Assert.Equal("codex", agents[0].Runtime);
        Assert.Equal(2, agents[0].ModelOptions!.Count);
        Assert.Equal("signed-out", agents[0].ModelOptions![1].Unavailable);
        Assert.Null(agents[1].ModelOptions);
        Assert.Equal("/api/agents/todo/planner", ChatAgents.Base(agents[0]));
        Assert.Equal("/api/peers/mac/agents/news/reader", ChatAgents.Base(agents[1]));
        Assert.Equal("news/reader", ChatAgents.LocalId(agents[1]));
        Assert.True(ChatAgents.PicksRuntime(agents[0]));
        Assert.False(ChatAgents.PicksRuntime(agents[1]));
        Assert.True(ChatAgents.PicksRuntime(Agent("space", "assistant")));
    }

    [Fact]
    public void ThePickerOffersTheDefaultTheChoicesAndASavedOneNoLongerOffered()
    {
        var options = new[] { new ChatModelChoice("codex/advanced", "codex", "advanced", "astra"), new ChatModelChoice("claude/basic", "claude", "basic", "haiku", "offline") };
        var entries = ChatAgents.Entries(Agent("todo", "planner", options, "codex"), "", Words);
        Assert.Equal(["", "codex/advanced", "claude/basic"], entries.Select(e => e.Value));
        Assert.Equal("default model · codex", entries[0].Label);
        Assert.Equal("codex · advanced · astra", entries[1].Label);
        Assert.False(entries[2].Enabled);
        var saved = ChatAgents.Entries(Agent("todo", "planner", options), "old/x", Words);
        Assert.Equal("old/x (no longer offered)", saved[1].Label);
        // Without choices of its own: the Claude words.
        Assert.Equal(["", "haiku", "sonnet", "opus", "fable"], ChatAgents.Entries(Agent("a", "b"), "", Words).Select(e => e.Value));
    }

    [Fact]
    public void AStoredSessionKeepsTheModelItRanOn()
    {
        var options = new[] { new ChatModelChoice("codex/advanced", "codex", "advanced", "astra") };
        var agent = Agent("todo", "planner", options, "codex");
        Assert.Equal("codex/advanced", ChatAgents.SessionChoice(agent, new ChatSession("s", "", 0, "codex", "astra")));
        Assert.Equal("claude/opus-4", ChatAgents.SessionChoice(agent, new ChatSession("s", "", 0, "claude", "opus-4")));
        Assert.Equal("", ChatAgents.SessionChoice(agent, new ChatSession("s", "", 0)));
        Assert.Equal("", ChatAgents.SessionChoice(Agent("a", "b"), new ChatSession("s", "", 0, "claude", "opus")));
    }

    [Fact]
    public void RunsAndSessionsDecode()
    {
        var runs = SpaceJson.Runs(JsonDocument.Parse("""{"runs":[{"id":"r1","agent":"todo/planner","message":"hi","status":"running","sessionId":"s1","sid":null}]}""").RootElement);
        Assert.Equal("s1", Assert.Single(runs).SessionId);
        var sessions = ChatSession.Decode(JsonDocument.Parse("""{"sessions":[{"sid":"a","title":"First","ts":1700000000000,"runtime":"codex","model":"astra"},{"title":"no sid"}]}""").RootElement);
        Assert.Equal(new ChatSession("a", "First", 1700000000000, "codex", "astra"), Assert.Single(sessions));
    }
}

public class ChatCardTests
{
    private const string Receipt = """{"v":1,"kind":"receipt","title":"Added 2 todos","items":[{"id":128,"title":"Write the report","detail":"tomorrow 15:00 · high","url":"https://todo.example.com/?t=128","version":1,"when":"Thu 08:00","tags":[{"text":"work","tone":"accent"},{"text":"x","tone":"odd"}]},{"id":"129","title":"Call Ann","url":"javascript:alert(1)"}],"state":"card-state","actions":{"undo":"card-undo"},"style":"agenda"}""";

    private static JsonElement J(string s) => JsonDocument.Parse(s).RootElement.Clone();

    [Fact]
    public void ACardDecodesLenientlyAndKeepsItsIndexAndToken()
    {
        var ev = J($$"""{"type":"cards","token":"tok","cards":[{"v":2,"kind":"receipt","items":[]},{{Receipt}},{"v":1,"kind":"value","text":"42"}]}""");
        var cards = ChatCards.Event(ev);
        Assert.Equal([1, 2], cards.Select(c => c.Index));
        Assert.All(cards, c => Assert.Equal("tok", c.Token));
        var card = cards[0].Card;
        Assert.Equal(("receipt", "Added 2 todos", "card-state", "card-undo"), (card.Kind, card.Title, card.State, card.Undo));
        Assert.Equal("128", card.Items[0].Id);
        Assert.Equal("https://todo.example.com/?t=128", card.Items[0].Url);
        Assert.Null(card.Items[1].Url);
        Assert.Equal([new ChatCardTag("work", "accent"), new ChatCardTag("x", "neutral")], card.Items[0].Tags);
        Assert.Equal("42", cards[1].Card.ValueText);
        // A list card has no undo, even when it names one.
        Assert.Null(ChatCards.Card(J("""{"v":1,"kind":"list","items":[{"id":"1","title":"a"}],"actions":{"undo":"x"}}"""))!.Undo);
        // Restored cards come without a token.
        Assert.Null(ChatCards.Decode(J($"[{Receipt}]"))[0].Token);
    }

    [Fact]
    public void UndoIsOfferedOnlyOnTheLatestLiveReplyAndForItemsStillOpen()
    {
        var shown = new ChatShownCard(ChatCards.Decode(J($"[{Receipt}]"), "tok")[0]);
        Assert.True(ChatCards.CanUndo(shown, actionable: true));
        Assert.False(ChatCards.CanUndo(shown, actionable: false));
        Assert.Equal(["128", "129"], ChatCards.OpenIds(shown, true));
        shown.Merge(ChatCards.States(J("""[{"id":"128","status":"removed"},{"id":129,"status":"active","changed":true,"title":"Call Ann at 5"}]""")));
        Assert.Empty(ChatCards.OpenIds(shown, true));
        var removed = ChatCards.Shown(shown.Received.Card.Items[0], shown.States["128"]);
        Assert.Equal(("Write the report", "undone", null, null), (removed.Title, removed.Pill, removed.Url, removed.When));
        Assert.Empty(removed.Detail);
        var changed = ChatCards.Shown(shown.Received.Card.Items[1], shown.States["129"]);
        Assert.Equal(("Call Ann at 5", "changed"), (changed.Title, changed.Pill));
        var plain = ChatCards.Shown(shown.Received.Card.Items[0], null);
        Assert.Equal(["tomorrow 15:00", "high"], plain.Detail);
        shown.ReadOnly = true;
        Assert.False(ChatCards.CanUndo(shown, true));
        var restored = new ChatShownCard(ChatCards.Decode(J($"[{Receipt}]"))[0]);
        Assert.False(ChatCards.CanUndo(restored, true));
    }

    [Fact]
    public void TheCardRoutesAndAnswersAreTheWebPanels()
    {
        Assert.Equal("/api/agents/cards", ChatCards.Base("/api/agents/todo/planner"));
        Assert.Equal("/api/peers/mac/agents/cards", ChatCards.Base("/api/peers/mac/agents/todo/planner"));
        Assert.Equal(ChatCardOutcomeKind.ReadOnly, ChatCards.Outcome(409, """{"ok":false,"readOnly":true}""").Kind);
        Assert.Equal(new ChatCardOutcome(ChatCardOutcomeKind.Error, [], "no such action"), ChatCards.Outcome(400, """{"error":"no such action"}""") with { Items = [] });
        Assert.Equal("HTTP 502", ChatCards.Outcome(502, "bad gateway").Note);
        var ok = ChatCards.Outcome(200, """{"ok":true,"items":[{"id":"1","status":"removed"},{"id":"2","status":"weird"}]}""");
        Assert.Equal(ChatCardOutcomeKind.Ok, ok.Kind);
        Assert.Equal("1", Assert.Single(ok.Items).Id);
        Assert.Empty(ChatCards.StateItems(J("""{"ok":false,"items":[{"id":"1","status":"done"}]}""")));
        var body = JsonSerializer.Serialize(ChatCards.ActionBody("tok", 2, ["1"]));
        Assert.Equal("""{"token":"tok","card":2,"action":"undo","items":["1"]}""", body);
        Assert.True(ChatCards.Actionable([true, false, false], 1));
        Assert.False(ChatCards.Actionable([false, true, false], 0));
    }
}

public class ChatMarkdownTests
{
    [Fact]
    public void BlocksFollowTheLinuxClientsReading()
    {
        var blocks = ChatMarkdown.Blocks("# Title\n\nSome **bold** and *it* text.\n\n- one\n  wrapped\n1. first\n\n```ts\nconst x = 1;\n```\n> quoted\n---\n| a | bb |\n|---|---|\n| 1 | 2 |");
        Assert.Equal([MdBlockKind.Heading, MdBlockKind.Paragraph, MdBlockKind.Item, MdBlockKind.Item, MdBlockKind.Code, MdBlockKind.Quote, MdBlockKind.Rule, MdBlockKind.Table], blocks.Select(b => b.Kind));
        Assert.Equal(1, blocks[0].Level);
        Assert.Equal([new MdSpan("Some "), new MdSpan("bold", Bold: true), new MdSpan(" and "), new MdSpan("it", Italic: true), new MdSpan(" text.")], blocks[1].Spans);
        Assert.Equal(("•", "one\nwrapped"), (blocks[2].Bullet, string.Concat(blocks[2].Spans.Select(s => s.Text))));
        Assert.Equal("1.", blocks[3].Bullet);
        Assert.Equal("const x = 1;", blocks[4].Text);
        Assert.Equal("a  bb\n─  ──\n1  2", blocks[7].Text);
    }

    [Fact]
    public void LinksAreHttpOnlyAndCodeIsLeftAsWritten()
    {
        var spans = ChatMarkdown.Inline("See [docs](https://x.dev/a) or https://y.dev/b. Run `a **b**` not [x](javascript:1).");
        Assert.Contains(new MdSpan("docs", Link: "https://x.dev/a"), spans);
        Assert.Contains(new MdSpan("https://y.dev/b", Link: "https://y.dev/b"), spans);
        Assert.Contains(new MdSpan("a **b**", Code: true), spans);
        Assert.DoesNotContain(spans, s => s.Link?.StartsWith("javascript", StringComparison.Ordinal) == true);
        // Half-streamed markup stays as text.
        Assert.Equal([new MdSpan("a **b")], ChatMarkdown.Inline("a **b"));
    }
}

/// <summary>The conversation against a stand-in Space: sending, steering, queueing, reconnecting, stopping, retrying.</summary>
public class ChatConversationTests
{
    private sealed class FakeApi : IChatApi
    {
        public readonly List<(string Method, string Path, object? Body)> Calls = [];
        /// <summary>What each event stream answers, in order: its run id and its events (null data ends it with a broken connection).</summary>
        public readonly Queue<(string? RunId, string?[] Events)> Streams = new();
        public Func<string, object, Exception?> PostFails = (_, _) => null;
        public JsonElement GetAnswer;

        /// <summary>When set, a stream opens only once the test lets it.</summary>
        public TaskCompletionSource? Opening;

        public async Task<ChatEvents> ChatEvents(HttpMethod method, string path, object? body, CancellationToken ct)
        {
            Calls.Add((method.Method, path, body));
            if (Opening is { } gate) await gate.Task;
            if (Streams.Count == 0) throw new SpaceApiException(SpaceApiFailure.Network, "offline");
            var (run, events) = Streams.Dequeue();
            return new ChatEvents(run, Read(events));
        }

        /// <summary>Events are numbered across streams, as one run numbers them; "n|data" replays event n.</summary>
        private int _seq;

        private async IAsyncEnumerable<SseMessage> Read(string?[] events, [EnumeratorCancellation] CancellationToken ct = default)
        {
            foreach (var e in events)
            {
                await Task.CompletedTask;
                if (e is null) throw new IOException("connection reset");
                var at = e.IndexOf('|');
                if (at > 0 && int.TryParse(e[..at], out var n)) yield return new SseMessage(n, e[(at + 1)..]);
                else yield return new SseMessage(++_seq, e);
            }
        }

        public Task ChatPost(string path, object body, CancellationToken ct)
        {
            Calls.Add(("POST", path, body));
            return PostFails(path, body) is { } e ? Task.FromException(e) : Task.CompletedTask;
        }

        public Task<JsonElement> ChatGet(string path, CancellationToken ct)
        {
            Calls.Add(("GET", path, null));
            return Task.FromResult(GetAnswer);
        }

        public Task<(int Status, string Body)> ChatAnswer(string path, object body, CancellationToken ct)
        {
            Calls.Add(("POST", path, body));
            return Task.FromResult((200, """{"ok":true,"items":[]}"""));
        }
    }

    private static ChatConversation Make(FakeApi api) => new("todo/planner", "/api/agents/todo/planner", local: true, api, sleep: (_, _) => Task.CompletedTask);

    private static async Task Until(Func<bool> done)
    {
        for (var i = 0; i < 500 && !done(); i++) await Task.Delay(5);
        Assert.True(done());
    }

    [Fact]
    public async Task ATurnIsSentWithItsControlsAndItsReplyFillsIn()
    {
        var api = new FakeApi();
        api.Streams.Enqueue(("run-1", ["""{"type":"system","subtype":"init","session_id":"s1"}""", """{"type":"assistant","message":{"content":[{"type":"text","text":"Hi."}]}}""", """{"type":"done"}"""]));
        var chat = Make(api);
        chat.Permission = () => ChatPermission.EditFiles;
        chat.Model = () => "codex/advanced";
        var ended = 0;
        chat.TurnEnded += () => ended++;
        chat.Send("  hello  ");
        await Until(() => !chat.Busy);
        Assert.Equal(["hello", "Hi."], chat.Messages.Select(m => m.Text));
        Assert.Equal("s1", chat.SessionId);
        Assert.Contains("run-1", chat.RunIds);
        Assert.Null(chat.RunId);
        Assert.False(chat.Messages[1].Live);
        Assert.Null(chat.Messages[1].Activity);
        Assert.Equal(1, ended);
        var body = (Dictionary<string, object>)api.Calls[0].Body!;
        Assert.Equal(("POST", "/api/agents/todo/planner/chat"), (api.Calls[0].Method, api.Calls[0].Path));
        Assert.Equal(("hello", "acceptEdits", "codex/advanced"), (body["message"], body["permissionMode"], body["model"]));
        // The next turn continues the session.
        api.Streams.Enqueue(("run-2", ["""{"type":"done"}"""]));
        chat.Send("again");
        await Until(() => !chat.Busy);
        Assert.Equal("s1", ((Dictionary<string, object>)api.Calls[^1].Body!)["sessionId"]);
    }

    [Fact]
    public async Task ADroppedStreamReattachesAfterTheLastEventItSaw()
    {
        var api = new FakeApi();
        api.Streams.Enqueue(("run-1", ["1|{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Part one.\"}]}}", null]));
        api.Streams.Enqueue((null, ["1|{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Part one.\"}]}}", "2|{\"type\":\"done\"}"]));
        var chat = Make(api);
        chat.Send("go");
        await Until(() => !chat.Busy);
        Assert.Equal(("GET", "/api/agents/todo/planner/runs/run-1/events?after=1"), (api.Calls[1].Method, api.Calls[1].Path));
        // The replayed event is skipped, so the paragraph shows once.
        Assert.Equal("Part one.", chat.Messages[1].Text);
        Assert.Null(chat.Messages[1].Failure);
    }

    [Fact]
    public async Task ATurnThatNeverStartedFailsWithTheSpacesReason()
    {
        var api = new FakeApi();
        var chat = Make(api);
        chat.Send("go");
        await Until(() => !chat.Busy);
        Assert.Equal(ChatFailureKind.Connection, chat.Messages[1].Failure!.Kind);
        Assert.Equal("go", chat.RetryableMessage);
        api.Streams.Enqueue(("run-2", ["""{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}""", """{"type":"done"}"""]));
        chat.Retry();
        await Until(() => !chat.Busy);
        Assert.Equal(["go", "ok"], chat.Messages.Select(m => m.Text));
        Assert.Null(chat.RetryableMessage);
    }

    [Fact]
    public async Task AMessageWrittenWhileATurnRunsJoinsItOrWaitsForTheNext()
    {
        var api = new FakeApi();
        var gate = new TaskCompletionSource();
        var chat = Make(api);
        api.Streams.Enqueue(("run-1", ["""{"type":"system","subtype":"init","session_id":"s1"}"""]));
        // The first stream ends without `done`, then the reattach waits for the test.
        var sleeps = 0;
        chat = new ChatConversation("todo/planner", "/api/agents/todo/planner", true, api, sleep: async (_, _) =>
        {
            sleeps++;
            await gate.Task;
        });
        chat.Send("first");
        await Until(() => chat.RunId == "run-1" && sleeps == 1);
        chat.Send("also this");
        await Until(() => api.Calls.Any(c => c.Path.EndsWith("/steer", StringComparison.Ordinal)));
        Assert.Equal(["also this"], chat.Messages[^1].Pending);
        // The steer is refused: the message waits for its own turn, right after it.
        api.PostFails = (path, _) => path.EndsWith("/steer", StringComparison.Ordinal) ? new SpaceApiException(SpaceApiFailure.Http, "no live chat", 409) : null;
        chat.Send("and this");
        await Until(() => chat.Messages.Count == 3);
        Assert.Equal(ChatRole.User, chat.Messages[^1].Role);
        api.Streams.Enqueue((null, ["""{"type":"steer","text":"also this"}""", """{"type":"done"}"""]));
        api.Streams.Enqueue(("run-2", ["""{"type":"assistant","message":{"content":[{"type":"text","text":"second reply"}]}}""", """{"type":"done"}"""]));
        gate.SetResult();
        await Until(() => !chat.Busy);
        Assert.Equal(["first", "", "and this", "second reply"], chat.Messages.Select(m => m.Text));
        Assert.Empty(chat.Messages[1].Pending);
        Assert.Contains(chat.Messages[1].Steps, s => s.Kind == ChatStepKind.Steer && s.Text == "also this");
    }

    [Fact]
    public async Task StopBeforeTheRunIsNamedIsSentOnceItIs()
    {
        var api = new FakeApi();
        var chat = Make(api);
        api.Opening = new TaskCompletionSource();
        api.Streams.Enqueue(("run-9", ["""{"type":"error","status":"stopped"}""", """{"type":"done"}"""]));
        chat.Send("long job");
        Assert.True(chat.Busy);
        chat.Stop();
        Assert.DoesNotContain(api.Calls, c => c.Path.EndsWith("/stop", StringComparison.Ordinal));
        api.Opening.SetResult();
        await Until(() => !chat.Busy);
        Assert.Contains(api.Calls, c => c.Path == "/api/agents/todo/planner/runs/run-9/stop");
        Assert.True(chat.Messages[1].Stopped);
        Assert.EndsWith("(stopped)", chat.Messages[1].Text, StringComparison.Ordinal);
        Assert.Null(chat.Messages[1].Failure);
    }

    [Fact]
    public async Task ARunningTurnOfTheAgentIsFollowedOnce()
    {
        var api = new FakeApi();
        var chat = Make(api);
        api.Streams.Enqueue((null, ["""{"type":"done"}"""]));
        var runs = new[] { new ChatRun("r1", "todo/planner", "from the web", "running"), new ChatRun("r2", "other/agent", "x", "running") };
        chat.AttachRunning(runs);
        await Until(() => !chat.Busy);
        Assert.Equal("/api/agents/todo/planner/runs/r1/events?after=0", api.Calls[0].Path);
        Assert.Equal("from the web", chat.Messages[0].Text);
        chat.AttachRunning(runs);
        Assert.Single(api.Calls);
    }

    [Fact]
    public async Task ApprovalsAndGrantsGoToTheRunningTurn()
    {
        var api = new FakeApi();
        var gate = new TaskCompletionSource();
        var chat = new ChatConversation("todo/planner", "/api/agents/todo/planner", true, api, sleep: async (_, _) => await gate.Task);
        Assert.NotNull(await chat.Answer("req", allow: true));
        api.Streams.Enqueue(("run-1", ["""{"type":"approval_request","id":"req-1","tool":"Bash","title":"make"}"""]));
        chat.Send("build");
        await Until(() => chat.Messages[^1].Steps.Count == 1);
        Assert.Null(await chat.Answer("req-1", allow: true, new Dictionary<string, IReadOnlyList<string>> { ["q"] = ["A"] }));
        var (_, path, body) = api.Calls[^1];
        Assert.Equal("/api/agents/todo/planner/runs/run-1/approvals/req-1", path);
        Assert.Equal("allow", ((Dictionary<string, object>)body!)["decision"]);
        api.Streams.Enqueue((null, ["""{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","is_error":true,"content":"requires approval"}]}}""", """{"type":"done"}"""]));
        gate.SetResult();
        await Until(() => !chat.Busy);
        Assert.Equal(ChatStepState.Cancelled, chat.Messages[^1].Steps[0].State);
        var granted = ChatPermission.ReadOnly;
        chat.SetPermission = p => granted = p;
        api.Streams.Enqueue(("run-2", ["""{"type":"done"}"""]));
        chat.GrantAndRetry();
        await Until(() => !chat.Busy);
        Assert.Equal(ChatPermission.EditFiles, granted);
        Assert.Equal(ChatWords.English.GrantMessage, chat.Messages[^2].Text);
    }

    [Fact]
    public async Task AStoredSessionOpensWithItsStepsAndCardsReadOnly()
    {
        var api = new FakeApi
        {
            GetAnswer = JsonDocument.Parse("""{"messages":[{"role":"user","text":"add it"},{"role":"ai","text":"Added.","steps":[{"kind":"tool","name":"Bash","input":"todo add"},{"kind":"text","text":"Added."}],"cards":[{"v":1,"kind":"receipt","items":[{"id":"1","title":"It"}],"actions":{"undo":"card-undo"}}]},{"role":"ai","text":""}]}""").RootElement.Clone(),
        };
        var chat = Make(api);
        await chat.Open("sess-1");
        Assert.Equal("sess-1", chat.SessionId);
        Assert.Equal(2, chat.Messages.Count);
        Assert.True(chat.Messages[1].Historic);
        var card = Assert.Single(chat.Messages[1].Cards);
        Assert.False(ChatCards.CanUndo(card, chat.CardsActionable(chat.Messages[1])));
        chat.NewConversation();
        Assert.Empty(chat.Messages);
        Assert.Null(chat.SessionId);
    }
}
