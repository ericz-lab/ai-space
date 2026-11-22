using System.Globalization;
using System.Text;

namespace AISpace.Core;

/// <summary>The library's filter by kind (src/web/Library.tsx): the built-in pages count as apps.</summary>
public enum LibraryFilter
{
    All,
    Apps,
    Agents,
    Widgets,
}

/// <summary>
/// Home's search and command box rules (docs/panel.md#omnibox), shared with the web panel
/// (src/space/shortcuts/ranking.ts), the Mac (<c>OmniboxRules.swift</c>) and Linux
/// (<c>core/catalogue.ts</c>): every word of the query in an entry's titles (every language), id,
/// description or machine; a name that equals the query ranks first, then one that starts with
/// it, has a word starting with it, or holds it; Enter opens the best match only when its name
/// holds the whole query, anything else is a question for Space Assistant.
/// </summary>
public static class HomeSearch
{
    public const int Exact = 100, Prefix = 80, Word = 60, Inside = 50, Text = 10;

    /// <summary>At or above this, the best match is a name the person typed: Enter opens it.</summary>
    public const int OpenScore = Inside;

    private static readonly char[] WordBreaks = [' ', '\t', '\n', '\r', '-', '_', '/', '·', '.'];

    /// <summary>Lower case without accents: <c>Café</c> and <c>cafe</c> are the same.</summary>
    public static string Fold(string s)
    {
        var decomposed = s.Normalize(NormalizationForm.FormKD);
        var b = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) b.Append(c);
        }
        return b.ToString().ToLowerInvariant();
    }

    /// <summary>The names an entry answers to: its titles in every language and its id, folded.</summary>
    public static IReadOnlyList<string> Names(HomeEntry e, IEnumerable<string>? more = null)
    {
        var names = new List<string> { e.Title };
        if (e.I18n is not null) names.AddRange(e.I18n.Values.Select(t => t.Title).Where(t => !string.IsNullOrEmpty(t))!);
        if (more is not null) names.AddRange(more);
        names.Add(e.Ref);
        return names.Select(Fold).ToList();
    }

    private static string TextOf(HomeEntry e)
    {
        var parts = new List<string> { e.Detail ?? "" };
        if (e.I18n is not null) parts.AddRange(e.I18n.Values.Select(t => t.Description ?? ""));
        return Fold(string.Join("\n", parts));
    }

    /// <summary>Whether every word of the (folded) query is somewhere in the entry: the library's search.</summary>
    public static bool Matches(string query, HomeEntry e)
    {
        var words = Fold(query).Split(WordBreaks[..4], StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return true;
        var hay = string.Join(" ", new[] { TextOf(e) }.Concat(Names(e)).Append(e.Peer is null ? "" : Fold(e.Peer)));
        return words.All(w => hay.Contains(w, StringComparison.Ordinal));
    }

    /// <summary>0 when the library search would not show the entry; more the better a name fits.</summary>
    public static int Score(string query, HomeEntry e)
    {
        var q = Fold(query.Trim());
        if (q.Length == 0 || !Matches(q, e)) return 0;
        var best = Text;
        foreach (var name in Names(e))
        {
            if (name == q) return Exact;
            if (name.StartsWith(q, StringComparison.Ordinal)) best = Math.Max(best, Prefix);
            else if (name.Split(WordBreaks, StringSplitOptions.RemoveEmptyEntries).Any(w => w.StartsWith(q, StringComparison.Ordinal))) best = Math.Max(best, Word);
            else if (name.Contains(q, StringComparison.Ordinal)) best = Math.Max(best, Inside);
        }
        return best;
    }

    /// <summary>The matching entries, best first; equal scores keep the given order.</summary>
    public static IReadOnlyList<HomeEntry> Rank(string query, IEnumerable<HomeEntry> entries, int limit = 50) =>
        entries.Select((e, i) => (e, i, s: Score(query, e))).Where(x => x.s > 0).OrderByDescending(x => x.s).ThenBy(x => x.i).Take(limit).Select(x => x.e).ToList();

    /// <summary>Enter opens the best match when its name holds the whole query; anything else asks the assistant.</summary>
    public static bool OpensByDefault(string query, HomeEntry? first) => first is not null && Score(query, first) >= OpenScore;

    public static bool Keeps(LibraryFilter filter, HomeEntry e) => filter switch
    {
        LibraryFilter.Apps => e.Kind is HomeKind.App or HomeKind.Builtin,
        LibraryFilter.Agents => e.Kind == HomeKind.Agent,
        LibraryFilter.Widgets => e.Kind == HomeKind.Widget,
        _ => true,
    };

    /// <summary>How many entries each filter keeps.</summary>
    public static IReadOnlyDictionary<LibraryFilter, int> Counts(IEnumerable<HomeEntry> entries)
    {
        var list = entries.ToList();
        return Enum.GetValues<LibraryFilter>().ToDictionary(f => f, f => list.Count(e => Keeps(f, e)));
    }
}
