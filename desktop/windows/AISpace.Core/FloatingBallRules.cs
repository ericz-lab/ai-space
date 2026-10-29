namespace AISpace.Core;

/// <summary>A point in screen units (device-independent pixels), y pointing down as on Windows.</summary>
public readonly record struct ScreenPoint(double X, double Y);

/// <summary>A rectangle in screen units, y pointing down.</summary>
public readonly record struct ScreenRect(double X, double Y, double Width, double Height)
{
    public double Right => X + Width;
    public double Bottom => Y + Height;
}

/// <summary>The four places the dial opens, clockwise from the top; the value is the slot's index.</summary>
public enum BallSection { Keep = 0, Assistant = 1, Todo = 2, Design = 3 }

/// <summary>What a drag offers the ball: one picture file, picture data, a file promised but not there (a browser's), or nothing it takes.</summary>
public enum BallOffer { File, Picture, Promise, Nothing }

/// <summary>What one section shows and where its work goes: the entry (an app or an agent), the agent's id, whether that agent is borrowed (Space Assistant), whether Settings left it empty.</summary>
public sealed record DialEntry(AppInfo? App, AgentInfo? AgentEntry, string? Agent, bool Borrowed, bool Hidden)
{
    public string? Title(string? lang = null) => App?.DisplayTitle(lang) ?? AgentEntry?.DisplayTitle(lang);

    /// <summary>The entry's picture: an app's icon or an agent's avatar (a URL, a path of the Space, or an emoji).</summary>
    public string? Icon => App?.Icon ?? AgentEntry?.Avatar;

    public bool IsAgent => AgentEntry is not null;
}

/// <summary>
/// The floating ball: a small round window over every app that takes a dropped picture and opens
/// into a dial of four sections, each handing text and pictures to an agent through Quick Chat.
/// Its rules without WPF, ported from the Mac's FloatingBallRules.swift
/// (desktop/macos/AISpace/Services/) and kept the same as the Linux client's
/// (desktop/linux/src/core/floating-ball.ts), with y pointing down as on Windows.
/// </summary>
public static class FloatingBallRules
{
    public const double Diameter = 52;
    /// <summary>The ball never stands closer than this to the edge of the work area.</summary>
    public const double Margin = 12;
    /// <summary>The glass disc that opens around the ball (Design Studio's spec, design 11).</summary>
    public const double DialDiameter = 168;
    /// <summary>The hub in the middle, where the section under the pointer is named.</summary>
    public const double HubDiameter = 60;
    /// <summary>The window around the disc: room for its shadow on every side.</summary>
    public const double DialWindow = DialDiameter + 64;
    /// <summary>A section Settings left empty; "" (or no setting) is the section's default app.</summary>
    public const string EmptySlot = "-";

    public static readonly BallSection[] Sections = [BallSection.Keep, BallSection.Assistant, BallSection.Todo, BallSection.Design];

    /// <summary>The middle of a section, in degrees counterclockwise from the right.</summary>
    public static double Angle(BallSection s) => s switch
    {
        BallSection.Keep => 90,
        BallSection.Assistant => 0,
        BallSection.Todo => 270,
        _ => 180,
    };

    /// <summary>The app of the Space a section stands for (an agent's app for the assistant).</summary>
    public static string App(BallSection s) => s switch
    {
        BallSection.Keep => "keep",
        BallSection.Assistant => "space",
        BallSection.Todo => "ai-todo",
        _ => "ai-design",
    };

    /// <summary>The name shown while the Space has no such entry.</summary>
    public static string FallbackTitle(BallSection s) => s switch
    {
        BallSection.Keep => "Keep",
        BallSection.Assistant => "Space Assistant",
        BallSection.Todo => "Todo",
        _ => "Design Studio",
    };

    /// <summary>
    /// Where the ball stands (its top-left corner): its saved place, kept inside the work area (a
    /// screen that was unplugged must not take the ball with it); with no saved place, the right
    /// edge a third of the way down, clear of the taskbar and the corners.
    /// </summary>
    public static ScreenPoint Origin(ScreenPoint? saved, double width, double height, ScreenRect visible)
    {
        double minX = visible.X + Margin, maxX = visible.Right - width - Margin;
        double minY = visible.Y + Margin, maxY = visible.Bottom - height - Margin;
        if (maxX < minX || maxY < minY) return new ScreenPoint(visible.X, visible.Y);
        var wanted = saved ?? new ScreenPoint(maxX, visible.Y + visible.Height / 3 - height / 2);
        return new ScreenPoint(Math.Min(Math.Max(wanted.X, minX), maxX), Math.Min(Math.Max(wanted.Y, minY), maxY));
    }

    /// <summary>The section under a point of a dial centred on <paramref name="center"/>: none in the hub or past the rim.</summary>
    public static BallSection? SectionAt(ScreenPoint point, ScreenPoint center)
    {
        double dx = point.X - center.X, dy = center.Y - point.Y;
        var r = Math.Sqrt(dx * dx + dy * dy);
        if (r < HubDiameter / 2 || r > DialDiameter / 2) return null;
        var degrees = Math.Atan2(dy, dx) * 180 / Math.PI;
        if (degrees < 0) degrees += 360;
        return degrees switch
        {
            >= 45 and < 135 => BallSection.Keep,
            >= 135 and < 225 => BallSection.Design,
            >= 225 and < 315 => BallSection.Todo,
            _ => BallSection.Assistant,
        };
    }

    /// <summary>Where the dial opens: centred on the ball, moved in just enough to stay whole on the screen.</summary>
    public static ScreenPoint DialCenter(ScreenPoint ball, ScreenRect visible)
    {
        var r = DialDiameter / 2 + 4;
        double minX = visible.X + r, maxX = visible.Right - r;
        double minY = visible.Y + r, maxY = visible.Bottom - r;
        if (maxX < minX || maxY < minY) return new ScreenPoint(visible.X + visible.Width / 2, visible.Y + visible.Height / 2);
        return new ScreenPoint(Math.Min(Math.Max(ball.X, minX), maxX), Math.Min(Math.Max(ball.Y, minY), maxY));
    }

    // Quick Chat beside the ball (the Mac's QuickChat.position)

    /// <summary>Quick Chat's width (Design Studio's spec, design 12).</summary>
    public const double ChatWidth = 380;
    /// <summary>
    /// Quick Chat's height. The Mac's native panel grows from 96 to 420 with the replies; Windows
    /// shows the Space's own chat page, which cannot tell the window its height and puts its model
    /// and permission choices in a second header row, so it keeps one height with room for both.
    /// </summary>
    public const double ChatHeight = 520;

    /// <summary>
    /// Where Quick Chat opens beside the ball (its top-left corner): left of it when there is room,
    /// else right; its bottom a little under the ball's middle, so it stands above the pointer;
    /// kept 8 inside the work area.
    /// </summary>
    public static ScreenPoint ChatOrigin(ScreenRect ball, double width, double height, ScreenRect visible)
    {
        const double gap = 12, edge = 8;
        var left = ball.X - gap - width;
        var x = left >= visible.X ? left : ball.Right + gap;
        var y = ball.Y + ball.Height / 2 + 48 - height;
        x = Math.Min(Math.Max(x, visible.X + edge), visible.Right - width - edge);
        y = Math.Min(Math.Max(y, visible.Y + edge), visible.Bottom - height - edge);
        return new ScreenPoint(Math.Round(x), Math.Round(y));
    }

    static string[] Parts(string r) => r.Split('/');

    /// <summary>
    /// The entry that shows a section among the Space's ids (<c>&lt;peer&gt;/</c> before a
    /// peer's): the app itself, or Space Assistant for the assistant's section. This machine's
    /// first, else the first peer that has it.
    /// </summary>
    public static string? RefFor(BallSection section, IEnumerable<string> refs)
    {
        var name = section == BallSection.Assistant ? "space/assistant" : App(section);
        var depth = Parts(name).Length;
        var matches = refs.Where(r => r == name || (r.EndsWith("/" + name, StringComparison.Ordinal) && Parts(r).Length == depth + 1)).ToList();
        return matches.FirstOrDefault(r => r == name) ?? matches.FirstOrDefault();
    }

    /// <summary>The section's setting for one Space: null for the default app, <see cref="EmptySlot"/> for none, else an entry key.</summary>
    public static string? Slot(BallSection section, IReadOnlyList<string>? slots)
    {
        var i = (int)section;
        return slots is not null && i < slots.Count && slots[i].Length > 0 ? slots[i] : null;
    }

    /// <summary>Slots with one section set to <paramref name="key"/> (null for the default), the others kept.</summary>
    public static List<string> Setting(BallSection section, string? key, IReadOnlyList<string>? slots)
    {
        var output = new List<string>(slots ?? []);
        while (output.Count < Sections.Length) output.Add("");
        output[(int)section] = key ?? "";
        return output;
    }

    /// <summary>The agent of an app (<c>name</c> or <c>peer/name</c>): one on the app's own machine first, else the same app elsewhere.</summary>
    public static string? AgentForApp(string app, IEnumerable<string> refs)
    {
        var p = Parts(app);
        var name = p[^1];
        if (name.Length == 0) return null;
        var peer = p.Length > 1 ? p[0] : null;
        var matches = refs.Where(r => Parts(r) is { Length: 2 or 3 } q && q[^2] == name).ToList();
        return matches.FirstOrDefault(r => (Parts(r) is { Length: 3 } q ? q[0] : null) == peer) ?? matches.FirstOrDefault();
    }

    /// <summary>The agent a section hands its work to: the app's own agent, this machine's first; for the assistant's section, Space Assistant.</summary>
    public static string? AgentFor(BallSection section, IEnumerable<string> refs)
    {
        var matches = refs.Where(r => Parts(r) is { Length: 2 or 3 } p && p[^2] == App(section) && (section != BallSection.Assistant || p[^1] == "assistant")).ToList();
        return matches.FirstOrDefault(r => Parts(r).Length == 2) ?? matches.FirstOrDefault();
    }

    /// <summary>
    /// <paramref name="types"/> are the drag's formats, <paramref name="files"/> the types of its
    /// files (one per file). A file wins over data, so nothing is read twice; more than one file is
    /// refused, as a section takes one picture at a time.
    /// </summary>
    public static BallOffer Offer(IReadOnlyCollection<string> types, IReadOnlyList<string> files, Func<string, bool> isPicture, bool promised = false)
    {
        if (files.Count > 0) return files.Count == 1 && isPicture(files[0]) ? BallOffer.File : BallOffer.Nothing;
        if (types.Any(isPicture)) return BallOffer.Picture;
        return promised ? BallOffer.Promise : BallOffer.Nothing;
    }

    static readonly HashSet<string> PictureFormats = new(StringComparer.OrdinalIgnoreCase)
    {
        "PNG", "Bitmap", "DeviceIndependentBitmap", "Format17", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
    };

    static readonly HashSet<string> PictureExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff",
    };

    /// <summary>A clipboard or drag format that carries a picture, or a file extension of one.</summary>
    public static bool IsPicture(string formatOrExtension) =>
        PictureFormats.Contains(formatOrExtension) || PictureExtensions.Contains(formatOrExtension);

    /// <summary>
    /// The picture's type from its first bytes, as the chat takes them (PNG, JPEG, GIF, WebP;
    /// src/web/chat-images.ts); null for anything else, which the app converts or refuses.
    /// </summary>
    public static string? PictureType(ReadOnlySpan<byte> b)
    {
        if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return "image/png";
        if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return "image/jpeg";
        if (b.Length >= 6 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x38) return "image/gif";
        if (b.Length >= 12 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return "image/webp";
        return null;
    }

    /// <summary>The largest picture the ball hands on (the chat's own limit per image, src/web/chat-images.ts).</summary>
    public const int MaxPictureBytes = 5 * 1024 * 1024;

    /// <summary>The lead put before the message when an app without an agent hands its work to Space Assistant (once).</summary>
    public static string WithLead(string draft, string lead) => draft.StartsWith(lead, StringComparison.Ordinal) ? draft : lead + "\n" + draft;

    /// <summary>
    /// Each section's entry and agent in a Space: what Settings set for it (an app or an agent, or
    /// nothing), else the section's default app. An agent takes the work itself; an app hands it to
    /// its own agent, or to Space Assistant when it has none. Apps the panel does not offer (hidden,
    /// archived, without a page) never stand in a section. Null lists: the Space has not answered yet.
    /// </summary>
    public static Dictionary<BallSection, DialEntry> Resolve(IReadOnlyList<AppInfo>? apps, IReadOnlyList<AgentInfo>? agents, IReadOnlyList<string>? slots)
    {
        var output = new Dictionary<BallSection, DialEntry>();
        var known = apps is not null && agents is not null;
        var shown = apps?.Where(a => a.Opens).ToList() ?? [];
        var agentList = agents ?? [];
        var agentRefs = agentList.Select(a => a.Id).ToList();
        foreach (var section in Sections)
        {
            var slot = Slot(section, slots);
            var hidden = slot == EmptySlot;
            AppInfo? app = null;
            AgentInfo? agentEntry = null;
            if (known && !hidden)
            {
                if (slot is not null)
                {
                    if (slot.StartsWith("app:", StringComparison.Ordinal)) app = shown.FirstOrDefault(a => a.Id == slot[4..]);
                    else if (slot.StartsWith("agent:", StringComparison.Ordinal)) agentEntry = agentList.FirstOrDefault(a => a.Id == slot[6..]);
                }
                else if (section == BallSection.Assistant)
                {
                    var r = RefFor(section, agentRefs);
                    agentEntry = agentList.FirstOrDefault(a => a.Id == r);
                }
                else
                {
                    var r = RefFor(section, shown.Select(a => a.Id));
                    app = shown.FirstOrDefault(a => a.Id == r);
                }
            }
            if (app is null && agentEntry is null)
            {
                output[section] = new DialEntry(null, null, null, false, hidden);
                continue;
            }
            var own = agentEntry?.Id ?? AgentForApp(app!.Id, agentRefs);
            var agent = own ?? AgentFor(BallSection.Assistant, agentRefs);
            output[section] = agent is null ? new DialEntry(null, null, null, false, hidden) : new DialEntry(app, agentEntry, agent, own is null, hidden);
        }
        return output;
    }

    /// <summary>The key a section setting stores for an app or an agent (the panel's tile keys).</summary>
    public static string Key(AppInfo app) => "app:" + app.Id;

    public static string Key(AgentInfo agent) => "agent:" + agent.Id;
}
