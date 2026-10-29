using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// The window before any Space is saved (the Mac's first launch): connect to a Space by its
/// address, or, in the Local edition, set one up on this computer.
/// </summary>
internal static class WelcomeView
{
    public static FrameworkElement Create(AppModel model)
    {
        var logo = new System.Windows.Controls.Image { Source = BitmapFrame.Create(new Uri("pack://application:,,,/Assets/AISpace.ico")), Width = 64, Height = 64, HorizontalAlignment = HorizontalAlignment.Left };
        var parts = new List<UIElement> { logo, Ui.Text(L.T("Welcome to AI Space"), 28, bold: true) };
        var connect = ConnectForm(model);
        if (model.Local.Available)
        {
            parts.Add(Ui.Card(new LocalView(model)));
            parts.Add(new Expander { Header = L.T("Connect to a Space elsewhere"), Content = connect, Margin = new Thickness(0, 8, 0, 0) });
        }
        else
        {
            parts.Add(Ui.Text(L.T("Connect to your Space: the panel of an AI Space on this computer, a server or a Hub."), secondary: true));
            parts.Add(Ui.Card(connect));
            parts.Add(Ui.Text(L.T("To run a Space on this computer instead, install the Local edition of AI Space for Windows."), 12, secondary: true));
        }
        var column = Ui.Column(16, [.. parts]);
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
