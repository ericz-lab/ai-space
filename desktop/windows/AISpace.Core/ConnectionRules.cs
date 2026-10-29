namespace AISpace.Core;

public enum ConnectionUrlError
{
    Empty,
    Invalid,
    UnsupportedScheme,
    Credentials,
    InsecureRemote,
}

public sealed class ConnectionUrlException(ConnectionUrlError code) : Exception(code.ToString())
{
    public ConnectionUrlError Code { get; } = code;
}

/// <summary>
/// What a connection URL may be: HTTPS anywhere, plain HTTP only to this computer's loopback
/// (the Mac's <c>ConnectionRules</c>, desktop/macos/AISpace/Services/Connection.swift).
/// </summary>
public static class ConnectionRules
{
    /// <summary>The default <c>SPACE_PORT</c> in src/space/config.ts.</summary>
    public const string LocalDefault = "http://127.0.0.1:8700/";

    public static bool IsLoopback(string host)
    {
        var h = host.ToLowerInvariant();
        if (h.StartsWith('[') && h.EndsWith(']')) h = h[1..^1];
        if (h is "localhost" or "::1") return true;
        var parts = h.Split('.');
        if (parts.Length != 4) return false;
        foreach (var p in parts)
        {
            if (p.Length is 0 or > 3 || !p.All(char.IsAsciiDigit) || int.Parse(p) > 255) return false;
        }
        return parts[0] == "127";
    }

    /// <summary>A package app's isolated loopback origin (<c>&lt;app&gt;.localhost</c>, docs/app-packages.md).</summary>
    public static bool IsLocalhostName(string host)
    {
        var h = host.ToLowerInvariant();
        return h == "localhost" || h.EndsWith(".localhost", StringComparison.Ordinal);
    }

    /// <summary>
    /// Turns what the operator typed into a panel URL, or says why it cannot be one. A missing
    /// scheme means HTTP for loopback and HTTPS otherwise; query and fragment are dropped.
    /// </summary>
    public static Uri Normalize(string input)
    {
        var text = input.Trim();
        if (text.Length == 0) throw new ConnectionUrlException(ConnectionUrlError.Empty);
        if (!text.Contains("://", StringComparison.Ordinal))
        {
            var host = text.Split('/', 2)[0];
            var bare = host.StartsWith('[') && host.Contains(']') ? host[..(host.IndexOf(']') + 1)] : host.Split(':')[0];
            text = (IsLoopback(bare) ? "http://" : "https://") + text;
        }
        var schemeEnd = text.IndexOf("://", StringComparison.Ordinal);
        var scheme = text[..schemeEnd].ToLowerInvariant();
        if (scheme.Length == 0 || !char.IsAsciiLetter(scheme[0])) throw new ConnectionUrlException(ConnectionUrlError.Invalid);
        if (scheme is not ("http" or "https")) throw new ConnectionUrlException(ConnectionUrlError.UnsupportedScheme);
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            throw new ConnectionUrlException(ConnectionUrlError.Invalid);
        }
        if (uri.UserInfo.Length > 0) throw new ConnectionUrlException(ConnectionUrlError.Credentials);
        if (scheme == "http" && !IsLoopback(uri.Host)) throw new ConnectionUrlException(ConnectionUrlError.InsecureRemote);
        var path = uri.AbsolutePath.Length == 0 ? "/" : uri.AbsolutePath;
        return new Uri($"{scheme}://{HostPort(uri)}{path}");
    }

    /// <summary>Whether two URLs share scheme, host and effective port.</summary>
    public static bool SameOrigin(Uri a, Uri b)
    {
        if (!a.IsAbsoluteUri || !b.IsAbsoluteUri) return false;
        return string.Equals(a.Scheme, b.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(a.Host, b.Host, StringComparison.OrdinalIgnoreCase)
            && a.Port == b.Port;
    }

    public static bool SameOrigin(string a, Uri b) => Uri.TryCreate(a, UriKind.Absolute, out var u) && SameOrigin(u, b);

    /// <summary><c>scheme://host[:port]/</c>; the default port is left out.</summary>
    public static Uri Origin(Uri url) => new($"{url.Scheme}://{HostPort(url)}/");

    /// <summary>The origin as a request's <c>Origin</c> header writes it: no trailing slash.</summary>
    public static string OriginHeader(Uri url) => $"{url.Scheme}://{HostPort(url)}";

    public static bool IsWeb(Uri url) => url.IsAbsoluteUri && url.Scheme is "http" or "https";

    private static string HostPort(Uri u)
    {
        var host = u.HostNameType == UriHostNameType.IPv6 && !u.Host.StartsWith('[') ? $"[{u.Host}]" : u.Host;
        return u.IsDefaultPort ? host.ToLowerInvariant() : $"{host.ToLowerInvariant()}:{u.Port}";
    }
}
