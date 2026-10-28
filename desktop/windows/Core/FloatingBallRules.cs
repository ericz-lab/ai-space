namespace AISpace.Core;

/// <summary>A point, size or rectangle in screen units, y pointing down (Windows and WPF).</summary>
public readonly record struct Pt(double X, double Y);

public readonly record struct Rect(double X, double Y, double Width, double Height)
{
    public double Right => X + Width;
    public double Bottom => Y + Height;
}

/// <summary>The four places the dial opens, clockwise from the top; the value is the slot's index.</summary>
public enum Section { Keep = 0, Assistant = 1, Todo = 2, Design = 3 }

/// <summary>What a drag offers the ball.</summary>
public enum Offer { File, Picture, Promise, Nothing }

/// <summary>
/// The floating ball: a small round window over every app that takes a dropped picture and opens
/// into a dial of four sections, each handing text and pictures to an agent through Quick Chat.
/// Its rules without WPF, ported from the Mac's FloatingBallRules.swift
/// (desktop/macos/AISpace/Services/), with y pointing down as on Windows.
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

    public static readonly Section[] Sections = [Section.Keep, Section.Assistant, Section.Todo, Section.Design];

    /// <summary>The middle of a section, in degrees counterclockwise from the right.</summary>
    public static double Angle(Section s) => s switch
    {
        Section.Keep => 90,
        Section.Assistant => 0,
        Section.Todo => 270,
        _ => 180,
    };

    /// <summary>The app of the Space a section stands for (an agent's app for the assistant).</summary>
    public static string App(Section s) => s switch
    {
        Section.Keep => "keep",
        Section.Assistant => "space",
        Section.Todo => "ai-todo",
        _ => "ai-design",
    };

    /// <summary>The name shown while the Space has no such entry.</summary>
    public static string FallbackTitle(Section s) => s switch
    {
        Section.Keep => "Keep",
        Section.Assistant => "Space Assistant",
        Section.Todo => "Todo",
        _ => "Design Studio",
    };

    /// <summary>
    /// Where the ball stands (its top-left corner): its saved place, kept inside the work area (a
    /// screen that was unplugged must not take the ball with it); with no saved place, the right
    /// edge a third of the way down, clear of the taskbar and the corners.
    /// </summary>
    public static Pt Origin(Pt? saved, double width, double height, Rect visible)
    {
        double minX = visible.X + Margin, maxX = visible.Right - width - Margin;
        double minY = visible.Y + Margin, maxY = visible.Bottom - height - Margin;
        if (maxX < minX || maxY < minY) return new Pt(visible.X, visible.Y);
        var wanted = saved ?? new Pt(maxX, visible.Y + visible.Height / 3 - height / 2);
        return new Pt(Math.Min(Math.Max(wanted.X, minX), maxX), Math.Min(Math.Max(wanted.Y, minY), maxY));
    }

    /// <summary>The section under a point of a dial centred on <paramref name="center"/>: none in the hub or past the rim.</summary>
    public static Section? SectionAt(Pt point, Pt center)
    {
        double dx = point.X - center.X, dy = center.Y - point.Y;
        var r = Math.Sqrt(dx * dx + dy * dy);
        if (r < HubDiameter / 2 || r > DialDiameter / 2) return null;
        var degrees = Math.Atan2(dy, dx) * 180 / Math.PI;
        if (degrees < 0) degrees += 360;
        return degrees switch
        {
            >= 45 and < 135 => Section.Keep,
            >= 135 and < 225 => Section.Design,
            >= 225 and < 315 => Section.Todo,
            _ => Section.Assistant,
        };
    }

    /// <summary>Where the dial opens: centred on the ball, moved in just enough to stay whole on the screen.</summary>
    public static Pt DialCenter(Pt ball, Rect visible)
    {
        var r = DialDiameter / 2 + 4;
        double minX = visible.X + r, maxX = visible.Right - r;
        double minY = visible.Y + r, maxY = visible.Bottom - r;
        if (maxX < minX || maxY < minY) return new Pt(visible.X + visible.Width / 2, visible.Y + visible.Height / 2);
        return new Pt(Math.Min(Math.Max(ball.X, minX), maxX), Math.Min(Math.Max(ball.Y, minY), maxY));
    }

    static string[] Parts(string r) => r.Split('/');

    /// <summary>
    /// The entry that shows a section among the catalogue's refs (<c>&lt;peer&gt;/</c> before a
    /// peer's): the app itself, or Space Assistant for the assistant's section. This machine's
    /// first, else the first peer that has it.
    /// </summary>
    public static string? RefFor(Section section, IEnumerable<string> refs)
    {
        var name = section == Section.Assistant ? "space/assistant" : App(section);
        var depth = Parts(name).Length;
        var matches = refs.Where(r => r == name || (r.EndsWith("/" + name, StringComparison.Ordinal) && Parts(r).Length == depth + 1)).ToList();
        return matches.FirstOrDefault(r => r == name) ?? matches.FirstOrDefault();
    }

    /// <summary>The section's setting for one Space: null for the default app, <see cref="EmptySlot"/> for none, else an entry key.</summary>
    public static string? Slot(Section section, IReadOnlyList<string>? slots)
    {
        var i = (int)section;
        return slots is not null && i < slots.Count && slots[i].Length > 0 ? slots[i] : null;
    }

    /// <summary>Slots with one section set to <paramref name="key"/> (null for the default), the others kept.</summary>
    public static List<string> Setting(Section section, string? key, IReadOnlyList<string>? slots)
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
    public static string? AgentFor(Section section, IEnumerable<string> refs)
    {
        var matches = refs.Where(r => Parts(r) is { Length: 2 or 3 } p && p[^2] == App(section) && (section != Section.Assistant || p[^1] == "assistant")).ToList();
        return matches.FirstOrDefault(r => Parts(r).Length == 2) ?? matches.FirstOrDefault();
    }

    /// <summary>
    /// <paramref name="types"/> are the drag's formats, <paramref name="files"/> the types of its
    /// files (one per file). A file wins over data, so nothing is read twice; more than one file is
    /// refused, as a section takes one picture at a time.
    /// </summary>
    public static Offer Offer(IReadOnlyCollection<string> types, IReadOnlyList<string> files, Func<string, bool> isPicture, bool promised = false)
    {
        if (files.Count > 0) return files.Count == 1 && isPicture(files[0]) ? AISpace.Core.Offer.File : AISpace.Core.Offer.Nothing;
        if (types.Any(isPicture)) return AISpace.Core.Offer.Picture;
        return promised ? AISpace.Core.Offer.Promise : AISpace.Core.Offer.Nothing;
    }

    static readonly HashSet<string> PictureFormats = new(StringComparer.OrdinalIgnoreCase)
    {
        "PNG", "Bitmap", "DeviceIndependentBitmap", "Format17", "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
    };

    static readonly HashSet<string> PictureExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic",
    };

    /// <summary>A clipboard or drag format that carries a picture, or a file extension of one.</summary>
    public static bool IsPicture(string formatOrExtension) =>
        PictureFormats.Contains(formatOrExtension) || PictureExtensions.Contains(formatOrExtension);

    /// <summary>The lead put before the message when an app without an agent hands its work to Space Assistant (once).</summary>
    public static string WithLead(string draft, string lead) => draft.StartsWith(lead, StringComparison.Ordinal) ? draft : lead + "\n" + draft;

    /// <summary>
    /// Each section's entry and agent in a Space: what Settings set for it (an app or an agent, or
    /// nothing), else the section's default app. An agent takes the work itself; an app hands it to
    /// its own agent, or to Space Assistant when it has none. A widget never stands in a section.
    /// </summary>
    public static Dictionary<Section, DialEntry> Resolve(Catalogue? catalogue, IReadOnlyList<string>? slots)
    {
        var output = new Dictionary<Section, DialEntry>();
        var agentRefs = catalogue?.Agents.Select(a => a.Ref).ToList() ?? [];
        foreach (var section in Sections)
        {
            var slot = Slot(section, slots);
            var hidden = slot == EmptySlot;
            Entry? entry = null;
            if (catalogue is not null && !hidden)
            {
                if (slot is not null) entry = catalogue.Entry(slot);
                else
                {
                    var pool = section == Section.Assistant ? catalogue.Agents : catalogue.Apps;
                    var r = RefFor(section, pool.Select(e => e.Ref));
                    entry = pool.FirstOrDefault(e => e.Ref == r);
                }
            }
            if (entry is null || entry.Kind == EntryKind.Widget)
            {
                output[section] = new DialEntry(null, null, false, hidden);
                continue;
            }
            var own = entry.Kind == EntryKind.Agent ? entry.Ref : AgentForApp(entry.Ref, agentRefs);
            var agent = own ?? AgentFor(Section.Assistant, agentRefs);
            output[section] = agent is null ? new DialEntry(null, null, false, hidden) : new DialEntry(entry, agent, own is null, hidden);
        }
        return output;
    }
}

/// <summary>What one section shows and where its work goes: the entry, the agent's ref, whether that agent is borrowed (Space Assistant), whether Settings left it empty.</summary>
public sealed record DialEntry(Entry? Entry, string? Agent, bool Borrowed, bool Hidden);
