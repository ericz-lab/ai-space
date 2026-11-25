using System.Runtime.InteropServices;

namespace AISpace.Shell;

/// <summary>The Win32 calls of voice input (docs/windows-desktop.md#voice-input): the key hook, typing Ctrl+V, the clipboard's count, who is in front, and the microphone.</summary>
internal static partial class Native
{
    // The low-level keyboard hook (Shell/HoldKeyHook.cs).

    public const int WH_KEYBOARD_LL = 13;
    public const int WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    /// <summary>KBDLLHOOKSTRUCT.flags: the event was made by a program (SendInput), not a keyboard.</summary>
    public const int LLKHF_INJECTED = 0x10;

    [LibraryImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
    public static partial IntPtr SetWindowsHookEx(int idHook, IntPtr proc, IntPtr hMod, uint threadId);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool UnhookWindowsHookEx(IntPtr hhk);

    [LibraryImport("user32.dll")]
    public static partial IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [LibraryImport("kernel32.dll", EntryPoint = "GetModuleHandleW")]
    public static partial IntPtr GetModuleHandle(IntPtr name);

    [LibraryImport("user32.dll")]
    public static partial short GetAsyncKeyState(int vk);

    public static bool IsKeyDown(int vk) => GetAsyncKeyState(vk) < 0;

    // Typing into the window in front.

    private const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int Dx, Dy; public uint MouseData, Flags, Time; public IntPtr ExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort Vk, Scan; public uint Flags, Time; public IntPtr ExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT Mouse;
        [FieldOffset(0)] public KEYBDINPUT Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint Type; public InputUnion U; }

    [LibraryImport("user32.dll", SetLastError = true)]
    private static partial uint SendInput(uint count, [In] INPUT[] inputs, int size);

    /// <summary>Presses and lets go of keys, in order, as if typed (each <c>(vk, down)</c>).</summary>
    public static bool SendKeys(params (ushort Vk, bool Down)[] keys)
    {
        var inputs = keys.Select(k => new INPUT { Type = INPUT_KEYBOARD, U = new InputUnion { Keyboard = new KEYBDINPUT { Vk = k.Vk, Flags = k.Down ? 0 : KEYEVENTF_KEYUP } } }).ToArray();
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()) == inputs.Length;
    }

    public const ushort VK_CONTROL = 0x11, VK_V = 0x56;
    /// <summary>
    /// A key code no layout uses: pressed while the talk key is held, so that letting go of it
    /// alone does not open the menu bar (Alt) or switch an input method (Ctrl), as AutoHotkey masks a modifier.
    /// </summary>
    public const ushort VK_MASK = 0xE8;

    // Who is in front.

    [LibraryImport("user32.dll")]
    public static partial IntPtr GetForegroundWindow();

    [LibraryImport("user32.dll")]
    public static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [LibraryImport("user32.dll")]
    public static partial uint GetClipboardSequenceNumber();

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x8;
    private const int TokenElevation = 20;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returned);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);

    /// <summary>
    /// Whether a process runs as administrator; null when its rights cannot be read, which for a
    /// program of this user means it is elevated (or the system's own, as the sign-in screen).
    /// </summary>
    public static bool? IsElevated(uint processId)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) return null;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return null;
            try
            {
                return GetTokenInformation(token, TokenElevation, out var elevated, sizeof(int), out _) ? elevated != 0 : null;
            }
            finally
            {
                CloseHandle(token);
            }
        }
        finally
        {
            CloseHandle(process);
        }
    }

    // The microphone (Shell/Microphone.cs): waveIn, which converts to the format asked for.

    public const uint WAVE_MAPPER = 0xFFFFFFFF, CALLBACK_EVENT = 0x50000, WHDR_DONE = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX { public ushort FormatTag, Channels; public uint SamplesPerSec, AvgBytesPerSec; public ushort BlockAlign, BitsPerSample, Size; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR { public IntPtr Data; public uint BufferLength, BytesRecorded; public IntPtr User; public uint Flags, Loops; public IntPtr Next, Reserved; }

    [LibraryImport("winmm.dll")]
    public static partial uint waveInGetNumDevs();

    [LibraryImport("winmm.dll")]
    public static partial uint waveInOpen(out IntPtr handle, uint deviceId, ref WAVEFORMATEX format, IntPtr callback, IntPtr instance, uint flags);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInStart(IntPtr handle);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInReset(IntPtr handle);

    [LibraryImport("winmm.dll")]
    public static partial uint waveInClose(IntPtr handle);

    // The voice overlay: the pointer passes through it.

    private const long WS_EX_TRANSPARENT = 0x00000020;

    /// <summary>A tool window that never takes the keyboard and lets the pointer through to what is under it.</summary>
    public static void MakeOverlay(System.Windows.Window window)
    {
        MakeToolWindow(window, noActivate: true);
        var hwnd = new System.Windows.Interop.WindowInteropHelper(window).Handle;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64() | WS_EX_TRANSPARENT));
    }
}
