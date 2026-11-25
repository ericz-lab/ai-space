using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>A run of a paragraph's text with its look: bold, italic, code, or a link (http and https only).</summary>
public sealed record MdSpan(string Text, bool Bold = false, bool Italic = false, bool Code = false, string? Link = null);

public enum MdBlockKind
{
    Paragraph,
    /// <summary><see cref="MdBlock.Level"/> 1 to 6.</summary>
    Heading,
    /// <summary>A list item: <see cref="MdBlock.Level"/> its depth, <see cref="MdBlock.Bullet"/> "•" or "1.".</summary>
    Item,
    Quote,
    /// <summary>Plain text in a monospace box: a fenced code block.</summary>
    Code,
    /// <summary>A table drawn in text columns, for the monospace box.</summary>
    Table,
    Rule,
}

public sealed record MdBlock(MdBlockKind Kind, IReadOnlyList<MdSpan> Spans, string Text = "", int Level = 0, string Bullet = "");

/// <summary>
/// An agent's reply as blocks a native view lays out, the Linux client's <c>core/markdown.ts</c>
/// with spans instead of Pango markup: paragraphs, headings, list items, quotes, code, tables and
/// rules; inline code spans, escapes, links (http and https only), bare URLs, bold and italics.
/// Anything else stays as text, so a half-streamed reply still reads.
/// </summary>
public static partial class ChatMarkdown
{
    [GeneratedRegex(@"(?<code>(?<tick>`+)(?<c>[\s\S]*?[^`])\k<tick>(?!`))|\\(?<esc>[\\`*{}_\[\]()#+.!|>-])|\[(?<label>[^\]]+)\]\((?<url>https?:[^)\s]+)\)|(?<bare>https?://[^\s<>　-〿一-鿿＀-￯]+)")]
    private static partial Regex Protected();

    [GeneratedRegex(@"\*\*\*(?<bi>[^*]+?)\*\*\*|\*\*(?<b>.+?)\*\*|__(?<u>[^_]+)__")]
    private static partial Regex Strong();

    [GeneratedRegex(@"\*(?<i>[^*\s][^*]*)\*|(?<=^|\s)_(?<u>[^_]+)_(?=\s|[.,!?]|$)")]
    private static partial Regex Emphasis();

    [GeneratedRegex(@"^(\s*)([-+*]|\d+[.)])\s+(.*)$")]
    private static partial Regex ListItem();

    public static IReadOnlyList<MdSpan> Inline(string source)
    {
        var spans = new List<MdSpan>();
        var at = 0;
        foreach (Match m in Protected().Matches(source))
        {
            if (m.Index > at) Emphasize(source[at..m.Index], spans);
            if (m.Groups["code"].Success) spans.Add(new MdSpan(m.Groups["c"].Value, Code: true));
            else if (m.Groups["esc"].Success) spans.Add(new MdSpan(m.Groups["esc"].Value));
            else if (m.Groups["label"].Success) spans.Add(new MdSpan(m.Groups["label"].Value, Link: m.Groups["url"].Value));
            else
            {
                var url = m.Groups["bare"].Value;
                var clean = url.TrimEnd(')', ',', '.', ';', ':', '!', '?', '\'', '"', '*');
                spans.Add(new MdSpan(clean, Link: clean));
                if (clean.Length < url.Length) spans.Add(new MdSpan(url[clean.Length..]));
            }
            at = m.Index + m.Length;
        }
        if (at < source.Length) Emphasize(source[at..], spans);
        // Adjacent plain runs read as one.
        var merged = new List<MdSpan>();
        foreach (var s in spans)
        {
            if (merged.Count > 0 && merged[^1] is var last && last with { Text = "" } == s with { Text = "" } && last.Link is null) merged[^1] = last with { Text = last.Text + s.Text };
            else if (s.Text.Length > 0) merged.Add(s);
        }
        return merged;
    }

    private static void Emphasize(string text, List<MdSpan> spans)
    {
        var at = 0;
        foreach (Match m in Strong().Matches(text))
        {
            if (m.Index > at) Italics(text[at..m.Index], spans, bold: false);
            if (m.Groups["bi"].Success) spans.Add(new MdSpan(m.Groups["bi"].Value, Bold: true, Italic: true));
            else Italics(m.Groups["b"].Success ? m.Groups["b"].Value : m.Groups["u"].Value, spans, bold: true);
            at = m.Index + m.Length;
        }
        if (at < text.Length) Italics(text[at..], spans, bold: false);
    }

    private static void Italics(string text, List<MdSpan> spans, bool bold)
    {
        var at = 0;
        foreach (Match m in Emphasis().Matches(text))
        {
            if (m.Index > at) spans.Add(new MdSpan(text[at..m.Index], Bold: bold));
            spans.Add(new MdSpan(m.Groups["i"].Success ? m.Groups["i"].Value : m.Groups["u"].Value, Bold: bold, Italic: true));
            at = m.Index + m.Length;
        }
        if (at < text.Length) spans.Add(new MdSpan(text[at..], Bold: bold));
    }

    private static List<string> Cells(string line)
    {
        var t = line.Trim();
        if (t.StartsWith('|')) t = t[1..];
        if (t.EndsWith('|') && !t.EndsWith("\\|", StringComparison.Ordinal)) t = t[..^1];
        return Regex.Split(t, @"(?<!\\)\|").Select(c => c.Trim()).ToList();
    }

    /// <summary>A table in text columns, so it reads in a monospace box.</summary>
    private static string TableText(List<List<string>> rows)
    {
        var widths = new List<int>();
        foreach (var r in rows)
        {
            for (var i = 0; i < r.Count; i++)
            {
                if (widths.Count <= i) widths.Add(0);
                widths[i] = Math.Max(widths[i], r[i].Length);
            }
        }
        string Line(List<string> r) => string.Join("  ", r.Select((c, i) => c.PadRight(widths[i]))).TrimEnd();
        var lines = new List<string> { Line(rows[0]), string.Join("  ", widths.Select(w => new string('─', w))) };
        lines.AddRange(rows.Skip(1).Select(Line));
        return string.Join("\n", lines);
    }

    public static IReadOnlyList<MdBlock> Blocks(string source)
    {
        var lines = source.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var output = new List<MdBlock>();
        var para = new List<string>();
        void Flush()
        {
            if (para.Count > 0) output.Add(new MdBlock(MdBlockKind.Paragraph, Inline(string.Join("\n", para))));
            para.Clear();
        }
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            var t = line.Trim();
            var fence = Regex.Match(t, "^(`{3,}|~{3,})(.*)$");
            if (fence.Success)
            {
                Flush();
                var marker = fence.Groups[1].Value;
                var code = new List<string>();
                for (i++; i < lines.Length && !lines[i].Trim().StartsWith(marker, StringComparison.Ordinal); i++) code.Add(lines[i]);
                output.Add(new MdBlock(MdBlockKind.Code, [], string.Join("\n", code)));
                continue;
            }
            if (t.Length == 0)
            {
                Flush();
                continue;
            }
            var heading = Regex.Match(t, @"^(#{1,6})\s+(.*?)\s*#*$");
            if (heading.Success)
            {
                Flush();
                output.Add(new MdBlock(MdBlockKind.Heading, Inline(heading.Groups[2].Value), Level: heading.Groups[1].Value.Length));
                continue;
            }
            if (Regex.IsMatch(t, @"^([-*_])(\s*\1){2,}$"))
            {
                Flush();
                output.Add(new MdBlock(MdBlockKind.Rule, []));
                continue;
            }
            if (t.StartsWith('|') && i + 1 < lines.Length && Regex.IsMatch(lines[i + 1].Trim(), @"^\|?\s*:?-{2,}"))
            {
                Flush();
                var rows = new List<List<string>> { Cells(t) };
                for (i += 2; i < lines.Length && lines[i].Trim().StartsWith('|'); i++) rows.Add(Cells(lines[i]));
                i--;
                output.Add(new MdBlock(MdBlockKind.Table, [], TableText(rows)));
                continue;
            }
            if (t.StartsWith('>'))
            {
                Flush();
                var quote = new List<string> { Regex.Replace(t, @"^>\s?", "") };
                while (i + 1 < lines.Length && lines[i + 1].Trim().StartsWith('>')) quote.Add(Regex.Replace(lines[++i].Trim(), @"^>\s?", ""));
                output.Add(new MdBlock(MdBlockKind.Quote, Inline(string.Join("\n", quote))));
                continue;
            }
            var item = ListItem().Match(line);
            if (item.Success)
            {
                Flush();
                var depth = item.Groups[1].Value.Replace("\t", "    ", StringComparison.Ordinal).Length / 2;
                var marker = item.Groups[2].Value;
                var bullet = char.IsDigit(marker[0]) ? marker.Replace(')', '.') : "•";
                var text = item.Groups[3].Value;
                // A wrapped item continues on indented lines that start no new item.
                while (i + 1 < lines.Length && Regex.IsMatch(lines[i + 1], @"^\s{2,}\S") && !ListItem().IsMatch(lines[i + 1])) text += "\n" + lines[++i].Trim();
                output.Add(new MdBlock(MdBlockKind.Item, Inline(text), Level: depth, Bullet: bullet));
                continue;
            }
            para.Add(line);
        }
        Flush();
        return output;
    }
}
