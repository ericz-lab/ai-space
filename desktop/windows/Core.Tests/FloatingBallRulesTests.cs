using AISpace.Core;
using Xunit;
using static AISpace.Core.FloatingBallRules;

namespace AISpace.Core.Tests;

/// <summary>The Mac's FloatingBallRulesTests, with y pointing down: a 1440 × 900 screen with the taskbar at the bottom.</summary>
public class FloatingBallRulesTests
{
    static readonly Rect Visible = new(0, 25, 1440, 805);
    static Pt Place(Pt? saved, Rect? screen = null) => Origin(saved, 52, 52, screen ?? Visible);

    [Fact]
    public void FirstPlaceIsTheRightEdgeAThirdOfTheWayDown()
    {
        var o = Place(null);
        Assert.Equal(1440 - 52 - 12, o.X);
        Assert.True(o.Y < Visible.Y + Visible.Height / 2);
        Assert.True(o.Y >= Visible.Y + Margin);
    }

    [Fact]
    public void SavedPlaceIsKeptWhenItFits() => Assert.Equal(new Pt(300, 400), Place(new Pt(300, 400)));

    [Fact]
    public void SavedPlaceOffTheScreenComesBackInside()
    {
        Assert.Equal(new Pt(12, 37), Place(new Pt(-40, 0)));
        Assert.Equal(new Pt(1376, 766), Place(new Pt(5000, 5000)));
    }

    [Fact]
    public void AScreenTooSmallForTheBallStillGetsIt() => Assert.Equal(new Pt(0, 0), Place(new Pt(10, 10), new Rect(0, 0, 40, 40)));

    static Offer Of(string[] types, string[]? files = null, bool promised = false) => Offer(types, files ?? [], IsPicture, promised);

    [Fact]
    public void OneFileIsTakenWhenItIsAPicture()
    {
        Assert.Equal(AISpace.Core.Offer.File, Of(["FileDrop"], [".png"]));
        Assert.Equal(AISpace.Core.Offer.Nothing, Of(["FileDrop"], [".pdf"]));
        Assert.Equal(AISpace.Core.Offer.Nothing, Of(["FileDrop"], [".png", ".jpg"]));
        Assert.Equal(AISpace.Core.Offer.Nothing, Of(["FileDrop"], [""]));
    }

    [Fact]
    public void PictureDataIsTakenAndAFileBesideItWins()
    {
        Assert.Equal(AISpace.Core.Offer.Picture, Of(["PNG", "UniformResourceLocatorW"]));
        Assert.Equal(AISpace.Core.Offer.File, Of(["Bitmap", "FileDrop"], [".HEIC"]));
        Assert.Equal(AISpace.Core.Offer.Nothing, Of(["Bitmap", "FileDrop"], [".pdf"]));
    }

    [Fact]
    public void APromiseIsTakenOnlyWithNothingBetter()
    {
        Assert.Equal(AISpace.Core.Offer.Promise, Of(["FileGroupDescriptorW", "UniformResourceLocatorW"], promised: true));
        Assert.Equal(AISpace.Core.Offer.Picture, Of(["PNG", "FileGroupDescriptorW"], promised: true));
    }

    [Fact]
    public void LinksAndTextAreRefused()
    {
        Assert.Equal(AISpace.Core.Offer.Nothing, Of(["UniformResourceLocatorW", "UnicodeText"]));
        Assert.Equal(AISpace.Core.Offer.Nothing, Of([]));
    }

    [Fact]
    public void SectionsGoClockwiseFromTheTop()
    {
        var c = new Pt(200, 200);
        Assert.Equal(Section.Keep, SectionAt(new Pt(200, 120), c));
        Assert.Equal(Section.Assistant, SectionAt(new Pt(280, 200), c));
        Assert.Equal(Section.Todo, SectionAt(new Pt(200, 280), c));
        Assert.Equal(Section.Design, SectionAt(new Pt(120, 200), c));
    }

    [Fact]
    public void TheHubAndPastTheRimAreNoSection()
    {
        var c = new Pt(200, 200);
        Assert.Null(SectionAt(new Pt(210, 205), c));
        Assert.Null(SectionAt(new Pt(200 + DialDiameter, 200), c));
    }

    [Fact]
    public void TheDialStaysWholeOnTheScreen()
    {
        var ball = new Pt(1440 - 38, 300);
        var c = DialCenter(ball, Visible);
        Assert.True(c.X + DialDiameter / 2 <= Visible.Right);
        Assert.Equal(ball.Y, c.Y);
        Assert.Equal(new Pt(700, 400), DialCenter(new Pt(700, 400), Visible));
    }

    [Fact]
    public void ASectionOpensThisMachinesEntryBeforeAPeers()
    {
        string[] refs = ["thinkbook/ai-todo", "ai-todo", "keep-notes", "david/space/assistant", "space/assistant", "thinkbook/ai-design"];
        Assert.Equal("ai-todo", RefFor(Section.Todo, refs));
        Assert.Equal("space/assistant", RefFor(Section.Assistant, refs));
        Assert.Equal("thinkbook/ai-design", RefFor(Section.Design, refs));
        Assert.Null(RefFor(Section.Keep, refs));
        Assert.Equal("thinkbook/space/assistant", RefFor(Section.Assistant, ["thinkbook/space/assistant"]));
    }

    [Fact]
    public void ASectionHandsItsWorkToItsAppsAgent()
    {
        string[] refs = ["space/assistant", "space/ui-fixer", "david/space/assistant", "thinkbook/ai-design/designer", "thinkbook/ai-todo/planner", "ai-todo/planner"];
        Assert.Equal("space/assistant", AgentFor(Section.Assistant, refs));
        Assert.Equal("ai-todo/planner", AgentFor(Section.Todo, refs));
        Assert.Equal("thinkbook/ai-design/designer", AgentFor(Section.Design, refs));
        Assert.Null(AgentFor(Section.Keep, refs));
    }

    [Fact]
    public void EachSpaceSetsItsOwnSections()
    {
        Assert.Null(Slot(Section.Keep, null));
        var slots = Setting(Section.Todo, "app:vault", null);
        Assert.Equal(["", "", "app:vault", ""], slots);
        Assert.Equal("app:vault", Slot(Section.Todo, slots));
        Assert.Null(Slot(Section.Keep, slots));
        var cleared = Setting(Section.Todo, null, Setting(Section.Design, EmptySlot, slots));
        Assert.Null(Slot(Section.Todo, cleared));
        Assert.Equal(EmptySlot, Slot(Section.Design, cleared));
    }

    [Fact]
    public void AnAppsAgentIsFoundOnItsOwnMachineFirst()
    {
        string[] refs = ["space/assistant", "keep/keeper", "thinkbook/ai-todo/planner", "ai-todo/planner"];
        Assert.Equal("keep/keeper", AgentForApp("keep", refs));
        Assert.Equal("thinkbook/ai-todo/planner", AgentForApp("thinkbook/ai-todo", refs));
        Assert.Equal("ai-todo/planner", AgentForApp("ai-todo", refs));
        Assert.Equal("thinkbook/ai-todo/planner", AgentForApp("david/ai-todo", refs));
        Assert.Null(AgentForApp("vault", refs));
    }

    [Fact]
    public void TheLeadGoesBeforeTheMessageOnce()
    {
        Assert.Equal("Save this to Keep:\n", WithLead("", "Save this to Keep:"));
        Assert.Equal("Save this to Keep:\nhi", WithLead("Save this to Keep:\nhi", "Save this to Keep:"));
    }
}
