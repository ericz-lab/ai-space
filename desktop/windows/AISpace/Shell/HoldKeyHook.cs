using System.Runtime.InteropServices;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Shell;

/// <summary>
/// Holding the talk key in any app (the Mac's <c>FnKey</c>; docs/windows-desktop.md#voice-input).
/// A hot key cannot be a bare modifier, so this is a low-level keyboard hook (<c>WH_KEYBOARD_LL</c>),
/// installed only while the setting is on. It sees every key typed in this session's programs and
/// keeps none: each event goes on unchanged, and keys typed by programs (SendInput, this app's own
/// Ctrl+V) are not looked at. <see cref="HoldKeyRules"/> decides what a press means.
///
/// Windows does not show a program the keys typed into a program running as administrator, so a
/// release there would be missed: while the key is down its state is also read every 0.1 seconds.
/// </summary>
internal sealed class HoldKeyHook : IDisposable
{
    private readonly Dispatcher _ui;
    private readonly Action _began, _ended, _cancelled;
    private readonly HookProc _proc;
    private readonly IntPtr _procPointer;
    private readonly DispatcherTimer _arm;
    private readonly DispatcherTimer _watch;
    private HoldKeyRules? _rules;
    private IntPtr _hook;
    private int _armed;
    private bool _seenDown;

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    public HoldKeyHook(Dispatcher ui, Action began, Action ended, Action cancelled)
    {
        _ui = ui;
        _began = began;
        _ended = ended;
        _cancelled = cancelled;
        // Kept in a field: the hook calls through this pointer for as long as it is installed.
        _proc = OnKey;
        _procPointer = Marshal.GetFunctionPointerForDelegate(_proc);
        _arm = new DispatcherTimer(DispatcherPriority.Input, ui) { Interval = HoldKeyRules.Delay };
        _arm.Tick += (_, _) =>
        {
            _arm.Stop();
            if (_rules is { } r) Run(r.Elapsed(_armed));
        };
        _watch = new DispatcherTimer(DispatcherPriority.Input, ui) { Interval = TimeSpan.FromMilliseconds(100) };
        _watch.Tick += (_, _) => Watch();
    }

    /// <summary>Installs the hook for <paramref name="key"/>, or removes it (null). False when Windows refused it.</summary>
    public bool Set(HoldToTalkKey? key)
    {
        Remove();
        if (key is not { } k) return true;
        _rules = new HoldKeyRules(HoldToTalkKeys.VirtualKey(k));
        _hook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _procPointer, Native.GetModuleHandle(IntPtr.Zero), 0);
        if (_hook != IntPtr.Zero) return true;
        Log.Write($"voice input: the keyboard hook was refused ({Marshal.GetLastPInvokeError()})");
        _rules = null;
        return false;
    }

    private void Remove()
    {
        if (_hook != IntPtr.Zero) Native.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
        _arm.Stop();
        _watch.Stop();
        // A recording in progress ends as if the key came up.
        if (_rules?.Reset() == true) _ended();
        _rules = null;
    }

    /// <summary>Runs on the UI thread for every key; it must return quickly, or Windows drops the hook.</summary>
    private IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && _rules is { } rules && (Marshal.ReadInt32(lParam, 8) & Native.LLKHF_INJECTED) == 0)
        {
            var message = wParam.ToInt32();
            var vk = Marshal.ReadInt32(lParam);
            var down = message is Native.WM_KEYDOWN or Native.WM_SYSKEYDOWN;
            if (down || message is Native.WM_KEYUP or Native.WM_SYSKEYUP)
            {
                if (down && vk == rules.Key && !rules.Holding) rules.Prune(Native.IsKeyDown);
                var action = rules.Feed(vk, down);
                if (action.Kind != HoldKeyRules.Kind.None) _ui.BeginInvoke(() => Run(action));
            }
        }
        return Native.CallNextHookEx(_hook, code, wParam, lParam);
    }

    private void Run(HoldKeyRules.Action action)
    {
        switch (action.Kind)
        {
            case HoldKeyRules.Kind.Arm:
                _armed = action.Token;
                _arm.Stop();
                _arm.Start();
                _seenDown = false;
                _watch.Start();
                break;
            case HoldKeyRules.Kind.Start:
                // Letting go of the key alone would otherwise open the menu bar (Alt) or switch an input method (Ctrl).
                Native.SendKeys((Native.VK_MASK, true), (Native.VK_MASK, false));
                _began();
                break;
            case HoldKeyRules.Kind.Stop:
                _ended();
                break;
            case HoldKeyRules.Kind.Cancel:
                _cancelled();
                break;
        }
        if (_rules is not { Holding: true }) _watch.Stop();
    }

    /// <summary>A release the hook missed (an elevated program in front) would leave the microphone on.</summary>
    private void Watch()
    {
        if (_rules is not { } rules || !rules.Holding)
        {
            _watch.Stop();
            return;
        }
        if (Native.IsKeyDown(rules.Key)) _seenDown = true;
        else if (_seenDown) Run(rules.Feed(rules.Key, down: false));
    }

    public void Dispose() => Remove();
}
