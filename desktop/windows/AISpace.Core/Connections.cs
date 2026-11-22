using System.Text.Json;
using System.Text.Json.Serialization;

namespace AISpace.Core;

/// <summary>
/// A saved Space the client can open: a local Space or a remote Hub's panel. Only this computer
/// knows about it; removing it never changes the server (the Mac's <c>Connection</c>).
/// </summary>
public sealed class Connection
{
    [JsonPropertyName("id")] public Guid Id { get; set; } = Guid.NewGuid();
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    /// <summary>The panel URL, normalized (<see cref="ConnectionRules.Normalize"/>).</summary>
    [JsonPropertyName("url")] public string Url { get; set; } = "";
    [JsonPropertyName("isDefault")] public bool IsDefault { get; set; }

    [JsonIgnore] public Uri Uri => new(Url);
    [JsonIgnore] public bool IsLocal => ConnectionRules.IsLoopback(Uri.Host);

    public static string DisplayName(string name, Uri url) => string.IsNullOrWhiteSpace(name) ? url.Host : name.Trim();
}

/// <summary>
/// The saved connections, as one JSON file under the user's application data, separate from any
/// Space workspace (the Mac's <c>ConnectionStore</c>). Exactly one is the default while any exist.
/// An unreadable file is set aside as <c>connections.unreadable.json</c>, never overwritten.
/// </summary>
public sealed class ConnectionStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly string _file;
    private List<Connection> _connections = [];

    public ConnectionStore(string file)
    {
        _file = file;
        Load();
    }

    public event Action? Changed;

    public IReadOnlyList<Connection> Connections => _connections;

    /// <summary>The path the unreadable file was moved to, when it was.</summary>
    public string? LoadError { get; private set; }

    public Connection? Default => _connections.FirstOrDefault(c => c.IsDefault) ?? _connections.FirstOrDefault();

    public Connection? Get(Guid id) => _connections.FirstOrDefault(c => c.Id == id);

    public Connection Add(string name, Uri url, bool makeDefault = false)
    {
        var c = new Connection { Name = Connection.DisplayName(name, url), Url = url.AbsoluteUri, IsDefault = makeDefault || _connections.Count == 0 };
        if (c.IsDefault) foreach (var o in _connections) o.IsDefault = false;
        _connections.Add(c);
        Save();
        return c;
    }

    /// <summary>A new name or address. Returns whether the address now names another origin.</summary>
    public bool Update(Guid id, string name, Uri url)
    {
        var c = Get(id);
        if (c is null) return false;
        var moved = !ConnectionRules.SameOrigin(c.Uri, url);
        c.Name = Connection.DisplayName(name, url);
        c.Url = url.AbsoluteUri;
        Save();
        return moved;
    }

    public void SetDefault(Guid id)
    {
        if (Get(id) is null) return;
        foreach (var c in _connections) c.IsDefault = c.Id == id;
        Save();
    }

    public void Remove(Guid id)
    {
        _connections.RemoveAll(c => c.Id == id);
        if (_connections.Count > 0 && !_connections.Any(c => c.IsDefault)) _connections[0].IsDefault = true;
        Save();
    }

    public static List<Connection> Decode(string text)
    {
        var list = JsonSerializer.Deserialize<List<Connection>>(text) ?? throw new JsonException("not a list");
        foreach (var c in list)
        {
            if (c.Id == Guid.Empty || string.IsNullOrEmpty(c.Url) || !Uri.TryCreate(c.Url, UriKind.Absolute, out _)) throw new JsonException("not a connection");
        }
        if (list.Count > 0 && !list.Any(c => c.IsDefault)) list[0].IsDefault = true;
        return list;
    }

    private void Load()
    {
        if (!File.Exists(_file)) return;
        try
        {
            _connections = Decode(File.ReadAllText(_file));
        }
        catch (Exception e) when (e is JsonException or IOException or NotSupportedException)
        {
            // Keep the unreadable file for the operator instead of overwriting it on the next save.
            var aside = Path.ChangeExtension(_file, ".unreadable.json");
            try
            {
                File.Move(_file, aside, overwrite: true);
                LoadError = aside;
            }
            catch (IOException)
            {
                LoadError = _file;
            }
        }
    }

    private void Save()
    {
        Files.WriteAtomic(_file, JsonSerializer.Serialize(_connections, Json) + "\n");
        Changed?.Invoke();
    }
}

public static class Files
{
    /// <summary>Writes beside the target and moves it over, so a crash never leaves half a file.</summary>
    public static void WriteAtomic(string file, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, text);
        File.Move(tmp, file, overwrite: true);
    }
}
