using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// The capsule at the bottom of the screen that says what voice input is doing (the Mac's
/// <c>DictationHUD</c>): Listening with the live text, then what was heard until the final text is
/// in, or a note for four seconds. A topmost tool window that never takes the keyboard and lets the
/// pointer through, so the field being dictated into keeps both; at the bottom of the screen under
/// the pointer.
/// </summary>
internal sealed class VoiceOverlay : Window
{
    private readonly TextBlock _glyph = Ui.Glyph(Mic, 16);
    private readonly TextBlock _text = Ui.Text("", 14);
    private readonly DispatcherTimer _noteTimer = new() { Interval = TimeSpan.FromSeconds(4) };
    private bool _note;

    // Segoe Fluent Icons: Microphone, Sync (working), MuteMicrophone-like note.
    public const string Mic = "";
    private const string Working = "", Info = "";

    public VoiceOverlay()
    {
        Title = "AI Space Voice Input";
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        Topmost = true;
        ShowInTaskbar = false;
        ShowActivated = false;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        Focusable = false;
        IsHitTestVisible = false;
        _text.MaxWidth = 420;
        _text.VerticalAlignment = VerticalAlignment.Center;
        _glyph.Margin = new Thickness(0, 0, 8, 0);
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(_glyph);
        row.Children.Add(_text);
        var capsule = new Border
        {
            Child = row,
            CornerRadius = new CornerRadius(20),
            Padding = new Thickness(16, 10, 16, 10),
            Margin = new Thickness(8),
            BorderThickness = new Thickness(1),
            Effect = new System.Windows.Media.Effects.DropShadowEffect { BlurRadius = 16, ShadowDepth = 2, Opacity = 0.25 },
        };
        capsule.SetResourceReference(Border.BackgroundProperty, "SolidBackgroundFillColorBaseBrush");
        capsule.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        Content = capsule;
        System.Windows.Automation.AutomationProperties.SetLiveSetting(_text, System.Windows.Automation.AutomationLiveSetting.Polite);
        _noteTimer.Tick += (_, _) =>
        {
            _noteTimer.Stop();
            if (_note) Conceal();
        };
        SourceInitialized += (_, _) => Native.MakeOverlay(this);
        SizeChanged += (_, _) => Place();
    }

    /// <summary>Recording: the live text, or <paramref name="hint"/> before anything was heard.</summary>
    public void Listening(string text, string hint) => Present(Mic, text.Length == 0 ? hint : VoiceText.Tail(text), red: true, note: false);

    /// <summary>Let go: what was heard so far, until the final text is in.</summary>
    public void Transcribing(string text) => Present(Working, text.Length == 0 ? L.T("Transcribing…") : VoiceText.Tail(text), red: false, note: false);

    /// <summary>A note that goes by itself after four seconds.</summary>
    public void Note(string text)
    {
        Present(Info, text, red: false, note: true);
        _noteTimer.Stop();
        _noteTimer.Start();
    }

    /// <summary>Done: hidden, unless a note is showing (a failure outlives the end of the recording).</summary>
    public void Done()
    {
        if (!_note) Conceal();
    }

    private void Present(string glyph, string text, bool red, bool note)
    {
        _note = note;
        if (!note) _noteTimer.Stop();
        _glyph.Text = glyph;
        if (red) _glyph.Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0x3B, 0x3B));
        else _glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        _text.Text = text;
        if (!IsVisible)
        {
            // The window exists before it shows, so it never takes the keyboard from the app in front.
            new System.Windows.Interop.WindowInteropHelper(this).EnsureHandle();
            Show();
        }
        Place();
    }

    private void Conceal()
    {
        _note = false;
        _noteTimer.Stop();
        Hide();
    }

    /// <summary>Centred at the bottom of the work area of the screen under the pointer, 72 above it.</summary>
    private void Place()
    {
        if (!IsVisible) return;
        var area = Native.WorkArea(this, Native.Cursor(this));
        Left = area.X + (area.Width - ActualWidth) / 2;
        Top = area.Y + area.Height - ActualHeight - 72;
    }
}
