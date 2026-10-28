using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using CoreRect = AISpace.Core.Rect;

namespace AISpace.Windows;

/// <summary>The few Win32 calls WPF does not offer.</summary>
static class Native
{
    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x00000080;
    const long WS_EX_NOACTIVATE = 0x08000000;
    const uint MONITOR_DEFAULTTONEAREST = 2;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }

    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("user32.dll")]
    static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    /// <summary>
    /// A tool window that never takes the keyboard: no taskbar button, not in Alt+Tab, and a click
    /// leaves the app in front where it was (the Mac's non-activating panel).
    /// </summary>
    public static void MakeToolWindow(Window window, bool noActivate)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var style = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64() | WS_EX_TOOLWINDOW;
        if (noActivate) style |= WS_EX_NOACTIVATE;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(style));
    }

    /// <summary>The pointer, in the window's device-independent pixels.</summary>
    public static Point Cursor(Visual visual)
    {
        GetCursorPos(out var p);
        var scale = VisualTreeHelper.GetDpi(visual);
        return new Point(p.X / scale.DpiScaleX, p.Y / scale.DpiScaleY);
    }

    /// <summary>The work area (without the taskbar) of the monitor at a point, both in device-independent pixels.</summary>
    public static CoreRect WorkArea(Visual visual, Point at)
    {
        var scale = VisualTreeHelper.GetDpi(visual);
        var monitor = MonitorFromPoint(new POINT { X = (int)(at.X * scale.DpiScaleX), Y = (int)(at.Y * scale.DpiScaleY) }, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            var w = SystemParameters.WorkArea;
            return new CoreRect(w.X, w.Y, w.Width, w.Height);
        }
        var r = info.Work;
        return new CoreRect(r.Left / scale.DpiScaleX, r.Top / scale.DpiScaleY, (r.Right - r.Left) / scale.DpiScaleX, (r.Bottom - r.Top) / scale.DpiScaleY);
    }
}
