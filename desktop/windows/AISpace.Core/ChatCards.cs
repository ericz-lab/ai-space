using System.Text.Json;
using System.Text.RegularExpressions;

namespace AISpace.Core;

/// <summary>A tag of a card's item: its words and tone (<c>neutral</c>, <c>accent</c>, <c>positive</c>, <c>warning</c>, <c>negative</c>).</summary>
public sealed record ChatCardTag(string Text, string Tone);

/// <summary>
/// One item of a chat card or of a state or undo answer. The version 2 fields this client draws in
/// the <c>rows</c> look are kept (<c>when</c>, <c>tags</c>, <c>value</c>, <c>progress</c>); the
/// others (<c>date</c>, <c>image</c>, <c>icon</c>) are left out, as a client that draws only rows may.
/// </summary>
public sealed record ChatCardItem(string Id, string Title)
{
    public string? Detail { get; init; }
    public string? Url { get; init; }
    public int? Version { get; init; }
    public string? When { get; init; }
    public IReadOnlyList<ChatCardTag> Tags { get; init; } = [];
    public string? Value { get; init; }
    public double? Progress { get; init; }
}

/// <summary>A card's item as the app answers it now: <c>active</c>, <c>done</c> or <c>removed</c>, and whether it changed elsewhere.</summary>
public sealed record ChatCardItemState(string Id, string Status)
{
    public string? Title { get; init; }
    public string? Detail { get; init; }
    public string? Url { get; init; }
    public int? Version { get; init; }
    public bool Changed { get; init; }
    public string? When { get; init; }
    public IReadOnlyList<ChatCardTag>? Tags { get; init; }
    public string? Value { get; init; }
    public double? Progress { get; init; }
}

/// <summary>A card (docs/chat-cards.md): <c>receipt</c>, <c>list</c> or <c>value</c>, its title, items, value text, state capability and undo.</summary>
public sealed record ChatCard(string Kind, string? Title, IReadOnlyList<ChatCardItem> Items, string? ValueText, string? State, string? Undo);

/// <summary>A card as it came: the card, exactly what ai-space sent (the state call sends it back), its index in its event (what an action names) and the event's token.</summary>
public sealed record ChatCardReceived(ChatCard Card, JsonElement Raw, int Index, string? Token);

/// <summary>An item as drawn: the card's fields under the app's current answer; an undone one keeps only its title and value.</summary>
public sealed record ChatCardShownItem(string Id, string Title, IReadOnlyList<string> Detail, string? Url, string Status, bool Changed, string? When, IReadOnlyList<ChatCardTag> Tags, string? Value, double? Progress)
{
    /// <summary>The pill an item carries: Undone, Changed elsewhere or Done (the web's order); null for none.</summary>
    public string? Pill => Status == "removed" ? "undone" : Changed ? "changed" : Status == "done" ? "done" : null;
}

/// <summary>What an undo came back with.</summary>
public enum ChatCardOutcomeKind
{
    Ok,
    /// <summary>409 <c>{ readOnly: true }</c>: the conversation moved on and the token is gone.</summary>
    ReadOnly,
    Error,
}

public sealed record ChatCardOutcome(ChatCardOutcomeKind Kind, IReadOnlyList<ChatCardItemState> Items, string Note = "");

/// <summary>
/// Chat cards (docs/chat-cards.md), the Linux client's <c>core/cards.ts</c>: what an app agent's
/// tools did this turn, drawn under the reply. ai-space extracts and checks the cards and hands them
/// over as a run event <c>{"type":"cards","cards":[...],"token":"..."}</c> or, without a token, on a
/// restored session's message; this client only decodes, draws and calls the two card routes.
/// Decoding is lenient: ai-space already dropped every card that breaks the contract.
/// </summary>
public static class ChatCards
{
    private static readonly string[] Kinds = ["receipt", "list", "value"];
    private static readonly string[] Tones = ["neutral", "accent", "positive", "warning", "negative"];

    private static string? Text(JsonElement o, string key) => ChatJson.Str(o, key) is { } s && s.Trim().Length > 0 ? Regex.Replace(s, @"\s+", " ").Trim() : null;

    private static string? IdOf(JsonElement o)
    {
        if (!o.TryGetProperty("id", out var v)) return null;
        if (v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n.ToString(System.Globalization.CultureInfo.InvariantCulture);
        return v.ValueKind == JsonValueKind.String && v.GetString()!.Trim() is { Length: > 0 } s ? s : null;
    }

    private static string? Http(JsonElement o, string key) => ChatJson.Str(o, key) is { } s && Regex.IsMatch(s, "^https?://", RegexOptions.IgnoreCase) ? s : null;

    private static int? VersionOf(JsonElement o) => o.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) && n >= 0 ? n : null;

    private static IReadOnlyList<ChatCardTag>? TagsOf(JsonElement o)
    {
        if (!o.TryGetProperty("tags", out var t) || t.ValueKind != JsonValueKind.Array) return null;
        var tags = new List<ChatCardTag>();
        foreach (var tag in t.EnumerateArray())
        {
            if (tag.ValueKind != JsonValueKind.Object || Text(tag, "text") is not { } text) continue;
            var tone = ChatJson.Str(tag, "tone") is { } s && Tones.Contains(s) ? s : "neutral";
            tags.Add(new ChatCardTag(text, tone));
        }
        return tags.Count == 0 ? null : tags.Take(4).ToList();
    }

    private static double? ProgressOf(JsonElement o) => o.TryGetProperty("progress", out var p) && p.ValueKind == JsonValueKind.Number && p.GetDouble() is var d && d is >= 0 and <= 1 ? d : null;

    private static ChatCardItem? Item(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object || IdOf(raw) is not { } id || Text(raw, "title") is not { } title) return null;
        return new ChatCardItem(id, title)
        {
            Detail = Text(raw, "detail"),
            Url = Http(raw, "url"),
            Version = VersionOf(raw),
            When = Text(raw, "when"),
            Tags = TagsOf(raw) ?? [],
            Value = Text(raw, "value"),
            Progress = ProgressOf(raw),
        };
    }

    /// <summary>One card as ai-space sent it, or null when it is not one this client can draw.</summary>
    public static ChatCard? Card(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Object) return null;
        if (!raw.TryGetProperty("v", out var v) || v.ValueKind != JsonValueKind.Number || v.GetDouble() != 1) return null;
        if (ChatJson.Str(raw, "kind") is not { } kind || !Kinds.Contains(kind)) return null;
        var items = raw.TryGetProperty("items", out var list) && list.ValueKind == JsonValueKind.Array ? list.EnumerateArray().Select(Item).OfType<ChatCardItem>().ToList() : [];
        var value = Text(raw, "text");
        if (kind == "value" ? value is null : items.Count == 0) return null;
        var undo = kind == "receipt" && raw.TryGetProperty("actions", out var a) && a.ValueKind == JsonValueKind.Object ? Text(a, "undo") : null;
        return new ChatCard(kind, Text(raw, "title"), items, value, Text(raw, "state"), undo);
    }

    /// <summary>Cards in the order sent, each with its index in that list (what an action names, even when one before it could not be read).</summary>
    public static IReadOnlyList<ChatCardReceived> Decode(JsonElement raw, string? token = null)
    {
        if (raw.ValueKind != JsonValueKind.Array) return [];
        var cards = new List<ChatCardReceived>();
        var index = 0;
        foreach (var r in raw.EnumerateArray())
        {
            if (Card(r) is { } card) cards.Add(new ChatCardReceived(card, r.Clone(), index, token));
            index++;
        }
        return cards;
    }

    /// <summary>A live <c>cards</c> run event: its cards with the token that lets them act.</summary>
    public static IReadOnlyList<ChatCardReceived> Event(JsonElement ev)
    {
        if (ChatJson.Str(ev, "type") != "cards" || !ev.TryGetProperty("cards", out var cards)) return [];
        return Decode(cards, ChatJson.Str(ev, "token") is { Length: > 0 } t ? t : null);
    }

    /// <summary>The items of a state or undo answer; an item this client cannot read is left out.</summary>
    public static IReadOnlyList<ChatCardItemState> States(JsonElement raw)
    {
        if (raw.ValueKind != JsonValueKind.Array) return [];
        var states = new List<ChatCardItemState>();
        foreach (var r in raw.EnumerateArray())
        {
            if (r.ValueKind != JsonValueKind.Object || ChatJson.Str(r, "status") is not ("active" or "done" or "removed") || IdOf(r) is not { } id) continue;
            states.Add(new ChatCardItemState(id, ChatJson.Str(r, "status")!)
            {
                Title = Text(r, "title"),
                Detail = Text(r, "detail"),
                Url = Http(r, "url"),
                Version = VersionOf(r),
                Changed = r.TryGetProperty("changed", out var c) && c.ValueKind == JsonValueKind.True,
                When = Text(r, "when"),
                Tags = TagsOf(r),
                Value = Text(r, "value"),
                Progress = ProgressOf(r),
            });
        }
        return states;
    }

    /// <summary>A state answer's items, or none when it failed (the card then shows what was printed).</summary>
    public static IReadOnlyList<ChatCardItemState> StateItems(JsonElement body) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True && body.TryGetProperty("items", out var items) ? States(items) : [];

    /// <summary>An undo's answer, as the web reads it: read-only (409 <c>readOnly</c>), a problem to show, or the items' new state.</summary>
    public static ChatCardOutcome Outcome(int status, string body)
    {
        JsonElement j = default;
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object) j = doc.RootElement.Clone();
        }
        catch (JsonException)
        {
        }
        bool True(string key) => j.ValueKind == JsonValueKind.Object && j.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.True;
        if (True("readOnly")) return new(ChatCardOutcomeKind.ReadOnly, []);
        if (status is < 200 or >= 300 || !True("ok")) return new(ChatCardOutcomeKind.Error, [], ChatJson.Str(j, "error") is { Length: > 0 } e ? e : $"HTTP {status}");
        return new(ChatCardOutcomeKind.Ok, j.TryGetProperty("items", out var items) ? States(items) : []);
    }

    /// <summary>The card routes beside an agent's chat routes: <c>/api/agents/cards</c>, or <c>/api/peers/&lt;peer&gt;/agents/cards</c> for a peer's agent.</summary>
    public static string Base(string agentBase) => Regex.Replace(agentBase, "/agents/[^/]+/[^/]+$", "/agents/cards");

    /// <summary><c>POST …/agents/cards/state</c>: the agent (<c>&lt;app&gt;/&lt;agent&gt;</c> on the machine the route reaches) and the card as received.</summary>
    public static object StateBody(string agent, ChatCardReceived card) => new Dictionary<string, object> { ["agent"] = agent, ["card"] = card.Raw };

    /// <summary><c>POST …/agents/cards/action</c>: the token, the card's index in its event and the chosen ids; ai-space builds the app's request.</summary>
    public static object ActionBody(string token, int index, IReadOnlyList<string> ids) => new Dictionary<string, object> { ["token"] = token, ["card"] = index, ["action"] = "undo", ["items"] = ids };

    /// <summary>An item as drawn (the web's <c>itemView</c>): the answer's fields over the card's; an undone item keeps its title and value only.</summary>
    public static ChatCardShownItem Shown(ChatCardItem item, ChatCardItemState? s)
    {
        var removed = s?.Status == "removed";
        var detail = removed ? null : s?.Detail ?? item.Detail;
        return new ChatCardShownItem(
            item.Id,
            (!removed ? s?.Title : null) ?? item.Title,
            detail is null ? [] : detail.Split(" · ").Where(p => p.Length > 0).ToList(),
            removed ? null : s?.Url ?? item.Url,
            s?.Status ?? "active",
            s?.Changed == true,
            removed ? null : s?.When ?? item.When,
            removed ? [] : s?.Tags ?? item.Tags,
            s?.Value ?? item.Value,
            removed ? null : s?.Progress ?? item.Progress);
    }

    /// <summary>The card can act: the reply is the conversation's latest, it came live with a token, it has an undo, and the token was not refused.</summary>
    public static bool CanUndo(ChatShownCard card, bool actionable) => actionable && !card.ReadOnly && card.Received.Token is not null && card.Received.Card.Undo is not null;

    /// <summary>An item that can still be undone: the card can act, and the item was neither undone nor changed elsewhere.</summary>
    public static bool Undoable(ChatShownCard card, bool actionable, string id) =>
        CanUndo(card, actionable) && card.States.GetValueOrDefault(id) is not ({ Status: "removed" } or { Changed: true });

    /// <summary>The ids the header's Undo takes back.</summary>
    public static IReadOnlyList<string> OpenIds(ChatShownCard card, bool actionable) => card.Received.Card.Items.Where(i => Undoable(card, actionable, i.Id)).Select(i => i.Id).ToList();

    /// <summary>A reply's cards may act while it is the conversation's latest: no message of the person after it (src/web/Chat.tsx).</summary>
    public static bool Actionable(IReadOnlyList<bool> isUser, int index) => index >= 0 && index < isUser.Count && !isUser.Skip(index + 1).Any(u => u);
}

/// <summary>A card as a reply shows it: what was received, what the app answered since, and the state of an undo.</summary>
public sealed class ChatShownCard(ChatCardReceived received)
{
    public ChatCardReceived Received { get; } = received;
    /// <summary>The items' current state by id, from the state call and the undo answers.</summary>
    public Dictionary<string, ChatCardItemState> States { get; } = [];
    public bool Busy { get; set; }
    /// <summary>The token was refused (409 <c>readOnly</c>): no undo controls any more.</summary>
    public bool ReadOnly { get; set; }
    /// <summary>The last action's problem, or the read-only notice.</summary>
    public string? Note { get; set; }
    /// <summary>Counts every change, so a view redraws the card only when it changed.</summary>
    public int Version { get; set; }

    public void Merge(IReadOnlyList<ChatCardItemState> items)
    {
        foreach (var i in items) States[i.Id] = i;
        Version++;
    }
}
