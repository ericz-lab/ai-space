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

        // The two entries.
        var local = Ui.Button(L.T("Connect to Local AI Space"), () => _ = setup.ConnectLocal(), accent: true);
        Button Remote() => Ui.Button(L.T("Connect to a Remote AI Space"), () =>
        {
            setup.Dismiss();
            connect.Visibility = Visibility.Visible;
        });
        var remote = Remote();
        var here = Ui.Text("", 12, secondary: true);
        var entries = Ui.Column(8, Ui.Row(local), here, Ui.Row(remote));

        // While it connects or installs: one line and one bar.
        var status = Ui.Text("", 18, bold: true);
        var bar = new ProgressBar { Minimum = 0, Maximum = 1, Height = 6, MaxWidth = 420, HorizontalAlignment = HorizontalAlignment.Left };
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
            here.Text = setup.Here switch
            {
                ThisComputerHere.Found => L.T("Found on this computer"),
                ThisComputerHere.None => L.T("Not on this computer yet: it is downloaded and installed first"),
                _ => L.T("Looking for an AI Space on this computer…"),
            };
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

        var column = Ui.Column(16, logo, Ui.Text(L.T("Welcome to AI Space"), 28, bold: true), entries, working, failed, connect);
        column.Margin = new Thickness(32, 48, 32, 48);
        column.MaxWidth = 660;
        column.HorizontalAlignment = HorizontalAlignment.Center;
        var scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Ui.Background(scroll);
        return scroll;
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
