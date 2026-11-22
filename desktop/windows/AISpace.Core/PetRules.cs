using System.Text.Json;

namespace AISpace.Core;

/// <summary>
/// The desk pet (docs/app-spec.md#space-mood): the web panel's Claude, drawn from the same sheet
/// (src/web/public/pet-claude.webp, made by src/web/pets/claude.py; the app carries it as
/// <c>Assets/pet-claude.png</c>) with the same animations and the same table for the Space's mood as
/// src/web/Pet.tsx. These are its rules without WPF, ported from the Linux client's
/// <c>core/pet.ts</c>, itself the Mac's <c>PetRules.swift</c>. Place is in pixels from the left of
/// the stage (the native Home page), time in seconds.
/// </summary>
public sealed record SpaceMood(string State, bool? Ok = null, string? Reason = null, string? Move = null, PetSay? Say = null, PetOpen? Open = null);

/// <summary>The mood's line, in English and (when the Space has it) Chinese.</summary>
public sealed record PetSay(string En, string? Zh = null);

/// <summary>What a click opens: the chat of <see cref="Agent"/> (<c>&lt;app&gt;/&lt;agent&gt;</c>), or the inbox.</summary>
public sealed record PetOpen(bool Inbox, string? Agent = null)
{
    public static readonly PetOpen ToInbox = new(true);

    public static PetOpen Chat(string agent) => new(false, agent);
}

/// <summary>One row of the sheet: <see cref="Frames"/> cells from the left, played over <see cref="Ms"/>; with <see cref="Pause"/>, the first cell is held that much longer after each loop.</summary>
public sealed record PetAnimation(int Row, int Frames, double Ms, double Pause = 0)
{
    /// <summary>How long one cell shows, in seconds.</summary>
    public double Step => Ms / Math.Max(Frames, 1) / 1000;
}

public sealed record PetSprite(
    string File,
    int Columns,
    int Rows,
    // Width in pixels the scuttle is drawn for; the size scales it, and the speed with it.
    double Width,
    // Pixels per second at Width.
    double Speed,
    IReadOnlyDictionary<string, PetAnimation> Anims,
    string Walk,
    // Rest animations to pick from when there is no mood, with their weights.
    IReadOnlyList<(string Name, double Weight)> Rests,
    // Played once on a click when the mood opens nothing.
    string Click,
    // The animation the pet rests in by state (<state>/stay while it waits in its corner).
    IReadOnlyDictionary<string, string> MoodRests,
    // Played once as a state begins.
    IReadOnlyDictionary<string, string> MoodOnce);

/// <summary>A mood in the sprite's terms: what it rests in, whether it waits in its corner, what it plays once as the mood begins, what it says and what a click opens.</summary>
public sealed record PetMood(string Rest, bool Stay, string? Once = null, PetSay? Say = null, PetOpen? Open = null)
{
    /// <summary>What tells one mood from the next: a new one starts the pet's behaviour over.</summary>
    public static string Key(PetMood? m) => m is null ? "" : $"{m.Rest}/{m.Stay}/{m.Once ?? ""}";
}

public static class PetRules
{
    /// <summary>The route the mood is read from, with every look at the Space.</summary>
    public const string MoodPath = "/api/pets/mood";

    /// <summary>Claude, as <c>CLAUDE</c> in src/web/Pet.tsx and the Linux client's core/pet.ts.</summary>
    public static readonly PetSprite Claude = new(
        File: "pet-claude.png",
        Columns: 12,
        Rows: 5,
        Width: 80,
        Speed: 55,
        Anims: new Dictionary<string, PetAnimation>
        {
            ["walk"] = new(0, 8, 320),
            ["sleep"] = new(1, 12, 3600),
            ["look"] = new(2, 12, 2880),
            ["hop"] = new(3, 12, 900, 1400),
            ["jump"] = new(4, 12, 720),
        },
        Walk: "walk",
        Rests: [("look", 0.5), ("sleep", 0.38), ("hop", 0.12)],
        Click: "jump",
        MoodRests: new Dictionary<string, string>
        {
            ["working"] = "look",
            ["waiting"] = "look",
            ["waiting/stay"] = "hop",
            ["error"] = "look",
            ["done"] = "look",
            ["sleep"] = "sleep",
        },
        MoodOnce: new Dictionary<string, string> { ["done"] = "jump" });

    /// <summary>The pet's width in device-independent pixels, as the panel's medium size.</summary>
    public const double Size = 80;

    /// <summary>Clear of the corner's edge, as the panel's pet waits clear of its dock.</summary>
    public const double CornerGap = 24;

    /// <summary>The bubble over the pet: shown at once when the line changes, then 6 seconds shown and 14 hidden.</summary>
    public const double BubbleShown = 6, BubbleHidden = 14;

    /// <summary>The route's answer, checked; anything else (an older Space, an error page) is no mood.</summary>
    public static SpaceMood? DecodeMood(JsonElement m)
    {
        if (m.ValueKind != JsonValueKind.Object || Str(m, "state") is not { } state) return null;
        bool? ok = m.TryGetProperty("ok", out var o) && o.ValueKind is JsonValueKind.True or JsonValueKind.False ? o.GetBoolean() : null;
        PetSay? say = null;
        if (m.TryGetProperty("say", out var s) && s.ValueKind == JsonValueKind.Object && Str(s, "en") is { } en) say = new PetSay(en, Str(s, "zh"));
        return new SpaceMood(state, ok, Str(m, "reason"), Str(m, "move"), say, DecodeOpen(m));
    }

    private static PetOpen? DecodeOpen(JsonElement m)
    {
        if (!m.TryGetProperty("open", out var o) || o.ValueKind != JsonValueKind.Object) return null;
        return Str(o, "kind") switch
        {
            "inbox" => PetOpen.ToInbox,
            "chat" when Str(o, "agent") is { Length: > 0 } agent => PetOpen.Chat(agent),
            _ => null,
        };
    }

    /// <summary>The line in the language on show: Chinese for <c>zh</c>, English otherwise; null when empty.</summary>
    public static string? SayText(PetSay? say, string lang)
    {
        if (say is null) return null;
        var t = lang == "zh" ? say.Zh ?? say.En : say.En;
        return string.IsNullOrEmpty(t) ? null : t;
    }

    /// <summary>Null, rest as without a mood, for no mood, a failed read, or a state the sprite does not list (<c>idle</c>, a newer one).</summary>
    public static PetMood? Shown(SpaceMood? mood, PetSprite? sprite = null)
    {
        sprite ??= Claude;
        if (mood is null || mood.Ok == false) return null;
        var stay = mood.Move == "stay";
        string? rest = null;
        if (stay) sprite.MoodRests.TryGetValue($"{mood.State}/stay", out rest);
        if (rest is null) sprite.MoodRests.TryGetValue(mood.State, out rest);
        if (rest is null || !sprite.Anims.ContainsKey(rest)) return null;
        sprite.MoodOnce.TryGetValue(mood.State, out var once);
        return new PetMood(rest, stay, once, mood.Say, mood.Open);
    }

    public static bool BubbleVisible(double elapsed) => elapsed >= 0 && elapsed % (BubbleShown + BubbleHidden) < BubbleShown;

    /// <summary>Seconds until the bubble next appears or goes.</summary>
    public static double BubbleUntilChange(double elapsed)
    {
        var t = Math.Max(0, elapsed) % (BubbleShown + BubbleHidden);
        return t < BubbleShown ? BubbleShown - t : BubbleShown + BubbleHidden - t;
    }

    /// <summary>Which way the bubble opens: towards the middle of the stage, so it never runs off an edge.</summary>
    public static bool OpensRight(double x, double width, double stage) => x + width / 2 < stage / 2;

    /// <summary>The cell's rectangle in a sheet of <paramref name="sheetWidth"/> × <paramref name="sheetHeight"/> pixels.</summary>
    public static (int X, int Y, int Width, int Height) Cell(PetSprite sprite, int column, int row, int sheetWidth, int sheetHeight)
    {
        int w = sheetWidth / sprite.Columns, h = sheetHeight / sprite.Rows;
        return (Math.Clamp(column, 0, sprite.Columns - 1) * w, Math.Clamp(row, 0, sprite.Rows - 1) * h, w, h);
    }

    private static string? Str(JsonElement o, string key) => o.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

/// <summary>
/// The pet's walk and its frames, as src/web/Pet.tsx moves it: walk to a random spot, rest a while,
/// walk again; a mood that stays sends it to the right-hand corner, where it rests facing into the
/// page. The view calls <see cref="Advance"/> when the time it returned comes, so nothing runs
/// between two changes.
/// </summary>
public sealed class PetMotion
{
    private readonly Func<double> _random;
    private double? _target;
    private bool _oneShot;
    private double _nextFrame;
    private double? _nextBehave;
    private double _lastMove;

    public PetMotion(PetSprite sprite, double width, double stage, double now, Func<double>? random = null)
    {
        Sprite = sprite;
        Width = width;
        Stage = stage;
        _random = random ?? Random.Shared.NextDouble;
        Animation = sprite.Rests.Count > 0 ? sprite.Rests[0].Name : sprite.Walk;
        X = _random() * Math.Max(0, stage - width);
        _lastMove = now;
        Behave(now);
    }

    public PetSprite Sprite { get; }
    public double Width { get; private set; }
    public double Stage { get; private set; }
    public double X { get; private set; }
    public string Animation { get; private set; }
    public int Frame { get; private set; }
    public bool FacingLeft { get; private set; }
    public PetMood? Mood { get; private set; }

    /// <summary>Pixels per second at this size, so the feet stay planted at any width.</summary>
    public double Speed => Sprite.Speed * Width / Sprite.Width;

    public bool Walking => _target is not null;

    /// <summary>Where a pet that stays waits.</summary>
    public double Corner => Math.Max(0, Stage - Width - PetRules.CornerGap);

    /// <summary>The cell on show: its column and row in the sheet.</summary>
    public (int Column, int Row) Cell => (Math.Min(Frame, Sprite.Columns - 1), Sprite.Anims.TryGetValue(Animation, out var a) ? a.Row : 0);

    /// <summary>A new mood: played once if it begins with an animation, else the behaviour starts over. The same mood again changes nothing.</summary>
    public void SetMood(PetMood? mood, double now)
    {
        var changed = PetMood.Key(mood) != PetMood.Key(Mood);
        Mood = mood;
        if (!changed) return;
        if (!PlayOnce(mood?.Once, now)) Behave(now);
    }

    /// <summary>A click that opens nothing: the click animation once.</summary>
    public void Click(double now) => PlayOnce(Sprite.Click, now);

    /// <summary>The stage changed size (a resized window): the pet stays on it, and one that stays follows its corner.</summary>
    public void Resize(double stage, double now, double? width = null)
    {
        Stage = stage;
        if (width is { } w) Width = w;
        var max = Math.Max(0, Stage - Width);
        X = Math.Clamp(X, 0, max);
        if (_target is { } t) _target = Math.Clamp(t, 0, max);
        if (Mood?.Stay == true && !Walking) Behave(now);
    }

    /// <summary>The pet held at <paramref name="x"/> (the pointer resting on it): it stays there and does nothing else until let go.</summary>
    public void Hold(double x, double now)
    {
        X = Math.Clamp(x, 0, Math.Max(0, Stage - Width));
        _target = null;
        _oneShot = false;
        _nextBehave = null;
        _lastMove = now;
    }

    /// <summary>The pet let go at <paramref name="x"/>: it carries on from there.</summary>
    public void Drop(double x, double now)
    {
        X = Math.Clamp(x, 0, Math.Max(0, Stage - Width));
        _target = null;
        _oneShot = false;
        _lastMove = now;
        Behave(now);
    }

    /// <summary>Everything due by <paramref name="now"/>: the walk, the frames, the next behaviour. Returns the seconds until the next change.</summary>
    public double Advance(double now)
    {
        // The walk: at the sprite's speed, the cell changing with it, so the feet do not slide.
        if (_target is { } t)
        {
            var dx = Speed * Math.Max(0, now - _lastMove);
            if (Math.Abs(t - X) <= dx)
            {
                X = t;
                _target = null;
                Behave(now);
            }
            else
            {
                X += t > X ? dx : -dx;
            }
        }
        _lastMove = now;
        if (_nextBehave is { } b && now >= b && !Walking && !_oneShot)
        {
            _nextBehave = null;
            Behave(now);
        }
        // At most one loop of frames per call: a late call skips cells, it never replays them.
        for (var n = 0; now >= _nextFrame && n < 64; n++) StepFrame(now);
        var next = _nextFrame - now;
        if (_nextBehave is { } nb && !Walking) next = Math.Min(next, nb - now);
        return Math.Max(0.016, next);
    }

    private void StepFrame(double now)
    {
        if (!Sprite.Anims.TryGetValue(Animation, out var a))
        {
            _nextFrame = now + 1;
            return;
        }
        Frame++;
        if (Frame >= a.Frames)
        {
            Frame = 0;
            if (_oneShot)
            {
                _oneShot = false;
                Behave(now);
                return;
            }
        }
        _nextFrame += Frame == 0 && a.Pause > 0 ? a.Step + a.Pause / 1000 : a.Step;
        // A call long after the last one starts the timing again from now.
        if (_nextFrame < now - 1) _nextFrame = now + a.Step;
    }

    private void SetAnimation(string name, double now)
    {
        if (!Sprite.Anims.TryGetValue(name, out var a)) return;
        Animation = name;
        Frame = 0;
        _nextFrame = now + a.Step;
    }

    /// <summary>Plays <paramref name="name"/> once, then behaves as before; false when the sprite lacks it or plays it already.</summary>
    private bool PlayOnce(string? name, double now)
    {
        if (name is null || (name == Animation && _oneShot) || !Sprite.Anims.ContainsKey(name)) return false;
        _target = null;
        _nextBehave = null;
        _oneShot = true;
        SetAnimation(name, now);
        return true;
    }

    private void WalkTo(double place, double now)
    {
        _target = place;
        FacingLeft = place < X;
        _lastMove = now;
        _nextBehave = null;
        SetAnimation(Sprite.Walk, now);
    }

    private string PickRest()
    {
        if (Mood is not null) return Mood.Rest;
        var r = _random();
        foreach (var (name, weight) in Sprite.Rests)
        {
            r -= weight;
            if (r <= 0) return name;
        }
        return Sprite.Rests.Count > 0 ? Sprite.Rests[0].Name : Sprite.Walk;
    }

    /// <summary>Walk somewhere, or rest; a mood that stays sends the pet to its corner and keeps it there.</summary>
    private void Behave(double now)
    {
        _oneShot = false;
        _nextBehave = null;
        if (Mood?.Stay == true)
        {
            if (Math.Abs(X - Corner) > 2)
            {
                WalkTo(Corner, now);
                return;
            }
            FacingLeft = true;
            _target = null;
            SetAnimation(PickRest(), now);
            return;
        }
        // A pet with a mood rests longer between walks.
        var calm = Mood is not null;
        if (_random() < (calm ? 0.3 : 0.45))
        {
            WalkTo(_random() * Math.Max(0, Stage - Width), now);
        }
        else
        {
            _target = null;
            SetAnimation(PickRest(), now);
            _nextBehave = now + (calm ? 6 + _random() * 10 : 1.8 + _random() * 3.5);
        }
    }
}
