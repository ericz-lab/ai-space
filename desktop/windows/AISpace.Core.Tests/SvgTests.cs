using System.Text;
using AISpace.Core;

namespace AISpace.Core.Tests;

public class SvgTests
{
    // Icons as a real Space serves them: an agent's avatar (/api/agents/ai-todo/planner/avatar) and
    // the panel's built-in Shortcuts and Terminal icons (/shortcuts.svg, /terminal.svg), trimmed.
    private const string Planner = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
          <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b4bf0"/><stop offset="1" stop-color="#2a2f6e"/></linearGradient></defs>
          <rect width="64" height="64" rx="14" fill="url(#g)"/>
          <rect x="14" y="16" width="36" height="34" rx="6" fill="none" stroke="#fff" stroke-width="3"/>
          <path d="M14 26h36" stroke="#fff" stroke-width="3"/>
          <path d="M22 12v8M42 12v8" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
          <rect x="32" y="32" width="12" height="6" rx="1.5" fill="#fff" opacity=".7"/>
          <path d="M46 40l1.3 3.4 3.4 1.3-3.4 1.3L46 49.4l-1.3-3.4-3.4-1.3 3.4-1.3z" fill="#fff"/>
        </svg>
        """;

    private const string Shortcuts = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbbf24"/><stop offset=".5" stop-color="#f59e0b"/><stop offset="1" stop-color="#ea580c"/></linearGradient>
          </defs>
          <rect width="64" height="64" rx="14" fill="url(#bg)"/>
          <rect x="1" y="1" width="62" height="62" rx="13" fill="none" stroke="#fff" stroke-opacity=".2"/>
          <!-- Stacked action cards. -->
          <rect x="13" y="18" width="34" height="34" rx="9" fill="#9a3412" fill-opacity=".16" transform="rotate(-12 30 35)"/>
          <path d="M37 18 26 32h8l-2 11 12-16h-8z" fill="#ea580c" stroke="#ea580c" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        """;

    private const string Terminal = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2c31"/><stop offset="1" stop-color="#0b0b0e"/></linearGradient>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="1.2" flood-color="#34d399" flood-opacity=".55"/></filter>
          </defs>
          <rect width="64" height="64" rx="14" fill="url(#bg)"/>
          <g filter="url(#glow)">
            <polyline points="15,21 27,32 15,43" fill="none" stroke="#34d399" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="32" y="38" width="17" height="5" rx="1.5" fill="#e5e7eb"/>
          </g>
          <circle cx="32" cy="32" r="8.2" fill="none" stroke="#000" stroke-opacity=".18" stroke-width="1"/>
        </svg>
        """;

    private static IEnumerable<SvgShape> Shapes(SvgNode n) => n switch
    {
        SvgShape s => [s],
        SvgGroup g => g.Children.SelectMany(Shapes),
        _ => [],
    };

    [Fact]
    public void ReadsTheSpacesOwnIcons()
    {
        var planner = SvgReader.Read(Planner)!;
        Assert.Equal((0d, 0d, 64d, 64d), (planner.X, planner.Y, planner.Width, planner.Height));
        var shapes = Shapes(planner.Root).ToList();
        Assert.Equal(6, shapes.Count);
        // The ground: a rounded square filled with the diagonal gradient, in the shape's box.
        var ground = shapes[0];
        Assert.Equal(SvgShapeKind.Rect, ground.Kind);
        Assert.Equal([0, 0, 64, 64, 14, 14], ground.Numbers);
        var gradient = Assert.IsType<SvgLinearGradient>(ground.Fill);
        Assert.Equal((0d, 0d, 1d, 1d, false), (gradient.X1, gradient.Y1, gradient.X2, gradient.Y2, gradient.UserSpace));
        Assert.Equal([new SvgStop(0, 0xFF5B4BF0), new SvgStop(1, 0xFF2A2F6E)], gradient.Stops);
        // A frame: stroke only.
        Assert.Null(shapes[1].Fill);
        Assert.Equal(new SvgColor(0xFFFFFFFF), shapes[1].Stroke);
        Assert.Equal(3, shapes[1].StrokeWidth);
        // An open path with no fill of its own still fills black by SVG's rule, as the panel draws it.
        Assert.Equal("M 14 26 h 36", shapes[2].PathData);
        Assert.Equal("M 22 12 v 8 M 42 12 v 8", shapes[3].PathData);
        Assert.Equal("round", shapes[3].LineCap);
        Assert.Equal(0.7, shapes[4].Opacity, 3);
        Assert.Equal("M 46 40 l 1.3 3.4 l 3.4 1.3 l -3.4 1.3 L 46 49.4 l -1.3 -3.4 l -3.4 -1.3 l 3.4 -1.3 z", shapes[5].PathData);

        var shortcuts = Shapes(SvgReader.Read(Shortcuts)!.Root).ToList();
        Assert.Equal(4, shortcuts.Count);
        Assert.Equal(3, Assert.IsType<SvgLinearGradient>(shortcuts[0].Fill).Stops.Count);
        Assert.Equal(new SvgColor(0x33FFFFFF), shortcuts[1].Stroke);
        Assert.Equal(new SvgColor(0x299A3412), shortcuts[2].Fill);
        // rotate(-12 30 35) keeps its centre where it is.
        var (x, y) = shortcuts[2].Transform.Apply(30, 35);
        Assert.Equal((30d, 35d), (Math.Round(x, 9), Math.Round(y, 9)));
        Assert.Equal("M 37 18 L 26 32 h 8 l -2 11 l 12 -16 h -8 z", shortcuts[3].PathData);
        Assert.Equal("round", shortcuts[3].LineJoin);

        // The glow filter is left out; the group and its shapes are drawn.
        var terminal = SvgReader.Read(Terminal)!;
        var group = Assert.IsType<SvgGroup>(terminal.Root.Children[1]);
        Assert.Equal("M 15 21 L 27 32 L 15 43", Assert.IsType<SvgShape>(group.Children[0]).PathData);
        Assert.Null(Assert.IsType<SvgShape>(group.Children[0]).Fill);
        var ring = Assert.IsType<SvgShape>(terminal.Root.Children[2]);
        Assert.Equal(SvgShapeKind.Circle, ring.Kind);
        Assert.Equal(new SvgColor(0x2E000000), ring.Stroke);
    }

    [Fact]
    public void LeavesWhatItCannotDrawWholeToTheFallback()
    {
        Assert.Null(SvgReader.Read(""));
        Assert.Null(SvgReader.Read("not xml"));
        Assert.Null(SvgReader.Read("<html><svg/></html>"));
        Assert.Null(SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>"""));
        Assert.Null(SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>A</text><rect width="1" height="1"/></svg>"""));
        Assert.Null(SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="x.png"/></svg>"""));
        Assert.Null(SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1" clip-path="url(#c)"/></svg>"""));
        // No DTD (entity expansion), no external reference is fetched.
        Assert.Null(SvgReader.Read("""<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1" height="1"/></svg>"""));
        Assert.Null(SvgReader.Read("<svg>" + new string(' ', SvgReader.MaxChars) + "</svg>"));
        // A path it cannot read is left out, the rest drawn.
        var partial = SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M 1 1 X 3"/><rect width="2" height="2" fill="red"/></svg>""")!;
        Assert.Single(Shapes(partial.Root));
        // Width and height stand in for a missing viewBox.
        var sized = SvgReader.Read("""<svg xmlns="http://www.w3.org/2000/svg" width="24px" height="24"><circle cx="12" cy="12" r="10" style="fill:#0f0;opacity:0.5"/></svg>""")!;
        Assert.Equal((24d, 24d), (sized.Width, sized.Height));
        Assert.Equal(new SvgColor(0xFF00FF00), Assert.IsType<SvgShape>(sized.Root.Children[0]).Fill);
        Assert.Equal(0.5, sized.Root.Children[0].Opacity);
    }

    [Fact]
    public void PathDataForWpf()
    {
        Assert.Equal("M 10 20 L 30 40 L 50 60", SvgPath.Normalize("M10,20 30,40 50 60"));
        Assert.Equal("m 1 1 l 2 2 z", SvgPath.Normalize("m1 1 2 2z"));
        Assert.Equal("M 0.5 0.5 L 0.25 -0.5", SvgPath.Normalize("M.5.5L.25-.5"));
        // Arc flags may run together in SVG; WPF wants them apart.
        Assert.Equal("M 0 0 a 1 1 0 0 1 1 1", SvgPath.Normalize("M0 0a1 1 0 011 1"));
        Assert.Equal("M 0 0 C 1 2 3 4 5 6 S 7 8 9 10 Q 1 1 2 2 T 3 3", SvgPath.Normalize("M0 0C1 2 3 4 5 6S7 8 9 10Q1 1 2 2T3 3"));
        Assert.Equal("M 100 0", SvgPath.Normalize("M1e2 0"));
        Assert.Null(SvgPath.Normalize("10 20"));
        Assert.Null(SvgPath.Normalize("M 1"));
        Assert.Null(SvgPath.Normalize("M 1 2 B 3"));
        Assert.Null(SvgPath.Normalize(""));
    }

    [Fact]
    public void ColoursAndTransforms()
    {
        Assert.Equal(0xFFFFFFFFu, SvgColors.Parse("#fff"));
        Assert.Equal(0xFF5B4BF0u, SvgColors.Parse("#5b4bf0"));
        Assert.Equal(0x80FF0000u, SvgColors.Parse("#ff000080"));
        Assert.Equal(0xFF102030u, SvgColors.Parse("rgb(16, 32, 48)"));
        Assert.Equal(0x80FF0000u, SvgColors.Parse("rgba(255,0,0,.5)"));
        Assert.Equal(0xFFFFFFFFu, SvgColors.Parse("White"));
        Assert.Null(SvgColors.Parse("url(#g)"));
        Assert.Null(SvgColors.Parse("#12"));
        Assert.Equal(0x33FFFFFFu, SvgColors.WithOpacity(0xFFFFFFFF, 0.2));

        Assert.True(SvgReader.Transform("").IsIdentity);
        Assert.Equal((15d, 25d), SvgReader.Transform("translate(10 20) scale(0.5)").Apply(10, 10));
        var (x, y) = SvgReader.Transform("rotate(90)").Apply(1, 0);
        Assert.Equal((0d, 1d), (Math.Round(x, 9), Math.Round(y, 9)));
        Assert.Equal(new SvgMatrix(1, 2, 3, 4, 5, 6), SvgReader.Transform("matrix(1,2,3,4,5,6)"));
        Assert.True(SvgReader.LooksLikeSvg(Encoding.UTF8.GetBytes("﻿<?xml version=\"1.0\"?>\n<svg/>")));
        Assert.False(SvgReader.LooksLikeSvg([0x89, 0x50, 0x4E, 0x47]));
    }
}
