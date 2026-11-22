using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// Packages (src/web/Packages.tsx): the apps installed from packages, with their version and
/// state, and the apps of connected Spaces. Installing, rolling back, removing and sharing stay in
/// the web panel, one row away.
/// </summary>
internal sealed class PackagesPane(SpaceSettingsPage page) : SettingsPane(page)
{
    public override string Title => L.T("Packages");

    protected override void Compose()
    {
        Add(new Block(null, async ct => Catalogue(await Api.Packages(ct))));
        Add(SettingsKit.Subhead(L.T("Manage")));
        Add(SettingsKit.List([SettingsKit.LinkRow(Ui.Web, L.T("Install Apps and Manage Connections in the Web Panel"), L.T("Install a .spaceapp, roll back or remove an app, share apps with another Space."), Page.OpenWebSettings)]));
    }

    private UIElement Catalogue(PackageCatalogue c)
    {
        var parts = new StackPanel();
        if (c.SpaceId.Length > 0) parts.Children.Add(SettingsKit.Note(L.F("This Space ID: {0}", c.SpaceId)));
        parts.Children.Add(SettingsKit.Subhead(L.T("Installed on This Machine")));
        parts.Children.Add(SettingsKit.List(c.Apps.Select(AppRow), L.T("No app was installed from a package.")));
        if (c.Remotes.Count > 0)
        {
            parts.Children.Add(SettingsKit.Subhead(L.T("Apps on Connected Spaces")));
            foreach (var r in c.Remotes)
            {
                var head = SettingsKit.Columns(null, Ui.Text(r.SpaceId, 13, bold: true, wrap: false), SettingsKit.Dot(r.Available ? StatusTone.Ok : StatusTone.Down, r.Available ? L.T("up") : L.T("down")));
                head.Margin = new Thickness(4, 8, 4, 4);
                parts.Children.Add(head);
                parts.Children.Add(SettingsKit.List(r.Apps.Select(a => SettingsKit.Row(a.Title, a.Version, null, a.App)), L.T("It shares no app with this Space.")));
            }
        }
        return parts;
    }

    private UIElement AppRow(PackageApp a)
    {
        var info = Context.Live?.App(a.App);
        UIElement? open = null;
        if (a.Page && info is not null)
        {
            open = Ui.Button(L.T("Open"), () => Context.OpenApp(info));
            AutomationProperties.SetName(open, L.F("Open {0}", a.Title));
        }
        var detail = string.Join(" · ", new[] { a.Version, State(a.State), a.SourceIncluded ? L.T("source included") : "" }.Where(s => s.Length > 0));
        return SettingsKit.Row(info?.DisplayTitle() ?? a.Title, detail, open, a.App, Context.Icons.View(info?.Icon, a.Title, 24));
    }

    /// <summary>How the package runs (src/space/packages/runtime.ts's states).</summary>
    private static string State(string? state) => state switch
    {
        "running" => L.T("running"),
        "stopped" => L.T("stopped"),
        "starting" => L.T("starting"),
        "failed" => L.T("failed"),
        "static" => L.T("static pages"),
        "on-demand" or "idle" => L.T("starts when used"),
        null or "" => "",
        var s => s,
    };
}

/// <summary>A section the app leaves to the web panel (Appearance): what it is, and the way there in the app.</summary>
internal sealed class WebPane(SpaceSettingsPage page, SettingsSection section) : SettingsPane(page)
{
    public override string Title => SpaceSettingsPage.Label(section);

    protected override void Compose()
    {
        var text = L.T("This app follows Windows' light or dark mode and accent colour. The web panel's themes, colours and backdrops are set in its own Settings, for the browsers that show it.");
        var open = Ui.Button(L.T("Open Settings in the Web Panel"), Page.OpenWebSettings, accent: true);
        var state = Ui.EmptyState(SpaceSettingsPage.Glyph(section), SpaceSettingsPage.Label(section), text, open);
        state.Margin = new Thickness(0, 48, 0, 0);
        Add(state);
    }
}

/// <summary>
/// Account (src/web/Auth.tsx's account rows): where the Space keeps its own password and this app is
/// signed in to it, the password can be changed and the signed-in sessions signed out one by one.
/// Signing out of the Space on this computer is offered either way.
/// </summary>
internal sealed class AccountPane(SpaceSettingsPage page) : SettingsPane(page)
{
    public override string Title => L.T("Account");

    protected override void Compose()
    {
        Add(new Block(null, async ct => Account(await Api.AuthSession(ct))));
    }

    private UIElement Account(AuthState auth)
    {
        var parts = new StackPanel();
        var builtin = SettingsRules.HasAccount(auth);
        if (builtin)
        {
            parts.Children.Add(Ui.SectionHeader(L.T("Change Password")));
            parts.Children.Add(PasswordForm());
            Block? sessions = null;
            sessions = new Block(L.T("Signed-In Sessions"), async ct => Sessions(await Api.AuthSessions(ct), () => sessions?.Reload()));
            parts.Children.Add(sessions.View);
            sessions.Reload();
        }
        parts.Children.Add(Ui.SectionHeader(L.T("This Computer")));
        var help = builtin
            ? L.T("Signing out ends this app's session on the Space and clears the Space's cookies and pages from this computer.")
            : L.T("The sign-in belongs to whatever stands in front of the Space (for example Cloudflare Access), or it needs none here. This app keeps it in this Space's own web data, apart from your browser; signing out clears it from this computer.");
        var button = Ui.Button(L.T("Sign Out…"), () => _ = SignOut(builtin));
        button.HorizontalAlignment = HorizontalAlignment.Left;
        parts.Children.Add(Ui.Card(Ui.Column(12, Ui.Text(help, 13, secondary: true), button), 16));
        return parts;
    }

    private FrameworkElement PasswordForm()
    {
        var current = new PasswordBox { MinWidth = 260, MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left };
        var next = new PasswordBox { MinWidth = 260, MaxWidth = 360, HorizontalAlignment = HorizontalAlignment.Left };
        AutomationProperties.SetName(current, L.T("Current password"));
        AutomationProperties.SetName(next, L.T("New password (at least 8 characters)"));
        var result = Ui.Text("", 12, secondary: true);
        AutomationProperties.SetLiveSetting(result, AutomationLiveSetting.Polite);
        var save = Ui.Button(L.T("Change Password"), () => { }, accent: true);
        save.HorizontalAlignment = HorizontalAlignment.Left;
        save.IsEnabled = false;
        void Valid() => save.IsEnabled = SettingsRules.CanChangePassword(current.Password, next.Password);
        current.PasswordChanged += (_, _) => Valid();
        next.PasswordChanged += (_, _) => Valid();
        save.Click += async (_, _) =>
        {
            save.IsEnabled = current.IsEnabled = next.IsEnabled = false;
            try
            {
                var (outcome, message) = await Api.ChangePassword(current.Password, next.Password);
                result.Text = outcome switch
                {
                    PasswordOutcome.Changed => L.T("Password changed. Every other signed-in device was signed out; this one stays signed in."),
                    PasswordOutcome.WrongCurrent => L.T("The current password is not right."),
                    PasswordOutcome.Rejected => L.F("The new password was refused: {0}", message),
                    PasswordOutcome.NotSignedIn => L.T("Change the password from a signed-in session, or with space auth reset-password on the server."),
                    _ => L.F("The password was not changed: {0}", message),
                };
                if (outcome == PasswordOutcome.Changed)
                {
                    current.Clear();
                    next.Clear();
                    Page.Toast(L.T("Password changed."));
                }
            }
            catch (Exception e)
            {
                result.Text = L.F("The password was not changed: {0}", SettingsWords.Error(e));
            }
            current.IsEnabled = next.IsEnabled = true;
            Valid();
        };
        var form = Ui.Column(6,
            Ui.Text(L.T("Current password"), 13, secondary: true), current,
            Ui.Text(L.T("New password (at least 8 characters)"), 13, secondary: true), next,
            Ui.Text(L.T("Every other signed-in device is signed out; this one stays signed in."), 12, secondary: true),
            save, result);
        return Ui.Card(form, 16);
    }

    private UIElement Sessions(IReadOnlyList<AuthSessionRow> sessions, Action reload)
    {
        return SettingsKit.List(sessions.Select(s =>
        {
            var title = s.UserAgent.Length > 0 ? s.UserAgent : L.T("Unknown client");
            var detail = s.Current ? L.T("this session") : s.LastSeenAt is { } seen ? L.F("last seen {0}", SettingsWords.Ago(seen)) : "";
            UIElement? end = null;
            if (!s.Current)
            {
                var b = Ui.Button(L.T("Sign Out"), () => { });
                AutomationProperties.SetName(b, L.F("Sign out {0}", title));
                b.Click += async (_, _) =>
                {
                    b.IsEnabled = false;
                    try
                    {
                        await Api.RevokeSession(s.Id);
                        Page.Toast(L.F("Signed out {0}.", title));
                    }
                    catch (Exception e)
                    {
                        Page.Toast(SettingsWords.Error(e), error: true);
                    }
                    reload();
                };
                end = b;
            }
            return SettingsKit.Row(title, detail, end, s.CreatedAt is { } created ? L.F("signed in {0}", SettingsWords.When(created)) : null);
        }), L.T("No session is signed in."));
    }

    /// <summary>Asks first, as the app's own Settings › Spaces does; then ends the Space's session and forgets its cookies here.</summary>
    private async Task SignOut(bool builtin)
    {
        if (Context.Connection is not { } c) return;
        var owner = Window.GetWindow(Page);
        var text = L.T("Its pages close, and the next visit asks you to sign in again. The Space itself is not changed.");
        var title = L.F("Sign out of {0} on this computer?", c.DisplayNameOr());
        var ok = owner is null ? MessageBox.Show(text, title, MessageBoxButton.OKCancel, MessageBoxImage.Question) : MessageBox.Show(owner, text, title, MessageBoxButton.OKCancel, MessageBoxImage.Question);
        if (ok != MessageBoxResult.OK) return;
        if (builtin)
        {
            try
            {
                await Api.SignOutOfSpace();
            }
            catch (SpaceApiException)
            {
                // The cookies go below anyway, which signs this computer out.
            }
        }
        // Closes this page with the Space's others; the window then shows the sign-in.
        await Context.Model.SignOut(c.Id);
    }
}

/// <summary>This Computer: the app's own preferences, in their window (Settings › General and Spaces).</summary>
internal sealed class ThisComputerPane(SpaceSettingsPage page) : SettingsPane(page)
{
    public override string Title => L.T("This Computer");

    protected override void Compose()
    {
        Add(SettingsKit.Note(L.T("What this app does on this computer, for every Space. These are kept here, not on the Space.")));
        Add(SettingsKit.List(
        [
            SettingsKit.LinkRow(Ui.Settings, L.T("AI Space Settings…"), L.T("Notifications, start at sign-in, Quick Chat, the floating ball, installing and the log."), () => Context.OpenAppSettings(0)),
            SettingsKit.LinkRow(Ui.Computer, L.T("Spaces on this computer"), L.T("Add, edit, make default, sign out or remove a Space."), () => Context.OpenAppSettings(1)),
        ]));
        Add(SettingsKit.Note(L.F("AI Space for Windows {0}", AppModel.Version)));
    }
}
