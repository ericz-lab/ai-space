using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Windows;

/// <summary>
/// Settings: the Space's address and this computer's device token, whether the ball is shown, and
/// what each of its four sections opens in this Space (the Mac's floating-ball settings).
/// </summary>
sealed class SettingsWindow : Window
{
    readonly Controller controller;
    readonly TextBox address = new() { Padding = new Thickness(4) };
    readonly PasswordBox token = new() { Padding = new Thickness(4) };
    readonly TextBlock status = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.75, Margin = new Thickness(0, 6, 0, 0) };
    readonly CheckBox showBall = new() { Content = Strings.T("showBall"), Margin = new Thickness(0, 14, 0, 0) };
    readonly StackPanel sections = new();
    bool filling;
    Catalogue? shown;
    bool built;

    public SettingsWindow(Controller controller)
    {
        this.controller = controller;
        Title = Strings.T("app") + " — " + Strings.T("settings").TrimEnd('…');
        Width = 460;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        address.Text = controller.Prefs.Address;
        showBall.IsChecked = controller.Prefs.FloatingBall;
        showBall.Click += (_, _) => controller.SetBallShown(showBall.IsChecked == true);

        var check = new Button { Content = Strings.T("check"), Padding = new Thickness(10, 2, 10, 2), Margin = new Thickness(0, 8, 8, 0) };
        check.Click += async (_, _) => await Check();
        var save = new Button { Content = Strings.T("save"), IsDefault = true, Padding = new Thickness(14, 3, 14, 3), Margin = new Thickness(8, 0, 0, 0) };
        save.Click += async (_, _) => { await controller.Apply(address.Text.Trim(), token.Password.Trim()); Close(); };
        var cancel = new Button { Content = Strings.T("cancel"), IsCancel = true, Padding = new Thickness(14, 3, 14, 3) };

        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(Label(Strings.T("address")));
        panel.Children.Add(address);
        panel.Children.Add(Label(Strings.T("token")));
        panel.Children.Add(token);
        panel.Children.Add(new TextBlock { Text = Strings.T("tokenHint"), TextWrapping = TextWrapping.Wrap, Opacity = 0.6, FontSize = 11, Margin = new Thickness(0, 4, 0, 0) });
        panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, Children = { check } });
        panel.Children.Add(status);
        panel.Children.Add(showBall);
        panel.Children.Add(Label(Strings.T("sections"), bold: true));
        panel.Children.Add(new TextBlock { Text = Strings.T("sectionsHint"), TextWrapping = TextWrapping.Wrap, Opacity = 0.6, FontSize = 11, Margin = new Thickness(0, 0, 0, 6) });
        panel.Children.Add(sections);
        panel.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 16, 0, 0), Children = { cancel, save } });
        Content = panel;
        CatalogueChanged();
    }

    static TextBlock Label(string text, bool bold = false) =>
        new() { Text = text, Margin = new Thickness(0, bold ? 16 : 10, 0, 4), FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal };

    /// <summary>Asks the Space with what was typed, without saving it.</summary>
    async System.Threading.Tasks.Task Check()
    {
        status.Text = Strings.T("checking");
        try
        {
            var typed = token.Password.Trim();
            var secret = typed.Length > 0 ? typed : Controller.Unprotect(controller.Prefs.ProtectedToken);
            using var client = new SpaceClient(address.Text.Trim(), secret.Length > 0 ? secret : null);
            var catalogue = await client.LoadCatalogue();
            status.Text = Strings.T("connected", catalogue.Apps.Count, catalogue.Agents.Count);
        }
        catch (Exception e)
        {
            status.Text = "⚠️ " + e.Message;
        }
    }

    /// <summary>One row per section: Default (what the Space offers), None, then its apps and agents.</summary>
    public void CatalogueChanged()
    {
        // A section chosen here changes the dial, not the rows: they are rebuilt only for a new catalogue.
        if (built && ReferenceEquals(shown, controller.Catalogue)) return;
        built = true;
        shown = controller.Catalogue;
        filling = true;
        sections.Children.Clear();
        var catalogue = controller.Catalogue;
        var defaults = FloatingBallRules.Resolve(catalogue, null);
        var names = new[] { "top", "right", "bottom", "left" };
        foreach (var section in FloatingBallRules.Sections)
        {
            var combo = new ComboBox { MinWidth = 260, IsEnabled = catalogue is not null };
            var fallback = defaults[section].Entry?.TitleIn(Strings.Lang) ?? FloatingBallRules.FallbackTitle(section);
            combo.Items.Add(new ComboBoxItem { Content = Strings.T("default", fallback), Tag = null });
            combo.Items.Add(new ComboBoxItem { Content = Strings.T("none"), Tag = FloatingBallRules.EmptySlot });
            foreach (var e in (catalogue?.Apps ?? []).Concat(catalogue?.Agents ?? []))
                combo.Items.Add(new ComboBoxItem { Content = e.TitleIn(Strings.Lang) + (e.Peer is { } p ? $" · {p}" : ""), Tag = e.Key });
            var slot = controller.SlotOf(section);
            combo.SelectedItem = combo.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string?)i.Tag == slot) ?? combo.Items[0];
            combo.SelectionChanged += (_, _) =>
            {
                if (!filling) controller.SetSlot(section, (combo.SelectedItem as ComboBoxItem)?.Tag as string);
            };
            var row = new DockPanel { Margin = new Thickness(0, 2, 0, 2) };
            var label = new TextBlock { Text = Strings.T(names[(int)section]), Width = 60, VerticalAlignment = VerticalAlignment.Center };
            DockPanel.SetDock(label, Dock.Left);
            row.Children.Add(label);
            row.Children.Add(combo);
            sections.Children.Add(row);
        }
        filling = false;
    }
}
