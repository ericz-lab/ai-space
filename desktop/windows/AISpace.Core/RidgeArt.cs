namespace AISpace.Core;

/// <summary>
/// The mountain range behind the welcome page, drawn in binary digits: a few peaks whose slopes
/// meet, with a little noise along the line, as an image-to-ASCII tool would draw a picture with
/// a "01" character set and ordered (Bayer) dithering. The crest is drawn whole; below it the
/// slopes facing the light (from the left) keep more digits than those turned away. The picture
/// is the same every time and fills whatever columns and rows it is given.
/// </summary>
public static class RidgeArt
{
    private const int Seed = 11;
    // Peaks stand about Spacing picture-heights apart, Low to High of it tall; a wider picture
    // shows more of them, not the same ones stretched.
    private const double Spacing = 0.9, Low = 0.50, High = 0.96, Slope = 0.87, Density = 0.14;

    private static readonly double[,] Bayer =
    {
        { 0, 8, 2, 10 }, { 12, 4, 14, 6 }, { 3, 11, 1, 9 }, { 15, 7, 13, 5 },
    };

    /// <summary>
    /// <paramref name="rows"/> lines of <paramref name="cols"/> characters each, '0', '1' or a
    /// space. <paramref name="cellAspect"/> is a character's width over the line height, so the
    /// slopes keep their angle whatever the font.
    /// </summary>
    public static string[] Lines(int cols, int rows, double cellAspect = 0.6)
    {
        if (cols <= 0 || rows <= 0) return [];
        var aspect = cols * cellAspect / rows;
        var heights = new double[cols + 2];
        for (var x = 0; x < heights.Length; x++) heights[x] = Height((x - 0.5) / cols, aspect) * rows;
        var lines = new string[rows];
        var line = new char[cols];
        for (var y = 0; y < rows; y++)
        {
            for (var x = 0; x < cols; x++)
            {
                var h = heights[x + 1];
                var depth = y + 0.5 - (rows - h);
                var show = false;
                if (depth >= 0)
                {
                    double left = heights[x], right = heights[x + 2];
                    // A steep slope drops more than a row per column: the crest fills the gap.
                    var crest = Math.Max(1, (h - Math.Min(left, right)) * 0.9);
                    var density = Density * (right < left ? 1.25 : 0.65);
                    show = depth < crest || density > (Bayer[y % 4, x % 4] + 0.5) / 16;
                }
                line[x] = show ? (Hash(x * 131 + y * 977) < 0.5 ? '0' : '1') : ' ';
            }
            lines[y] = new string(line);
        }
        return lines;
    }

    /// <summary>The range's height at <paramref name="u"/> (0 to 1 across), as a fraction of the picture's height.</summary>
    private static double Height(double u, double aspect)
    {
        // v: across the picture in picture-heights, 0 in the middle, so it grows from the centre.
        var v = (u - 0.5) * aspect;
        var h = 0.0;
        var last = (int)Math.Ceiling(aspect / 2 / Spacing) + 1;
        for (var i = -last; i <= last; i++)
        {
            var px = (i - 0.5 + Hash(Seed * 100 + i) * 0.8) * Spacing;
            var ph = Low + (High - Low) * Hash(Seed * 100 + i + 50);
            var s = Slope * (0.7 + 0.6 * Hash(Seed * 100 + i + 90));
            h = Math.Max(h, ph - Math.Abs(v - px) * s);
        }
        return h + 0.035 * (Noise(v * 1.2, Seed) - 0.5) + 0.015 * (Noise(v * 4, Seed + 3) - 0.5);
    }

    private static double Noise(double x, int seed)
    {
        var i = (int)Math.Floor(x);
        var f = x - i;
        var u = f * f * (3 - 2 * f);
        return Hash(i * 7919 + seed) * (1 - u) + Hash((i + 1) * 7919 + seed) * u;
    }

    /// <summary>A number in [0, 1) from <paramref name="n"/>, the same on every machine.</summary>
    internal static double Hash(int n)
    {
        unchecked
        {
            var x = (uint)n ^ 0x9e3779b9u;
            x *= 0x85ebca6bu;
            x ^= x >> 13;
            x *= 0xc2b2ae35u;
            x ^= x >> 16;
            return x / 4294967296.0;
        }
    }
}
