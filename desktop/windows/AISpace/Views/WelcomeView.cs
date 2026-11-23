using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// The window before any Space is saved (docs/windows-desktop.md#this-computer): two entries, and
/// neither is taken by itself. Connect to Local AI Space uses the one on this computer, installing
/// it first behind a single progress bar when there is none; Connect to a Remote AI Space opens the
/// address form.
/// </summary>
internal static class WelcomeView
{
    public static FrameworkElement Create(AppModel model)
    {
        // BitmapFrame.Create of an .ico is its first frame, the 16 px one; the largest stays sharp at any scale.
        var icon = BitmapDecoder.Create(new Uri("pack://application:,,,/Assets/AISpace.ico"), BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        var logo = new System.Windows.Controls.Image { Source = icon.Frames.MaxBy(f => f.PixelWidth), Width = 64, Height = 64, HorizontalAlignment = HorizontalAlignment.Left };
        System.Windows.Media.RenderOptions.SetBitmapScalingMode(logo, System.Windows.Media.BitmapScalingMode.HighQuality);
        var setup = model.ThisComputer;
        var connect = Ui.Card(ConnectForm(model));
        connect.Visibility = Visibility.Collapsed;

        // The two entries, side by side.
        var local = Ui.Button(L.T("Connect to Local AI Space"), () => _ = setup.ConnectLocal(), accent: true);
        Button Remote() => Ui.Button(L.T("Connect to a Remote AI Space"), () =>
        {
            setup.Dismiss();
            connect.Visibility = Visibility.Visible;
        });
        var entries = Ui.Row(local, Remote());

        // While it connects or installs: one line and one bar.
        var status = Ui.Text("", 18, bold: true);
        var bar = new ProgressBar { Minimum = 0, Maximum = 1, Height = 6, BorderThickness = new Thickness(0) };
        // The part still to go is faint, so the part done reads at a glance.
        bar.SetResourceReference(Control.BackgroundProperty, "DividerStrokeColorDefaultBrush");
        var working = Ui.Column(12, status, bar);

        // A failure: why in one line, Retry, and the installer's last lines folded away.
        var why = Ui.Text("", secondary: true);
        var tail = new TextBox
        {
            IsReadOnly = true,
            FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MaxHeight = 220,
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };
        var details = new Expander { Header = L.T("Details"), Content = tail };
        var failed = Ui.Column(12, why, Ui.Row(Ui.Button(L.T("Retry"), () => _ = setup.ConnectLocal(), accent: true), Remote()), details);

        void Fill()
        {
            var phase = setup.Phase;
            local.IsEnabled = phase is ThisComputerPhase.Choose or ThisComputerPhase.Failed;
            entries.Visibility = phase is ThisComputerPhase.Choose ? Visibility.Visible : Visibility.Collapsed;
            working.Visibility = phase is ThisComputerPhase.Connecting or ThisComputerPhase.Installing ? Visibility.Visible : Visibility.Collapsed;
            status.Text = phase == ThisComputerPhase.Installing ? L.T("Installing AI Space…") : L.T("Connecting to AI Space…");
            bar.IsIndeterminate = phase == ThisComputerPhase.Connecting;
            bar.Value = setup.Progress;
            failed.Visibility = phase == ThisComputerPhase.Failed ? Visibility.Visible : Visibility.Collapsed;
            why.Text = setup.Failure;
            tail.Text = phase == ThisComputerPhase.Failed ? ServiceInstaller.Tail(setup.Lines) : "";
            details.Visibility = tail.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            if (phase != ThisComputerPhase.Choose && phase != ThisComputerPhase.Failed) connect.Visibility = Visibility.Collapsed;
        }
        setup.Changed += Fill;
        Fill();

        var title = Ui.Text(L.T("Welcome to AI Space"), 28, bold: true);
        // More room under the title than between the mark and it: the entries, the bar or the form start a part of their own.
        title.Margin = new Thickness(0, 0, 0, 16);
        var column = Ui.Column(16, logo, title, entries, working, failed, connect);
        column.Margin = new Thickness(32, 48, 32, 48);
        // One width whatever the page shows, so the mark and the title stay put when the entries, the
        // bar or the form below them change: a column as wide as its content would be centred again.
        column.MaxWidth = 480;
        var scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        // The page's ground: a range of mountains in faint binary digits along the bottom, under the text.
        var page = new Grid();
        Ui.Background(page);
        page.Children.Add(new RidgeView { Height = 260, VerticalAlignment = VerticalAlignment.Bottom, IsHitTestVisible = false });
        page.Children.Add(scroll);
        return page;
    }

    private static FrameworkElement ConnectForm(AppModel model)
    {
        var url = new TextBox { MinWidth = 360 };
        var name = new TextBox { MinWidth = 360 };
        var error = Ui.Text("", 12);
        error.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        error.Visibility = Visibility.Collapsed;
        void Connect()
        {
            try
            {
                var u = ConnectionRules.Normalize(url.Text);
                model.Add(name.Text.Trim(), u);
                url.Text = "";
                name.Text = "";
                error.Visibility = Visibility.Collapsed;
            }
            catch (ConnectionUrlException e)
            {
                error.Text = ConnectionDialog.Message(e.Code);
                error.Visibility = Visibility.Visible;
            }
        }
        var button = Ui.Button(L.T("Connect"), Connect, accent: true);
        url.KeyDown += (_, e) =>
        {
            if (e.Key == System.Windows.Input.Key.Enter) Connect();
        };
        var local = Ui.Button(L.T("Use This Computer's Address"), () => url.Text = ConnectionRules.LocalDefault);
        return Ui.Column(8,
            Ui.Text(L.T("Address"), 13, bold: true), url,
            Ui.Text(L.T("Name (optional)"), 13, bold: true), name,
            Ui.Text(L.T("Sign in on the page that opens when the Space asks for it; this app keeps the sign-in for that Space only."), 12, secondary: true),
            error, Ui.Row(button, local));
    }
}

/// <summary>
/// <see cref="RidgeArt"/> at whatever width the page has, in a monospaced font and the theme's text
/// colour faded far back, so it reads as ground in light and dark alike. It is drawn again when the
/// size or the theme changes, not otherwise.
/// </summary>
internal sealed class RidgeView : FrameworkElement
{
    private const double GlyphSize = 11, LineHeight = 12, Fade = 0.16;
    private static readonly System.Windows.Media.Typeface Face = new(new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"), FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);

    public static readonly DependencyProperty ForegroundProperty = DependencyProperty.Register(
        nameof(Foreground), typeof(System.Windows.Media.Brush), typeof(RidgeView),
        new FrameworkPropertyMetadata(System.Windows.Media.Brushes.Gray, FrameworkPropertyMetadataOptions.AffectsRender));

    public System.Windows.Media.Brush Foreground
    {
        get => (System.Windows.Media.Brush)GetValue(ForegroundProperty);
        set => SetValue(ForegroundProperty, value);
    }

    public RidgeView() => SetResourceReference(ForegroundProperty, "TextFillColorPrimaryBrush");

    protected override void OnRender(System.Windows.Media.DrawingContext dc)
    {
        if (ActualWidth <= 0 || ActualHeight <= 0) return;
        try
        {
            var dip = System.Windows.Media.VisualTreeHelper.GetDpi(this).PixelsPerDip;
            var brush = new System.Windows.Media.SolidColorBrush(Foreground is System.Windows.Media.SolidColorBrush s ? s.Color : System.Windows.Media.Colors.Gray) { Opacity = Fade };
            brush.Freeze();
            var cell = Text("0", brush, dip).WidthIncludingTrailingWhitespace;
            var cols = (int)Math.Ceiling(ActualWidth / cell);
            var rows = (int)Math.Floor(ActualHeight / LineHeight);
            var lines = RidgeArt.Lines(cols, rows, cell / LineHeight);
            if (lines.Length == 0) return;
            var text = Text(string.Join("\n", lines), brush, dip);
            text.LineHeight = LineHeight;
            dc.DrawText(text, new Point(0, ActualHeight - rows * LineHeight));
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            // A throw here would stop every layout pass of the window: the picture is left out instead.
            Shell.Log.Write($"Welcome ridges not drawn: {e.Message}");
        }
    }

    private static System.Windows.Media.FormattedText Text(string s, System.Windows.Media.Brush brush, double dip) =>
        new(s, System.Globalization.CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Face, GlyphSize, brush, dip);
}
