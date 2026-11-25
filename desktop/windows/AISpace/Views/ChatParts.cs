using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Animation;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>The chat's words that come from AISpace.Core's rules, in the interface's language.</summary>
internal static class ChatText
{
    public static ChatWords Words => new(
        L.T("(stopped)"),
        L.T("Sign in on the panel first, then try again."),
        L.T("The connection to the agent was lost."),
        L.T("I have granted more permissions. Please finish the step that was refused for lack of permission."),
        L.T("The answer did not reach the agent: no turn is running"),
        why => L.F("The answer did not reach the agent: {0}", why),
        L.T("This card is read-only now: the conversation has moved on."));

    public static ChatModelWords ModelWords => new(L.T("Default model"), L.T("no longer offered"), Tier, Unavailable, Claude);

    private static string Tier(string tier) => tier switch
    {
        "basic" => L.T("Basic"),
        "junior" => L.T("Junior"),
        "intermediate" => L.T("Intermediate"),
        "advanced" => L.T("Advanced"),
        _ => tier,
    };

    private static string Unavailable(string why) => why switch
    {
        "signed-out" => L.T("signed out"),
        "offline" => L.T("offline"),
        _ => why,
    };

    private static string Claude(string model) => model switch
    {
        "haiku" => L.T("haiku · fast"),
        "opus" => L.T("opus · strong"),
        "fable" => L.T("fable · strongest"),
        _ => model,
    };

    public static string Permission(ChatPermission p) => p switch
    {
        ChatPermission.EditFiles => L.T("Edit files"),
        ChatPermission.All => L.T("All permissions"),
        _ => L.T("Ask before changes"),
    };

    public static string Activity(ChatActivity a) => a.Kind switch
    {
        ChatActivityKind.Starting => L.T("Starting…"),
        ChatActivityKind.Reconnecting => L.T("Reconnecting…"),
        ChatActivityKind.Thinking => a.Detail.Length == 0 ? L.T("Thinking…") : L.F("Thinking with {0}…", a.Detail),
        _ => L.F("Running {0}…", a.Detail),
    };

    public static string Failure(ChatFailure f) => f.Kind switch
    {
        ChatFailureKind.Busy => L.T("The model service is busy or over its limit. Wait a moment and try again."),
        ChatFailureKind.SignedOut => L.T("The agent's runtime is not signed in on the Space."),
        ChatFailureKind.TimedOut => L.T("The reply took too long and was stopped."),
        ChatFailureKind.Exited => L.F("The agent's runtime stopped without a reply (exit code {0}).", f.Code),
        ChatFailureKind.Unavailable => L.T("The agent's runtime could not start on the Space."),
        ChatFailureKind.Connection => L.T("The reply could not be reached."),
        _ => L.T("The agent could not reply."),
    };

    /// <summary>A tool's name as its row shows it: the kind's word, or an MCP tool's server and name.</summary>
    public static string Tool(string name) => ChatTools.KindOf(name) switch
    {
        ChatToolKind.Bash => L.T("Bash"),
        ChatToolKind.Read => L.T("Read"),
        ChatToolKind.Write => L.T("Write"),
        ChatToolKind.Edit => L.T("Edit"),
        ChatToolKind.Search => L.T("Search"),
        ChatToolKind.Web => L.T("Web"),
        ChatToolKind.Code => L.T("Code"),
        ChatToolKind.Task => L.T("Agent"),
        ChatToolKind.Plan => L.T("Plan"),
        _ => ChatTools.OtherTitle(name),
    };
}

/// <summary>
/// The pieces of a native chat (the Mac's <c>ChatView.swift</c>): an agent's reply as formatted
/// text, its tool calls as quiet rows, a past session's runs of calls folded, the status row, the
/// failure card, the chat cards and the person's messages. Colours come from the Fluent theme.
/// </summary>
internal static class ChatParts
{
    public static readonly FontFamily Mono = new("Cascadia Mono, Consolas, Courier New");

    public static T Brush<T>(T e, DependencyProperty p, string key) where T : FrameworkElement
    {
        e.SetResourceReference(p, key);
        return e;
    }

    public static Border Box(UIElement child, string background, string border, double radius = 10, Thickness? padding = null)
    {
        var b = new Border { Child = child, CornerRadius = new CornerRadius(radius), BorderThickness = new Thickness(1), Padding = padding ?? new Thickness(12, 10, 12, 10) };
        b.SetResourceReference(Border.BackgroundProperty, background);
        b.SetResourceReference(Border.BorderBrushProperty, border);
        return b;
    }

    /// <summary>Plain text in the monospace face that can be selected and copied (code, a tool's input and output).</summary>
    public static TextBox Code(string text, double size = 12.5, bool wrap = false, bool failed = false)
    {
        var t = new TextBox
        {
            Text = text,
            IsReadOnly = true,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            FontFamily = Mono,
            FontSize = size,
            Padding = new Thickness(0),
            TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap,
            HorizontalScrollBarVisibility = wrap ? ScrollBarVisibility.Disabled : ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            MinHeight = 0,
            MinWidth = 0,
        };
        t.SetResourceReference(Control.ForegroundProperty, failed ? "SystemFillColorCriticalBrush" : "TextFillColorPrimaryBrush");
        return t;
    }

    // Markdown

    /// <summary>An agent's text as blocks (<see cref="ChatMarkdown"/>); links open as the app opens links.</summary>
    public static FrameworkElement Markdown(string text, Action<Uri> open)
    {
        var column = new StackPanel();
        foreach (var block in ChatMarkdown.Blocks(text))
        {
            FrameworkElement e = block.Kind switch
            {
                MdBlockKind.Heading => Paragraph(block.Spans, open, block.Level switch { 1 => 20, 2 => 17, _ => 15 }, bold: true),
                MdBlockKind.Item => Item(block, open),
                MdBlockKind.Quote => Quote(block, open),
                MdBlockKind.Code or MdBlockKind.Table => CodeBlock(block.Text),
                MdBlockKind.Rule => Brush(new Border { Height = 1, Margin = new Thickness(0, 4, 0, 4) }, Border.BackgroundProperty, "DividerStrokeColorDefaultBrush"),
                _ => Paragraph(block.Spans, open),
            };
            if (column.Children.Count > 0) e.Margin = new Thickness(e.Margin.Left, block.Kind == MdBlockKind.Item ? 3 : 8, e.Margin.Right, 0);
            column.Children.Add(e);
        }
        return column;
    }

    public static TextBlock Paragraph(IReadOnlyList<MdSpan> spans, Action<Uri> open, double size = 14, bool bold = false, bool secondary = false)
    {
        var t = Ui.Text("", size, secondary: secondary, bold: bold);
        t.LineHeight = size * 1.45;
        foreach (var s in spans) t.Inlines.Add(Inline(s, open));
        return t;
    }

    private static System.Windows.Documents.Inline Inline(MdSpan s, Action<Uri> open)
    {
        var run = new Run(s.Text);
        if (s.Bold) run.FontWeight = FontWeights.SemiBold;
        if (s.Italic) run.FontStyle = FontStyles.Italic;
        if (s.Code)
        {
            run.FontFamily = Mono;
            run.FontSize = 13;
            run.SetResourceReference(TextElement.BackgroundProperty, "SubtleFillColorSecondaryBrush");
        }
        if (s.Link is { } link && Uri.TryCreate(link, UriKind.Absolute, out var url) && ConnectionRules.IsWeb(url))
        {
            var h = new Hyperlink(run) { ToolTip = link };
            h.SetResourceReference(TextElement.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
            h.Click += (_, _) => open(url);
            return h;
        }
        return run;
    }

    private static FrameworkElement Item(MdBlock block, Action<Uri> open)
    {
        var grid = new Grid { Margin = new Thickness(block.Level * 18 + 4, 0, 0, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(block.Bullet.Length > 1 ? 26 : 16) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var bullet = Ui.Text(block.Bullet, 14, secondary: true, wrap: false);
        var text = Paragraph(block.Spans, open);
        Grid.SetColumn(text, 1);
        grid.Children.Add(bullet);
        grid.Children.Add(text);
        return grid;
    }

    private static FrameworkElement Quote(MdBlock block, Action<Uri> open)
    {
        var b = new Border { Child = Paragraph(block.Spans, open, secondary: true), BorderThickness = new Thickness(3, 0, 0, 0), Padding = new Thickness(10, 2, 0, 2) };
        b.SetResourceReference(Border.BorderBrushProperty, "DividerStrokeColorDefaultBrush");
        return b;
    }

    private static FrameworkElement CodeBlock(string text) =>
        Box(Code(text), "SubtleFillColorSecondaryBrush", "CardStrokeColorDefaultBrush", 8, new Thickness(12, 8, 12, 8));

    // The person's message

    public static FrameworkElement UserMessage(ChatMessage m)
    {
        var column = new StackPanel { HorizontalAlignment = HorizontalAlignment.Right };
        if (m.Images.Count > 0)
        {
            var pictures = new WrapPanel { HorizontalAlignment = HorizontalAlignment.Right, MaxWidth = 380 };
            foreach (var image in m.Images) pictures.Children.Add(Thumbnail(image, 88));
            column.Children.Add(pictures);
        }
        if (m.Text.Length > 0)
        {
            var text = new TextBlock { Text = m.Text, FontSize = 14, TextWrapping = TextWrapping.Wrap, LineHeight = 20 };
            text.SetResourceReference(TextBlock.ForegroundProperty, "TextOnAccentFillColorPrimaryBrush");
            var bubble = new Border { Child = text, CornerRadius = new CornerRadius(14), Padding = new Thickness(12, 8, 12, 8), HorizontalAlignment = HorizontalAlignment.Right };
            bubble.SetResourceReference(Border.BackgroundProperty, "AccentFillColorDefaultBrush");
            if (column.Children.Count > 0) bubble.Margin = new Thickness(0, 6, 0, 0);
            column.Children.Add(bubble);
        }
        column.Margin = new Thickness(60, 0, 0, 0);
        column.ContextMenu = CopyMenu(m.Text);
        return column;
    }

    public static ContextMenu CopyMenu(string text)
    {
        var menu = new ContextMenu();
        var copy = new MenuItem { Header = L.T("Copy") };
        copy.Click += (_, _) => SetClipboard(text);
        menu.Items.Add(copy);
        return menu;
    }

    public static void SetClipboard(string text)
    {
        try
        {
            Clipboard.SetText(text);
        }
        catch (System.Runtime.InteropServices.COMException e)
        {
            Log.Write($"chat: copy: {e.Message}");
        }
    }

    /// <summary>A picture at most <paramref name="size"/> square; an unreadable one shows its name.</summary>
    public static FrameworkElement Thumbnail(ChatImage image, double size)
    {
        FrameworkElement face;
        try
        {
            var bmp = new System.Windows.Media.Imaging.BitmapImage();
            bmp.BeginInit();
            bmp.StreamSource = new MemoryStream(image.Bytes);
            bmp.DecodePixelWidth = (int)(size * 2);
            bmp.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
            bmp.EndInit();
            bmp.Freeze();
            face = new Image { Source = bmp, Stretch = Stretch.UniformToFill, Width = size, Height = size };
        }
        catch (Exception e) when (e is NotSupportedException or InvalidOperationException or IOException or ArgumentException)
        {
            face = Ui.Text(image.Name, 11, secondary: true);
        }
        var b = new Border { Child = face, Width = size, Height = size, CornerRadius = new CornerRadius(8), ClipToBounds = true, Margin = new Thickness(0, 0, 6, 6), ToolTip = image.Name };
        b.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorSecondaryBrush");
        return b;
    }

    // Steps

    /// <summary>A message the person added during the turn; while unread, that the agent reads it after its current step.</summary>
    public static FrameworkElement SteerRow(string text, bool pending)
    {
        var t = Ui.Text("", 13);
        t.Inlines.Add(new Run("↳ ") { FontSize = 12 });
        t.Inlines.Add(new Run(L.T("You")) { FontWeight = FontWeights.SemiBold });
        if (text.Length > 0) t.Inlines.Add(new Run("  " + text));
        if (pending)
        {
            var note = new Run("  " + L.T("the agent reads it after its current step")) { FontSize = 12 };
            note.SetResourceReference(TextElement.ForegroundProperty, "TextFillColorSecondaryBrush");
            t.Inlines.Add(note);
        }
        return Box(t, "SubtleFillColorSecondaryBrush", "SubtleFillColorSecondaryBrush", 10, new Thickness(12, 7, 12, 7));
    }

    /// <summary>The turn's status row: a pulsing dot and what the agent is doing.</summary>
    public static FrameworkElement Status(string text)
    {
        var dot = new System.Windows.Shapes.Ellipse { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 8, 0) };
        dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, "AccentFillColorDefaultBrush");
        if (!SystemParameters.ClientAreaAnimation) dot.Opacity = 0.7;
        else dot.BeginAnimation(UIElement.OpacityProperty, new DoubleAnimation(1, 0.25, TimeSpan.FromSeconds(0.8)) { AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever });
        var label = Ui.Text(text, 13, secondary: true, wrap: false);
        var row = Ui.Row(dot, label);
        label.Margin = new Thickness(0);
        row.Margin = new Thickness(4, 2, 0, 0);
        return row;
    }

    private static string Glyph(ChatToolKind kind) => kind switch
    {
        ChatToolKind.Bash => Ui.Terminal,
        ChatToolKind.Read => "",
        ChatToolKind.Write or ChatToolKind.Edit => Ui.Edit,
        ChatToolKind.Search => Ui.Search,
        ChatToolKind.Web => Ui.Web,
        ChatToolKind.Code => "",
        ChatToolKind.Task => Ui.Agent,
        ChatToolKind.Plan => "",
        _ => Ui.Settings,
    };

    /// <summary>
    /// One tool call as a quiet line (src/web/ChatToolRow.tsx <c>WorkStep</c>): glyph, title, its
    /// first line and, for what needs attention, Running, Failed or No result received; a click
    /// opens the full input and output. <paramref name="expanded"/> keeps it open across redraws.
    /// </summary>
    public static FrameworkElement ToolRow(ChatStep step, HashSet<string> expanded)
    {
        var summary = ChatTools.Summary(step.Text);
        var expandable = step.Output.Length > 0 || step.Text.Trim() != summary;
        var failed = step.State == ChatStepState.Failed;
        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var glyph = Ui.Glyph(Glyph(ChatTools.KindOf(step.Title)), 12);
        glyph.Margin = new Thickness(0, 0, 8, 0);
        glyph.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorSecondaryBrush");
        var title = Ui.Text(ChatText.Tool(step.Title), 12.5, bold: true, wrap: false);
        Grid.SetColumn(title, 1);
        grid.Children.Add(glyph);
        grid.Children.Add(title);
        if (summary.Length > 0)
        {
            var dot = new System.Windows.Shapes.Ellipse { Width = 3, Height = 3, Margin = new Thickness(8, 0, 8, 0), VerticalAlignment = VerticalAlignment.Center };
            dot.SetResourceReference(System.Windows.Shapes.Shape.FillProperty, step.State switch
            {
                ChatStepState.Failed => "SystemFillColorCriticalBrush",
                ChatStepState.Succeeded => "SystemFillColorSuccessBrush",
                _ => "TextFillColorTertiaryBrush",
            });
            var text = new TextBlock { Text = summary, FontFamily = Mono, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
            text.SetResourceReference(TextBlock.ForegroundProperty, failed ? "SystemFillColorCriticalBrush" : "TextFillColorSecondaryBrush");
            var line = new DockPanel();
            DockPanel.SetDock(dot, Dock.Left);
            line.Children.Add(dot);
            line.Children.Add(text);
            Grid.SetColumn(line, 2);
            grid.Children.Add(line);
        }
        var cue = step.State switch
        {
            ChatStepState.Running => L.T("Running"),
            ChatStepState.Failed => L.T("Failed"),
            ChatStepState.Incomplete => L.T("No result received"),
            _ => "",
        };
        if (cue.Length > 0)
        {
            var c = Ui.Text(cue, 11, secondary: !failed, wrap: false);
            if (failed) c.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
            c.Margin = new Thickness(8, 0, 0, 0);
            c.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(c, 3);
            grid.Children.Add(c);
        }
        var button = new Button
        {
            Content = grid,
            Padding = new Thickness(4, 3, 6, 3),
            Background = Brushes.Transparent,
            BorderThickness = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            ToolTip = step.Text.Length == 0 ? step.Title : step.Text.Length > 400 ? step.Text[..400] + "…" : step.Text,
            Cursor = expandable ? System.Windows.Input.Cursors.Hand : null,
        };
        System.Windows.Automation.AutomationProperties.SetName(button, $"{ChatText.Tool(step.Title)} {summary} {cue}".Trim());
        var column = new StackPanel();
        column.Children.Add(button);
        var details = new StackPanel { Margin = new Thickness(24, 2, 0, 6) };
        void Fill()
        {
            details.Children.Clear();
            if (!expanded.Contains(step.Id)) return;
            var io = new StackPanel();
            if (step.Text.Length > 0) io.Children.Add(Io(L.T("IN"), step.Text, false));
            if (step.Output.Length > 0) io.Children.Add(Io(L.T("OUT"), step.Output, failed));
            details.Children.Add(Box(io, "SubtleFillColorSecondaryBrush", "CardStrokeColorDefaultBrush", 10, new Thickness(0)));
        }
        button.Click += (_, _) =>
        {
            if (!expandable) return;
            if (!expanded.Remove(step.Id)) expanded.Add(step.Id);
            Fill();
        };
        Fill();
        column.Children.Add(details);
        return column;
    }

    private static FrameworkElement Io(string label, string text, bool failed)
    {
        var grid = new Grid { Margin = new Thickness(12, 8, 12, 8) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(36) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(Ui.Text(label, 10.5, secondary: true, bold: true, wrap: false));
        var body = new StackPanel();
        var code = Code(text, 12, wrap: true, failed: failed);
        code.MaxHeight = 180;
        body.Children.Add(code);
        if (text.Length >= 12000) body.Children.Add(Ui.Text(L.T("Output limited to 12,000 characters."), 11, secondary: true));
        Grid.SetColumn(body, 1);
        grid.Children.Add(body);
        return grid;
    }

    /// <summary>A past session's run of tool calls folded to one line: "Ran commands" or "Called tools" and how many, the calls one click away.</summary>
    public static FrameworkElement ToolFold(IReadOnlyList<ChatStep> steps, HashSet<string> expanded)
    {
        var key = "fold:" + steps[0].Id;
        var chevron = Ui.Glyph("", 10);
        var head = Ui.Row(chevron, Ui.Text(ChatTools.AllCommands(steps) ? L.T("Ran commands") : L.T("Called tools"), 12.5, secondary: true, bold: true, wrap: false), Ui.Text(steps.Count.ToString(System.Globalization.CultureInfo.CurrentCulture), 11, secondary: true, wrap: false));
        var button = new Button { Content = head, Padding = new Thickness(4, 3, 6, 3), Background = Brushes.Transparent, BorderThickness = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Left };
        var list = new StackPanel { Margin = new Thickness(22, 2, 0, 4) };
        void Fill()
        {
            var open = expanded.Contains(key);
            chevron.Text = open ? "" : "";
            System.Windows.Automation.AutomationProperties.SetItemStatus(button, open ? L.T("Expanded") : L.T("Collapsed"));
            list.Children.Clear();
            if (open)
            {
                foreach (var s in steps) list.Children.Add(ToolRow(s, expanded));
            }
        }
        button.Click += (_, _) =>
        {
            if (!expanded.Remove(key)) expanded.Add(key);
            Fill();
        };
        Fill();
        return Ui.Column(0, button, list);
    }

    /// <summary>A turn that did not come back: what happened in words, the Space's own text, and Try Again when sending once more may work.</summary>
    public static FrameworkElement FailureCard(ChatFailure failure, Action? retry)
    {
        var title = ChatText.Failure(failure);
        var column = new StackPanel();
        column.Children.Add(Ui.Text(title, 13.5, bold: true));
        if (failure.Detail.Length > 0 && failure.Detail != title)
        {
            var detail = Code(failure.Detail, 12, wrap: true);
            detail.MaxHeight = 110;
            detail.SetResourceReference(Control.ForegroundProperty, "TextFillColorSecondaryBrush");
            detail.Margin = new Thickness(0, 4, 0, 0);
            column.Children.Add(detail);
        }
        if (retry is not null && failure.Retryable)
        {
            var b = Ui.Button(L.T("Try Again"), retry);
            b.HorizontalAlignment = HorizontalAlignment.Left;
            b.Margin = new Thickness(0, 8, 0, 0);
            column.Children.Add(b);
        }
        var glyph = Ui.Glyph(Ui.Warning, 16);
        glyph.VerticalAlignment = VerticalAlignment.Top;
        glyph.Margin = new Thickness(0, 1, 10, 0);
        glyph.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        var row = new DockPanel();
        DockPanel.SetDock(glyph, Dock.Left);
        row.Children.Add(glyph);
        row.Children.Add(column);
        return Box(row, "SystemFillColorCriticalBackgroundBrush", "SystemFillColorCriticalBrush", 12);
    }

    /// <summary>Tools refused for lack of permission, for a runtime that cannot ask: the next permission and Grant and Retry.</summary>
    public static FrameworkElement Denied(IReadOnlyList<string> tools, ChatPermission next, Action? grant)
    {
        var column = new StackPanel();
        var line = Ui.Row(Ui.Glyph(Ui.Lock, 13), Ui.Text(L.F("{0} was refused for lack of permission", string.Join(", ", tools)), 13));
        foreach (var t in line.Children.OfType<TextBlock>()) t.SetResourceReference(TextBlock.ForegroundProperty, "SystemFillColorCriticalBrush");
        column.Children.Add(line);
        if (grant is not null)
        {
            column.Children.Add(Ui.Text(L.F("Next messages: {0}", ChatText.Permission(next)), 12, secondary: true));
            var b = Ui.Button(L.T("Grant and Retry"), grant);
            b.HorizontalAlignment = HorizontalAlignment.Left;
            b.Margin = new Thickness(0, 6, 0, 0);
            column.Children.Add(b);
        }
        return Box(column, "CardBackgroundFillColorDefaultBrush", "CardStrokeColorDefaultBrush", 10);
    }

    // Chat cards (docs/chat-cards.md), every look drawn as rows.

    public static FrameworkElement Card(ChatShownCard card, bool actionable, Action<IReadOnlyList<string>> undo, Action<Uri> open)
    {
        var c = card.Received.Card;
        var column = new StackPanel();
        var head = new DockPanel { Margin = new Thickness(0, 0, 0, 4) };
        var ids = ChatCards.OpenIds(card, actionable);
        if (ids.Count > 0)
        {
            var b = Ui.Button(card.Busy ? L.T("Undoing…") : L.T("Undo"), () => undo(ids));
            b.MinWidth = 0;
            b.Padding = new Thickness(10, 3, 10, 3);
            b.IsEnabled = !card.Busy;
            DockPanel.SetDock(b, Dock.Right);
            head.Children.Add(b);
        }
        var title = c.Title ?? c.Kind switch { "receipt" => L.T("Done"), "value" => "", _ => "" };
        if (title.Length > 0) head.Children.Add(Ui.Text(title, 13, bold: true));
        if (head.Children.Count > 0) column.Children.Add(head);
        if (c.Kind == "value" && c.ValueText is { } value) column.Children.Add(Ui.Text(value, 22, bold: true));
        foreach (var item in c.Items)
        {
            column.Children.Add(CardItem(ChatCards.Shown(item, card.States.GetValueOrDefault(item.Id)), open));
        }
        if (card.Note is { } note)
        {
            var n = Ui.Text(note, 12, secondary: true);
            n.Margin = new Thickness(0, 6, 0, 0);
            column.Children.Add(n);
        }
        return Box(column, "CardBackgroundFillColorDefaultBrush", "CardStrokeColorDefaultBrush", 12);
    }

    private static FrameworkElement CardItem(ChatCardShownItem item, Action<Uri> open)
    {
        var grid = new Grid { Margin = new Thickness(0, 5, 0, 5) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel();
        var title = Ui.Text("", 13.5);
        var run = new Run(item.Title);
        if (item.Status == "removed") run.TextDecorations = TextDecorations.Strikethrough;
        if (item.Url is { } url && Uri.TryCreate(url, UriKind.Absolute, out var u))
        {
            var h = new Hyperlink(run);
            h.SetResourceReference(TextElement.ForegroundProperty, "AccentTextFillColorPrimaryBrush");
            h.Click += (_, _) => open(u);
            title.Inlines.Add(h);
        }
        else
        {
            title.Inlines.Add(run);
        }
        text.Children.Add(title);
        var detail = item.Detail.ToList();
        if (item.When is { } when) detail.Insert(0, when);
        if (detail.Count > 0) text.Children.Add(Ui.Text(string.Join(" · ", detail), 12, secondary: true));
        if (item.Tags.Count > 0)
        {
            var tags = new WrapPanel { Margin = new Thickness(0, 3, 0, 0) };
            foreach (var tag in item.Tags) tags.Children.Add(Pill(tag.Text, tag.Tone));
            text.Children.Add(tags);
        }
        if (item.Progress is { } p) text.Children.Add(new ProgressBar { Value = p, Maximum = 1, Height = 4, Margin = new Thickness(0, 5, 0, 0) });
        grid.Children.Add(text);
        var side = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top };
        if (item.Value is { } v) side.Children.Add(Ui.Text(v, 13, bold: true, wrap: false));
        if (item.Pill is { } pill)
        {
            side.Children.Add(Pill(pill switch
            {
                "undone" => L.T("Undone"),
                "changed" => L.T("Changed elsewhere"),
                _ => L.T("Done"),
            }, pill == "undone" ? "neutral" : pill == "changed" ? "warning" : "positive"));
        }
        foreach (var e in side.Children.OfType<FrameworkElement>()) e.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(side, 1);
        grid.Children.Add(side);
        return grid;
    }

    private static FrameworkElement Pill(string text, string tone)
    {
        var (background, foreground) = tone switch
        {
            "accent" => ("SystemFillColorAttentionBackgroundBrush", "AccentTextFillColorPrimaryBrush"),
            "positive" => ("SystemFillColorSuccessBackgroundBrush", "SystemFillColorSuccessBrush"),
            "warning" => ("SystemFillColorCautionBackgroundBrush", "SystemFillColorCautionBrush"),
            "negative" => ("SystemFillColorCriticalBackgroundBrush", "SystemFillColorCriticalBrush"),
            _ => ("SubtleFillColorSecondaryBrush", "TextFillColorSecondaryBrush"),
        };
        var t = Ui.Text(text, 11, wrap: false);
        t.SetResourceReference(TextBlock.ForegroundProperty, foreground);
        var b = new Border { Child = t, CornerRadius = new CornerRadius(8), Padding = new Thickness(7, 1, 7, 2), Margin = new Thickness(0, 0, 4, 0), VerticalAlignment = VerticalAlignment.Center };
        b.SetResourceReference(Border.BackgroundProperty, background);
        return b;
    }
}
