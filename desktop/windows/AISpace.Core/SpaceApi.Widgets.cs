namespace AISpace.Core;

/// <summary>
/// The widgets' writes (docs/app-spec.md#views-copy-and-actions, docs/panel.md#resize-a-widget): an
/// action, a refresh, and the layout's frames. They go with the Space's origin and this connection's
/// sign-in, as every write of this client; a Space takes them from the panel's owner only.
/// </summary>
public sealed partial class SpaceApi
{
    /// <summary>
    /// <c>POST /api/widgets/:app/:name/action</c> with <c>{ action, value? }</c>. A failure of any kind
    /// (the app's error, an HTTP status, nothing answering) is an answer with its <c>Error</c>, never a throw.
    /// </summary>
    public Task<WidgetAnswer> WidgetAction(HomeWidget w, string action, string? value = null, CancellationToken ct = default) =>
        WidgetAction(w, action, WidgetActions.Request(action, value), ct);

    private async Task<WidgetAnswer> WidgetAction(HomeWidget w, string action, object? body, CancellationToken ct)
    {
        if (body is null) return new WidgetAnswer(null, Error: "the text is empty or too long");
        return await WidgetWrite(WidgetActions.Path(w, "action"), body, ct).ConfigureAwait(false);
    }

    /// <summary><c>POST /api/widgets/:app/:name/refresh</c>: the source is read again and the fresh card returned.</summary>
    public Task<WidgetAnswer> RefreshWidget(HomeWidget w, CancellationToken ct = default) =>
        WidgetWrite(WidgetActions.Path(w, "refresh"), new System.Text.Json.Nodes.JsonObject(), ct);

    private async Task<WidgetAnswer> WidgetWrite(string path, object body, CancellationToken ct)
    {
        try
        {
            var (status, _, text) = await Answer(HttpMethod.Post, path, body, ct).ConfigureAwait(false);
            if (status is >= 300 and < 400 or 401 or 403) return new WidgetAnswer(null, Error: "sign in required");
            return WidgetAnswer.Decode(status, text);
        }
        catch (SpaceApiException e)
        {
            return new WidgetAnswer(null, Error: e.Message);
        }
    }

    /// <summary>
    /// <c>PUT /api/panel/layout</c> with a widget layout write. Throws <see cref="SpaceApiException"/>
    /// as every write; a Space from before the stepless layout refuses <c>frames</c> with 400
    /// (<see cref="LayoutRefused"/>).
    /// </summary>
    public async Task PutLayout(LayoutWrite write, CancellationToken ct = default) =>
        await Send(HttpMethod.Put, SpaceCheck.LayoutPath, write.ToJson(), ct).ConfigureAwait(false);

    /// <summary>Whether a failed layout write was the Space refusing what it does not know (an older one), not a failure to reach it.</summary>
    public static bool LayoutRefused(SpaceApiException e) => e.Kind == SpaceApiFailure.Http && e.Status == 400;
}
