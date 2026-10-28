using System.Security.Cryptography;
using System.Text;
using System.Windows.Threading;
using AISpace.Core;
using Microsoft.Toolkit.Uwp.Notifications;

namespace AISpace.Shell;

/// <summary>
/// Inbox threads as Windows notifications, with Mark as Read and Done on the notification itself
/// (the Mac's <c>Notifier</c>). The inbox stays the record; a notification is a pointer to it. A
/// click on one that arrives after the app quit starts it again in the background.
/// </summary>
internal sealed class Notifier(AppModel model)
{
    /// <summary>The app routes a click (open the item) and the two actions back to the right Space.</summary>
    public Action<Guid, string?> OnOpen { get; set; } = (_, _) => { };
    public Action<Guid, string, bool> OnMark { get; set; } = (_, _, _) => { };

    public void SetUp(Dispatcher ui)
    {
        ToastNotificationManagerCompat.OnActivated += e =>
        {
            var args = ToastArguments.Parse(e.Argument);
            ui.BeginInvoke(() => Activated(args));
        };
    }

    private void Activated(ToastArguments args)
    {
        if (!args.TryGetValue("connection", out var raw) || !Guid.TryParse(raw, out var id)) return;
        args.TryGetValue("thread", out var thread);
        args.TryGetValue("url", out var url);
        var action = args.TryGetValue("action", out var a) ? a : "open";
        switch (action)
        {
            case "read" when !string.IsNullOrEmpty(thread):
                OnMark(id, thread, false);
                break;
            case "done" when !string.IsNullOrEmpty(thread):
                OnMark(id, thread, true);
                break;
            default:
                OnOpen(id, string.IsNullOrEmpty(url) ? null : url);
                break;
        }
    }

    public void Post(IReadOnlyList<InboxItem> items, Connection from, bool showName)
    {
        if (!model.Prefs.Notifications || items.Count == 0) return;
        foreach (var item in items.Take(5))
        {
            try
            {
                var b = new ToastContentBuilder()
                    .AddArgument("connection", from.Id.ToString())
                    .AddArgument("thread", item.Thread)
                    .AddArgument("url", item.Url ?? "")
                    .AddText(item.Heading, hintMaxLines: 1)
                    .AddText(item.Text.Length > 400 ? item.Text[..400] : item.Text)
                    .AddAttributionText(showName ? $"{item.App} · {Connection.DisplayName(from.Name, from.Uri)}" : item.App)
                    .AddButton(new ToastButton().SetContent(L.T("Mark as Read")).AddArgument("action", "read").SetBackgroundActivation())
                    .AddButton(new ToastButton().SetContent(L.T("Done")).AddArgument("action", "done").SetBackgroundActivation());
                // A sound only for what asks for attention, as on the Mac.
                if (item.Level is not ("alert" or "warn")) b.AddAudio(new ToastAudio { Silent = true });
                b.Show(t =>
                {
                    // One notification per thread: a newer message replaces the older one.
                    t.Tag = Short(item.Thread);
                    t.Group = Short(from.Id.ToString("N"));
                });
            }
            catch (Exception e)
            {
                Log.Write($"notification: {e.Message}");
            }
        }
    }

    /// <summary>A notification's tag and group are short; a stable digest keeps them unique enough.</summary>
    private static string Short(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s)))[..16];

    public static void ClearAll()
    {
        try
        {
            ToastNotificationManagerCompat.History.Clear();
        }
        catch (Exception e)
        {
            Log.Write($"notifications: {e.Message}");
        }
    }
}
