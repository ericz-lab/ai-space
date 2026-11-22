using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace AISpace.Core;

/// <summary>A 2-D affine transform as SVG writes it: <c>matrix(a b c d e f)</c>, mapping (x, y) to (a·x + c·y + e, b·x + d·y + f).</summary>
public readonly record struct SvgMatrix(double A, double B, double C, double D, double E, double F)
{
    public static readonly SvgMatrix Identity = new(1, 0, 0, 1, 0, 0);

    public bool IsIdentity => this == Identity;

    /// <summary>This transform applied after <paramref name="inner"/> (an element's own transform inside its parent's).</summary>
    public SvgMatrix Then(SvgMatrix inner) => new(
        A * inner.A + C * inner.B,
        B * inner.A + D * inner.B,
        A * inner.C + C * inner.D,
        B * inner.C + D * inner.D,
        A * inner.E + C * inner.F + E,
        B * inner.E + D * inner.F + F);

    public (double X, double Y) Apply(double x, double y) => (A * x + C * y + E, B * x + D * y + F);
}

/// <summary>A colour stop of a gradient: where it is (0…1) and its colour as ARGB.</summary>
public sealed record SvgStop(double Offset, uint Argb);

/// <summary>How a shape is filled or stroked: one colour, or a gradient.</summary>
public abstract record SvgPaint;

/// <summary>One colour, its opacity folded into the alpha.</summary>
public sealed record SvgColor(uint Argb) : SvgPaint;

/// <summary>
/// A linear gradient from (X1, Y1) to (X2, Y2): in the shape's bounding box (0…1) unless
/// <see cref="UserSpace"/>, then in the drawing's units.
/// </summary>
public sealed record SvgLinearGradient(double X1, double Y1, double X2, double Y2, bool UserSpace, IReadOnlyList<SvgStop> Stops, double Opacity, SvgMatrix Transform) : SvgPaint;

/// <summary>A radial gradient around (Cx, Cy) of radius R, its focus at (Fx, Fy); units as <see cref="SvgLinearGradient"/>.</summary>
public sealed record SvgRadialGradient(double Cx, double Cy, double R, double Fx, double Fy, bool UserSpace, IReadOnlyList<SvgStop> Stops, double Opacity, SvgMatrix Transform) : SvgPaint;

public enum SvgShapeKind
{
    Path,
    Rect,
    Circle,
    Ellipse,
    Line,
}

/// <summary>Something drawn: a group of nodes, or one shape.</summary>
public abstract record SvgNode(SvgMatrix Transform, double Opacity);

public sealed record SvgGroup(SvgMatrix Transform, double Opacity, IReadOnlyList<SvgNode> Children) : SvgNode(Transform, Opacity);

/// <summary>
/// One shape. A path, polygon or polyline is <see cref="PathData"/> (normalized: one command
/// letter per segment, numbers separated by spaces, which WPF's path markup reads as SVG's);
/// a rectangle, circle, ellipse or line is its numbers in <see cref="Numbers"/> (rect: x y width
/// height rx ry; circle: cx cy r; ellipse: cx cy rx ry; line: x1 y1 x2 y2).
/// </summary>
public sealed record SvgShape(SvgMatrix Transform, double Opacity, SvgShapeKind Kind, string? PathData, IReadOnlyList<double> Numbers,
    SvgPaint? Fill, SvgPaint? Stroke, double StrokeWidth, string LineCap, string LineJoin, bool EvenOdd) : SvgNode(Transform, Opacity);

/// <summary>A drawing read from SVG: its view box (x, y, width, height) and its content.</summary>
public sealed record SvgDocument(double X, double Y, double Width, double Height, SvgGroup Root);

/// <summary>
/// A small, defensive SVG reader for the Space's icons (the panel's built-in icons and agents'
/// avatars are SVG, which WPF cannot draw). It reads <c>svg</c> with its <c>viewBox</c>, <c>g</c>,
/// <c>path</c>, <c>rect</c> (with <c>rx</c>/<c>ry</c>), <c>circle</c>, <c>ellipse</c>, <c>line</c>,
/// <c>polygon</c>, <c>polyline</c>; presentation attributes and the <c>style</c> attribute
/// (<c>fill</c>, <c>stroke</c>, <c>stroke-width</c>, <c>stroke-linecap</c>, <c>stroke-linejoin</c>,
/// <c>fill-rule</c>, <c>opacity</c>, <c>fill-opacity</c>, <c>stroke-opacity</c>), inherited as SVG
/// inherits them; <c>transform</c> (matrix, translate, scale, rotate, skewX, skewY); linear and radial
/// gradients in <c>defs</c> (stops, units, <c>gradientTransform</c>, <c>href</c> to another
/// gradient's stops); colours as #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba() and common names.
/// Filters (drop shadows, glows) are left out: the shapes are drawn without them. Anything that
/// would paint what it cannot read (text, embedded images, <c>use</c>, masks, clip paths, CSS style
/// sheets) makes the whole icon unreadable (null), so the caller keeps its fallback rather than
/// draw half an icon. It never throws, refuses DTDs and external references, and limits the size.
/// </summary>
public static class SvgReader
{
    public const int MaxChars = 512 * 1024, MaxElements = 4000;

    private static readonly HashSet<string> Unsupported = ["text", "image", "use", "mask", "clipPath", "foreignObject", "style", "pattern", "symbol", "marker", "switch", "a", "textPath", "tspan"];
    private static readonly HashSet<string> Skipped = ["title", "desc", "metadata", "filter"];

    /// <summary>The drawing, or null when the text is not an SVG this reader can draw whole.</summary>
    public static SvgDocument? Read(string text)
    {
        if (string.IsNullOrEmpty(text) || text.Length > MaxChars) return null;
        try
        {
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                XmlResolver = null,
                MaxCharactersInDocument = MaxChars,
                IgnoreComments = true,
                IgnoreProcessingInstructions = true,
            };
            var doc = new XmlDocument { XmlResolver = null };
            using (var reader = XmlReader.Create(new StringReader(text), settings)) doc.Load(reader);
            var root = doc.DocumentElement;
            if (root is null || root.LocalName != "svg") return null;
            if (root.GetElementsByTagName("*").Count > MaxElements) return null;
            var ctx = new Context();
            foreach (XmlElement e in root.GetElementsByTagName("*"))
            {
                if (Unsupported.Contains(e.LocalName)) return null;
                if (e.HasAttribute("clip-path") || e.HasAttribute("mask")) return null;
                if (e.LocalName is "linearGradient" or "radialGradient" && e.GetAttribute("id") is { Length: > 0 } id) ctx.Gradients[id] = e;
            }
            var (vx, vy, vw, vh) = ViewBox(root);
            if (!(vw > 0 && vh > 0)) return null;
            var group = Group(root, Style.Initial, ctx, depth: 0);
            if (group is null || ctx.Failed || ctx.Drawn == 0) return null;
            return new SvgDocument(vx, vy, vw, vh, group);
        }
        catch (Exception e) when (e is XmlException or InvalidOperationException or FormatException or OverflowException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Whether the bytes look like SVG (an XML document whose first element is <c>svg</c>), not a picture WPF decodes itself.</summary>
    public static bool LooksLikeSvg(ReadOnlySpan<byte> bytes)
    {
        var head = Encoding.UTF8.GetString(bytes[..Math.Min(bytes.Length, 1024)]).TrimStart('﻿', ' ', '\t', '\r', '\n');
        return head.StartsWith('<') && head.Contains("<svg", StringComparison.Ordinal);
    }

    private sealed class Context
    {
        public readonly Dictionary<string, XmlElement> Gradients = [];
        public bool Failed;
        public int Drawn;
    }

    /// <summary>The inherited presentation properties.</summary>
    private sealed record Style(string Fill, string Stroke, double StrokeWidth, string LineCap, string LineJoin, bool EvenOdd, double FillOpacity, double StrokeOpacity)
    {
        public static readonly Style Initial = new("#000", "none", 1, "butt", "miter", false, 1, 1);
    }

    private static (double, double, double, double) ViewBox(XmlElement svg)
    {
        var vb = Numbers(svg.GetAttribute("viewBox"));
        if (vb.Count == 4) return (vb[0], vb[1], vb[2], vb[3]);
        var w = Length(svg.GetAttribute("width")) ?? 0;
        var h = Length(svg.GetAttribute("height")) ?? 0;
        return (0, 0, w, h);
    }

    /// <summary>An attribute, the <c>style</c> attribute's declaration winning over it.</summary>
    private static string? Prop(XmlElement e, string name)
    {
        var style = e.GetAttribute("style");
        if (style.Length > 0)
        {
            foreach (var decl in style.Split(';'))
            {
                var i = decl.IndexOf(':');
                if (i > 0 && decl[..i].Trim() == name) return decl[(i + 1)..].Trim();
            }
        }
        return e.HasAttribute(name) ? e.GetAttribute(name).Trim() : null;
    }

    private static Style Inherit(XmlElement e, Style parent)
    {
        var s = parent;
        if (Prop(e, "fill") is { } fill) s = s with { Fill = fill };
        if (Prop(e, "stroke") is { } stroke) s = s with { Stroke = stroke };
        if (Prop(e, "stroke-width") is { } sw && Length(sw) is { } w) s = s with { StrokeWidth = w };
        if (Prop(e, "stroke-linecap") is { } cap) s = s with { LineCap = cap };
        if (Prop(e, "stroke-linejoin") is { } join) s = s with { LineJoin = join };
        if (Prop(e, "fill-rule") is { } rule) s = s with { EvenOdd = rule == "evenodd" };
        if (Prop(e, "fill-opacity") is { } fo && Unit(fo) is { } f) s = s with { FillOpacity = f };
        if (Prop(e, "stroke-opacity") is { } so && Unit(so) is { } o) s = s with { StrokeOpacity = o };
        return s;
    }

    private static SvgGroup? Group(XmlElement e, Style parent, Context ctx, int depth)
    {
        if (depth > 32) return null;
        var style = Inherit(e, parent);
        var children = new List<SvgNode>();
        foreach (var child in e.ChildNodes.OfType<XmlElement>())
        {
            if (child.NamespaceURI.Length > 0 && child.NamespaceURI != "http://www.w3.org/2000/svg") continue;
            if (child.LocalName is "defs" or "linearGradient" or "radialGradient" || Skipped.Contains(child.LocalName)) continue;
            if (Prop(child, "display") == "none" || Prop(child, "visibility") == "hidden") continue;
            if (child.LocalName == "svg")
            {
                // A nested viewport (its own viewBox and size): not read.
                ctx.Failed = true;
                return null;
            }
            SvgNode? node = child.LocalName == "g" ? Group(child, style, ctx, depth + 1) : Shape(child, style, ctx);
            if (ctx.Failed) return null;
            if (node is not null) children.Add(node);
        }
        return new SvgGroup(depth == 0 ? SvgMatrix.Identity : Transform(e.GetAttribute("transform")), depth == 0 ? 1 : Unit(Prop(e, "opacity")) ?? 1, children);
    }

    private static SvgShape? Shape(XmlElement e, Style parent, Context ctx)
    {
        var s = Inherit(e, parent);
        double N(string name, double fallback = 0) => Length(e.GetAttribute(name)) ?? fallback;
        SvgShapeKind kind;
        string? path = null;
        List<double> numbers = [];
        switch (e.LocalName)
        {
            case "path":
                kind = SvgShapeKind.Path;
                path = SvgPath.Normalize(e.GetAttribute("d"));
                if (path is null) return null;
                break;
            case "polygon":
            case "polyline":
            {
                kind = SvgShapeKind.Path;
                var p = Numbers(e.GetAttribute("points"));
                if (p.Count < 4) return null;
                var b = new StringBuilder("M ").Append(F(p[0])).Append(' ').Append(F(p[1]));
                for (var i = 2; i + 1 < p.Count; i += 2) b.Append(" L ").Append(F(p[i])).Append(' ').Append(F(p[i + 1]));
                if (e.LocalName == "polygon") b.Append(" Z");
                path = b.ToString();
                break;
            }
            case "rect":
            {
                kind = SvgShapeKind.Rect;
                double w = N("width"), h = N("height");
                if (!(w > 0 && h > 0)) return null;
                double? rx = Length(e.GetAttribute("rx")), ry = Length(e.GetAttribute("ry"));
                var x = rx ?? ry ?? 0;
                var y = ry ?? rx ?? 0;
                numbers = [N("x"), N("y"), w, h, Math.Clamp(x, 0, w / 2), Math.Clamp(y, 0, h / 2)];
                break;
            }
            case "circle":
                kind = SvgShapeKind.Circle;
                numbers = [N("cx"), N("cy"), N("r")];
                if (!(numbers[2] > 0)) return null;
                break;
            case "ellipse":
                kind = SvgShapeKind.Ellipse;
                numbers = [N("cx"), N("cy"), N("rx"), N("ry")];
                if (!(numbers[2] > 0 && numbers[3] > 0)) return null;
                break;
            case "line":
                kind = SvgShapeKind.Line;
                numbers = [N("x1"), N("y1"), N("x2"), N("y2")];
                break;
            default:
                // An element of no drawing (an unknown one in another vocabulary): left out.
                return null;
        }
        var fill = kind == SvgShapeKind.Line ? null : Paint(s.Fill, s.FillOpacity, ctx);
        var stroke = s.StrokeWidth > 0 ? Paint(s.Stroke, s.StrokeOpacity, ctx) : null;
        if (ctx.Failed || (fill is null && stroke is null)) return null;
        ctx.Drawn++;
        return new SvgShape(Transform(e.GetAttribute("transform")), Unit(Prop(e, "opacity")) ?? 1, kind, path, numbers, fill, stroke, s.StrokeWidth, s.LineCap, s.LineJoin, s.EvenOdd);
    }

    private static SvgPaint? Paint(string value, double opacity, Context ctx)
    {
        value = value.Trim();
        if (value is "none" or "transparent" or "") return null;
        if (value.StartsWith("url(", StringComparison.Ordinal))
        {
            var end = value.IndexOf(')');
            var id = end > 4 ? value[4..end].Trim().Trim('\'', '"').TrimStart('#') : "";
            if (!ctx.Gradients.TryGetValue(id, out var g))
            {
                // A paint server it does not know: a fallback colour after the url, else nothing.
                var rest = end > 0 ? value[(end + 1)..].Trim() : "";
                return rest.Length > 0 ? Paint(rest, opacity, ctx) : null;
            }
            return Gradient(g, opacity, ctx);
        }
        return SvgColors.Parse(value) is { } argb ? new SvgColor(SvgColors.WithOpacity(argb, opacity)) : null;
    }

    private static SvgPaint? Gradient(XmlElement g, double opacity, Context ctx)
    {
        // Stops and units may come from the gradient it refers to (href).
        var chain = new List<XmlElement> { g };
        for (var cur = g; chain.Count < 8 && Href(cur) is { } id && ctx.Gradients.TryGetValue(id, out var next) && !chain.Contains(next); cur = next) chain.Add(next);
        string? Attr(string name) => chain.Select(x => x.HasAttribute(name) ? x.GetAttribute(name) : null).FirstOrDefault(v => v is not null);
        var stopsOf = chain.FirstOrDefault(x => x.ChildNodes.OfType<XmlElement>().Any(c => c.LocalName == "stop"));
        var stops = new List<SvgStop>();
        double last = 0;
        foreach (var stop in stopsOf?.ChildNodes.OfType<XmlElement>().Where(c => c.LocalName == "stop") ?? [])
        {
            var offset = Prop(stop, "offset") is { } o ? Fraction(o) ?? 0 : 0;
            last = Math.Max(last, Math.Clamp(offset, 0, 1));
            var color = SvgColors.Parse(Prop(stop, "stop-color") ?? "#000") ?? 0xFF000000;
            stops.Add(new SvgStop(last, SvgColors.WithOpacity(color, Unit(Prop(stop, "stop-opacity")) ?? 1)));
        }
        if (stops.Count == 0) return null;
        if (stops.Count == 1) return new SvgColor(SvgColors.WithOpacity(stops[0].Argb, opacity));
        var user = Attr("gradientUnits") == "userSpaceOnUse";
        double C(string name, double fallback) => Attr(name) is { } v ? (user ? Length(v) : Fraction(v)) ?? fallback : fallback;
        var transform = Transform(Attr("gradientTransform") ?? "");
        if (g.LocalName == "linearGradient") return new SvgLinearGradient(C("x1", 0), C("y1", 0), C("x2", 1), C("y2", 0), user, stops, opacity, transform);
        var cx = C("cx", 0.5);
        var cy = C("cy", 0.5);
        return new SvgRadialGradient(cx, cy, C("r", 0.5), C("fx", cx), C("fy", cy), user, stops, opacity, transform);
    }

    private static string? Href(XmlElement e)
    {
        var h = e.GetAttribute("href");
        if (h.Length == 0) h = e.GetAttribute("href", "http://www.w3.org/1999/xlink");
        return h.StartsWith('#') ? h[1..] : null;
    }

    // Numbers.

    private static readonly Regex NumberPattern = new(@"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", RegexOptions.CultureInvariant);

    public static List<double> Numbers(string? text)
    {
        var list = new List<double>();
        if (string.IsNullOrEmpty(text)) return list;
        foreach (Match m in NumberPattern.Matches(text))
        {
            if (double.TryParse(m.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v)) list.Add(v);
        }
        return list;
    }

    /// <summary>A length in user units: a number, with <c>px</c> or no unit; anything else (%, em) is not read.</summary>
    public static double? Length(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        if (t.EndsWith("px", StringComparison.Ordinal)) t = t[..^2];
        return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v) ? v : null;
    }

    /// <summary>A number or a percentage, as a fraction (<c>50%</c> is 0.5).</summary>
    private static double? Fraction(string text)
    {
        var t = text.Trim();
        if (t.EndsWith('%')) return Length(t[..^1]) is { } p ? p / 100 : null;
        return Length(t);
    }

    /// <summary>An opacity, 0…1.</summary>
    private static double? Unit(string? text) => text is null ? null : Fraction(text) is { } v ? Math.Clamp(v, 0, 1) : null;

    private static string F(double v) => v.ToString("R", CultureInfo.InvariantCulture);

    private static readonly Regex TransformPattern = new(@"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)", RegexOptions.CultureInvariant);

    /// <summary>A <c>transform</c> attribute as one matrix; the identity for an empty or unreadable one.</summary>
    public static SvgMatrix Transform(string? text)
    {
        var m = SvgMatrix.Identity;
        if (string.IsNullOrWhiteSpace(text)) return m;
        foreach (Match t in TransformPattern.Matches(text))
        {
            var a = Numbers(t.Groups[2].Value);
            SvgMatrix step;
            switch (t.Groups[1].Value)
            {
                case "matrix" when a.Count == 6:
                    step = new SvgMatrix(a[0], a[1], a[2], a[3], a[4], a[5]);
                    break;
                case "translate" when a.Count >= 1:
                    step = new SvgMatrix(1, 0, 0, 1, a[0], a.Count > 1 ? a[1] : 0);
                    break;
                case "scale" when a.Count >= 1:
                    step = new SvgMatrix(a[0], 0, 0, a.Count > 1 ? a[1] : a[0], 0, 0);
                    break;
                case "rotate" when a.Count >= 1:
                {
                    var r = a[0] * Math.PI / 180;
                    var (cos, sin) = (Math.Cos(r), Math.Sin(r));
                    step = new SvgMatrix(cos, sin, -sin, cos, 0, 0);
                    if (a.Count >= 3)
                    {
                        // rotate(a cx cy): translate(cx cy) rotate(a) translate(-cx -cy).
                        step = new SvgMatrix(1, 0, 0, 1, a[1], a[2]).Then(step).Then(new SvgMatrix(1, 0, 0, 1, -a[1], -a[2]));
                    }
                    break;
                }
                case "skewX" when a.Count >= 1:
                    step = new SvgMatrix(1, 0, Math.Tan(a[0] * Math.PI / 180), 1, 0, 0);
                    break;
                case "skewY" when a.Count >= 1:
                    step = new SvgMatrix(1, Math.Tan(a[0] * Math.PI / 180), 0, 1, 0, 0);
                    break;
                default:
                    continue;
            }
            m = m.Then(step);
        }
        return m;
    }
}

/// <summary>
/// SVG path data rewritten for WPF's path markup, which reads the same commands: every segment
/// with its own command letter (SVG lets a command repeat, and makes the pairs after a move
/// line-tos), every number apart, arc flags apart (SVG lets them run together, <c>a1 1 0 011 1</c>).
/// </summary>
public static class SvgPath
{
    private static readonly Dictionary<char, int> Args = new()
    {
        ['M'] = 2, ['L'] = 2, ['H'] = 1, ['V'] = 1, ['C'] = 6, ['S'] = 4, ['Q'] = 4, ['T'] = 2, ['A'] = 7, ['Z'] = 0,
    };

    /// <summary>The normalized data, or null when it is not path data this can read.</summary>
    public static string? Normalize(string? d)
    {
        if (string.IsNullOrWhiteSpace(d) || d.Length > SvgReader.MaxChars) return null;
        var output = new StringBuilder();
        var i = 0;
        char? command = null;
        var segments = 0;
        while (true)
        {
            Skip(d, ref i);
            if (i >= d.Length) break;
            var c = d[i];
            if (char.IsAsciiLetter(c))
            {
                if (!Args.ContainsKey(char.ToUpperInvariant(c))) return null;
                command = c;
                i++;
                if (char.ToUpperInvariant(c) == 'Z')
                {
                    output.Append(c).Append(' ');
                    segments++;
                    continue;
                }
            }
            else if (command is null || char.ToUpperInvariant(command.Value) == 'Z')
            {
                return null;
            }
            var cmd = command!.Value;
            var upper = char.ToUpperInvariant(cmd);
            var values = new List<string>();
            for (var k = 0; k < Args[upper]; k++)
            {
                Skip(d, ref i);
                string? v = upper == 'A' && k is 3 or 4 ? Flag(d, ref i) : Number(d, ref i);
                if (v is null) return null;
                values.Add(v);
            }
            output.Append(cmd).Append(' ').Append(string.Join(' ', values)).Append(' ');
            segments++;
            // The pairs after a move are line-tos.
            if (upper == 'M') command = cmd == 'M' ? 'L' : 'l';
        }
        return segments > 0 ? output.ToString().TrimEnd() : null;
    }

    private static void Skip(string d, ref int i)
    {
        while (i < d.Length && (char.IsWhiteSpace(d[i]) || d[i] == ',')) i++;
    }

    private static string? Flag(string d, ref int i) => i < d.Length && d[i] is '0' or '1' ? d[i++].ToString() : null;

    private static string? Number(string d, ref int i)
    {
        var start = i;
        if (i < d.Length && d[i] is '+' or '-') i++;
        var digits = false;
        while (i < d.Length && char.IsAsciiDigit(d[i]))
        {
            i++;
            digits = true;
        }
        if (i < d.Length && d[i] == '.')
        {
            i++;
            while (i < d.Length && char.IsAsciiDigit(d[i]))
            {
                i++;
                digits = true;
            }
        }
        if (!digits) return null;
        if (i < d.Length && d[i] is 'e' or 'E')
        {
            var save = i;
            i++;
            if (i < d.Length && d[i] is '+' or '-') i++;
            if (i < d.Length && char.IsAsciiDigit(d[i]))
            {
                while (i < d.Length && char.IsAsciiDigit(d[i])) i++;
            }
            else
            {
                i = save;
            }
        }
        var text = d[start..i];
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) && double.IsFinite(v) ? v.ToString("R", CultureInfo.InvariantCulture) : null;
    }
}

/// <summary>SVG colours as ARGB.</summary>
public static class SvgColors
{
    private static readonly Dictionary<string, uint> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["black"] = 0xFF000000, ["white"] = 0xFFFFFFFF, ["red"] = 0xFFFF0000, ["green"] = 0xFF008000, ["blue"] = 0xFF0000FF,
        ["yellow"] = 0xFFFFFF00, ["orange"] = 0xFFFFA500, ["purple"] = 0xFF800080, ["gray"] = 0xFF808080, ["grey"] = 0xFF808080,
        ["silver"] = 0xFFC0C0C0, ["navy"] = 0xFF000080, ["teal"] = 0xFF008080, ["maroon"] = 0xFF800000, ["lime"] = 0xFF00FF00,
        ["aqua"] = 0xFF00FFFF, ["cyan"] = 0xFF00FFFF, ["fuchsia"] = 0xFFFF00FF, ["magenta"] = 0xFFFF00FF, ["olive"] = 0xFF808000,
        ["pink"] = 0xFFFFC0CB, ["gold"] = 0xFFFFD700, ["brown"] = 0xFFA52A2A, ["indigo"] = 0xFF4B0082, ["violet"] = 0xFFEE82EE,
        ["darkgray"] = 0xFFA9A9A9, ["lightgray"] = 0xFFD3D3D3, ["whitesmoke"] = 0xFFF5F5F5,
        // An icon has no text colour around it: the current colour is drawn black.
        ["currentColor"] = 0xFF000000,
    };

    private static readonly Regex Rgb = new(@"^rgba?\(\s*([^,\s]+)[\s,]+([^,\s]+)[\s,]+([^,\s/)]+)(?:[\s,/]+([^)\s]+))?\s*\)$", RegexOptions.CultureInvariant);

    /// <summary>A colour as ARGB, or null when it is none, a paint server or unreadable.</summary>
    public static uint? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var t = text.Trim();
        if (Named.TryGetValue(t, out var named)) return named;
        if (t.StartsWith('#'))
        {
            var h = t[1..];
            if (!h.All(char.IsAsciiHexDigit)) return null;
            if (h.Length is 3 or 4) h = string.Concat(h.Select(c => $"{c}{c}"));
            if (h.Length == 6) return 0xFF000000 | Convert.ToUInt32(h, 16);
            if (h.Length == 8)
            {
                var rgba = Convert.ToUInt32(h, 16);
                return (rgba << 24) | (rgba >> 8);
            }
            return null;
        }
        var m = Rgb.Match(t);
        if (!m.Success) return null;
        static double? Channel(string s) => s.EndsWith('%') ? SvgReader.Length(s[..^1]) * 2.55 : SvgReader.Length(s);
        var r = Channel(m.Groups[1].Value);
        var g = Channel(m.Groups[2].Value);
        var b = Channel(m.Groups[3].Value);
        if (r is null || g is null || b is null) return null;
        var alpha = m.Groups[4].Success ? (m.Groups[4].Value.EndsWith('%') ? SvgReader.Length(m.Groups[4].Value[..^1]) / 100 : SvgReader.Length(m.Groups[4].Value)) ?? 1 : 1;
        static uint B(double v) => (uint)Math.Clamp(Math.Round(v), 0, 255);
        return (B(alpha * 255) << 24) | (B(r.Value) << 16) | (B(g.Value) << 8) | B(b.Value);
    }

    /// <summary>The colour with its alpha multiplied by <paramref name="opacity"/>.</summary>
    public static uint WithOpacity(uint argb, double opacity)
    {
        var a = (uint)Math.Clamp(Math.Round((argb >> 24) * Math.Clamp(opacity, 0, 1)), 0, 255);
        return (a << 24) | (argb & 0x00FFFFFF);
    }
}
