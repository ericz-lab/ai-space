using System.Windows;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace;

/// <summary>
/// An icon read by <see cref="SvgReader"/> as a WPF drawing: a frozen <see cref="DrawingImage"/>
/// of the icon's view box, sharp at any scale. Every brush and pen is made new from its colours
/// and frozen (a theme brush is never cloned), and anything WPF refuses leaves the whole icon to
/// its fallback: this never throws.
/// </summary>
internal static class SvgDrawing
{
    public static ImageSource? Image(byte[] bytes)
    {
        try
        {
            var text = System.Text.Encoding.UTF8.GetString(bytes);
            return SvgReader.Read(text) is { } doc ? Image(doc) : null;
        }
        catch (Exception e) when (e is ArgumentException or FormatException or InvalidOperationException or NotSupportedException)
        {
            Shell.Log.Write($"svg icon not drawn: {e.Message}");
            return null;
        }
    }

    public static ImageSource? Image(SvgDocument doc)
    {
        try
        {
            var box = new Rect(doc.X, doc.Y, doc.Width, doc.Height);
            var root = new DrawingGroup { ClipGeometry = Frozen(new RectangleGeometry(box)) };
            // The view box itself, transparent: the image is the whole box even where nothing is drawn.
            root.Children.Add(new GeometryDrawing(Brushes.Transparent, null, Frozen(new RectangleGeometry(box))));
            root.Children.Add(Group(doc.Root));
            root.Freeze();
            var image = new DrawingImage(root);
            image.Freeze();
            return image;
        }
        catch (Exception e) when (e is ArgumentException or FormatException or InvalidOperationException or NotSupportedException)
        {
            Shell.Log.Write($"svg icon not drawn: {e.Message}");
            return null;
        }
    }

    private static T Frozen<T>(T f) where T : Freezable
    {
        f.Freeze();
        return f;
    }

    private static Transform? Matrix(SvgMatrix m) => m.IsIdentity ? null : Frozen(new MatrixTransform(m.A, m.B, m.C, m.D, m.E, m.F));

    private static Drawing Group(SvgGroup g)
    {
        var group = new DrawingGroup { Transform = Matrix(g.Transform), Opacity = g.Opacity };
        foreach (var child in g.Children)
        {
            var drawing = child switch
            {
                SvgGroup sub => Group(sub),
                SvgShape shape => Shape(shape),
                _ => null,
            };
            if (drawing is not null) group.Children.Add(drawing);
        }
        return group;
    }

    private static Drawing? Shape(SvgShape s)
    {
        var geometry = Geometry(s);
        if (geometry is null) return null;
        var fill = s.Fill is { } f ? Brush(f) : null;
        Pen? pen = null;
        if (s.Stroke is { } st && Brush(st) is { } strokeBrush)
        {
            var cap = s.LineCap switch { "round" => PenLineCap.Round, "square" => PenLineCap.Square, _ => PenLineCap.Flat };
            pen = new Pen(strokeBrush, s.StrokeWidth)
            {
                StartLineCap = cap,
                EndLineCap = cap,
                DashCap = cap,
                LineJoin = s.LineJoin switch { "round" => PenLineJoin.Round, "bevel" => PenLineJoin.Bevel, _ => PenLineJoin.Miter },
                MiterLimit = 4,
            };
            pen.Freeze();
        }
        if (fill is null && pen is null) return null;
        var drawing = new GeometryDrawing(fill, pen, geometry);
        if (s.Transform.IsIdentity && s.Opacity >= 1) return drawing;
        var group = new DrawingGroup { Transform = Matrix(s.Transform), Opacity = s.Opacity };
        group.Children.Add(drawing);
        return group;
    }

    private static Geometry? Geometry(SvgShape s)
    {
        var n = s.Numbers;
        Geometry? g = s.Kind switch
        {
            // WPF's path markup fills even-odd unless told otherwise; SVG fills non-zero by default.
            SvgShapeKind.Path when s.PathData is { } d => System.Windows.Media.Geometry.Parse((s.EvenOdd ? "F0 " : "F1 ") + d),
            SvgShapeKind.Rect => new RectangleGeometry(new Rect(n[0], n[1], n[2], n[3]), n[4], n[5]),
            SvgShapeKind.Circle => new EllipseGeometry(new Point(n[0], n[1]), n[2], n[2]),
            SvgShapeKind.Ellipse => new EllipseGeometry(new Point(n[0], n[1]), n[2], n[3]),
            SvgShapeKind.Line => new LineGeometry(new Point(n[0], n[1]), new Point(n[2], n[3])),
            _ => null,
        };
        if (g is null) return null;
        g.Freeze();
        return g;
    }

    private static Color ColorOf(uint argb) => Color.FromArgb((byte)(argb >> 24), (byte)(argb >> 16), (byte)(argb >> 8), (byte)argb);

    private static Brush? Brush(SvgPaint paint)
    {
        Brush brush;
        switch (paint)
        {
            case SvgColor c:
                brush = new SolidColorBrush(ColorOf(c.Argb));
                break;
            case SvgLinearGradient l:
                brush = new LinearGradientBrush(Stops(l.Stops), new Point(l.X1, l.Y1), new Point(l.X2, l.Y2))
                {
                    MappingMode = l.UserSpace ? BrushMappingMode.Absolute : BrushMappingMode.RelativeToBoundingBox,
                    Opacity = l.Opacity,
                    Transform = Matrix(l.Transform),
                };
                break;
            case SvgRadialGradient r:
                brush = new RadialGradientBrush(Stops(r.Stops))
                {
                    MappingMode = r.UserSpace ? BrushMappingMode.Absolute : BrushMappingMode.RelativeToBoundingBox,
                    Center = new Point(r.Cx, r.Cy),
                    GradientOrigin = new Point(r.Fx, r.Fy),
                    RadiusX = r.R,
                    RadiusY = r.R,
                    Opacity = r.Opacity,
                    Transform = Matrix(r.Transform),
                };
                break;
            default:
                return null;
        }
        brush.Freeze();
        return brush;
    }

    private static GradientStopCollection Stops(IReadOnlyList<SvgStop> stops)
    {
        var c = new GradientStopCollection(stops.Select(s => new GradientStop(ColorOf(s.Argb), s.Offset)));
        c.Freeze();
        return c;
    }
}
