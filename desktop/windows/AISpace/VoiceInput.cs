using System.Windows;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;
using AISpace.Views;

namespace AISpace;

/// <summary>
/// Voice input (docs/windows-desktop.md#voice-input), both forms: the microphone beside the app's
/// own fields (Home's command box, Quick Chat), whose transcript goes into the field and is never
/// sent, and holding a key in any app (the Mac's <c>Dictation</c>), whose transcript goes into
/// the field in front through the clipboard and a simulated Ctrl+V. One recording at a time, one
/// microphone. The rules are AISpace.Core's (<see cref="VoiceSession"/>, <see cref="HoldKeyRules"/>,
/// <see cref="DictationRules"/>, <see cref="VoiceLanguage"/>, <see cref="VoiceSpace"/>); this class
/// joins them to the microphone, the overlay and the clipboard.
/// </summary>
internal sealed class VoiceInput : IDisposable
{
    /// <summary>What each Space answered to <c>GET /api/voice</c>, by origin, for the life of the app.</summary>
    private static readonly Dictionary<Uri, bool> Known = [];

    private readonly AppModel _model;
    private readonly Dispatcher _ui;
    private readonly VoiceOverlay _overlay = new();
    private readonly HoldKeyHook _hook;
    private VoiceSession? _session;
    private Microphone? _mic;
    private string _hint = "";
    private string _heard = "";
    /// <summary>Whose recording it is: a field's button, or <see cref="HoldOwner"/>.</summary>
    private object? _owner;
    /// <summary>Between the key going down and the recording starting, while the Space is asked.</summary>
    private bool _choosing;
    /// <summary>The key came up (or was part of a combination) while the Space was asked: nothing is recorded.</summary>
    private bool _released;

    private static readonly object HoldOwner = new();

    public VoiceInput(AppModel model, Dispatcher ui)
    {
        _model = model;
        _ui = ui;
        _hook = new HoldKeyHook(ui, HoldBegan, HoldEnded, HoldCancelled);
    }

    /// <summary>A recording started, finished or changed hands: the fields' buttons redraw.</summary>
    public event Action? Changed;

    /// <summary>Whether <paramref name="owner"/>'s recording is under way (listening).</summary>
    public bool Recording(object owner) => _owner == owner && _mic is not null;

    /// <summary>Whether <paramref name="owner"/>'s recording is being transcribed.</summary>
    public bool Transcribing(object owner) => _owner == owner && _session is not null && _mic is null;

    /// <summary>Whether a recording of anyone's is under way or being transcribed.</summary>
    public bool Busy => _session is not null || _choosing;

    /// <summary>Applies Settings › General: the hook is installed only while hold to talk is on. False when Windows refused the hook.</summary>
    public bool Apply() => _hook.Set(_model.Prefs.VoiceInput ? _model.Prefs.VoiceInputKey : null);

    /// <summary>Whether the Space can transcribe, asked once per Space; false while it does not answer (asked again next time).</summary>
    public static async Task<bool> CanTranscribe(SpaceApi api)
    {
        if (Known.TryGetValue(api.Base, out var known)) return known;
        if (await api.VoiceAvailable() is not { } can) return false;
        Known[api.Base] = can;
        return can;
    }

    private string Language => VoiceLanguage.Code(_model.Prefs.VoiceLanguage, Core.Lang.Current);

    // The microphone beside a field

    /// <summary>
    /// The field's microphone was clicked: starts recording into <paramref name="api"/>'s Space, or,
    /// when this field is recording, ends it; <paramref name="deliver"/> gets the transcript once.
    /// </summary>
    public void Toggle(object owner, SpaceApi api, Action<string> deliver)
    {
        if (Recording(owner))
        {
            Finish();
            return;
        }
        if (Busy) return;
        Begin(owner, api, deliver, L.T("Listening… click the microphone to stop"));
    }

    // Holding the key

    private string KeyLabel => _model.Prefs.VoiceInputKey == HoldToTalkKey.RightAlt ? L.T("Right Alt") : L.T("Right Ctrl");

    private async void HoldBegan()
    {
        if (Busy) return;
        _choosing = true;
        _released = false;
        _overlay.Listening("", L.F("Listening… let go of {0} to finish", KeyLabel));
        try
        {
            if (await HoldSpace() is not { } api) return;
            // Let go before the Space answered: too short to have said anything.
            if (_released)
            {
                _overlay.Done();
                return;
            }
            Begin(HoldOwner, api, Paste, L.F("Listening… let go of {0} to finish", KeyLabel));
        }
        finally
        {
            _choosing = false;
        }
    }

    /// <summary>
    /// One Space: the one chosen under Transcribe with, else the selected one, and never another:
    /// the saved Spaces may not all be the person's own, and speech goes nowhere unasked.
    /// </summary>
    private async Task<SpaceApi?> HoldSpace()
    {
        var saved = _model.Store.Connections.Select(c => c.Id).ToList();
        if (VoiceSpace.Choose(saved, _model.Prefs.VoiceInputSpace, _model.Selected, _model.Store.Default?.Id) is not { } id || _model.Store.Get(id) is not { } c)
        {
            _overlay.Note(L.T("Add a Space first to use voice input."));
            return null;
        }
        if (!_model.Lives.TryGetValue(id, out var live) || live.Status is not (LiveStatus.Ok or LiveStatus.Unknown))
        {
            _overlay.Note(L.F("{0} is not connected. Voice input needs the Space.", c.DisplayNameOr()));
            return null;
        }
        if (!await CanTranscribe(live.Api))
        {
            _overlay.Note(saved.Count > 1
                ? L.F("{0} cannot transcribe speech. Choose another Space in AI Space Settings → General → Transcribe with.", c.DisplayNameOr())
                : L.F("{0} cannot transcribe speech.", c.DisplayNameOr()));
            return null;
        }
        return live.Api;
    }

    private void HoldEnded()
    {
        if (_choosing)
        {
            _released = true;
            return;
        }
        if (_owner == HoldOwner) Finish();
    }

    /// <summary>The key turned out to be part of a combination: the recording is dropped, nothing is sent.</summary>
    private void HoldCancelled()
    {
        if (_choosing)
        {
            _released = true;
            return;
        }
        if (_owner == HoldOwner) _session?.Cancel();
    }

    // One recording

    private void Begin(object owner, SpaceApi api, Action<string> deliver, string hint)
    {
        if (Microphone.Unavailable() is { } why)
        {
            _overlay.Note(why);
            return;
        }
        var session = new VoiceSession(api.VoiceSocket, api.Transcribe, Language);
        var mic = new Microphone(bytes => session.Feed(bytes));
        try
        {
            mic.Start();
        }
        catch (IOException e)
        {
            Log.Write($"voice input: {e.Message}");
            mic.Dispose();
            _overlay.Note(L.F("Could not record: {0}", e.Message));
            return;
        }
        _session = session;
        _mic = mic;
        _owner = owner;
        _hint = hint;
        _heard = "";
        session.TextChanged += text => _ui.BeginInvoke(() =>
        {
            if (_session != session) return;
            _heard = text;
            if (_mic is not null) _overlay.Listening(text, _hint);
            else _overlay.Transcribing(text);
        });
        // The limit, or held too long for a transcriber that is not ready: the microphone closes.
        session.RecordingEnded += () => _ui.BeginInvoke(() =>
        {
            if (_session == session) StopMic();
        });
        session.Start();
        _overlay.Listening("", hint);
        Changed?.Invoke();
        _ = Await(session, deliver);
    }

    /// <summary>Let go (or clicked again): the last audio goes, then the final text.</summary>
    private void Finish()
    {
        if (_session is not { } session) return;
        StopMic();
        session.Stop();
        _overlay.Transcribing(session.Live ? _heard : "");
    }

    private void StopMic()
    {
        var mic = _mic;
        _mic = null;
        // Stopping hands over what was recorded so far before the session is told to stop.
        mic?.Dispose();
        Changed?.Invoke();
    }

    private async Task Await(VoiceSession session, Action<string> deliver)
    {
        var outcome = await session.Outcome;
        await _ui.InvokeAsync(() =>
        {
            if (_session != session) return;
            StopMic();
            _session = null;
            _owner = null;
            Changed?.Invoke();
            switch (outcome)
            {
                case VoiceOutcome.Text { Value.Length: > 0 } t:
                    _overlay.Done();
                    deliver(t.Value);
                    break;
                case VoiceOutcome.Failed f:
                    Log.Write($"voice input: {f.Kind} {f.Detail}");
                    _overlay.Note(f.Kind switch
                    {
                        VoiceFailure.TooSlow => L.T("The voice connection is too slow."),
                        VoiceFailure.TimedOut => L.T("Voice connection timed out."),
                        _ when f.Detail.Length == 0 => L.T("Voice input failed."),
                        _ => L.F("Voice input failed: {0}", f.Detail),
                    });
                    break;
                default:
                    _overlay.Done();
                    break;
            }
        });
    }

    // Into the field in front

    /// <summary>
    /// The transcript goes through the clipboard: written (marked to stay out of the clipboard
    /// history), pasted with Ctrl+V into the window in front, and the earlier contents put back once
    /// the field has read them. Where Windows would drop the keys (nothing in front, a program run
    /// as administrator) or this app has no field focused, it stays on the clipboard and the overlay says so.
    /// </summary>
    private void Paste(string text)
    {
        var front = Native.GetForegroundWindow();
        Native.GetWindowThreadProcessId(front, out var pid);
        var own = front != IntPtr.Zero && pid == Environment.ProcessId;
        var focused = Keyboard.FocusedElement;
        var ownTakesText = focused is TextBoxBase or Microsoft.Web.WebView2.Wpf.WebView2 or System.Windows.Controls.ComboBox { IsEditable: true };
        var self = Native.IsElevated((uint)Environment.ProcessId) == true;
        var elevated = !own && front != IntPtr.Zero && !self && Native.IsElevated(pid) != false;
        var delivery = DictationRules.For(front != IntPtr.Zero, own, ownTakesText, elevated);
        var saved = delivery == DictationRules.Delivery.Paste ? Snapshot() : null;
        if (!Write(text, transient: delivery == DictationRules.Delivery.Paste))
        {
            _overlay.Note(L.T("The clipboard is in use by another program, so the text could not be put in."));
            return;
        }
        var written = Native.GetClipboardSequenceNumber();
        if (delivery == DictationRules.Delivery.ClipboardOnly)
        {
            _overlay.Note(elevated
                ? L.T("The text is on the clipboard. Press Ctrl+V to paste it: the program in front runs as administrator, so AI Space cannot type into it.")
                : L.T("The text is on the clipboard. Press Ctrl+V to paste it."));
            return;
        }
        Native.SendKeys((Native.VK_CONTROL, true), (Native.VK_V, true), (Native.VK_V, false), (Native.VK_CONTROL, false));
        var timer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = DictationRules.RestoreDelay };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            if (!DictationRules.Restores(delivery, Native.GetClipboardSequenceNumber(), written)) return;
            Restore(saved);
        };
        timer.Start();
    }

    /// <summary>Every format of the clipboard that can be read now, copied: the clipboard's own objects go once it changes.</summary>
    private static DataObject? Snapshot()
    {
        try
        {
            if (Clipboard.GetDataObject() is not { } data) return null;
            var copy = new DataObject();
            foreach (var format in data.GetFormats(false))
            {
                try
                {
                    if (data.GetData(format, false) is { } value) copy.SetData(format, value, false);
                }
                catch (Exception e) when (e is System.Runtime.InteropServices.COMException or System.Runtime.InteropServices.ExternalException or OutOfMemoryException or InvalidOperationException)
                {
                    // A format that cannot be read now (delayed rendering by a program that quit) is left out.
                }
            }
            return copy;
        }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            return null;
        }
    }

    private static bool Write(string text, bool transient)
    {
        var data = new DataObject();
        data.SetText(text, TextDataFormat.UnicodeText);
        if (transient)
        {
            // Windows' clipboard history and its cloud sync skip what carries these (as the Mac marks it transient).
            data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(new byte[4]), false);
            data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]), false);
            data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]), false);
        }
        try
        {
            Clipboard.SetDataObject(data, true);
            return true;
        }
        catch (System.Runtime.InteropServices.ExternalException e)
        {
            Log.Write($"voice input: the clipboard: {e.Message}");
            return false;
        }
    }

    private static void Restore(DataObject? saved)
    {
        try
        {
            if (saved is null || saved.GetFormats(false).Length == 0) Clipboard.Clear();
            else Clipboard.SetDataObject(saved, true);
        }
        catch (Exception e)
        {
            // A format copied from another program may not go back (it was the program's own object).
            Log.Write($"voice input: the earlier clipboard could not be put back: {e.Message}");
        }
    }

    public void Dispose()
    {
        _hook.Dispose();
        _session?.Cancel();
        _mic?.Dispose();
        _mic = null;
        _overlay.Close();
    }
}
