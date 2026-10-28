using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using AISpace.Core;

namespace AISpace.Windows;

/// <summary>
/// Quick Chat (the Mac's QuickChatPanel): a small window to talk to one agent of the Space. Pick
/// the agent at the top; Enter sends, Shift+Enter starts a new line, Ctrl+V pastes a picture,
/// Ctrl+N starts a new conversation, Esc hides it. Each agent keeps its conversation until the
/// Space changes; a reply goes on (on the Space) while the window is hidden.
/// </summary>
sealed class QuickChatWindow : Window
{
    readonly Controller controller;
    readonly ComboBox agents = new() { MinWidth = 200, Margin = new Thickness(0, 0, 8, 0) };
    readonly StackPanel messages = new();
    readonly ScrollViewer scroller;
    readonly WrapPanel thumbnails = new() { Margin = new Thickness(0, 0, 0, 4) };
    readonly TextBox input = new()
    {
        AcceptsReturn = true,
        TextWrapping = TextWrapping.Wrap,
        MinHeight = 56,
        MaxHeight = 160,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        Padding = new Thickness(6),
    };
    readonly Button send = new() { Padding = new Thickness(10, 3, 10, 3) };
    readonly TextBlock empty = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.6, Margin = new Thickness(4, 12, 4, 12) };
    readonly Dictionary<string, Conversation> conversations = [];
    readonly List<ChatImage> attached = [];
    Conversation? current;
    bool filling;

    public QuickChatWindow(Controller controller)
    {
        this.controller = controller;
        Title = Strings.T("quickChat");
        Width = 400;
        Height = 520;
        MinWidth = 320;
        MinHeight = 300;
        Topmost = true;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.Manual;
        SourceInitialized += (_, _) => Native.MakeToolWindow(this, noActivate: false);

        var newConversation = new Button { Content = "＋", ToolTip = Strings.T("newConversation"), Padding = new Thickness(8, 2, 8, 2) };
        newConversation.Click += (_, _) => NewConversation();
        var top = new DockPanel { Margin = new Thickness(10, 10, 10, 6) };
        DockPanel.SetDock(newConversation, Dock.Right);
        top.Children.Add(newConversation);
        top.Children.Add(agents);
        agents.SelectionChanged += (_, _) => { if (!filling) Select(SelectedRef); };

        scroller = new ScrollViewer { Content = messages, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(10, 0, 10, 0) };

        send.Click += async (_, _) => await SendOrStop();
        var bar = new DockPanel { Margin = new Thickness(0, 6, 0, 0), LastChildFill = false };
        DockPanel.SetDock(send, Dock.Right);
        bar.Children.Add(send);
        var bottom = new StackPanel { Margin = new Thickness(10, 6, 10, 10) };
        bottom.Children.Add(thumbnails);
        bottom.Children.Add(input);
        bottom.Children.Add(bar);

        var root = new DockPanel();
        DockPanel.SetDock(top, Dock.Top);
        DockPanel.SetDock(bottom, Dock.Bottom);
        root.Children.Add(top);
        root.Children.Add(bottom);
        root.Children.Add(scroller);
        Content = root;

        input.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.None) { e.Handled = true; await SendOrStop(sendOnly: true); }
        };
        CommandManager.AddPreviewExecutedHandler(input, (_, e) =>
        {
            if (e.Command == ApplicationCommands.Paste && PastePicture()) e.Handled = true;
        });
        PreviewKeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) { e.Handled = true; Hide(); }
            else if (e.Key == Key.N && Keyboard.Modifiers == ModifierKeys.Control) { e.Handled = true; NewConversation(); }
        };
        // Like the Mac's panel: it goes away when another window takes the keyboard.
        Deactivated += (_, _) => { if (!agents.IsDropDownOpen) Hide(); };
        Closing += (_, e) => { e.Cancel = true; Hide(); };
        CatalogueChanged();
    }

    string? SelectedRef => (agents.SelectedItem as ComboBoxItem)?.Tag as string;

    /// <summary>Shows the window on an agent, with a lead line in the draft and a picture attached when given.</summary>
    public void Open(string? agent, string? lead, ChatImage? picture)
    {
        if (agent is not null && controller.Catalogue?.Route(agent) is not null) SelectAgent(agent);
        if (lead is not null) input.Text = FloatingBallRules.WithLead(input.Text, lead);
        if (picture is not null) Attach(picture);
        if (!IsVisible)
        {
            // Near the top of the screen with the pointer, like a launcher.
            var area = Native.WorkArea(this, Native.Cursor(this));
            Left = area.X + (area.Width - Width) / 2;
            Top = area.Y + area.Height / 5;
        }
        Show();
        Activate();
        input.Focus();
        input.CaretIndex = input.Text.Length;
    }

    /// <summary>The Space changed: every conversation ends.</summary>
    public void Reset()
    {
        conversations.Clear();
        current = null;
        Render();
    }

    public void CatalogueChanged()
    {
        var keep = SelectedRef ?? controller.Prefs.LastAgent;
        filling = true;
        agents.Items.Clear();
        foreach (var a in controller.Catalogue?.Agents ?? [])
            agents.Items.Add(new ComboBoxItem { Content = a.TitleIn(Strings.Lang) + (a.Peer is { } p ? $" · {p}" : ""), Tag = a.Ref });
        filling = false;
        SelectAgent(keep ?? FloatingBallRules.AgentFor(Section.Assistant, controller.Catalogue?.Agents.Select(a => a.Ref) ?? []));
    }

    void SelectAgent(string? agent)
    {
        filling = true;
        agents.SelectedItem = agents.Items.OfType<ComboBoxItem>().FirstOrDefault(i => (string)i.Tag == agent) ?? agents.Items.OfType<ComboBoxItem>().FirstOrDefault();
        filling = false;
        Select(SelectedRef);
    }

    void Select(string? agent)
    {
        if (current is not null) current.Changed -= Render;
        current = null;
        if (agent is not null && controller.Client is { } client && controller.Catalogue?.Route(agent) is { } route)
        {
            if (!conversations.TryGetValue(agent, out current))
                conversations[agent] = current = new Conversation(client, route, () => controller.Prefs.Permission);
            current.Changed += Render;
            if (controller.Prefs.LastAgent != agent)
            {
                controller.Prefs.LastAgent = agent;
                controller.Save();
            }
        }
        Render();
    }

    void NewConversation()
    {
        current?.Reset();
        attached.Clear();
        RenderThumbnails();
        input.Clear();
    }

    async System.Threading.Tasks.Task SendOrStop(bool sendOnly = false)
    {
        if (current is not { } c) return;
        if (c.Busy)
        {
            if (!sendOnly) await c.Stop();
            return;
        }
        var text = input.Text;
        var images = attached.ToList();
        if (text.Trim().Length == 0 && images.Count == 0) return;
        input.Clear();
        attached.Clear();
        RenderThumbnails();
        await c.Send(text, images);
    }

    // Pictures

    bool PastePicture()
    {
        if (Clipboard.ContainsFileDropList())
        {
            var file = Clipboard.GetFileDropList().Cast<string>().FirstOrDefault(f => FloatingBallRules.IsPicture(Path.GetExtension(f)));
            if (file is null) return false;
            try { AttachBytes(File.ReadAllBytes(file), Path.GetFileName(file)); }
            catch (IOException) { controller.Notify(Strings.T("unreadable")); }
            return true;
        }
        if (!Clipboard.ContainsImage() || Clipboard.GetImage() is not { } bitmap) return false;
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using var output = new MemoryStream();
        encoder.Save(output);
        AttachBytes(output.ToArray(), "Pasted image.png");
        return true;
    }

    void AttachBytes(byte[] bytes, string name)
    {
        if (ChatImage.TypeOf(bytes) is not { } type) { controller.Notify(Strings.T("notAPicture")); return; }
        Attach(new ChatImage(name, type, bytes));
    }

    void Attach(ChatImage picture)
    {
        if (!ChatImage.Fits(attached, picture)) { controller.Notify(Strings.T("tooMany")); return; }
        attached.Add(picture);
        RenderThumbnails();
    }

    void RenderThumbnails()
    {
        thumbnails.Children.Clear();
        foreach (var picture in attached)
        {
            var remove = new Button { Content = "×", ToolTip = Strings.T("remove"), Padding = new Thickness(4, 0, 4, 0), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
            remove.Click += (_, _) => { attached.Remove(picture); RenderThumbnails(); };
            var cell = new Grid { Width = 56, Height = 56, Margin = new Thickness(0, 0, 6, 0) };
            cell.Children.Add(new Image { Source = Thumbnail(picture.Bytes, 112), Stretch = Stretch.UniformToFill });
            cell.Children.Add(remove);
            thumbnails.Children.Add(cell);
        }
    }

    static ImageSource? Thumbnail(byte[] bytes, int width)
    {
        try
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = width;
            image.StreamSource = new MemoryStream(bytes);
            image.EndInit();
            image.Freeze();
            return image;
        }
        catch (Exception) { return null; }
    }

    // Messages

    void Render()
    {
        messages.Children.Clear();
        var c = current;
        if (c is null || c.Messages.Count == 0)
        {
            empty.Text = c is null ? Strings.T("noAgent") : Strings.T("handTo", agents.Text);
            messages.Children.Add(empty);
        }
        foreach (var m in c?.Messages ?? [])
        {
            var bubble = new StackPanel();
            foreach (var picture in m.Images)
                bubble.Children.Add(new Image { Source = Thumbnail(picture.Bytes, 320), MaxHeight = 160, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 0, 0, 4) });
            if (m.Text.Length > 0 || m.Live)
                bubble.Children.Add(new TextBox
                {
                    Text = m.Text.Length > 0 ? m.Text : "…",
                    IsReadOnly = true,
                    BorderThickness = new Thickness(0),
                    Background = Brushes.Transparent,
                    TextWrapping = TextWrapping.Wrap,
                    Foreground = m.Failed ? Brushes.Firebrick : SystemColors.ControlTextBrush,
                });
            foreach (var approval in m.Waiting) bubble.Children.Add(ApprovalRow(c!, approval));
            messages.Children.Add(new Border
            {
                Child = bubble,
                Padding = new Thickness(8, 6, 8, 6),
                Margin = m.FromPerson ? new Thickness(40, 4, 0, 4) : new Thickness(0, 4, 40, 4),
                CornerRadius = new CornerRadius(10),
                Background = new SolidColorBrush(m.FromPerson ? Color.FromArgb(40, 10, 132, 255) : Color.FromArgb(24, 120, 120, 128)),
                HorizontalAlignment = m.FromPerson ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            });
        }
        var busy = c?.Busy == true;
        send.Content = busy ? Strings.T("stop") : Strings.T("send");
        send.IsEnabled = c is not null;
        input.IsEnabled = c is not null;
        scroller.ScrollToEnd();
    }

    UIElement ApprovalRow(Conversation c, Approval approval)
    {
        var row = new StackPanel { Margin = new Thickness(0, 6, 0, 0) };
        row.Children.Add(new TextBlock { Text = approval.Title.Length > 0 ? approval.Title : approval.Tool, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        if (approval.Detail.Length > 0) row.Children.Add(new TextBlock { Text = approval.Detail, Opacity = 0.7, TextWrapping = TextWrapping.Wrap, MaxHeight = 80 });
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 4, 0, 0) };
        foreach (var (label, allow) in new[] { (Strings.T("allow"), true), (Strings.T("deny"), false) })
        {
            var button = new Button { Content = label, Padding = new Thickness(10, 2, 10, 2), Margin = new Thickness(0, 0, 6, 0) };
            button.Click += async (_, _) =>
            {
                buttons.IsEnabled = false;
                try { await c.Answer(approval, allow); }
                catch (Exception e) { controller.Notify(e.Message); buttons.IsEnabled = true; }
            };
            buttons.Children.Add(button);
        }
        row.Children.Add(buttons);
        return row;
    }
}
