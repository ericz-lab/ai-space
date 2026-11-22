using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace AISpace.Shell;

/// <summary>The few Win32 calls WPF has no wrapper for.</summary>
internal static partial class Native
{
    public const int WM_HOTKEY = 0x0312;
    public const int SW_RESTORE = 9;
    public const int ASFW_ANY = -1;

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool UnregisterHotKey(IntPtr hWnd, int id);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool SetForegroundWindow(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool AllowSetForegroundWindow(int dwProcessId);

    [LibraryImport("shell32.dll")]
    public static partial void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

    // The floating ball's window and the screens (Views/BallWindow.cs).

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_TOOLWINDOW = 0x00000080;
    private const long WS_EX_NOACTIVATE = 0x08000000;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static partial IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static partial IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetCursorPos(out POINT point);

    [LibraryImport("user32.dll")]
    private static partial IntPtr MonitorFromPoint(POINT point, uint flags);

    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    /// <summary>
    /// A tool window: no taskbar button and not in Alt+Tab; with <paramref name="noActivate"/>, a
    /// click on it leaves the app in front where it was (the Mac's non-activating panel).
    /// </summary>
    public static void MakeToolWindow(System.Windows.Window window, bool noActivate)
    {
        var hwnd = new System.Windows.Interop.WindowInteropHelper(window).Handle;
        var style = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64() | WS_EX_TOOLWINDOW;
        if (noActivate) style |= WS_EX_NOACTIVATE;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(style));
    }

    /// <summary>The pointer, in the visual's device-independent pixels.</summary>
    public static System.Windows.Point Cursor(System.Windows.Media.Visual visual)
    {
        GetCursorPos(out var p);
        var scale = System.Windows.Media.VisualTreeHelper.GetDpi(visual);
        return new System.Windows.Point(p.X / scale.DpiScaleX, p.Y / scale.DpiScaleY);
    }

    /// <summary>The work area (the screen without the taskbar) of the monitor at a point, both in device-independent pixels.</summary>
    public static Core.ScreenRect WorkArea(System.Windows.Media.Visual visual, System.Windows.Point at)
    {
        var scale = System.Windows.Media.VisualTreeHelper.GetDpi(visual);
        var monitor = MonitorFromPoint(new POINT { X = (int)(at.X * scale.DpiScaleX), Y = (int)(at.Y * scale.DpiScaleY) }, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO { Size = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            var w = System.Windows.SystemParameters.WorkArea;
            return new Core.ScreenRect(w.X, w.Y, w.Width, w.Height);
        }
        var r = info.Work;
        return new Core.ScreenRect(r.Left / scale.DpiScaleX, r.Top / scale.DpiScaleY, (r.Right - r.Left) / scale.DpiScaleX, (r.Bottom - r.Top) / scale.DpiScaleY);
    }

    /// <summary>
    /// Every monitor's work area, the primary first, in the device-independent pixels of
    /// <paramref name="visual"/> (a window not yet shown has the system's scale).
    /// </summary>
    public static IReadOnlyList<Core.ScreenRect> WorkAreas(System.Windows.Media.Visual visual)
    {
        var scale = System.Windows.Media.VisualTreeHelper.GetDpi(visual);
        var areas = Forms.Screen.AllScreens.OrderByDescending(s => s.Primary)
            .Select(s => s.WorkingArea)
            .Select(r => new Core.ScreenRect(r.Left / scale.DpiScaleX, r.Top / scale.DpiScaleY, r.Width / scale.DpiScaleX, r.Height / scale.DpiScaleY))
            .ToList();
        if (areas.Count > 0) return areas;
        var w = System.Windows.SystemParameters.WorkArea;
        return [new Core.ScreenRect(w.X, w.Y, w.Width, w.Height)];
    }

    /// <summary>
    /// Keeps a window wholly on one monitor's work area, so its title bar can be reached: a
    /// window whose size or place (centred on its owner, or saved) would put part of it off the
    /// screen is moved and, when it must be, shrunk once it has its size (<see cref="Core.WindowPlacement"/>).
    /// </summary>
    public static void KeepOnScreen(System.Windows.Window window)
    {
        void Fit()
        {
            if (window.WindowState != System.Windows.WindowState.Normal) return;
            var areas = WorkAreas(window);
            var r = new Core.ScreenRect(window.Left, window.Top, window.ActualWidth, window.ActualHeight);
            if (double.IsNaN(r.X) || double.IsNaN(r.Y) || Core.WindowPlacement.IsOnScreen(r, areas)) return;
            var fit = Core.WindowPlacement.Fit(r, areas, window.MinWidth, window.MinHeight);
            window.Left = fit.X;
            window.Top = fit.Y;
            if (fit.Width < r.Width) window.Width = fit.Width;
            if (fit.Height < r.Height) window.Height = fit.Height;
        }
        window.Loaded += (_, _) => Fit();
    }

    /// <summary>Tells Explorer that file associations changed, so a new link handler is used at once.</summary>
    public static void AssociationsChanged() => SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);

    // Start menu shortcut (IShellLinkW).

    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink;

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    private interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
        void Resolve(IntPtr hwnd, int fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    public static void CreateShortcut(string file, string target, string description)
    {
        var link = (IShellLinkW)new ShellLink();
        try
        {
            link.SetPath(target);
            link.SetWorkingDirectory(Path.GetDirectoryName(target) ?? "");
            link.SetDescription(description);
            link.SetIconLocation(target, 0);
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            ((IPersistFile)link).Save(file, true);
        }
        finally
        {
            Marshal.FinalReleaseComObject(link);
        }
    }
}
