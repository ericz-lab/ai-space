namespace AISpace.Core;

public static class Versions
{
    /// <summary>Whether <paramref name="a"/> is newer than <paramref name="b"/> (x.y.z with an optional pre-release, which sorts before its release).</summary>
    public static bool Newer(string a, string b)
    {
        static (int[] Nums, string? Pre) Parse(string v)
        {
            var parts = v.Trim().TrimStart('v').Split('-', 2);
            var nums = parts[0].Split('.').Select(n => int.TryParse(n, out var x) ? x : 0).ToArray();
            return (nums, parts.Length > 1 ? parts[1] : null);
        }
        var x = Parse(a);
        var y = Parse(b);
        for (var i = 0; i < 3; i++)
        {
            var d = (i < x.Nums.Length ? x.Nums[i] : 0) - (i < y.Nums.Length ? y.Nums[i] : 0);
            if (d != 0) return d > 0;
        }
        if (x.Pre == y.Pre) return false;
        if (x.Pre is null) return true;
        if (y.Pre is null) return false;
        return string.CompareOrdinal(x.Pre, y.Pre) > 0;
    }
}
