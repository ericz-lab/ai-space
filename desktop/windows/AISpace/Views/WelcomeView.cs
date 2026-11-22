using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// The window before any Space is saved (docs/windows-desktop.md#this-computer). The app has
/// looked for an AI Space on this computer by then and found none, so the page offers two
/// choices and takes neither by itself: install AI Space here, or connect to one elsewhere.
/// </summary>
internal static class WelcomeView
{
    public static FrameworkElement Create(AppModel model)
    {
        var logo = new System.Windows.Controls.Image { Source = BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico")), Width = 64, Height = 64, HorizontalAlignment = HorizontalAlignment.Left };
        var connect = Ui.Card(ConnectForm(model));
        connect.Visibility = Visibility.Collapsed;
        Button elsewhere = null!;
        elsewhere = Ui.Button(L.T("Connect to an AI Space on Another Machine"), () =>
        {
            connect.Visibility = Visibility.Visible;
            elsewhere.Visibility = Visibility.Collapsed;
        });
        var column = Ui.Column(16, logo, Ui.Text(L.T("Welcome to AI Space"), 28, bold: true), Ui.Card(ThisComputerCard(model.ThisComputer)), Ui.Row(elsewhere), connect);
        column.Margin = new Thickness(32, 48, 32, 48);
        column.MaxWidth = 660;
        column.HorizontalAlignment = HorizontalAlignment.Center;
        var scroll = new ScrollViewer { Content = column, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Ui.Background(scroll);
        return scroll;
    }

    /// <summary>Where the search stands, the button that installs AI Space, and what its installer prints.</summary>
    private static FrameworkElement ThisComputerCard(ThisComputerSetup setup)
    {
        var status = Ui.Text("", secondary: true);
        var note = Ui.Text(L.T("Installing downloads the latest release and runs its own installer. AI Space then runs in the background for your user, with or without this app. This app never updates or removes it: the command \"space uninstall\" does."), 12, secondary: true);
        var install = Ui.Button(L.T("Install AI Space on This Computer"), () => _ = setup.Install(), accent: true);
        var output = new TextBox
        {
            IsReadOnly = true,
            FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MaxHeight = 220,
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };
        void Fill()
        {
            var phase = setup.Phase;
            status.Text = phase switch
            {
                ThisComputerPhase.Looking => L.T("Looking for an AI Space on this computer…"),
                ThisComputerPhase.Installing => L.T("Installing AI Space…"),
                ThisComputerPhase.Failed => setup.Failure,
                _ => L.T("No AI Space is running on this computer. Install it here, or connect to one on another machine."),
            };
            install.Content = phase == ThisComputerPhase.Failed ? L.T("Retry") : L.T("Install AI Space on This Computer");
            install.IsEnabled = phase is ThisComputerPhase.NotFound or ThisComputerPhase.Failed;
            install.Visibility = phase == ThisComputerPhase.Looking ? Visibility.Collapsed : Visibility.Visible;
            note.Visibility = phase == ThisComputerPhase.NotFound ? Visibility.Visible : Visibility.Collapsed;
            // While it runs, every line as it comes; once it has failed, the end, which says why.
            output.Text = phase switch
            {
                ThisComputerPhase.Installing => string.Join("\n", setup.Lines),
                ThisComputerPhase.Failed => ServiceInstaller.Tail(setup.Lines),
                _ => "",
            };
            output.Visibility = output.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            output.ScrollToEnd();
        }
        setup.Changed += Fill;
        Fill();
        return Ui.Column(12, Ui.Text(L.T("AI Space on This Computer"), 18, bold: true), status, output, Ui.Row(install), note);
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
