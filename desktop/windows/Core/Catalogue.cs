using System.Text.Json;

namespace AISpace.Core;

public enum EntryKind { App, Agent, Widget }

/// <summary>An app or agent of the Space, keyed as the panel keys it (<c>app:&lt;ref&gt;</c>, <c>agent:&lt;ref&gt;</c>).</summary>
public sealed record Entry(EntryKind Kind, string Ref, string Title, string? Icon, string? Peer, IReadOnlyDictionary<string, string> Titles)
{
    public string Key => $"{(Kind == EntryKind.App ? "app" : Kind == EntryKind.Agent ? "agent" : "widget")}:{Ref}";

    /// <summary>The title in a language: the exact tag, then its primary subtag, then the base.</summary>
    public string TitleIn(string lang)
    {
        if (Titles.TryGetValue(lang, out var exact)) return exact;
        foreach (var (tag, text) in Titles)
            if (tag.Split('-')[0] == lang) return text;
        return Title;
    }
}

/// <summary>An agent's chat routes: local, or forwarded to the peer that owns it.</summary>
public sealed record AgentInfo(string Ref, string App, string Name, string? Peer)
{
    public string Base => (Peer is null ? "/api" : $"/api/peers/{Uri.EscapeDataString(Peer)}") + $"/agents/{Uri.EscapeDataString(App)}/{Uri.EscapeDataString(Name)}";
}

/// <summary>
/// The Space's apps and agents as this client reads them (<c>GET /api/apps</c>, <c>/api/agents</c>),
/// decoded as the other clients do: every field the client can live without is optional and a
/// malformed row is skipped, so an older or newer server still decodes.
/// </summary>
public sealed class Catalogue
{
    public required IReadOnlyList<Entry> Apps { get; init; }
    public required IReadOnlyList<Entry> Agents { get; init; }
    public required IReadOnlyList<AgentInfo> AgentRoutes { get; init; }

    public Entry? Entry(string key) => Apps.Concat(Agents).FirstOrDefault(e => e.Key == key);

    public AgentInfo? Route(string agentRef) => AgentRoutes.FirstOrDefault(a => a.Ref == agentRef);

    public static Catalogue Decode(string appsJson, string agentsJson)
    {
        var apps = new List<Entry>();
        foreach (var a in Rows(appsJson, "apps"))
        {
            var id = Str(a, "id");
            var title = Str(a, "title");
            if (id is null || title is null || Str(a, "url") is null) continue;
            if (a.TryGetProperty("hidden", out var hidden) && hidden.ValueKind == JsonValueKind.True) continue;
            if (Str(a, "status") == "archived") continue;
            apps.Add(new Entry(EntryKind.App, id, title, Str(a, "icon"), Str(a, "peer"), Titles(a)));
        }
        var agents = new List<Entry>();
        var routes = new List<AgentInfo>();
        foreach (var a in Rows(agentsJson, "agents"))
        {
            string? id = Str(a, "id"), app = Str(a, "app"), name = Str(a, "name"), title = Str(a, "title");
            if (id is null || app is null || name is null || title is null) continue;
            var peer = Str(a, "peer");
            agents.Add(new Entry(EntryKind.Agent, id, title, Str(a, "avatar"), peer, Titles(a)));
            routes.Add(new AgentInfo(id, app, name, peer));
        }
        return new Catalogue { Apps = apps, Agents = agents, AgentRoutes = routes };
    }

    static IEnumerable<JsonElement> Rows(string json, string key)
    {
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object || !doc.RootElement.TryGetProperty(key, out var rows) || rows.ValueKind != JsonValueKind.Array)
            throw new FormatException($"/api/{key} did not answer as ai-space does");
        return rows.EnumerateArray().Where(r => r.ValueKind == JsonValueKind.Object).Select(r => r.Clone()).ToList();
    }

    static string? Str(JsonElement e, string key) =>
        e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    static Dictionary<string, string> Titles(JsonElement e)
    {
        var output = new Dictionary<string, string>();
        if (!e.TryGetProperty("i18n", out var i18n) || i18n.ValueKind != JsonValueKind.Object) return output;
        foreach (var lang in i18n.EnumerateObject())
            if (lang.Value.ValueKind == JsonValueKind.Object && Str(lang.Value, "title") is { Length: > 0 } t) output[lang.Name] = t;
        return output;
    }
}
