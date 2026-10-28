using System.Windows;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>Adds a Space, or changes a saved one's name and address (the Mac's connection form).</summary>
internal sealed class ConnectionDialog : Window
{
    private readonly TextBox _name = new() { MinWidth = 360 };
    private readonly TextBox _url = new() { MinWidth = 360 };
    private readonly TextBlock _error = Ui.Text("", 12);

    public ConnectionDialog(Connection? existing)
    {
        Title = existing is null ? L.T("Add a Space") : L.T("Edit Space");
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ShowInTaskbar = false;
        _name.Text = existing?.Name ?? "";
        _url.Text = existing?.Url ?? "";
        _error.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        _error.Visibility = Visibility.Collapsed;

        var save = Ui.Button(existing is null ? L.T("Add") : L.T("Save"), Save, accent: true);
        save.IsDefault = true;
        var cancel = Ui.Button(L.T("Cancel"), () => DialogResult = false);
        cancel.IsCancel = true;
        var buttons = Ui.Row(save, cancel);
        buttons.HorizontalAlignment = HorizontalAlignment.Right;

        var note = existing is null
            ? L.T("The address of a Space's panel, such as https://space.example.com or http://127.0.0.1:8700 for one on this computer.")
            : L.T("A new address opens fresh pages: text not yet sent on the old ones is lost.");
        var body = Ui.Column(8,
            Ui.Text(L.T("Address"), 13, bold: true), _url,
            Ui.Text(L.T("Name (optional)"), 13, bold: true), _name,
            Ui.Text(note, 12, secondary: true), _error, buttons);
        body.Margin = new Thickness(24);
        body.MaxWidth = 460;
        Content = body;
        Ui.Background(body);
        Loaded += (_, _) => (existing is null ? _url : _name).Focus();
    }

    public string SpaceName => _name.Text.Trim();
    public Uri? SpaceUrl { get; private set; }

    private void Save()
    {
        try
        {
            SpaceUrl = ConnectionRules.Normalize(_url.Text);
            DialogResult = true;
        }
        catch (ConnectionUrlException e)
        {
            _error.Text = Message(e.Code);
            _error.Visibility = Visibility.Visible;
            _url.Focus();
        }
    }

    public static string Message(ConnectionUrlError code) => code switch
    {
        ConnectionUrlError.Empty => L.T("Enter the address of the Space."),
        ConnectionUrlError.UnsupportedScheme => L.T("Use an http or https address."),
        ConnectionUrlError.Credentials => L.T("Leave the user name and password out of the address; sign in on the page instead."),
        ConnectionUrlError.InsecureRemote => L.T("Use https for a Space on another computer; plain http is only for this computer."),
        _ => L.T("That is not a web address."),
    };
}
