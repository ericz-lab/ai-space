using System.Globalization;

namespace AISpace;

/// <summary>
/// The interface's words in English and Chinese, chosen by Windows' display language. The Chinese
/// is kept in one table per area, so that the areas' owners never edit the same file:
/// <c>Strings.zh.cs</c> (the shell: window, tray, settings window, Quick Chat, the ball, …),
/// <c>Strings.zh.Home.cs</c> (Home), <c>Strings.zh.Inbox.cs</c> (Inbox, Shortcuts, the desk pet) and
/// <c>Strings.zh.SpaceSettings.cs</c> (the Space's settings). A string is in exactly one of them
/// (<c>desktop/windows/strings.test.ts</c> checks it); any area may use any table's strings.
/// </summary>
internal static partial class L
{
    private static readonly bool Chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";
    private static Dictionary<string, string>? _zh;

    /// <summary>Every table in one, made on first use (after every table's static field is set).</summary>
    private static Dictionary<string, string> Zh => _zh ??= new[] { ZhCore, ZhHome, ZhInbox, ZhSpaceSettings }.SelectMany(t => t).ToDictionary(p => p.Key, p => p.Value);

    public static string T(string english) => Chinese && Zh.TryGetValue(english, out var zh) ? zh : english;

    public static string F(string english, params object?[] args) => string.Format(CultureInfo.CurrentCulture, T(english), args);
}
