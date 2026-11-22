namespace AISpace.Core;

/// <summary>The Space's own pages, as the web panel names them (src/web/panel-link.ts).</summary>
public enum SpacePageKind
{
    /// <summary>The panel's first screen: the library and the screens.</summary>
    Home,
    Inbox,
    Shortcuts,
    Terminal,
    Settings,
    /// <summary>An agent's chat.</summary>
    Chat,
    /// <summary>The App Store (docs/app-catalog.md).</summary>
    Store,
}

/// <summary>One of the Space's own pages, with the chat's agent, session and draft when it is a chat.</summary>
public sealed record SpacePage(SpacePageKind Kind, string? Agent = null, string? Session = null, string? Text = null);

/// <summary>
/// Which of the Space's own pages an address is (src/web/panel-link.ts): the panel's root, the
/// built-in pages <c>/?page=inbox|shortcuts|terminal|settings|store</c> and the chat page
/// <c>/?page=chat&amp;agent=…&amp;session=…</c>, and the fragment links <c>#inbox</c>,
/// <c>#terminal</c>, <c>#settings</c>, <c>#shortcuts</c>, <c>#store</c> and <c>#chat=&lt;agent&gt;&amp;text=…</c>.
/// Such an address never leaves the app: the window opens it natively, or as an in-app tab. Only
/// an address of the Space's own origin and the panel's own path counts; anything else is not a
/// page of the Space (an app's page, a file, another site) and is null.
/// </summary>
public static class SpacePages
{
    private static readonly Dictionary<string, SpacePageKind> Names = new(StringComparer.Ordinal)
    {
        ["inbox"] = SpacePageKind.Inbox,
        ["shortcuts"] = SpacePageKind.Shortcuts,
        ["terminal"] = SpacePageKind.Terminal,
        ["settings"] = SpacePageKind.Settings,
        ["store"] = SpacePageKind.Store,
    };

    public static SpacePage? Of(Uri url, Uri space)
    {
        if (!ConnectionRules.IsWeb(url) || !ConnectionRules.SameOrigin(url, space)) return null;
        if (!SamePath(url.AbsolutePath, space.AbsolutePath)) return null;
        var query = Query.Parse(url.Query);
        if (query.TryGetValue("page", out var name))
        {
            if (name == "chat") return new SpacePage(SpacePageKind.Chat, Value(query, "agent"), Value(query, "session"));
            // A name the panel does not know shows its first screen, as the panel itself does.
            return new SpacePage(Names.TryGetValue(name, out var kind) ? kind : SpacePageKind.Home);
        }
        return Fragment(url.Fragment) ?? new SpacePage(SpacePageKind.Home);
    }

    /// <summary>A fragment link (<c>parsePanelLink</c>): its first key names the window; a window's key takes no value.</summary>
    private static SpacePage? Fragment(string fragment)
    {
        var raw = fragment.StartsWith('#') ? fragment[1..] : fragment;
        if (raw.Length == 0) return null;
        var first = raw.Split('&')[0];
        var key = Uri.UnescapeDataString(first.Split('=')[0]);
        var pairs = Query.Parse("?" + raw);
        if (key == "chat")
        {
            var text = Value(pairs, "text");
            return new SpacePage(SpacePageKind.Chat, Value(pairs, "chat"), Text: text is null ? null : text[..Math.Min(text.Length, 20_000)]);
        }
        return Names.TryGetValue(key, out var kind) && Value(pairs, key) is null ? new SpacePage(kind) : null;
    }

    private static string? Value(Dictionary<string, string> q, string key) => q.TryGetValue(key, out var v) && v.Trim().Length > 0 ? v.Trim() : null;

    private static bool SamePath(string a, string b)
    {
        static string Trim(string p) => p.EndsWith("/index.html", StringComparison.Ordinal) ? p[..^"index.html".Length] : p;
        return string.Equals(Trim(a).TrimEnd('/'), Trim(b).TrimEnd('/'), StringComparison.Ordinal);
    }

    /// <summary>
    /// Whether a main-frame navigation in the in-app tab of one of the Space's pages
    /// (<paramref name="tab"/>: the terminal's or the chat's) goes to another of its pages, which
    /// the window then opens in its own place instead: closing the terminal page leads the panel's
    /// script to the Space's root, which is the native Home, not the web launcher in that tab.
    /// </summary>
    public static bool LeavesTab(Uri url, Uri space, SpacePageKind tab) => Of(url, space) is { } page && page.Kind != tab;

    /// <summary>The built-in page's own address: <c>/?page=&lt;name&gt;</c> under the panel's path; the panel itself for Home.</summary>
    /// <summary>
    /// The App Store's address; with <paramref name="pick"/>, the one the first-use card opens
    /// (<c>/?page=store&amp;pick=all</c>), where every installable app starts ticked.
    /// </summary>
    public static Uri StoreUrl(Uri space, bool pick = false) => new(Root(space), pick ? "?page=store&pick=all" : "?page=store");

    public static Uri PageUrl(Uri space, SpacePageKind kind)
    {
        var root = Root(space);
        if (kind == SpacePageKind.Home) return root;
        if (kind == SpacePageKind.Chat) return ChatUrl(space, null);
        return new Uri(root, "?page=" + Names.First(n => n.Value == kind).Key);
    }

    /// <summary>
    /// The chat page on <paramref name="agent"/> (the Space's default agent when null), resuming
    /// <paramref name="session"/>; <paramref name="text"/> goes in its message field through the
    /// fragment link and is never sent. A chat page already open on the same agent takes a new
    /// draft without reloading, since only the fragment changes.
    /// </summary>
    public static Uri ChatUrl(Uri space, string? agent, string? text = null, string? session = null)
    {
        var query = "?page=chat";
        if (!string.IsNullOrEmpty(agent)) query += "&agent=" + Uri.EscapeDataString(agent);
        if (!string.IsNullOrEmpty(session)) query += "&session=" + Uri.EscapeDataString(session);
        var url = new Uri(Root(space), query);
        if (string.IsNullOrEmpty(text)) return url;
        var fragment = "chat" + (string.IsNullOrEmpty(agent) ? "" : "=" + Uri.EscapeDataString(agent)) + "&text=" + Uri.EscapeDataString(text);
        return new Uri(url.GetLeftPart(UriPartial.Query) + "#" + fragment);
    }

    /// <summary>The panel's own address: the Space's origin and path, without query or fragment.</summary>
    public static Uri Root(Uri space)
    {
        var path = space.AbsolutePath.EndsWith('/') ? space.AbsolutePath : space.AbsolutePath + "/";
        return new Uri(ConnectionRules.Origin(space), path);
    }
}
