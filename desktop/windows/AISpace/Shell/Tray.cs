using AISpace.Core;

namespace AISpace.Shell;

/// <summary>
/// The icon in the notification area (the Mac's menu bar extra): for each Space, who is working,
/// what is unread and whether it needs a sign-in; Quick Chat, Settings and Quit. A click opens
/// the window. The menu is built fresh each time it opens.
/// </summary>
internal sealed class Tray : IDisposable
{
    private readonly AppModel _model;
    private readonly App _app;
    private readonly Forms.NotifyIcon _icon;
    private readonly Forms.ContextMenuStrip _menu = new();

    public Tray(AppModel model, App app)
    {
        _model = model;
        _app = app;
        using var stream = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/Assets/AISpace.ico")).Stream;
        _icon = new Forms.NotifyIcon
        {
            Icon = new System.Drawing.Icon(stream, Forms.SystemInformation.SmallIconSize),
            Text = "AI Space",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _menu.Opening += (_, e) =>
        {
            Build();
            e.Cancel = false;
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == Forms.MouseButtons.Left) _app.ShowMain();
        };
        _icon.BalloonTipClicked += (_, _) => _app.ShowMain();
        _model.Changed += Update;
        Build();
    }

    private void Update()
    {
        var unread = _model.Unread;
        var working = _model.Lives.Values.Sum(l => l.Running.Count);
        var text = "AI Space";
        if (unread > 0) text += " — " + L.F("{0} unread", unread);
        if (working > 0) text += (unread > 0 ? ", " : " — ") + L.F("{0} working", working);
        _icon.Text = text.Length > 120 ? text[..120] : text;
    }

    /// <summary>Once, when the window first closes: the app is still here.</summary>
    public void Hint() => _icon.ShowBalloonTip(6000, "AI Space", L.T("AI Space keeps running here, so the inbox can reach you. Right-click for more, or quit it from this menu."), Forms.ToolTipIcon.Info);

    public void Notice(string title, string text) => _icon.ShowBalloonTip(4000, title, text, Forms.ToolTipIcon.None);

    private void Build()
    {
        _menu.Items.Clear();
        var open = new Forms.ToolStripMenuItem(L.T("Open AI Space"), null, (_, _) => _app.ShowMain());
        open.Font = new System.Drawing.Font(open.Font, System.Drawing.FontStyle.Bold);
        _menu.Items.Add(open);
        if (_model.Store.Connections.Count == 0)
        {
            _menu.Items.Add(new Forms.ToolStripMenuItem(L.T("No Space yet")) { Enabled = false });
        }
        foreach (var c in _model.Store.Connections)
        {
            _menu.Items.Add(new Forms.ToolStripSeparator());
            if (!_model.Lives.TryGetValue(c.Id, out var live)) continue;
            Space(c, live);
        }
        _menu.Items.Add(new Forms.ToolStripSeparator());
        var shortcut = _model.Prefs.QuickChat == QuickChatShortcut.Off ? "" : "\t" + Shortcuts.Label(_model.Prefs.QuickChat);
        _menu.Items.Add(new Forms.ToolStripMenuItem(L.T("Quick Chat") + shortcut, null, (_, _) => _app.ShowQuickChat(null, null)));
        if (_app.Ball is { } ball)
        {
            _menu.Items.Add(new Forms.ToolStripMenuItem(L.T("Show the Floating Ball"), null, (_, _) => ball.Set(!ball.Shown)) { Checked = ball.Shown });
        }
        _menu.Items.Add(new Forms.ToolStripMenuItem(L.T("Settings…"), null, (_, _) => _app.OpenSettings()));
        _menu.Items.Add(new Forms.ToolStripSeparator());
        _menu.Items.Add(new Forms.ToolStripMenuItem(L.T("Quit AI Space"), null, (_, _) => _app.Quit()));
    }

    private void Space(Connection c, SpaceLive live)
    {
        var name = c.DisplayNameOr();
        var state = live.Status switch
        {
            LiveStatus.Ok when live.Running.Count > 0 => L.F("{0} working", live.Running.Count),
            LiveStatus.Ok => "",
            LiveStatus.SignInNeeded => L.T("Sign-in needed"),
            LiveStatus.Offline => L.T("Offline"),
            _ => L.T("Connecting…"),
        };
        var header = new Forms.ToolStripMenuItem(state.Length > 0 ? $"{name} — {state}" : name, null, (_, _) => _model.ShowTab(c.Id, null));
        header.Font = new System.Drawing.Font(header.Font, System.Drawing.FontStyle.Bold);
        _menu.Items.Add(header);
        if (live.Status == LiveStatus.SignInNeeded)
        {
            _menu.Items.Add(new Forms.ToolStripMenuItem("    " + L.T("Sign In…"), null, (_, _) => _model.ShowTab(c.Id, null)));
        }
        foreach (var run in live.Running.Take(3))
        {
            var agent = live.AgentId(run);
            _menu.Items.Add(new Forms.ToolStripMenuItem("    ⚙ " + Clip(run.Message), null, (_, _) => _model.ShowChat(c.Id, agent)));
        }
        foreach (var item in live.Inbox.Where(i => i.Unread).Take(4))
        {
            var thread = item.Thread;
            var url = item.Url;
            _menu.Items.Add(new Forms.ToolStripMenuItem("    • " + Clip(item.Heading + ": " + item.Text), null, (_, _) =>
            {
                _model.OpenInboxItem(c.Id, url);
                _ = live.Mark([thread], read: true);
            }));
        }
        if (live.Summary.Unread > 0)
        {
            _menu.Items.Add(new Forms.ToolStripMenuItem("    " + L.F("Inbox ({0} unread)", live.Summary.Unread), null, (_, _) => _model.ShowInbox(c.Id)));
        }
        var apps = live.Apps.Take(8).ToList();
        if (apps.Count > 0)
        {
            var sub = new Forms.ToolStripMenuItem("    " + L.T("Apps"));
            foreach (var app in apps) sub.DropDownItems.Add(new Forms.ToolStripMenuItem(app.DisplayTitle(), null, (_, _) => _model.OpenApp(app, c.Id)));
            _menu.Items.Add(sub);
        }
    }

    private static string Clip(string s)
    {
        var line = s.ReplaceLineEndings(" ").Trim();
        // Menu items treat & as a mnemonic marker.
        line = line.Replace("&", "&&", StringComparison.Ordinal);
        return line.Length > 60 ? line[..60] + "…" : line;
    }

    public void Dispose()
    {
        _model.Changed -= Update;
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Dispose();
    }
}
