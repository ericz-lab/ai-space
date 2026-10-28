using System.Text.Json;
using System.Text.Json.Serialization;

namespace AISpace.Core;

/// <summary>
/// The person's choices on this computer, one JSON file under <c>%APPDATA%\AI Space</c>. The device
/// token is kept protected for this Windows user (DPAPI, done by the app); this type only stores
/// the protected text.
/// </summary>
public sealed class Preferences
{
    /// <summary>The Space's address.</summary>
    public string Address { get; set; } = "";
    /// <summary>The device token, protected for this Windows user (base64 of DPAPI output).</summary>
    public string ProtectedToken { get; set; } = "";
    /// <summary>The floating ball is shown (on by default on Windows: it is this app).</summary>
    public bool FloatingBall { get; set; } = true;
    /// <summary>The ball's four sections for each Space address: entry keys, top, right, bottom, left; "" the default, "-" none.</summary>
    public Dictionary<string, List<string>> Slots { get; set; } = [];
    /// <summary>Where the ball last stood (its top-left corner, in device-independent pixels).</summary>
    public double[]? Origin { get; set; }
    /// <summary>The agent Quick Chat opened last, by ref.</summary>
    public string? LastAgent { get; set; }
    /// <summary>The chat's permission: "" asks first, "acceptEdits", "bypassPermissions".</summary>
    public string Permission { get; set; } = "";

    [JsonIgnore]
    public Pt? SavedOrigin
    {
        get => Origin is [var x, var y] ? new Pt(x, y) : null;
        set => Origin = value is { } p ? [Math.Round(p.X), Math.Round(p.Y)] : null;
    }

    static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static Preferences Load(string file)
    {
        try
        {
            return File.Exists(file) ? JsonSerializer.Deserialize<Preferences>(File.ReadAllText(file)) ?? new Preferences() : new Preferences();
        }
        catch (JsonException)
        {
            // An unreadable file is set aside, not lost, and the app starts afresh.
            File.Move(file, file + ".unreadable", overwrite: true);
            return new Preferences();
        }
    }

    /// <summary>Writes atomically: a temporary file moved over the old one.</summary>
    public void Save(string file)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var tmp = file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
        File.Move(tmp, file, overwrite: true);
    }
}
