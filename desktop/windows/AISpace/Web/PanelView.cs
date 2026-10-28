using System.Windows;
using System.Windows.Controls;
using AISpace.Core;
using AISpace.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AISpace.Web;

/// <summary>
/// One page of a saved Space in its WebView2 profile: the panel, or an app opened as a tab (the
/// Mac's <c>PanelSession</c>). The navigation policy keeps the page in its view and sends links out,
/// a check after each load says whether the panel is ready, and an overlay shows the state while
/// there is nothing else to show. Hiding the view keeps its page, its streams and unsent text.
/// </summary>
internal sealed class PanelView : Grid
{
    private static readonly string Version = typeof(PanelView).Assembly.GetName().Version?.ToString(3) ?? "0";
    private readonly WebProfiles _profiles;
    // A web view is a window of its own, drawn over anything WPF puts on it, so the overlay is
    // shown in its place rather than over it.
    private readonly Border _overlay = new() { Visibility = Visibility.Collapsed };
    private WebView2? _web;
    private Task<WebView2?>? _starting;
    private bool _hasContent;
    private CancellationTokenSource? _check;

    public PanelView(WebProfiles profiles, Connection connection, Uri home, bool verifiesSpace, string? app = null)
    {
        _profiles = profiles;
        Connection = connection;
        Home = home;
        VerifiesSpace = verifiesSpace;
        App = app;
        Ui.Background(this);
        Children.Add(_overlay);
        UpdateOverlay();
    }

    public Connection Connection { get; }
    public Uri Home { get; }
    /// <summary>The panel checks it is a Space it can talk to; an app's page only that it is shown.</summary>
    public bool VerifiesSpace { get; }
    /// <summary>The app this view is a tab of; null for the panel.</summary>
    public string? App { get; }
    public SpaceState State { get; private set; } = SpaceState.Connecting;
    public string PageTitle { get; private set; } = "";
    public Uri? Current => _web?.Source;
    public bool CanGoBack => _web?.CanGoBack == true;
    public bool CanGoForward => _web?.CanGoForward == true;
    public bool IsDisposed { get; private set; }

    /// <summary>State, title or history changed.</summary>
    public event Action<PanelView>? Changed;
    /// <summary>The state changed: the app refreshes the native views on ready and signs the Local edition in again.</summary>
    public event Action<PanelView, SpaceState>? StateChanged;
    public event Action<PanelView, bool>? FullScreenChanged;

    /// <summary>A link leaving the page: an app of the Space opens as its tab, anything else in the browser.</summary>
    public Action<Uri> OpenLink { get; set; } = _ => { };
    /// <summary>The native check of the Space behind the page (<see cref="SpaceApi.CheckSpace"/>).</summary>
    public Func<CancellationToken, Task<SpaceState>> CheckSpace { get; set; } = _ => Task.FromResult(SpaceState.Ready);
    /// <summary>The overlay's "Edit Space" action.</summary>
    public Action? EditConnection { get; set; }

    /// <summary>Starts again from the view's home page.</summary>
    public void Load() => Load(Home);

    public void Load(Uri url)
    {
        SetState(SpaceState.Connecting);
        _hasContent = false;
        Navigate(url);
    }

    public async void Navigate(Uri url)
    {
        var web = await Ensure();
        if (web?.CoreWebView2 is null) return;
        try
        {
            web.CoreWebView2.Navigate(url.AbsoluteUri);
        }
        catch (ArgumentException e)
        {
            Log.Write($"navigate {url}: {e.Message}");
        }
    }

    /// <summary>
    /// Attaches a picture to the chat the page opens, as if it were dropped on the chat's field
    /// (src/web/Chat.tsx takes dropped files as images): once the page has read its <c>#chat</c>
    /// link and shows the field, within ten seconds. The picture is never sent by itself.
    /// </summary>
    public async Task<bool> DropPicture(string name, string type, byte[] bytes)
    {
        const string ready = "!location.hash.startsWith('#chat') && !!document.querySelector('.chat-input textarea:not([disabled])')";
        // The link is read when the page has loaded, or at once by a page already up.
        await Task.Delay(400);
        for (var i = 0; i < 40; i++)
        {
            if (IsDisposed || _web?.CoreWebView2 is not { } core) return false;
            try
            {
                if (await core.ExecuteScriptAsync(ready) == "true")
                {
                    var script = $$"""
                        (() => {
                          const box = document.querySelector('.chat-input');
                          if (!box) return false;
                          const raw = atob({{System.Text.Json.JsonSerializer.Serialize(Convert.ToBase64String(bytes))}});
                          const data = new Uint8Array(raw.length);
                          for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
                          const transfer = new DataTransfer();
                          transfer.items.add(new File([data], {{System.Text.Json.JsonSerializer.Serialize(name)}}, { type: {{System.Text.Json.JsonSerializer.Serialize(type)}} }));
                          box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
                          return true;
                        })()
                        """;
                    return await core.ExecuteScriptAsync(script) == "true";
                }
            }
            catch (Exception e) when (e is InvalidOperationException or System.Runtime.InteropServices.COMException)
            {
                // Between two documents: try again.
            }
            await Task.Delay(250);
        }
        Log.Write("quick chat: the chat did not open in time for the dropped picture");
        return false;
    }

    /// <summary>Reloads the page; after a failure, starts again from the home page.</summary>
    public void Reload()
    {
        if (_web?.CoreWebView2 is null || _web.Source is null || State.IsFailure) Load();
        else _web.CoreWebView2.Reload();
    }

    public void RecoverIfFailed()
    {
        if (State.IsFailure) Load();
    }

    public void GoBack() => _web?.GoBack();

    public void GoForward() => _web?.GoForward();

    public void FocusPage() => _web?.Focus();

    /// <summary>The address to open in the browser: the page shown when it is the Space's, else the home page.</summary>
    public Uri BrowserUrl => Current is { } u && ConnectionRules.SameOrigin(u, Home) ? u : Home;

    /// <summary>Ends the page for good (the tab closed, the Space was removed or signed out).</summary>
    public void Close()
    {
        if (IsDisposed) return;
        IsDisposed = true;
        _check?.Cancel();
        if (_web is not null)
        {
            Children.Remove(_web);
            _web.Dispose();
            _web = null;
        }
    }

    private bool ShowsHomeOrigin => _web?.Source is { } u && ConnectionRules.SameOrigin(u, Home);

    private Task<WebView2?> Ensure() => _web?.CoreWebView2 is not null ? Task.FromResult<WebView2?>(_web) : _starting ??= Start();

    private async Task<WebView2?> Start()
    {
        try
        {
            if (IsDisposed) return null;
            var env = await _profiles.Environment();
            var web = new WebView2 { DefaultBackgroundColor = Ui.SystemDark() ? System.Drawing.Color.FromArgb(32, 32, 32) : System.Drawing.Color.White };
            Children.Insert(0, web);
            _web = web;
            await web.EnsureCoreWebView2Async(env, WebProfiles.Options(env, Connection.Id));
            if (IsDisposed) return null;
            Configure(web.CoreWebView2);
            // Hidden behind the mark until the page has something to show.
            UpdateOverlay();
            return web;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            SetState(SpaceState.Unreachable(L.T("The Microsoft Edge WebView2 Runtime is not installed.")));
            return null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Log.Write($"web view: {e}");
            SetState(SpaceState.Unreachable(e.Message));
            return null;
        }
        finally
        {
            _starting = null;
        }
    }

    private void Configure(CoreWebView2 core)
    {
        var s = core.Settings;
        // The Space tells this client's pages and feedback apart by this token (src/space/feedback/client.ts).
        s.UserAgent = $"{s.UserAgent} AISpaceWindows/{Version}";
        s.IsStatusBarEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
#if !DEBUG
        s.AreDevToolsEnabled = false;
#endif
        core.NavigationStarting += (_, e) => Decide(e, isMainFrame: true);
        core.FrameNavigationStarting += (_, e) => Decide(e, isMainFrame: false);
        core.NewWindowRequested += OnNewWindow;
        core.ContentLoading += (_, _) =>
        {
            if (ShowsHomeOrigin) _hasContent = true;
            UpdateOverlay();
        };
        core.NavigationCompleted += OnCompleted;
        core.DocumentTitleChanged += (_, _) =>
        {
            PageTitle = core.DocumentTitle;
            Changed?.Invoke(this);
        };
        core.HistoryChanged += (_, _) => Changed?.Invoke(this);
        core.SourceChanged += (_, _) => Changed?.Invoke(this);
        core.PermissionRequested += OnPermission;
        core.ProcessFailed += OnProcessFailed;
        core.ContainsFullScreenElementChanged += (_, _) => FullScreenChanged?.Invoke(this, core.ContainsFullScreenElement);
    }

    private void Decide(CoreWebView2NavigationStartingEventArgs e, bool isMainFrame)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var url))
        {
            e.Cancel = true;
            return;
        }
        var request = new NavigationRequest(url, isMainFrame, IsLinkActivation: e.IsUserInitiated && !e.IsRedirected, OpensNewWindow: false, FromHomePage: ShowsHomeOrigin);
        switch (NavigationPolicy.Decide(request, Home))
        {
            case NavigationDecision.Allow:
                break;
            case NavigationDecision.OpenExternally:
                e.Cancel = true;
                OpenLink(url);
                break;
            default:
                e.Cancel = true;
                break;
        }
    }

    /// <summary>target=_blank and window.open never make a second view that could outlive this one's checks.</summary>
    private void OnNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var url) && ConnectionRules.IsWeb(url)) OpenLink(url);
    }

    private void OnCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            _hasContent = true;
            if (SpaceCheck.ClassifyNavigationError(e.WebErrorStatus.ToString()) is { } failed) SetState(failed);
            else UpdateOverlay();
            return;
        }
        _hasContent = true;
        Check();
    }

    private async void Check()
    {
        if (!VerifiesSpace)
        {
            SetState(ShowsHomeOrigin ? SpaceState.Ready : SpaceState.AuthenticationRequired);
            return;
        }
        // Another origin in the main frame: an access layer's sign-in page, which the person fills in.
        if (!ShowsHomeOrigin)
        {
            SetState(SpaceState.AuthenticationRequired);
            return;
        }
        _check?.Cancel();
        var cts = _check = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        try
        {
            var state = await CheckSpace(cts.Token);
            if (!cts.IsCancellationRequested) SetState(state);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception e)
        {
            SetState(SpaceState.Incompatible(e.Message));
        }
    }

    private void OnPermission(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        Uri? Parse(string? s) => Uri.TryCreate(s, UriKind.Absolute, out var u) ? u : null;
        switch (e.PermissionKind)
        {
            case CoreWebView2PermissionKind.Microphone:
            case CoreWebView2PermissionKind.Camera:
                var kind = e.PermissionKind == CoreWebView2PermissionKind.Microphone ? MediaCaptureKind.Microphone : MediaCaptureKind.Camera;
                var grant = MediaCapturePolicy.Grants(kind, _web?.Source, Parse(e.Uri), Home, Connection.Uri);
                e.State = grant ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
                break;
            case CoreWebView2PermissionKind.Notifications:
                // The app shows the inbox as Windows notifications itself; a page's own would say it twice.
                e.State = CoreWebView2PermissionState.Deny;
                break;
            case CoreWebView2PermissionKind.Geolocation:
            case CoreWebView2PermissionKind.OtherSensors:
                e.State = CoreWebView2PermissionState.Deny;
                break;
        }
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Write($"web process failed: {e.ProcessFailedKind} ({e.Reason})");
        switch (e.ProcessFailedKind)
        {
            case CoreWebView2ProcessFailedKind.BrowserProcessExited:
                // Every view of the app lost its browser: make a new web view on the next start.
                if (_web is not null)
                {
                    Children.Remove(_web);
                    _web.Dispose();
                    _web = null;
                }
                Load();
                break;
            case CoreWebView2ProcessFailedKind.RenderProcessExited:
            case CoreWebView2ProcessFailedKind.RenderProcessUnresponsive:
                // The page restores its runs from the Space; reloading never resends a prompt.
                SetState(SpaceState.Connecting);
                Reload();
                break;
        }
    }

    private void SetState(SpaceState state)
    {
        if (State == state) return;
        State = state;
        UpdateOverlay();
        StateChanged?.Invoke(this, state);
        Changed?.Invoke(this);
    }

    private void UpdateOverlay()
    {
        UIElement? content = State.Kind switch
        {
            SpaceStateKind.Unreachable => Failure(L.F("Cannot reach {0}", Connection.DisplayNameOr()), State.Detail),
            SpaceStateKind.Incompatible => Failure(L.T("This address is not an AI Space panel this app can open"), State.Detail),
            // The page itself shows a sign-in form or a connection error: leave it visible.
            SpaceStateKind.AuthenticationRequired => null,
            _ => _hasContent ? null : Connecting(),
        };
        _overlay.Child = content;
        _overlay.Visibility = content is null ? Visibility.Collapsed : Visibility.Visible;
        Ui.Background(_overlay);
        if (_web is not null) _web.Visibility = content is null ? Visibility.Visible : Visibility.Hidden;
    }

    private static FrameworkElement Connecting()
    {
        var ring = new ProgressBar { IsIndeterminate = true, Width = 160, Height = 4 };
        var p = Ui.Column(16, Ui.Text("AI Space", 22, bold: true), ring);
        p.HorizontalAlignment = HorizontalAlignment.Center;
        p.VerticalAlignment = VerticalAlignment.Center;
        return p;
    }

    private FrameworkElement Failure(string title, string detail)
    {
        var actions = new List<UIElement> { Ui.Button(L.T("Try Again"), Load, accent: true), Ui.Button(L.T("Open in Browser"), () => OpenLink(BrowserUrl)) };
        if (EditConnection is { } edit) actions.Add(Ui.Button(L.T("Edit Space…"), edit));
        var buttons = Ui.Row([.. actions]);
        var body = Ui.Column(12, Ui.Glyph(Ui.Warning, 28), Ui.Text(title, 20, bold: true), Ui.Text(detail, 13, secondary: true), buttons);
        body.MaxWidth = 520;
        body.HorizontalAlignment = HorizontalAlignment.Center;
        body.VerticalAlignment = VerticalAlignment.Center;
        return body;
    }
}
