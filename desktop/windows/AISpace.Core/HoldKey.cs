namespace AISpace.Core;

/// <summary>
/// The key held to talk in any app (docs/windows-desktop.md#voice-input). Windows has no fn key
/// that programs can see, so one of the right-hand modifiers stands in for it: held alone it does
/// nothing in Windows or in common programs, and it is not an input method's switch by default.
/// </summary>
public enum HoldToTalkKey
{
    RightCtrl,
    RightAlt,
}

public static class HoldToTalkKeys
{
    // Virtual-key codes as a low-level keyboard hook reports them (left and right apart).
    public const int VkLShift = 0xA0, VkRShift = 0xA1, VkLControl = 0xA2, VkRControl = 0xA3, VkLMenu = 0xA4, VkRMenu = 0xA5;

    public static int VirtualKey(HoldToTalkKey key) => key == HoldToTalkKey.RightAlt ? VkRMenu : VkRControl;

    public static string Label(HoldToTalkKey key) => key == HoldToTalkKey.RightAlt ? "Right Alt" : "Right Ctrl";
}

/// <summary>
/// When holding the talk key means "talk": the Mac's <c>FnHoldRules</c> on Windows' key events.
/// Free of Windows: <c>Shell/HoldKeyHook.cs</c> feeds it every key a low-level hook sees and runs
/// its timer, the tests check the decisions.
///
/// The key is also half of shortcuts (Ctrl+C with the right Ctrl), so a press arms a short timer
/// and only the key held alone until it runs out starts recording; letting go after that stops it.
/// A tap never starts. Pressed while another key is down, or another key pressed before the timer
/// runs out, it is a combination and does nothing until it comes up. Unlike the Mac, a key pressed
/// while already recording cancels the recording (nothing is sent): on Windows the talk key is a
/// modifier people also use with other keys, so a slow Ctrl+C must not paste a transcript.
/// </summary>
public sealed class HoldKeyRules(int key)
{
    public enum Kind
    {
        None,
        /// <summary>Run the timer, then call <see cref="Elapsed"/> with the token.</summary>
        Arm,
        Start,
        Stop,
        /// <summary>The recording was part of a combination after all: drop it, send nothing.</summary>
        Cancel,
    }

    public readonly record struct Action(Kind Kind, int Token = 0)
    {
        public static readonly Action None = new(Kind.None);
    }

    /// <summary>Long enough that a tap or a combination never starts, short enough not to clip the first word.</summary>
    public static readonly TimeSpan Delay = TimeSpan.FromMilliseconds(250);

    private enum Phase { Idle, Armed, Recording, Spoiled }

    private readonly HashSet<int> _others = [];
    private Phase _phase = Phase.Idle;
    private int _token;

    public int Key { get; } = key;

    /// <summary>The key is down in one of the ways this tracks: the caller watches for a missed release meanwhile.</summary>
    public bool Holding => _phase != Phase.Idle;

    public bool Recording => _phase == Phase.Recording;

    /// <summary>A key went down or up (a key held down repeats its down).</summary>
    public Action Feed(int vk, bool down)
    {
        if (vk != Key)
        {
            if (!down)
            {
                _others.Remove(vk);
                return Action.None;
            }
            var repeat = !_others.Add(vk);
            switch (_phase)
            {
                case Phase.Armed:
                    _phase = Phase.Spoiled;
                    return Action.None;
                case Phase.Recording when !repeat:
                    _phase = Phase.Spoiled;
                    return new Action(Kind.Cancel);
                default:
                    return Action.None;
            }
        }
        if (down)
        {
            // A repeat while held, or a second down without an up, changes nothing.
            if (_phase != Phase.Idle) return Action.None;
            if (_others.Count > 0)
            {
                _phase = Phase.Spoiled;
                return Action.None;
            }
            _phase = Phase.Armed;
            return new Action(Kind.Arm, ++_token);
        }
        var was = _phase;
        _phase = Phase.Idle;
        return was == Phase.Recording ? new Action(Kind.Stop) : Action.None;
    }

    /// <summary>The timer of an <see cref="Kind.Arm"/> ran out.</summary>
    public Action Elapsed(int token)
    {
        if (_phase != Phase.Armed || token != _token) return Action.None;
        _phase = Phase.Recording;
        return new Action(Kind.Start);
    }

    /// <summary>
    /// Forgets other keys that are no longer down: a release the hook did not see (a window of an
    /// elevated program had the keyboard) would otherwise spoil every later press.
    /// </summary>
    public void Prune(Func<int, bool> isDown) => _others.RemoveWhere(vk => !isDown(vk));

    /// <summary>The setting went off or the key changed: forget a hold in progress. True when a recording was going on.</summary>
    public bool Reset()
    {
        var recording = _phase == Phase.Recording;
        _phase = Phase.Idle;
        _others.Clear();
        return recording;
    }
}

/// <summary>How a transcript of the hold-to-talk input reaches the field that has the keyboard (the Mac's <c>DictationRules</c>).</summary>
public static class DictationRules
{
    public enum Delivery
    {
        /// <summary>Through the clipboard and a simulated Ctrl+V to the window in front, then the clipboard is put back.</summary>
        Paste,
        /// <summary>The transcript stays on the clipboard for the person to paste.</summary>
        ClipboardOnly,
    }

    /// <summary>
    /// <paramref name="foreground"/>: a window is in front. <paramref name="own"/>: it is this app's,
    /// and <paramref name="ownTakesText"/>: its focused element is a text field or a web page.
    /// <paramref name="elevated"/>: it belongs to a program running as administrator (or one whose
    /// rights cannot be read) while this app is not: Windows drops input sent to it.
    /// </summary>
    public static Delivery For(bool foreground, bool own, bool ownTakesText, bool elevated)
    {
        if (!foreground) return Delivery.ClipboardOnly;
        if (own) return ownTakesText ? Delivery.Paste : Delivery.ClipboardOnly;
        return elevated ? Delivery.ClipboardOnly : Delivery.Paste;
    }

    /// <summary>How long a pasted transcript holds the clipboard before what was there comes back.</summary>
    public static readonly TimeSpan RestoreDelay = TimeSpan.FromMilliseconds(800);

    /// <summary>
    /// The earlier clipboard comes back after a paste, unless something else was copied since
    /// (Windows' clipboard sequence number moved). A transcript left to paste is never taken away.
    /// </summary>
    public static bool Restores(Delivery delivery, uint sequenceNow, uint sequenceWritten) =>
        delivery == Delivery.Paste && sequenceNow == sequenceWritten;
}
