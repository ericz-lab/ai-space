using System.Windows.Interop;
using AISpace.Core;

namespace AISpace.Shell;

/// <summary>The Quick Chat shortcut, system-wide, on a message-only window of its own (the Mac's <c>HotKey</c>).</summary>
internal sealed class HotKey : IDisposable
{
    private const int Id = 0xA15C;
    private readonly HwndSource _window;
    private readonly Action _pressed;
    private bool _registered;

    public HotKey(Action pressed)
    {
        _pressed = pressed;
        // HWND_MESSAGE: never shown, only receives messages.
        _window = new HwndSource(new HwndSourceParameters("ai-space-hotkey") { ParentWindow = new IntPtr(-3), WindowStyle = 0 });
        _window.AddHook(Hook);
    }

    /// <summary>False when another program holds the combination.</summary>
    public bool Register(QuickChatShortcut shortcut)
    {
        Unregister();
        if (Shortcuts.Keys(shortcut) is not { } keys) return true;
        _registered = Native.RegisterHotKey(_window.Handle, Id, keys.Modifiers, keys.Key);
        return _registered;
    }

    private void Unregister()
    {
        if (!_registered) return;
        Native.UnregisterHotKey(_window.Handle, Id);
        _registered = false;
    }

    private IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == Native.WM_HOTKEY && wParam.ToInt32() == Id)
        {
            handled = true;
            _pressed();
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        Unregister();
        _window.RemoveHook(Hook);
        _window.Dispose();
    }
}
