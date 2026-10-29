using System.Globalization;

namespace AISpace;

/// <summary>The interface's words in English and Chinese, chosen by Windows' display language.</summary>
internal static partial class L
{
    private static readonly bool Chinese = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "zh";

    public static string T(string english) => Chinese && Zh.TryGetValue(english, out var zh) ? zh : english;

    public static string F(string english, params object?[] args) => string.Format(CultureInfo.CurrentCulture, T(english), args);
}
