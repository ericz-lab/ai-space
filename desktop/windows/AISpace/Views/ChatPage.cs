namespace AISpace.Views;

/// <summary>
/// The main window's Chat (the Mac's chat panel): a native conversation with one of the Space's
/// agents (<see cref="ChatView"/>). The bar shows its tab while it is open; closing the tab hides
/// it and the conversation goes on, as it does when the page is not shown.
/// </summary>
internal sealed class ChatPage : NativePage
{
    private readonly ChatView _view;

    public ChatPage(PageContext context) : base(context)
    {
        _view = new ChatView(context.Model, compact: false);
        _view.AgentChanged += () => context.Model.NotifyChanged();
        Content = _view;
    }

    public override string Title => _view.Agent?.DisplayTitle() ?? L.T("Chat");

    /// <summary>Shows <paramref name="agent"/> (null: the one shown), <paramref name="text"/> in the field when given, <paramref name="session"/> when given.</summary>
    public void Open(string? agent, string? text, string? session)
    {
        _view.Show(Context.SpaceId, agent, text, session);
        if (IsShown) _view.FocusComposer();
    }

    public override void Shown()
    {
        _view.Show(Context.SpaceId, null);
        _view.Shown();
        _view.FocusComposer();
    }

    public override void LiveChanged() => _view.LiveChanged();

    public override void Refresh() => _view.Shown();

    public override void Close() => _view.Detach();
}
