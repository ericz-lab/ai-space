using AISpace.Core;

namespace AISpace.Core.Tests;

public class RidgeArtTests
{
    [Fact]
    public void TheRangeFillsTheGivenSizeWithBinaryDigitsAndIsTheSameEveryTime()
    {
        var lines = RidgeArt.Lines(120, 30);
        Assert.Equal(30, lines.Length);
        Assert.All(lines, l => Assert.Equal(120, l.Length));
        Assert.All(lines, l => Assert.Matches("^[01 ]*$", l));
        Assert.Equal(lines, RidgeArt.Lines(120, 30));
    }

    [Theory]
    [InlineData(120, 30)]
    [InlineData(60, 20)]
    [InlineData(240, 24)]
    public void TheSkyIsEmptyAndTheCrestRunsAcrossEveryColumn(int cols, int rows)
    {
        var lines = RidgeArt.Lines(cols, rows);
        // The highest peak stays under the top, the lowest valley well above the bottom.
        Assert.True(string.IsNullOrWhiteSpace(lines[0]));
        Assert.Contains(lines.Take(rows / 2), l => l.Trim().Length > 0);
        // A wide window shows more peaks, never a gap between them.
        for (var x = 0; x < cols; x++)
            Assert.Contains(lines, l => l[x] != ' ');
    }

    [Fact]
    public void NothingIsDrawnInNoRoom()
    {
        Assert.Empty(RidgeArt.Lines(0, 10));
        Assert.Empty(RidgeArt.Lines(10, 0));
    }
}
