using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Threading;
using AISpace.Core;
using AISpace.Shell;

namespace AISpace.Views;

/// <summary>
/// Shortcuts in Home's command box (docs/shortcuts.md#native-search-and-shared-resolution, the web's
/// <c>Omnibox.tsx</c>): after a pause in typing the Space reads the text (<c>POST /api/shortcuts/resolve</c>:
/// arithmetic, a conversion, an action named at its start with the rest filling its inputs, such as
/// <c>待办 明天下午3点 写周报</c>). What it can run is listed above Ask Space Assistant, and Enter takes
/// the first when it means one thing only. Choosing one opens its form under the box with what the
/// text gave (<see cref="ShortcutRunner"/>, the Shortcuts page's): a complete read runs at once, a
/// write waits for Create (Enter again in the box sends it). Escape closes the form, then clears the box.
/// When the Space cannot be asked, the box searches the catalogue as before.
/// </summary>
internal sealed partial class HomePage
{
    private const int MaxIntents = 3;

    private DispatcherTimer? _resolveTimer;
    private ShortcutResolution _resolution = ShortcutResolution.None;
    /// <summary>The text <see cref="_resolution"/> answers.</summary>
    private string? _resolvedFor;
    private IReadOnlyList<ShortcutAction>? _shortcutCatalogue;
    private ShortcutRunner? _shortcut;
    private FrameworkElement? _shortcutCard;
    /// <summary>The text the open form came from; another text closes it.</summary>
    private string? _shortcutFor;
    private int _shortcutSerial;

    /// <summary>The box's text changed: an open form goes, and the Space is asked again after a pause.</summary>
    private void ShortcutQueryChanged()
    {
        var q = _query.Trim();
        if (_shortcutFor != q) CloseShortcut(draw: false);
        _resolveTimer ??= NewResolveTimer();
        _resolveTimer.Stop();
        if (q.Length > 0 && q != _resolvedFor) _resolveTimer.Start();
    }

    private DispatcherTimer NewResolveTimer()
    {
        var t = new DispatcherTimer { Interval = ShortcutRules.ResolveAfter };
        t.Tick += async (_, _) =>
        {
            t.Stop();
            await ResolveNow(_query.Trim());
        };
        return t;
    }

    /// <summary>Asks the Space what the text can run; an answer to a text no longer in the box is dropped. Null when it could not be asked.</summary>
    private async Task<ShortcutResolution?> ResolveNow(string q)
    {
        if (q.Length == 0 || Context.Api is not { } api) return null;
        if (q == _resolvedFor) return _resolution;
        try
        {
            var r = await api.ResolveShortcut(q, ShortcutRules.IanaZone());
            if (_closed || _query.Trim() != q) return r;
            _resolution = r;
            _resolvedFor = q;
            Draw();
            return r;
        }
        catch (Exception e) when (e is SpaceApiException or System.Net.Http.HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            // An older Space has no resolver, or it does not answer: the box still searches the catalogue.
            Log.Write($"Home could not resolve a shortcut: {e.Message}");
            return null;
        }
    }

    /// <summary>The intents for the text in the box, once the Space answered for it.</summary>
    private IReadOnlyList<ShortcutIntent> CurrentIntents(string q) =>
        q == _resolvedFor ? _resolution.Intents.Where(ShortcutRules.Runnable).Take(MaxIntents).ToList() : [];

    /// <summary>Enter in the box: sends an open form, else runs the intent that takes Enter. False when neither, so the box goes on as before.</summary>
    private async Task<bool> SubmitShortcut(string q)
    {
        if (_shortcut is { } open && _shortcutFor == q)
        {
            open.Run();
            return true;
        }
        var r = await ResolveNow(q);
        if (_closed || _query.Trim() != q || r is null || ShortcutRules.EnterIntent(r) is not { } intent) return false;
        await OpenIntent(intent, q);
        return true;
    }

    private async Task OpenIntent(ShortcutIntent intent, string q)
    {
        if (Context.Api is not { } api) return;
        if (intent.Kind == "calc" && _shortcutCatalogue is null)
        {
            try
            {
                _shortcutCatalogue = await api.ShortcutActions();
            }
            catch (Exception e) when (e is SpaceApiException or System.Net.Http.HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
            {
                Ui.Toast(_root, e.Message, error: true);
                return;
            }
        }
        if (_closed || _query.Trim() != q) return;
        if (ShortcutRules.ActionOf(intent, _shortcutCatalogue ?? []) is not { } action) return;
        var values = ShortcutRules.IntentValues(intent, action);
        CloseShortcut(draw: false);
        var runner = new ShortcutRunner(Context, action, () => { }, values);
        runner.SetActive(IsShown);
        _shortcut = runner;
        _shortcutFor = q;
        _shortcutSerial++;
        _shortcutCard = ShortcutCard(runner);
        Draw();
        if (ShortcutRules.RunsAtOnce(action, values)) runner.Run();
        else runner.FocusNext();
    }

    /// <summary>The open form in a card, with Close (as Escape).</summary>
    private FrameworkElement ShortcutCard(ShortcutRunner runner)
    {
        var close = Ui.IconButton(Ui.Close, L.T("Close"), () =>
        {
            CloseShortcut(draw: true);
            _field.Focus();
        });
        close.HorizontalAlignment = HorizontalAlignment.Right;
        close.VerticalAlignment = VerticalAlignment.Top;
        close.Margin = new Thickness(0, -6, -6, 0);
        var grid = new Grid();
        grid.Children.Add(runner.View);
        grid.Children.Add(close);
        var card = Ui.Card(grid, 18);
        card.Margin = new Thickness(0, 4, 0, 8);
        AutomationProperties.SetName(card, ShortcutRules.Title(runner.Action, InboxParts.Lang));
        return card;
    }

    /// <summary>Closes the open form; a run it started goes on in the Space (the Shortcuts page lists it).</summary>
    private bool CloseShortcut(bool draw)
    {
        if (_shortcut is null) return false;
        _shortcut.Close();
        _shortcut = null;
        _shortcutCard = null;
        _shortcutFor = null;
        if (draw) Draw();
        return true;
    }

    /// <summary>What Draw compares for the shortcuts: the answer it shows and the open form.</summary>
    private string ShortcutSignature() =>
        $"shortcuts={_resolvedFor}|{string.Join(",", _resolution.Intents.Select(i => i.Key + ":" + string.Join(";", i.Args.Select(a => a.Key + "=" + a.Value))))}|form={(_shortcut is null ? 0 : _shortcutSerial)}\n";

    /// <summary>The open form, then a row for each intent of the text, above Ask Space Assistant. True when one of them takes Enter.</summary>
    private bool DrawShortcuts(string q)
    {
        if (_shortcutCard is { } card && _shortcutFor == q) _body.Children.Add(card);
        var intents = CurrentIntents(q);
        if (intents.Count == 0) return false;
        var enter = ShortcutRules.EnterIntent(_resolution);
        var lang = InboxParts.Lang;
        var today = ShortcutRules.Today(DateTimeOffset.Now, TimeZoneInfo.Local);
        foreach (var intent in intents)
        {
            // Arithmetic is the catalogue's calculator; its name is the action's when the catalogue was read.
            var action = ShortcutRules.ActionOf(intent, _shortcutCatalogue ?? []);
            var title = action is null ? L.T("Calculator") : ShortcutRules.Title(action, lang);
            var summary = action is null ? intent.Expression ?? "" : ShortcutRules.IntentSummary(intent, action, lang, today);
            var takes = ReferenceEquals(intent, enter);
            var row = new Button { Padding = new Thickness(14, 8, 14, 8), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 4, 0, 0), Tag = "intent:" + intent.Key };
            if (takes) row.SetResourceReference(StyleProperty, "AccentButtonStyle");
            var name = Ui.Text(title, 14, bold: true, wrap: false);
            var detail = Ui.Text(summary, 12.5, secondary: !takes, wrap: false);
            detail.Opacity = takes ? 0.85 : 1;
            if (takes)
            {
                name.ClearValue(TextBlock.ForegroundProperty);
                detail.ClearValue(TextBlock.ForegroundProperty);
            }
            var words = Ui.Column(1, name);
            if (summary.Length > 0) words.Children.Add(detail);
            var glyph = Ui.Glyph(Ui.Shortcuts, 15);
            glyph.Margin = new Thickness(0, 0, 10, 0);
            var content = new DockPanel();
            content.Children.Add(glyph);
            content.Children.Add(words);
            row.Content = content;
            row.ToolTip = takes ? L.T("Enter runs it") : null;
            AutomationProperties.SetName(row, summary.Length > 0 ? $"{title}, {summary}" : title);
            row.Click += async (_, _) => await OpenIntent(intent, q);
            _body.Children.Add(row);
            _first ??= row;
        }
        return enter is not null;
    }

    public override void Hidden() => _shortcut?.SetActive(false);
}
