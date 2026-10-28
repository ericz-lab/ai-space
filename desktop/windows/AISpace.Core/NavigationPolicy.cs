namespace AISpace.Core;

public enum NavigationDecision
{
    Allow,
    OpenExternally,
    Cancel,
}

/// <summary>One navigation as the policy sees it, free of WebView2 types so it can be tested.</summary>
/// <param name="IsLinkActivation">The person clicked a link (a user-initiated navigation that is not a redirect).</param>
/// <param name="OpensNewWindow">target=_blank or window.open: WebView2 asks for a new window.</param>
/// <param name="FromHomePage">The main frame currently shows the view's own origin (the Space, or the app of a tab).</param>
public sealed record NavigationRequest(Uri Url, bool IsMainFrame, bool IsLinkActivation, bool OpensNewWindow, bool FromHomePage);

/// <summary>
/// The page stays in its view; everything else goes to the default browser, or to the app's own
/// tab when the link is an app's (the caller checks <see cref="AppRoutes"/> on
/// <see cref="NavigationDecision.OpenExternally"/>). A redirect or script navigation away from the
/// page's origin stays, so an access layer's sign-in can complete, but a link the person clicks on
/// the page leaves (the Mac's <c>NavigationPolicy</c>). Downloads are WebView2's own: it keeps
/// them in Downloads and shows them in its download list.
/// </summary>
public static class NavigationPolicy
{
    public static NavigationDecision Decide(NavigationRequest r, Uri home)
    {
        var scheme = r.Url.IsAbsoluteUri ? r.Url.Scheme.ToLowerInvariant() : "";
        var web = scheme is "http" or "https";
        var sameOrigin = web && ConnectionRules.SameOrigin(r.Url, home);

        if (r.OpensNewWindow) return web ? NavigationDecision.OpenExternally : NavigationDecision.Cancel;
        switch (scheme)
        {
            case "about":
            case "blob":
            case "data":
                return NavigationDecision.Allow;
            case "http":
            case "https":
                break;
            default:
                // mailto:, tel:, other apps' schemes: only on a click, and never inside the view.
                return r.IsLinkActivation ? NavigationDecision.OpenExternally : NavigationDecision.Cancel;
        }
        if (!r.IsMainFrame || sameOrigin) return NavigationDecision.Allow;
        if (r.IsLinkActivation && r.FromHomePage) return NavigationDecision.OpenExternally;
        return NavigationDecision.Allow;
    }

    /// <summary>
    /// The schemes the app hands to Windows on a click. Others (<c>ms-settings:</c>, <c>search-ms:</c>,
    /// file and shell handlers) could start programs without a word, so a page can never reach them.
    /// </summary>
    public static bool MayOpenExternally(Uri url) => url.IsAbsoluteUri && url.Scheme.ToLowerInvariant() is "http" or "https" or "mailto" or "tel";
}

public enum MediaCaptureKind
{
    Microphone,
    Camera,
    Other,
}

/// <summary>
/// The microphone for the pages this app opened, so their voice input works (getUserMedia). The
/// page and the frame asking must both be of the view's own origin or the connection's: an
/// embedded or redirected-to site gets nothing. The camera is never granted (the Mac's
/// <c>MediaCapturePolicy</c>).
/// </summary>
public static class MediaCapturePolicy
{
    public static bool Grants(MediaCaptureKind kind, Uri? page, Uri? frame, Uri home, Uri connection)
    {
        if (kind != MediaCaptureKind.Microphone || page is null || frame is null) return false;
        bool Own(Uri u) => ConnectionRules.IsWeb(u) && (ConnectionRules.SameOrigin(u, home) || ConnectionRules.SameOrigin(u, connection));
        return Own(page) && Own(frame);
    }
}
