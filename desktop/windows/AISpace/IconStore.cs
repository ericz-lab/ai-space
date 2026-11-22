using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using AISpace.Core;

namespace AISpace;

/// <summary>
/// One Space's icons (apps' <c>icon</c>, agents' <c>avatar</c>, widgets'), as the catalogue names
/// them: a path or URL the Space serves, fetched once with the Space's sign-in and kept for the
/// app's run, or an emoji drawn as text. An SVG (the panel's built-in icons, agents' avatars) is
/// drawn by <see cref="SvgDrawing"/> as a vector image; one it cannot read whole, or a broken
/// picture, stays null and the caller draws its fallback. Runs on the UI thread.
/// </summary>
internal sealed class IconStore(Func<SpaceApi?> api)
{
    private readonly Dictionary<string, ImageSource?> _images = [];
    private readonly HashSet<string> _loading = [];

    /// <summary>An icon was fetched (its key as the catalogue gave it), or found undrawable: redraw what showed its fallback.</summary>
    public event Action<string>? Arrived;

    /// <summary>Whether the value names a picture to fetch (a path or a web address) rather than an emoji.</summary>
    public static bool IsFetched(string? icon) => icon is { Length: > 0 } i && (i.StartsWith('/') || i.StartsWith("http:", StringComparison.OrdinalIgnoreCase) || i.StartsWith("https:", StringComparison.OrdinalIgnoreCase));

    /// <summary>The value as an emoji to draw, or null when it is a picture or nothing.</summary>
    public static string? Emoji(string? icon) => icon is { Length: > 0 and <= 8 } e && !IsFetched(e) ? e : null;

    /// <summary>The picture when it is here; else null, and it is fetched (<see cref="Arrived"/> follows).</summary>
    public ImageSource? Get(string? icon)
    {
        if (!IsFetched(icon)) return null;
        if (_images.TryGetValue(icon!, out var known)) return known;
        if (_loading.Add(icon!)) _ = Load(icon!);
        return null;
    }

    /// <summary>
    /// A square of <paramref name="size"/> showing the icon: the picture once fetched, until then
    /// (and for one that cannot be drawn) the emoji, else the first letter of <paramref name="fallback"/>
    /// on a tinted ground. An app's icon is cut to a rounded square; <paramref name="round"/> cuts it
    /// to a circle, as every client draws an agent's avatar (the web panel's <c>.tile.agent</c>). It
    /// swaps itself when the picture arrives. <paramref name="placeholder"/>, when given, stands in for
    /// the letter (a built-in page's own artwork).
    /// </summary>
    public FrameworkElement View(string? icon, string fallback, double size = 40, bool round = false, Func<FrameworkElement>? placeholder = null)
    {
        var host = new Grid { Width = size, Height = size };
        var radius = round ? size / 2 : size * 0.22;
        void Draw()
        {
            host.Children.Clear();
            if (Get(icon) is { } image)
            {
                host.Children.Add(Picture(image, size, round));
                return;
            }
            if (placeholder is not null)
            {
                host.Children.Add(placeholder());
                return;
            }
            var emoji = Emoji(icon);
            var letter = emoji ?? (fallback.Length > 0 ? char.ToUpper(fallback.Trim().FirstOrDefault(' '), System.Globalization.CultureInfo.CurrentCulture).ToString() : "?");
            var text = Ui.Text(letter, size * (emoji is null ? 0.45 : 0.6), bold: emoji is null, wrap: false);
            text.HorizontalAlignment = HorizontalAlignment.Center;
            text.VerticalAlignment = VerticalAlignment.Center;
            if (emoji is not null) text.FontFamily = new FontFamily("Segoe UI Emoji");
            var tile = new Border { CornerRadius = new CornerRadius(radius), Child = text };
            if (emoji is null) tile.SetResourceReference(Border.BackgroundProperty, "SubtleFillColorSecondaryBrush");
            host.Children.Add(tile);
        }
        Draw();
        if (IsFetched(icon) && !_images.ContainsKey(icon!))
        {
            void OnArrived(string key)
            {
                if (key != icon) return;
                Arrived -= OnArrived;
                Draw();
            }
            Arrived += OnArrived;
        }
        return host;
    }

    /// <summary>
    /// A picture as an icon of <paramref name="size"/>: cut to a rounded square, or to a circle. Its
    /// ground is whatever lies behind it: nothing is painted under the picture, so one with
    /// transparent parts shows the page there.
    /// </summary>
    public static Image Picture(ImageSource image, double size, bool round)
    {
        var radius = size * 0.22;
        var img = new Image { Source = image, Width = size, Height = size, Stretch = Stretch.UniformToFill };
        RenderOptions.SetBitmapScalingMode(img, BitmapScalingMode.HighQuality);
        // A clip, not a border's corners: a border's ClipToBounds clips to its square.
        img.Clip = round
            ? new EllipseGeometry(new Point(size / 2, size / 2), size / 2, size / 2)
            : new RectangleGeometry(new Rect(0, 0, size, size), radius, radius);
        return img;
    }

    /// <summary>Forgets every picture (the Space signed out or changed address): they are fetched again when next asked.</summary>
    public void Clear()
    {
        _images.Clear();
        _loading.Clear();
    }

    private async Task Load(string icon)
    {
        ImageSource? image = null;
        try
        {
            if (api() is { } a)
            {
                var bytes = await a.Bytes(icon);
                if (SvgReader.LooksLikeSvg(bytes))
                {
                    image = SvgDrawing.Image(bytes);
                }
                else
                {
                    image = Bitmap(bytes);
                }
            }
        }
        catch (SpaceApiException e) when (e.Kind is SpaceApiFailure.Network or SpaceApiFailure.AuthenticationRequired)
        {
            // Not reached, or not signed in yet: asked again the next time it is drawn.
            _loading.Remove(icon);
            return;
        }
        catch (Exception e) when (e is SpaceApiException or NotSupportedException or IOException or InvalidOperationException or ArgumentException or System.Runtime.InteropServices.COMException or FileFormatException)
        {
            // A broken picture: the fallback stays.
        }
        if (!_loading.Remove(icon)) return;
        _images[icon] = image;
        Arrived?.Invoke(icon);
    }

    private static BitmapImage Bitmap(byte[] bytes)
    {
        var bmp = new BitmapImage();
        bmp.BeginInit();
        bmp.CacheOption = BitmapCacheOption.OnLoad;
        bmp.DecodePixelWidth = 128;
        bmp.StreamSource = new MemoryStream(bytes);
        bmp.EndInit();
        bmp.Freeze();
        return bmp;
    }
}
