using System.Globalization;
using System.Windows.Interop;
using AISpace.Core;
using AISpace.Shell;
using Microsoft.Web.WebView2.Core;

namespace AISpace.Web;

/// <summary>
/// WebView2 for the whole app: one browser process with its data under <c>%LOCALAPPDATA%</c>, and in
/// it one profile per saved Space, so each keeps its own cookies (its sign-in), storage and cache as
/// the Mac keeps one website data store per connection. The native calls read and write a
/// profile's cookies through a small hidden view of it, which lets the inbox and the tray refresh
/// a Space whose window is not open. Everything here runs on the UI thread.
/// </summary>
internal sealed class WebProfiles(string folder)
{
    private Task<CoreWebView2Environment>? _environment;
    private readonly Dictionary<Guid, Task<CoreWebView2Controller>> _hosts = [];
    private HwndSource? _parking;

    /// <summary>The browser process ended unexpectedly; views start again on their next use.</summary>
    public event Action? BrowserExited;

    /// <summary>Null until checked; the WebView2 Runtime's version when it is installed.</summary>
    public static string? RuntimeVersion()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (WebView2RuntimeNotFoundException)
        {
            return null;
        }
    }

    public Task<CoreWebView2Environment> Environment() => _environment ??= Create();

    private async Task<CoreWebView2Environment> Create()
    {
        try
        {
            Directory.CreateDirectory(folder);
            var options = new CoreWebView2EnvironmentOptions { Language = CultureInfo.CurrentUICulture.Name };
            var env = await CoreWebView2Environment.CreateAsync(null, folder, options);
            env.BrowserProcessExited += (_, e) =>
            {
                if (e.BrowserProcessExitKind != CoreWebView2BrowserProcessExitKind.Failed) return;
                Log.Write("the WebView2 browser process failed");
                _environment = null;
                _hosts.Clear();
                BrowserExited?.Invoke();
            };
            return env;
        }
        catch
        {
            _environment = null;
            throw;
        }
    }

    public static CoreWebView2ControllerOptions Options(CoreWebView2Environment env, Guid connection)
    {
        var o = env.CreateCoreWebView2ControllerOptions();
        o.ProfileName = AppPaths.WebProfile(connection);
        return o;
    }

    private Task<CoreWebView2Controller> Host(Guid connection)
    {
        if (_hosts.TryGetValue(connection, out var t) && !t.IsFaulted) return t;
        t = CreateHost(connection);
        _hosts[connection] = t;
        return t;
    }

    private async Task<CoreWebView2Controller> CreateHost(Guid connection)
    {
        var env = await Environment();
        // A hidden pop-up window to own the views that only read and write cookies.
        _parking ??= new HwndSource(new HwndSourceParameters("ai-space-profiles") { WindowStyle = unchecked((int)0x80000000), Width = 1, Height = 1 });
        var c = await env.CreateCoreWebView2ControllerAsync(_parking.Handle, Options(env, connection));
        c.IsVisible = false;
        return c;
    }

    private async Task<CoreWebView2CookieManager> CookieManager(Guid connection) => (await Host(connection)).CoreWebView2.CookieManager;

    /// <summary>The <c>Cookie</c> header the profile would send to <paramref name="url"/>; null when it has none.</summary>
    public async Task<string?> CookieHeader(Guid connection, Uri url)
    {
        try
        {
            var list = await (await CookieManager(connection)).GetCookiesAsync(url.AbsoluteUri);
            return SpaceApi.CookieHeader(list.Select(c => (c.Name, c.Value)));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Log.Write($"cookies: {e.Message}");
            return null;
        }
    }

    /// <summary>Whether the profile holds a live <c>space_session</c> cookie for the Space (the Local edition's sign-in).</summary>
    public async Task<bool> HasSession(Guid connection, Uri space)
    {
        var list = await (await CookieManager(connection)).GetCookiesAsync(space.AbsoluteUri);
        var cookies = list.Select(c => (c.Name, c.Domain, c.IsSession ? (DateTimeOffset?)null : new DateTimeOffset(c.Expires.ToUniversalTime(), TimeSpan.Zero)));
        return LocalVersions.HasSession(cookies, space.Host, DateTimeOffset.UtcNow);
    }

    /// <summary>Puts cookies from a native answer into the profile, where the pages find them.</summary>
    public async Task SetCookies(Guid connection, IEnumerable<SetCookie> cookies)
    {
        var m = await CookieManager(connection);
        foreach (var s in cookies)
        {
            var domain = s.HostOnly ? s.Domain : "." + s.Domain;
            var c = m.CreateCookie(s.Name, s.Value, domain, s.Path);
            if (s.Expires is { } at)
            {
                if (at <= DateTimeOffset.UtcNow)
                {
                    m.DeleteCookie(c);
                    continue;
                }
                c.Expires = at.UtcDateTime;
            }
            c.IsHttpOnly = s.HttpOnly;
            c.IsSecure = s.Secure;
            c.SameSite = s.SameSite?.ToLowerInvariant() switch
            {
                "strict" => CoreWebView2CookieSameSiteKind.Strict,
                "none" => CoreWebView2CookieSameSiteKind.None,
                _ => CoreWebView2CookieSameSiteKind.Lax,
            };
            m.AddOrUpdateCookie(c);
        }
    }

    /// <summary>Signs the Space out on this computer: every cookie and every other piece of site data of its profile.</summary>
    public async Task Clear(Guid connection)
    {
        var host = await Host(connection);
        await host.CoreWebView2.Profile.ClearBrowsingDataAsync();
    }

    /// <summary>A removed Space: its profile goes once no view of it is left.</summary>
    public async Task Forget(Guid connection, bool deleteData)
    {
        if (!_hosts.Remove(connection, out var t)) return;
        try
        {
            var host = await t;
            var profile = host.CoreWebView2.Profile;
            host.Close();
            if (deleteData) profile.Delete();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Log.Write($"forget profile: {e.Message}");
        }
    }
}
