using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using AISpace.Core;

namespace AISpace.Views;

/// <summary>
/// The Claude desk pet over Home (docs/windows-desktop.md#desk-pet): the web panel's Claude walking
/// along the bottom of the native Home page, showing the Space's mood (<c>GET /api/pets/mood</c>,
/// read after each look at the Space) with its line in a bubble. A click (or Enter on it) opens
/// the chat or the inbox the mood points at, else Claude jumps; right-click (or the menu key) hides
/// it, and Settings › General shows it again. The rules are <see cref="PetRules"/> and
/// <see cref="PetMotion"/> (the Linux client's <c>core/pet.ts</c> and <c>app/pet.ts</c>, the Mac's
/// <c>PetRules.swift</c>); the sheet is <c>Assets/pet-claude.png</c>.
///
/// The seam: the main window calls <see cref="Attach"/> once, with the overlay it lays over the
/// native Home page; the overlay has no background, so only the sprite takes the pointer, and it is
/// visible exactly while Home is shown. The pet's timers run only while the overlay is visible in
/// a window that is not minimised, and fire only when a cell or the place changes; with Windows'
/// animation effects off it is not shown.
/// </summary>
internal static class PetView
{
    private static DeskPet? _pet;

    public static void Attach(Grid overlay, AppModel model) => _pet ??= new DeskPet(overlay, model);
}

/// <summary>The pet in the main window: the sprite, its bubble and their timers.</summary>
internal sealed class DeskPet
{
    private const double Bottom = 6;
    private static readonly Uri SheetUri = new("pack://application:,,,/Assets/pet-claude.png");

    private readonly Grid _overlay;
    private readonly AppModel _model;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Button _sprite;
    private readonly Image _image = new() { Stretch = Stretch.Uniform };
    private readonly ScaleTransform _flip = new(1, 1);
    private readonly Border _bubble;
    private readonly TextBlock _bubbleText;
    private readonly DispatcherTimer _timer = new(DispatcherPriority.Render);
    private readonly DispatcherTimer _bubbleTimer = new();
    private readonly Dictionary<(int, int), CroppedBitmap> _cells = [];
    private BitmapSource? _sheet;
    private bool _sheetFailed;
    private Window? _window;
    private PetMotion? _motion;
    private PetMood? _mood;
    private double _stage;
    private bool _running;
    private bool _hovering;
    private bool _bubbleOn;
    private double? _bubbleSince;
    /// <summary>Which Space's look the mood was read after: a new look, or another Space, reads it again.</summary>
    private (Guid? Space, DateTimeOffset? At) _moodOf;
    private int _moodRequest;

    public DeskPet(Grid overlay, AppModel model)
    {
        _overlay = overlay;
        _model = model;
        var size = PetRules.Size;

        _image.RenderTransformOrigin = new Point(0.5, 0.5);
        _image.RenderTransform = _flip;
        RenderOptions.SetBitmapScalingMode(_image, BitmapScalingMode.HighQuality);
        // A bare button: the sprite and the keyboard's focus rectangle, nothing of the theme's chrome.
        var template = new ControlTemplate(typeof(Button)) { VisualTree = new FrameworkElementFactory(typeof(ContentPresenter)) };
        _sprite = new Button
        {
            Content = _image,
            Template = template,
            Width = size,
            Height = size,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Bottom,
            Margin = new Thickness(0, 0, 0, Bottom),
            Cursor = Cursors.Hand,
            Background = Brushes.Transparent,
            Visibility = Visibility.Collapsed,
        };
        System.Windows.Automation.AutomationProperties.SetName(_sprite, L.T("Claude, the desk pet"));
        _sprite.Click += (_, _) => Click();
        _sprite.MouseEnter += (_, _) => Hover(true);
        _sprite.MouseLeave += (_, _) => Hover(false);
        _sprite.ContextMenu = Menu();

        _bubbleText = new TextBlock { FontSize = 12, TextWrapping = TextWrapping.Wrap, MaxWidth = 220 };
        _bubbleText.SetResourceReference(TextBlock.ForegroundProperty, "TextFillColorPrimaryBrush");
        _bubble = new Border
        {
            Child = _bubbleText,
            Padding = new Thickness(10, 6, 10, 7),
            CornerRadius = new CornerRadius(10),
            BorderThickness = new Thickness(1),
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
            Visibility = Visibility.Collapsed,
            Margin = new Thickness(0, 0, 0, Bottom + size + 2),
        };
        _bubble.SetResourceReference(Border.BackgroundProperty, "SolidBackgroundFillColorTertiaryBrush");
        _bubble.SetResourceReference(Border.BorderBrushProperty, "CardStrokeColorDefaultBrush");
        System.Windows.Automation.AutomationProperties.SetLiveSetting(_bubble, System.Windows.Automation.AutomationLiveSetting.Polite);

        overlay.Children.Add(_bubble);
        overlay.Children.Add(_sprite);

        _timer.Tick += (_, _) =>
        {
            _timer.Stop();
            Schedule();
        };
        _bubbleTimer.Tick += (_, _) =>
        {
            _bubbleTimer.Stop();
            FlipBubble();
        };
        overlay.SizeChanged += (_, e) => Layout(e.NewSize.Width);
        overlay.IsVisibleChanged += (_, _) => Sync();
        overlay.Loaded += (_, _) => FindWindow();
        model.Changed += OnModelChanged;
        SystemParameters.StaticPropertyChanged += OnSystemChanged;
        FindWindow();
        Sync();
        OnModelChanged();
    }

    private double Now => _clock.Elapsed.TotalSeconds;

    /// <summary>Shown at all: the preference, and Windows' animation effects (as the Mac hides it under Reduce Motion).</summary>
    private bool Wanted => _model.Prefs.DeskPet && SystemParameters.ClientAreaAnimation;

    private void FindWindow()
    {
        if (_window is not null || Window.GetWindow(_overlay) is not { } w) return;
        _window = w;
        w.StateChanged += (_, _) => Sync();
    }

    private void OnSystemChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(SystemParameters.ClientAreaAnimation)) _overlay.Dispatcher.BeginInvoke(Sync);
    }

    /// <summary>The preference or the Space changed, or a look at the Space ended: show or hide, and read the mood again after a new look.</summary>
    private void OnModelChanged()
    {
        Sync();
        var space = _model.Selected;
        var live = _model.SelectedLive;
        var of = (space, live?.LastRefresh);
        if (of == _moodOf) return;
        var otherSpace = of.space != _moodOf.Space;
        _moodOf = of;
        if (otherSpace) SetMood(null);
        if (live is null || live.Status != LiveStatus.Ok || _model.SelectedConnection is not { } c) return;
        var api = _model.Api(c);
        var mine = ++_moodRequest;
        InboxParts.Run(async () =>
        {
            var mood = await api.Mood();
            if (mine == _moodRequest) SetMood(PetRules.Shown(mood));
        }, _ =>
        {
            // Not reached: the pet walks and rests with no mood.
            if (mine == _moodRequest) SetMood(null);
        });
    }

    private void SetMood(PetMood? mood)
    {
        var before = Line();
        _mood = mood;
        if (_motion is not null)
        {
            _motion.SetMood(mood, Now);
            if (_running) Schedule();
        }
        var line = Line();
        System.Windows.Automation.AutomationProperties.SetHelpText(_sprite, line ?? "");
        if (line != before)
        {
            _bubbleSince = null;
            RestartBubble();
        }
    }

    private string? Line() => PetRules.SayText(_mood?.Say, InboxParts.Lang);

    /// <summary>Shown or hidden, running or still, as the preference, the animations, Home and the window say.</summary>
    private void Sync()
    {
        FindWindow();
        var shown = Wanted;
        var visibility = shown ? Visibility.Visible : Visibility.Collapsed;
        if (_sprite.Visibility != visibility) _sprite.Visibility = visibility;
        var run = shown && _overlay.IsVisible && _window?.WindowState != WindowState.Minimized && _motion is not null && Sheet() is not null;
        if (run == _running)
        {
            Place();
            return;
        }
        _running = run;
        if (run)
        {
            Schedule();
            RestartBubble();
        }
        else
        {
            _timer.Stop();
            _bubbleTimer.Stop();
            Place();
        }
    }

    private void Layout(double width)
    {
        if (width <= 0) return;
        _stage = width;
        if (_motion is { } m) m.Resize(width, Now);
        else
        {
            _motion = new PetMotion(PetRules.Claude, PetRules.Size, width, Now);
            _motion.SetMood(_mood, Now);
        }
        // The first size starts the pet; a later one places it again.
        Sync();
        if (_running) Schedule();
    }

    /// <summary>Everything due now, drawn; the timer set for the next change (at most 20 a second while it walks).</summary>
    private void Schedule()
    {
        _timer.Stop();
        if (!_running || _motion is not { } m) return;
        var delay = m.Advance(Now);
        Draw();
        _timer.Interval = TimeSpan.FromSeconds(Math.Max(0.05, delay));
        _timer.Start();
    }

    private void Draw()
    {
        if (_motion is not { } m) return;
        var (column, row) = m.Cell;
        if (Cell(column, row) is { } cell && !ReferenceEquals(_image.Source, cell)) _image.Source = cell;
        var flip = m.FacingLeft ? -1 : 1;
        if (_flip.ScaleX != flip) _flip.ScaleX = flip;
        Place();
    }

    /// <summary>The sprite at the pet's place, the bubble above it opening towards the middle.</summary>
    private void Place()
    {
        if (_motion is not { } m) return;
        var x = Math.Round(m.X);
        if (_sprite.Margin.Left != x) _sprite.Margin = new Thickness(x, 0, 0, Bottom);
        var line = Line();
        var show = _sprite.Visibility == Visibility.Visible && _overlay.IsVisible && line is not null && (_bubbleOn || _hovering);
        if (show)
        {
            if (_bubbleText.Text != line) _bubbleText.Text = line;
            var bottom = _bubble.Margin.Bottom;
            if (PetRules.OpensRight(m.X, m.Width, _stage))
            {
                _bubble.HorizontalAlignment = HorizontalAlignment.Left;
                _bubble.Margin = new Thickness(x, 0, 0, bottom);
            }
            else
            {
                _bubble.HorizontalAlignment = HorizontalAlignment.Right;
                _bubble.Margin = new Thickness(0, 0, Math.Max(0, Math.Round(_stage - m.X - m.Width)), bottom);
            }
        }
        var visibility = show ? Visibility.Visible : Visibility.Collapsed;
        if (_bubble.Visibility != visibility) _bubble.Visibility = visibility;
    }

    private void RestartBubble()
    {
        _bubbleTimer.Stop();
        if (Line() is null)
        {
            _bubbleSince = null;
            _bubbleOn = false;
            Place();
            return;
        }
        _bubbleSince ??= Now;
        FlipBubble();
    }

    /// <summary>The bubble comes and goes while the line stays: shown at once, then 6 seconds shown and 14 hidden.</summary>
    private void FlipBubble()
    {
        if (!_running || _bubbleSince is not { } since)
        {
            Place();
            return;
        }
        var elapsed = Now - since;
        _bubbleOn = PetRules.BubbleVisible(elapsed);
        Place();
        _bubbleTimer.Interval = TimeSpan.FromSeconds(PetRules.BubbleUntilChange(elapsed) + 0.05);
        _bubbleTimer.Start();
    }

    private void Hover(bool on)
    {
        _hovering = on;
        Place();
    }

    /// <summary>The chat or the inbox the mood points at; else the jump.</summary>
    private void Click()
    {
        if (_mood?.Open is { } open && _model.Selected is { } space)
        {
            if (open.Inbox) _model.ShowInbox(space);
            else _model.ShowChat(space, open.Agent);
            return;
        }
        _motion?.Click(Now);
        if (_running) Schedule();
    }

    private ContextMenu Menu()
    {
        var hide = new MenuItem { Header = L.T("Hide the Desk Pet"), ToolTip = L.T("Settings › General shows it again.") };
        hide.Click += (_, _) =>
        {
            _model.Prefs.DeskPet = false;
            _model.SavePrefs();
            Sync();
        };
        var menu = new ContextMenu();
        menu.Items.Add(hide);
        return menu;
    }

    private BitmapSource? Sheet()
    {
        if (_sheet is not null || _sheetFailed) return _sheet;
        try
        {
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.UriSource = SheetUri;
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.EndInit();
            bmp.Freeze();
            _sheet = bmp;
        }
        catch (Exception e) when (e is IOException or NotSupportedException or InvalidOperationException or ArgumentException or FileFormatException)
        {
            // Without its sheet the pet is not shown; the log says why.
            _sheetFailed = true;
            Shell.Log.Write($"desk pet sheet: {e.Message}");
        }
        return _sheet;
    }

    private CroppedBitmap? Cell(int column, int row)
    {
        if (_cells.TryGetValue((column, row), out var cell)) return cell;
        if (Sheet() is not { } sheet) return null;
        var (x, y, w, h) = PetRules.Cell(PetRules.Claude, column, row, sheet.PixelWidth, sheet.PixelHeight);
        cell = new CroppedBitmap(sheet, new Int32Rect(x, y, w, h));
        cell.Freeze();
        _cells[(column, row)] = cell;
        return cell;
    }
}
