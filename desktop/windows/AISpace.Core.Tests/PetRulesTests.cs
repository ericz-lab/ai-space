using System.Text.Json;
using AISpace.Core;

namespace AISpace.Core.Tests;

// The Linux client's core/pet.test.ts (itself the Mac's PetRulesTests), the in-window parts.
public class PetRulesTests
{
    /// <summary>A random source that plays back fixed numbers, the last one again once they run out.</summary>
    private static Func<double> Fixed(params double[] values)
    {
        var left = new Queue<double>(values);
        return () => left.Count > 1 ? left.Dequeue() : left.Count == 1 ? left.Peek() : 0;
    }

    private static SpaceMood Mood(string state, string move = "roam") => new(state, Ok: true, Move: move);

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void TheMoodDecodesFromTheRouteAndANewerStateOrABareAnswerStillDoes()
    {
        var m = PetRules.DecodeMood(Json("""
            { "ok": true, "state": "waiting", "reason": "approval", "move": "stay", "say": { "en": "Planner is waiting for you", "zh": "规划师 在等你" },
              "open": { "kind": "chat", "agent": "ai-todo/planner" }, "counts": { "running": 1 }, "asOf": "2026-11-13T10:00:00.000Z" }
            """));
        Assert.NotNull(m);
        Assert.Equal("waiting", m.State);
        Assert.Equal(PetOpen.Chat("ai-todo/planner"), m.Open);
        Assert.Equal("规划师 在等你", PetRules.SayText(m.Say, "zh"));
        Assert.Equal("Planner is waiting for you", PetRules.SayText(m.Say, "en"));
        Assert.Equal(new SpaceMood("dancing"), PetRules.DecodeMood(Json("""{ "state": "dancing" }""")));
        Assert.Null(PetRules.DecodeMood(Json("\"<html>\"")));
        Assert.Null(PetRules.DecodeMood(Json("""{ "ok": false }""")));
        // A click target that is not one of the two kinds is dropped.
        Assert.Null(PetRules.DecodeMood(Json("""{ "state": "done", "open": { "kind": "page", "url": "https://example.com" } }"""))!.Open);
        Assert.Equal(PetOpen.ToInbox, PetRules.DecodeMood(Json("""{ "state": "error", "open": { "kind": "inbox" } }"""))!.Open);
        // The Space on this machine answers without a line: none is shown.
        var sleeping = PetRules.DecodeMood(Json("""{"ok":true,"counts":{"running":0},"asOf":"2026-11-22T03:42:08.828Z","state":"sleep","move":"stay"}"""));
        Assert.Null(PetRules.SayText(sleeping!.Say, "en"));
    }

    [Fact]
    public void ClaudeShowsEachStateAsThePanelDoes()
    {
        Assert.Equal("look", PetRules.Shown(Mood("working"))?.Rest);
        Assert.Equal(new PetMood("hop", true), PetRules.Shown(Mood("waiting", "stay")));
        Assert.Equal("look", PetRules.Shown(Mood("waiting"))?.Rest);
        Assert.True(PetRules.Shown(Mood("error", "stay"))?.Stay);
        Assert.Equal("jump", PetRules.Shown(Mood("done"))?.Once);
        Assert.Equal("sleep", PetRules.Shown(Mood("sleep", "stay"))?.Rest);
        // Idle, an unknown state, a failed read or none: rest as without a mood.
        Assert.Null(PetRules.Shown(Mood("idle")));
        Assert.Null(PetRules.Shown(Mood("dancing")));
        Assert.Null(PetRules.Shown(new SpaceMood("working", Ok: false)));
        Assert.Null(PetRules.Shown(null));
    }

    [Fact]
    public void TheTableNamesOnlyAnimationsTheSheetHas()
    {
        var c = PetRules.Claude;
        var named = c.MoodRests.Values.Concat(c.MoodOnce.Values).Concat(c.Rests.Select(r => r.Name)).Append(c.Walk).Append(c.Click);
        foreach (var name in named) Assert.True(c.Anims.ContainsKey(name), name);
        foreach (var a in c.Anims.Values)
        {
            Assert.InRange(a.Row, 0, c.Rows - 1);
            Assert.InRange(a.Frames, 1, c.Columns);
        }
        Assert.Equal(1.0, c.Rests.Sum(r => r.Weight), 6);
    }

    [Fact]
    public void TheTableIsTheWebs()
    {
        // src/web/Pet.tsx's CLAUDE, as the Linux test compares it: read from the source so the two cannot drift.
        var source = File.ReadAllText(Path.Combine(Root(), "src", "web", "Pet.tsx"));
        foreach (var (name, a) in PetRules.Claude.Anims)
        {
            var pause = a.Pause > 0 ? $", pause: {a.Pause}" : "";
            Assert.Contains($"{name}: {{ row: {a.Row}, frames: {a.Frames}, ms: {a.Ms}{pause} }}", source);
        }
        var c = PetRules.Claude;
        Assert.Contains($"columns: {c.Columns},\n  rows: {c.Rows},\n  width: {c.Width},", source.ReplaceLineEndings("\n"));
        Assert.Contains("rests: [" + string.Join(", ", c.Rests.Select(r => $"[\"{r.Name}\", {r.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture)}]")) + "]", source);
        Assert.Contains($"click: \"{c.Click}\"", source);
        var rest = string.Join(", ", c.MoodRests.Select(p => (p.Key.Contains('/') ? $"\"{p.Key}\"" : p.Key) + $": \"{p.Value}\""));
        var once = string.Join(", ", c.MoodOnce.Select(p => $"{p.Key}: \"{p.Value}\""));
        Assert.Contains($"moods: {{ rest: {{ {rest} }}, once: {{ {once} }} }}", source);
        Assert.Contains("const SPEED = 55;", source);
        Assert.Contains("pet-claude.webp", source);
    }

    [Fact]
    public void ACellIsCutFromTheSheet()
    {
        // The app's PNG: 128-pixel cells, 12 by 5.
        Assert.Equal((256, 384, 128, 128), PetRules.Cell(PetRules.Claude, 2, 3, 1536, 640));
        Assert.Equal((11 * 128, 0, 128, 128), PetRules.Cell(PetRules.Claude, 40, -1, 1536, 640));
    }

    [Fact]
    public void APetThatStaysWalksToItsCornerAndRestsFacingIn()
    {
        var m = new PetMotion(PetRules.Claude, 80, 1000, 0, Fixed(0.5));
        m.SetMood(PetRules.Shown(Mood("waiting", "stay")), 0);
        Assert.True(m.Walking);
        Assert.Equal("walk", m.Animation);
        Assert.Equal(1000 - 80 - 24, m.Corner);
        // 55 pixels a second at its drawn width: from 460 to 896 takes about 8 seconds.
        var t = 0.0;
        while (m.Walking && t < 20)
        {
            t += 0.05;
            m.Advance(t);
        }
        Assert.Equal(m.Corner, m.X);
        Assert.True(m.FacingLeft);
        Assert.Equal("hop", m.Animation);
        Assert.InRange(t, 7, 9);
    }

    [Fact]
    public void SpeedFollowsTheSizeSoTheFeetStayPlanted()
    {
        Assert.Equal(55, new PetMotion(PetRules.Claude, 80, 500, 0, Fixed(0)).Speed);
        Assert.Equal(55.0 * 110 / 80, new PetMotion(PetRules.Claude, 110, 500, 0, Fixed(0)).Speed);
    }

    [Fact]
    public void DoneSpinsOnceThenRests()
    {
        // 0.9: no walk, so the pet rests where it is.
        var m = new PetMotion(PetRules.Claude, 80, 600, 0, Fixed(0, 0.9));
        m.SetMood(PetRules.Shown(Mood("done")), 1);
        Assert.Equal("jump", m.Animation);
        // The same mood read again changes nothing.
        m.SetMood(PetRules.Shown(Mood("done")), 1.1);
        Assert.Equal("jump", m.Animation);
        m.Advance(1 + 0.72 + 0.01);
        Assert.Equal("look", m.Animation);
        Assert.Equal(0, m.Frame);
    }

    [Fact]
    public void FramesFollowTheClockAndHoldTheFirstCellAfterAPause()
    {
        var m = new PetMotion(PetRules.Claude, 80, 600, 0, Fixed(0, 0.9));
        m.SetMood(PetRules.Shown(Mood("waiting", "stay")), 0);
        // Walks to the corner first; put it there.
        m.Drop(m.Corner, 0);
        Assert.Equal("hop", m.Animation);
        var step = 0.9 / 12;
        m.Advance(step * 3 + 0.001);
        Assert.Equal(3, m.Frame);
        m.Advance(step * 12 + 0.001);
        Assert.Equal(0, m.Frame);
        // The first cell is held 1.4 s longer after each loop.
        m.Advance(step * 13 + 0.5);
        Assert.Equal(0, m.Frame);
        m.Advance(step * 13 + 1.4 + 0.001);
        Assert.Equal(1, m.Frame);
        Assert.Equal(3, m.Cell.Row);
    }

    [Fact]
    public void AClickJumpsAndAHeldPetGoesNowhere()
    {
        var m = new PetMotion(PetRules.Claude, 80, 600, 0, Fixed(0, 0.9));
        m.Click(0);
        Assert.Equal("jump", m.Animation);
        m.Hold(300, 0.1);
        Assert.Equal(300, m.X);
        Assert.False(m.Walking);
        m.Advance(60);
        Assert.Equal(300, m.X);
        m.Hold(5000, 61);
        Assert.Equal(520, m.X);
    }

    [Fact]
    public void AResizedStageKeepsThePetOnIt()
    {
        var m = new PetMotion(PetRules.Claude, 80, 1000, 0, Fixed(1, 0.9));
        Assert.Equal(920, m.X);
        m.Resize(500, 1);
        Assert.Equal(420, m.X);
        m.Resize(500, 2, 110);
        Assert.Equal(390, m.X);
    }

    [Fact]
    public void ALateCallSkipsCellsRatherThanReplayingThem()
    {
        var m = new PetMotion(PetRules.Claude, 80, 600, 0, Fixed(0, 0.9));
        m.SetMood(new PetMood("sleep", false), 0);
        // Asleep: 3.6 s a loop. Ten minutes later, the next change is a cell away, not a backlog.
        Assert.True(m.Advance(600) <= 0.3 + 1e-9);
    }

    [Fact]
    public void TheBubbleComesAndGoesAndOpensTowardsTheMiddle()
    {
        Assert.True(PetRules.BubbleVisible(0));
        Assert.True(PetRules.BubbleVisible(5.9));
        Assert.False(PetRules.BubbleVisible(6.1));
        Assert.False(PetRules.BubbleVisible(19.9));
        Assert.True(PetRules.BubbleVisible(20.1));
        Assert.Equal(4, PetRules.BubbleUntilChange(2));
        Assert.Equal(10, PetRules.BubbleUntilChange(10));
        Assert.True(PetRules.OpensRight(100, 80, 1000));
        Assert.False(PetRules.OpensRight(800, 80, 1000));
    }

    /// <summary>The repository's root, above the test's build output.</summary>
    internal static string Root()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d is not null; d = d.Parent)
        {
            if (File.Exists(Path.Combine(d.FullName, "package.json")) && Directory.Exists(Path.Combine(d.FullName, "src", "web"))) return d.FullName;
        }
        throw new DirectoryNotFoundException("the repository root");
    }
}
