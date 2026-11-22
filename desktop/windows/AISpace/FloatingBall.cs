using System.Windows.Media;
using System.Windows.Media.Imaging;
using AISpace.Core;
using AISpace.Shell;
using AISpace.Views;

namespace AISpace;

/// <summary>A picture the floating ball hands to Quick Chat: a type the chat takes (PNG, JPEG, GIF, WebP).</summary>
internal sealed record BallPicture(string Name, string Type, byte[] Bytes);

/// <summary>
/// The floating ball (the Mac's <c>FloatingBall</c>, the Linux client's <c>app/floating-ball.ts</c>):
/// shown when Settings turns it on, its four sections filled from the Space the main window shows
/// (each Space keeps its own choices), and what the ball reports turned into Quick Chat opened
/// beside it: on the section's agent, with "Save this to …:" when an app lends Space Assistant,
/// and with a dropped picture attached.
/// </summary>
internal sealed class FloatingBall
{
    private readonly AppModel _model;
    private readonly App _app;
    private Dictionary<BallSection, DialEntry> _dial = [];
    private BallWindow? _window;
    private Guid? _space;

    public FloatingBall(AppModel model, App app)
    {
        _model = model;
        _app = app;
        _model.Changed += Fill;
    }

    public bool Shown => _model.Prefs.FloatingBall;

    /// <summary>The Space the sections come from: the one the main window shows, else the default.</summary>
    public Connection? Space => _model.SelectedConnection ?? _model.Store.Default;

    public void Set(bool shown)
    {
        _model.Prefs.FloatingBall = shown;
        _model.SavePrefs();
        Sync();
    }

    /// <summary>Shows or closes the ball as the preferences say.</summary>
    public void Sync()
    {
        if (_model.Prefs.FloatingBall && _window is null)
        {
            var w = _window = new BallWindow(_model.Prefs.BallOrigin);
            w.OpenSection += s => Open(s, null);
            w.Dropped += Dropped;
            w.Refused += Notice;
            w.Moved += at =>
            {
                _model.Prefs.BallOrigin = at;
                _model.SavePrefs();
            };
            w.QuickChatRequested += () => _app.ShowQuickChat(null, null);
            w.SettingsRequested += () => _app.OpenSettings();
            w.HideRequested += () => Set(false);
            w.Show();
            Fill();
        }
        else if (!_model.Prefs.FloatingBall && _window is not null)
        {
            _window.Close();
            _window = null;
        }
    }

    public void Close()
    {
        _window?.Close();
        _window = null;
    }

    /// <summary>A section's setting in a Space: null for the default, <see cref="FloatingBallRules.EmptySlot"/> for none, else an entry key.</summary>
    public string? Slot(Guid space, BallSection section) => FloatingBallRules.Slot(section, Slots(space));

    public void SetSlot(Guid space, BallSection section, string? key)
    {
        _model.Prefs.BallSlots[space.ToString()] = FloatingBallRules.Setting(section, key, Slots(space));
        _model.SavePrefs();
        Fill();
    }

    private List<string>? Slots(Guid space) => _model.Prefs.BallSlots.GetValueOrDefault(space.ToString());

    /// <summary>What each section shows in the current Space, worked out again whenever it may have changed.</summary>
    private void Fill()
    {
        if (_window is null) return;
        var c = Space;
        var live = c is not null && _model.Lives.TryGetValue(c.Id, out var l) && l.LastRefresh is not null ? l : null;
        if (_space is { } before && before != c?.Id) _model.Icons(before).Arrived -= OnIcon;
        if (c is not null)
        {
            // Once per store, which is made again when the Space signs out or changes address.
            _model.Icons(c.Id).Arrived -= OnIcon;
            _model.Icons(c.Id).Arrived += OnIcon;
        }
        _space = c?.Id;
        _dial = FloatingBallRules.Resolve(live?.Apps, live?.Agents, c is null ? null : Slots(c.Id));
        _window.SetSections(FloatingBallRules.Sections.ToDictionary(s => s, s =>
        {
            var d = _dial[s];
            var title = d.Title() ?? FallbackTitle(s);
            var icon = d.Icon;
            return new DialSectionView(title, c is not null ? _model.Icons(c.Id).Get(icon) : null, IconStore.Emoji(icon), d.IsAgent, d.Agent is not null, d.Hidden);
        }));
    }

    /// <summary>A section's name while the Space has no such entry (<see cref="FloatingBallRules.FallbackTitle"/>, in the interface's language).</summary>
    public static string FallbackTitle(BallSection s) => s switch
    {
        BallSection.Keep => L.T("Keep"),
        BallSection.Assistant => L.T("Space Assistant"),
        BallSection.Todo => L.T("Todo"),
        _ => L.T("Design Studio"),
    };

    /// <summary>An icon the Space serves arrived (IconStore, fetched with the Space's sign-in): the dial is drawn again.</summary>
    private void OnIcon(string icon) => Fill();

    /// <summary>
    /// Quick Chat beside the ball on the section's agent. When the app has no agent of its own,
    /// Space Assistant takes the work and the draft starts by saying where it goes. With no
    /// section (the hub), Space Assistant takes a dropped picture.
    /// </summary>
    private void Open(BallSection? section, BallPicture? picture)
    {
        var d = section is { } s ? _dial.GetValueOrDefault(s) : null;
        if (section is not null && d?.Agent is null)
        {
            _app.OpenSettings();
            return;
        }
        var agent = d?.Agent ?? Assistant();
        var lead = d is { Borrowed: true } && d.Title() is { } title ? FloatingBallRules.WithLead("", L.F("Save this to {0}:", title)) : null;
        _app.Chat().Present(agent, lead, Space?.Id, _window?.Frame, picture);
    }

    private string? Assistant()
    {
        if (Space is not { } c || !_model.Lives.TryGetValue(c.Id, out var live)) return null;
        return FloatingBallRules.AgentFor(BallSection.Assistant, live.Agents.Select(a => a.Id));
    }

    private void Dropped(BallSection? section, byte[] bytes, string name)
    {
        if (Picture(bytes, name) is not { } picture)
        {
            Notice(L.T("That is not a picture."));
            return;
        }
        if (picture.Bytes.Length > FloatingBallRules.MaxPictureBytes)
        {
            Notice(L.T("Pictures can be at most 5 MB."));
            return;
        }
        Open(section, picture);
    }

    /// <summary>The picture as the chat takes it: as it is when it is PNG, JPEG, GIF or WebP, else (a bitmap, a TIFF) as PNG.</summary>
    private static BallPicture? Picture(byte[] bytes, string name)
    {
        if (FloatingBallRules.PictureType(bytes) is { } type) return new BallPicture(name, type, bytes);
        try
        {
            var frame = BitmapDecoder.Create(new MemoryStream(bytes), BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(frame);
            using var output = new MemoryStream();
            encoder.Save(output);
            return new BallPicture(Path.ChangeExtension(name, ".png"), "image/png", output.ToArray());
        }
        catch (Exception e) when (e is NotSupportedException or IOException or InvalidOperationException or ArgumentException or System.Runtime.InteropServices.COMException or FileFormatException)
        {
            return null;
        }
    }

    private void Notice(string text) => _app.Notice(L.T("Floating Ball"), text);
}
