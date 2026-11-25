using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// The microphone beside a field (the Mac's <c>VoiceButton</c>): hidden until the field's Space
/// says it can transcribe (<c>GET /api/voice</c>), red while it listens, greyed while the words are
/// transcribed. A click records, a second click ends it; the transcript goes into the field and is
/// never sent (<see cref="VoiceInput.Toggle"/>).
/// </summary>
internal sealed class VoiceButton : Button
{
    private readonly VoiceInput _voice;
    private readonly Func<SpaceApi?> _api;
    private readonly Action<string> _deliver;
    private readonly TextBlock _glyph = Ui.Glyph(VoiceOverlay.Mic, 16);
    private Uri? _asked;

    public VoiceButton(VoiceInput voice, Func<SpaceApi?> api, Action<string> deliver)
    {
        _voice = voice;
        _api = api;
        _deliver = deliver;
        Content = _glyph;
        Padding = new Thickness(8, 4, 8, 4);
        Background = Brushes.Transparent;
        BorderThickness = new Thickness(0);
        Visibility = Visibility.Collapsed;
        Focusable = true;
        Click += (_, _) =>
        {
            if (_api() is { } a) _voice.Toggle(this, a, _deliver);
        };
        Loaded += (_, _) =>
        {
            _voice.Changed += Draw;
            Check();
        };
        Unloaded += (_, _) => _voice.Changed -= Draw;
        Draw();
    }

    /// <summary>Asks the Space whether it can transcribe, once per Space; again after a failed answer.</summary>
    public async void Check()
    {
        if (_api() is not { } api) return;
        if (_asked == api.Base && Visibility == Visibility.Visible) return;
        _asked = api.Base;
        var can = await VoiceInput.CanTranscribe(api);
        if (_api()?.Base == api.Base) Visibility = can ? Visibility.Visible : Visibility.Collapsed;
    }

    private void Draw()
    {
        var recording = _voice.Recording(this);
        var transcribing = _voice.Transcribing(this);
        var label = recording ? L.T("Stop Recording") : transcribing ? L.T("Transcribing…") : L.T("Voice Input");
        _glyph.Text = recording ? "" : transcribing ? "" : VoiceOverlay.Mic;
        if (recording) _glyph.Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0x3B, 0x3B));
        else _glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        IsEnabled = !transcribing;
        ToolTip = label;
        System.Windows.Automation.AutomationProperties.SetName(this, label);
    }
}
