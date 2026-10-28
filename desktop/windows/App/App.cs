using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AISpace.Core;
using Forms = System.Windows.Forms;

namespace AISpace.Windows;

static class Program
{
    [STAThread]
    static int Main()
    {
        // One ball per Windows user: a second start only leaves.
        using var single = new Mutex(true, @"Local\AISpace.FloatingBall", out var first);
        if (!first) return 0;
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var controller = new Controller(app);
        app.Startup += (_, _) => controller.Start();
        return app.Run();
    }
}

/// <summary>
/// The app: a tray icon, the floating ball, Quick Chat and Settings, around one Space. The
/// catalogue (apps and agents) is fetched at start, after Settings, and every minute; the dial and
/// Quick Chat's agent list follow it.
/// </summary>
sealed class Controller(Application app)
{
    static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AI Space");
    static readonly string PreferencesFile = Path.Combine(Folder, "preferences.json");

    Preferences prefs = new();
    SpaceClient? client;
    Catalogue? catalogue;
    Dictionary<Section, DialEntry> dial = [];
    readonly Dictionary<string, ImageSource?> icons = [];
    readonly DispatcherTimer refresh = new() { Interval = TimeSpan.FromMinutes(1) };
    Forms.NotifyIcon? tray;
    BallWindow? ball;
    QuickChatWindow? quick;
    SettingsWindow? settings;

    public Preferences Prefs => prefs;
    public Catalogue? Catalogue => catalogue;
    public SpaceClient? Client => client;

    public void Start()
    {
        prefs = Preferences.Load(PreferencesFile);
        Connect();
        MakeTray();
        SyncBall();
        refresh.Tick += async (_, _) => await Refresh();
        refresh.Start();
        _ = Refresh();
        if (client is null) OpenSettings();
    }

    // The Space

    public static string Protect(string token) =>
        token.Length == 0 ? "" : Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser));

    public static string Unprotect(string stored)
    {
        if (stored.Length == 0) return "";
        try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(stored), null, DataProtectionScope.CurrentUser)); }
        catch (Exception) { return ""; } // Another user's or another computer's: asked for again.
    }

    void Connect()
    {
        client?.Dispose();
        client = null;
        if (prefs.Address.Length == 0) return;
        try { client = new SpaceClient(prefs.Address, Unprotect(prefs.ProtectedToken) is { Length: > 0 } t ? t : null); }
        catch (FormatException) { }
    }

    public async Task Refresh()
    {
        if (client is not { } c) { catalogue = null; Changed(); return; }
        try
        {
            catalogue = await c.LoadCatalogue();
            await LoadIcons(c, catalogue);
        }
        catch (SignInException)
        {
            catalogue = null;
            Notify(Strings.T("signIn"));
        }
        catch (Exception)
        {
            // Offline: the last catalogue stays until the Space answers again.
        }
        Changed();
    }

    /// <summary>Icons served by the Space (a path or a URL), fetched once; an emoji is drawn as text.</summary>
    async Task LoadIcons(SpaceClient c, Catalogue cat)
    {
        foreach (var e in cat.Apps.Concat(cat.Agents))
        {
            if (e.Icon is not { } icon || !IsFetched(icon) || icons.ContainsKey(icon)) continue;
            try
            {
                var bytes = await c.GetBytes(icon);
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.DecodePixelWidth = 64;
                image.StreamSource = new MemoryStream(bytes);
                image.EndInit();
                image.Freeze();
                icons[icon] = image;
            }
            catch (Exception)
            {
                icons[icon] = null; // An SVG or a broken picture: the first letter instead.
            }
        }
    }

    static bool IsFetched(string icon) => icon.StartsWith('/') || icon.StartsWith("http", StringComparison.Ordinal);

    public ImageSource? IconOf(Entry e) => e.Icon is { } i && icons.TryGetValue(i, out var image) ? image : null;
    public static string? EmojiOf(Entry e) => e.Icon is { Length: > 0 and <= 8 } i && !IsFetched(i) ? i : null;

    IReadOnlyList<string>? Slots => client is { } c && prefs.Slots.TryGetValue(c.Base.ToString(), out var s) ? s : null;

    public string? SlotOf(Section s) => FloatingBallRules.Slot(s, Slots);

    public void SetSlot(Section s, string? key)
    {
        if (client is not { } c) return;
        prefs.Slots[c.Base.ToString()] = FloatingBallRules.Setting(s, key, Slots);
        Save();
        Changed();
    }

    void Changed()
    {
        dial = FloatingBallRules.Resolve(catalogue, Slots);
        ball?.SetSections(FloatingBallRules.Sections.ToDictionary(s => s, s =>
        {
            var d = dial[s];
            var title = d.Entry?.TitleIn(Strings.Lang) ?? FloatingBallRules.FallbackTitle(s);
            return new DialSectionView(title, d.Entry is { } e ? IconOf(e) : null, d.Entry is { } e2 ? EmojiOf(e2) : null,
                d.Entry?.Kind == EntryKind.Agent, d.Agent is not null, d.Hidden);
        }));
        quick?.CatalogueChanged();
        settings?.CatalogueChanged();
    }

    public void Save()
    {
        try { prefs.Save(PreferencesFile); }
        catch (IOException) { }
    }

    /// <summary>Settings saved: a new address or token means a new connection.</summary>
    public async Task Apply(string address, string token)
    {
        var protectedToken = token.Length == 0 ? prefs.ProtectedToken : Protect(token);
        var changed = address != prefs.Address || protectedToken != prefs.ProtectedToken;
        prefs.Address = address;
        prefs.ProtectedToken = protectedToken;
        Save();
        if (!changed) return;
        Connect();
        quick?.Reset();
        await Refresh();
    }

    // The ball

    public void SetBallShown(bool shown)
    {
        prefs.FloatingBall = shown;
        Save();
        SyncBall();
    }

    void SyncBall()
    {
        if (prefs.FloatingBall && ball is null)
        {
            ball = new BallWindow(prefs.SavedOrigin);
            ball.OpenSection += s => OpenSection(s, null);
            ball.Dropped += Dropped;
            ball.Refused += reason => Notify(Strings.T(reason));
            ball.Moved += at => { prefs.SavedOrigin = at; Save(); };
            ball.QuickChatRequested += () => OpenQuickChat(null, null, null);
            ball.SettingsRequested += OpenSettings;
            ball.HideRequested += () => SetBallShown(false);
            ball.Show();
            Changed();
        }
        else if (!prefs.FloatingBall && ball is not null)
        {
            ball.Close();
            ball = null;
        }
        if (tray?.ContextMenuStrip?.Items[1] is Forms.ToolStripMenuItem item) item.Checked = prefs.FloatingBall;
    }

    /// <summary>A section: Quick Chat on its agent, with "Save this to …" when an app borrows Space Assistant.</summary>
    void OpenSection(Section s, ChatImage? picture)
    {
        var d = dial.GetValueOrDefault(s);
        if (d?.Agent is null) { OpenSettings(); return; }
        var lead = d.Borrowed && d.Entry is { } e ? Strings.T("saveTo", e.TitleIn(Strings.Lang)) : null;
        OpenQuickChat(d.Agent, lead, picture);
    }

    void Dropped(Section? s, byte[] bytes, string name)
    {
        var type = ChatImage.TypeOf(bytes);
        if (type is null) { Notify(Strings.T("notAPicture")); return; }
        var picture = new ChatImage(name, type, bytes);
        if (!ChatImage.Fits([], picture)) { Notify(Strings.T("tooMany")); return; }
        // The hub hands a picture to Space Assistant.
        OpenSection(s ?? Section.Assistant, picture);
    }

    // Windows

    public void OpenQuickChat(string? agent, string? lead, ChatImage? picture)
    {
        quick ??= new QuickChatWindow(this);
        quick.Open(agent ?? prefs.LastAgent, lead, picture);
    }

    public void OpenSettings()
    {
        if (settings is null)
        {
            settings = new SettingsWindow(this);
            settings.Closed += (_, _) => settings = null;
            settings.Show();
        }
        settings.Activate();
    }

    void MakeTray()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add(Strings.T("quickChat"), null, (_, _) => OpenQuickChat(null, null, null));
        menu.Items.Add(new Forms.ToolStripMenuItem(Strings.T("showBall"), null, (_, _) => SetBallShown(!prefs.FloatingBall)) { Checked = prefs.FloatingBall });
        menu.Items.Add(Strings.T("settings"), null, (_, _) => OpenSettings());
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(Strings.T("quit"), null, (_, _) => Quit());
        using var stream = typeof(Controller).Assembly.GetManifestResourceStream("AppIcon.ico");
        tray = new Forms.NotifyIcon
        {
            Text = Strings.T("app"),
            Icon = stream is null ? System.Drawing.SystemIcons.Application : new System.Drawing.Icon(stream),
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.MouseClick += (_, e) => { if (e.Button == Forms.MouseButtons.Left) OpenQuickChat(null, null, null); };
    }

    public void Notify(string text) => tray?.ShowBalloonTip(4000, Strings.T("app"), text, Forms.ToolTipIcon.None);

    void Quit()
    {
        refresh.Stop();
        if (tray is not null) { tray.Visible = false; tray.Dispose(); }
        client?.Dispose();
        app.Shutdown();
    }
}
