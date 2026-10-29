using static AISpace.Core.FloatingBallRules;

namespace AISpace.Core.Tests;

/// <summary>The Mac's FloatingBallRulesTests, with y pointing down: a 1440 × 900 screen with the taskbar at the bottom.</summary>
public class FloatingBallRulesTests
{
    static readonly ScreenRect Visible = new(0, 25, 1440, 805);
    static ScreenPoint Place(ScreenPoint? saved, ScreenRect? screen = null) => Origin(saved, 52, 52, screen ?? Visible);

    [Fact]
    public void FirstPlaceIsTheRightEdgeAThirdOfTheWayDown()
    {
        var o = Place(null);
        Assert.Equal(1440 - 52 - 12, o.X);
        Assert.True(o.Y < Visible.Y + Visible.Height / 2);
        Assert.True(o.Y >= Visible.Y + Margin);
    }

    [Fact]
    public void SavedPlaceIsKeptWhenItFits() => Assert.Equal(new ScreenPoint(300, 400), Place(new ScreenPoint(300, 400)));

    [Fact]
    public void SavedPlaceOffTheScreenComesBackInside()
    {
        Assert.Equal(new ScreenPoint(12, 37), Place(new ScreenPoint(-40, 0)));
        Assert.Equal(new ScreenPoint(1376, 766), Place(new ScreenPoint(5000, 5000)));
    }

    [Fact]
    public void AScreenTooSmallForTheBallStillGetsIt() => Assert.Equal(new ScreenPoint(0, 0), Place(new ScreenPoint(10, 10), new ScreenRect(0, 0, 40, 40)));

    static BallOffer Of(string[] types, string[]? files = null, bool promised = false) => Offer(types, files ?? [], IsPicture, promised);

    [Fact]
    public void OneFileIsTakenWhenItIsAPicture()
    {
        Assert.Equal(BallOffer.File, Of(["FileDrop"], [".png"]));
        Assert.Equal(BallOffer.Nothing, Of(["FileDrop"], [".pdf"]));
        Assert.Equal(BallOffer.Nothing, Of(["FileDrop"], [".png", ".jpg"]));
        Assert.Equal(BallOffer.Nothing, Of(["FileDrop"], [""]));
    }

    [Fact]
    public void PictureDataIsTakenAndAFileBesideItWins()
    {
        Assert.Equal(BallOffer.Picture, Of(["PNG", "UniformResourceLocatorW"]));
        Assert.Equal(BallOffer.File, Of(["Bitmap", "FileDrop"], [".JPG"]));
        Assert.Equal(BallOffer.Nothing, Of(["Bitmap", "FileDrop"], [".pdf"]));
    }

    [Fact]
    public void APromiseIsTakenOnlyWithNothingBetter()
    {
        Assert.Equal(BallOffer.Promise, Of(["FileGroupDescriptorW", "UniformResourceLocatorW"], promised: true));
        Assert.Equal(BallOffer.Picture, Of(["PNG", "FileGroupDescriptorW"], promised: true));
    }

    [Fact]
    public void LinksAndTextAreRefused()
    {
        Assert.Equal(BallOffer.Nothing, Of(["UniformResourceLocatorW", "UnicodeText"]));
        Assert.Equal(BallOffer.Nothing, Of([]));
    }

    [Fact]
    public void SectionsGoClockwiseFromTheTop()
    {
        var c = new ScreenPoint(200, 200);
        Assert.Equal(BallSection.Keep, SectionAt(new ScreenPoint(200, 120), c));
        Assert.Equal(BallSection.Assistant, SectionAt(new ScreenPoint(280, 200), c));
        Assert.Equal(BallSection.Todo, SectionAt(new ScreenPoint(200, 280), c));
        Assert.Equal(BallSection.Design, SectionAt(new ScreenPoint(120, 200), c));
    }

    [Fact]
    public void TheHubAndPastTheRimAreNoSection()
    {
        var c = new ScreenPoint(200, 200);
        Assert.Null(SectionAt(new ScreenPoint(210, 205), c));
        Assert.Null(SectionAt(new ScreenPoint(200 + DialDiameter, 200), c));
    }

    [Fact]
    public void TheDialStaysWholeOnTheScreen()
    {
        var ball = new ScreenPoint(1440 - 38, 300);
        var c = DialCenter(ball, Visible);
        Assert.True(c.X + DialDiameter / 2 <= Visible.Right);
        Assert.Equal(ball.Y, c.Y);
        Assert.Equal(new ScreenPoint(700, 400), DialCenter(new ScreenPoint(700, 400), Visible));
    }

    [Fact]
    public void ASectionOpensThisMachinesEntryBeforeAPeers()
    {
        string[] refs = ["thinkbook/ai-todo", "ai-todo", "keep-notes", "david/space/assistant", "space/assistant", "thinkbook/ai-design"];
        Assert.Equal("ai-todo", RefFor(BallSection.Todo, refs));
        Assert.Equal("space/assistant", RefFor(BallSection.Assistant, refs));
        Assert.Equal("thinkbook/ai-design", RefFor(BallSection.Design, refs));
        Assert.Null(RefFor(BallSection.Keep, refs));
        Assert.Equal("thinkbook/space/assistant", RefFor(BallSection.Assistant, ["thinkbook/space/assistant"]));
    }

    [Fact]
    public void ASectionHandsItsWorkToItsAppsAgent()
    {
        string[] refs = ["space/assistant", "space/ui-fixer", "david/space/assistant", "thinkbook/ai-design/designer", "thinkbook/ai-todo/planner", "ai-todo/planner"];
        Assert.Equal("space/assistant", AgentFor(BallSection.Assistant, refs));
        Assert.Equal("ai-todo/planner", AgentFor(BallSection.Todo, refs));
        Assert.Equal("thinkbook/ai-design/designer", AgentFor(BallSection.Design, refs));
        Assert.Null(AgentFor(BallSection.Keep, refs));
    }

    [Fact]
    public void EachSpaceSetsItsOwnSections()
    {
        Assert.Null(Slot(BallSection.Keep, null));
        var slots = Setting(BallSection.Todo, "app:vault", null);
        Assert.Equal(["", "", "app:vault", ""], slots);
        Assert.Equal("app:vault", Slot(BallSection.Todo, slots));
        Assert.Null(Slot(BallSection.Keep, slots));
        var cleared = Setting(BallSection.Todo, null, Setting(BallSection.Design, EmptySlot, slots));
        Assert.Null(Slot(BallSection.Todo, cleared));
        Assert.Equal(EmptySlot, Slot(BallSection.Design, cleared));
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
    [Fact]
    public void QuickChatOpensLeftOfTheBallAndStandsAboveIt()
    {
        var ball = new ScreenRect(1376, 500, 52, 52);
        var o = ChatOrigin(ball, ChatWidth, 400, Visible);
        Assert.Equal(1376 - 12 - ChatWidth, o.X);
        Assert.Equal(500 + 26 + 48 - 400, o.Y);
    }

    [Fact]
    public void QuickChatOpensRightOfABallAtTheLeftEdgeAndStaysOnTheScreen()
    {
        var o = ChatOrigin(new ScreenRect(12, 40, 52, 52), ChatWidth, 400, Visible);
        Assert.Equal(12 + 52 + 12, o.X);
        Assert.Equal(Visible.Y + 8, o.Y);
        var low = ChatOrigin(new ScreenRect(700, 900, 52, 52), ChatWidth, 400, Visible);
        Assert.Equal(Visible.Bottom - 400 - 8, low.Y);
    }

    [Fact]
    public void PicturesAreKnownByTheirFirstBytes()
    {
        Assert.Equal("image/png", PictureType([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        Assert.Equal("image/jpeg", PictureType([0xFF, 0xD8, 0xFF, 0xE0]));
        Assert.Equal("image/gif", PictureType("GIF89a"u8));
        Assert.Equal("image/webp", PictureType("RIFF\0\0\0\0WEBP"u8));
        Assert.Null(PictureType("%PDF-1.7"u8));
        Assert.Null(PictureType([]));
    }

    static AppInfo App(string id, string? url = "/x/", bool hidden = false) => new(id, id.Split('/')[^1], id + " title", null, null, null, null, url, null, hidden);
    static AgentInfo Agent(string id) => new(id, id.Split('/')[^2], id.Split('/')[^1], id + " title", null, null, null, null, false);

    [Fact]
    public void TheDialFillsItsSectionsFromTheSpace()
    {
        var apps = new[] { App("keep"), App("ai-todo"), App("ai-design", hidden: true) };
        var agents = new[] { Agent("space/assistant"), Agent("ai-todo/planner") };
        var dial = Resolve(apps, agents, null);
        Assert.Equal("keep", dial[BallSection.Keep].App?.Id);
        Assert.Equal("space/assistant", dial[BallSection.Keep].Agent);
        Assert.True(dial[BallSection.Keep].Borrowed);
        Assert.Equal("ai-todo/planner", dial[BallSection.Todo].Agent);
        Assert.False(dial[BallSection.Todo].Borrowed);
        Assert.Equal("space/assistant", dial[BallSection.Assistant].AgentEntry?.Id);
        Assert.True(dial[BallSection.Assistant].IsAgent);
        // A hidden app never stands in a section.
        Assert.Null(dial[BallSection.Design].Agent);
    }

    [Fact]
    public void SettingsChooseOrEmptyASection()
    {
        var apps = new[] { App("keep"), App("vault") };
        var agents = new[] { Agent("space/assistant"), Agent("vault/keeper") };
        var slots = Setting(BallSection.Design, Key(apps[1]), Setting(BallSection.Keep, EmptySlot, Setting(BallSection.Todo, Key(agents[1]), null)));
        var dial = Resolve(apps, agents, slots);
        Assert.True(dial[BallSection.Keep].Hidden);
        Assert.Null(dial[BallSection.Keep].Agent);
        Assert.Equal("vault/keeper", dial[BallSection.Design].Agent);
        Assert.Equal("vault/keeper", dial[BallSection.Todo].AgentEntry?.Id);
        Assert.Equal("app:vault", Key(apps[1]));
    }

    [Fact]
    public void NoSpaceYetLeavesEverySectionWithoutAnAgent()
    {
        var dial = Resolve(null, null, null);
        Assert.All(Sections, s => Assert.Null(dial[s].Agent));
        Assert.All(Sections, s => Assert.False(dial[s].Hidden));
        Assert.Null(Resolve([App("keep")], [], null)[BallSection.Keep].Agent);
    }
}
