using System.Text;
using System.Threading.Channels;
using K = AISpace.Core.HoldKeyRules.Kind;

namespace AISpace.Core.Tests;

/// <summary>Voice input's rules: the Mac's VoiceLanguageTests, DictationRulesTests and FnHoldRulesTests, and the live session.</summary>
public class VoiceTests
{
    // Language (the Mac's VoiceLanguage)

    [Fact]
    public void SameAsAppFollowsTheAppsLanguage()
    {
        Assert.Equal("zh", VoiceLanguage.Code(VoiceLanguage.SameAsApp, "zh"));
        Assert.Equal("zh", VoiceLanguage.Code(null, "zh-Hans"));
        Assert.Equal("en", VoiceLanguage.Code("", "en-US"));
        // A display language no provider names: the provider detects it.
        Assert.Equal("", VoiceLanguage.Code("", "fr"));
    }

    [Fact]
    public void DetectSendsNothingAndAChosenCodeWins()
    {
        Assert.Equal("", VoiceLanguage.Code(VoiceLanguage.Detect, "zh"));
        Assert.Equal("ja", VoiceLanguage.Code("ja", "zh"));
        Assert.Equal("ko", VoiceLanguage.Code("ko", "en"));
        // An unknown saved value falls back to the app's language.
        Assert.Equal("en", VoiceLanguage.Code("xx", "en"));
    }

    [Fact]
    public void TheLanguageGoesInTheStartAndOnTheClip()
    {
        Assert.Equal("{\"type\":\"start\",\"format\":\"pcm_s16le\",\"sample_rate\":16000,\"channels\":1,\"language\":\"zh\"}", VoiceLanguage.StartMessage("zh"));
        Assert.Contains("\"language\":\"\"", VoiceLanguage.StartMessage(""));
        Assert.Contains("\"language\":\"\"", VoiceLanguage.StartMessage("zh-CN"));
        Assert.Equal([("language", "en")], VoiceLanguage.UploadFields("en"));
        Assert.Empty(VoiceLanguage.UploadFields(""));
    }

    // Text

    [Fact]
    public void ChineseSegmentsAreJoinedWithoutSpaces()
    {
        var t = new VoiceTranscript();
        t.Update(0, "今天天气", final: true);
        Assert.Equal("今天天气很好", t.Update(1, "很好", final: true));
        Assert.Equal("今天天气很好 OK", t.Update(2, "OK", final: false));
        var e = new VoiceTranscript();
        e.Update(0, "hello", true);
        Assert.Equal("hello world", e.Update(1, " world ", false));
    }

    [Fact]
    public void AFinalSegmentIsKeptAndAPartialReplacesItsDraft()
    {
        var t = new VoiceTranscript();
        t.Update(0, "hel", false);
        Assert.Equal("hello", t.Update(0, "hello", true));
        Assert.Equal("hello", t.Update(0, "changed", false));
        Assert.Equal("hello there", t.Update(1, "there", false));
    }

    [Fact]
    public void TidyDropsOnlySpacesBetweenWideCharacters()
    {
        Assert.Equal("你好世界", VoiceText.Tidy("你好 世界"));
        Assert.Equal("你好 AI 世界", VoiceText.Tidy("你好 AI 世界"));
        Assert.Equal("こんにちは世界", VoiceText.Tidy("こんにちは 世界"));
        Assert.Equal("a b", VoiceText.Tidy("a b"));
    }

    [Fact]
    public void TheOverlayShowsTheEndOfALongTranscript()
    {
        Assert.Equal("short", VoiceText.Tail("  short "));
        var words = string.Join(" ", Enumerable.Range(0, 60).Select(i => $"w{i}"));
        var tail = VoiceText.Tail(words);
        Assert.StartsWith("…", tail);
        Assert.EndsWith("w59", tail);
        Assert.True(tail.Length <= 121);
        Assert.DoesNotContain(" ", tail[..2]);
        var chinese = new string('字', 200);
        Assert.Equal("…" + new string('字', 120), VoiceText.Tail(chinese));
    }

    [Fact]
    public void ATranscriptGoesAfterWhatTheFieldHolds()
    {
        Assert.Equal("hello", VoiceText.Append("  ", "hello"));
        Assert.Equal("open the todo app", VoiceText.Append("open ", "the todo app"));
        Assert.Equal("打开待办", VoiceText.Append("打开", "待办"));
    }

    [Fact]
    public void FramesAreAtMostAHundredMilliseconds()
    {
        var f = new VoicePcmFrames();
        Assert.Empty(f.Append(new byte[3000]));
        var frames = f.Append(new byte[7000]);
        Assert.Equal(3, frames.Count);
        Assert.All(frames, x => Assert.Equal(3200, x.Length));
        Assert.Equal(400, f.Finish()!.Length);
        Assert.Null(f.Finish());
    }

    [Fact]
    public void TheClipIsAWavOfMono16kPcm()
    {
        var wav = VoiceText.Wav(new byte[] { 1, 2, 3, 4 });
        Assert.Equal(48, wav.Length);
        Assert.Equal("RIFF", Encoding.ASCII.GetString(wav, 0, 4));
        Assert.Equal(40, BitConverter.ToInt32(wav, 4));
        Assert.Equal("WAVEfmt ", Encoding.ASCII.GetString(wav, 8, 8));
        Assert.Equal(1, BitConverter.ToInt16(wav, 22));
        Assert.Equal(16000, BitConverter.ToInt32(wav, 24));
        Assert.Equal(32000, BitConverter.ToInt32(wav, 28));
        Assert.Equal(16, BitConverter.ToInt16(wav, 34));
        Assert.Equal("data", Encoding.ASCII.GetString(wav, 36, 4));
        Assert.Equal(4, BitConverter.ToInt32(wav, 40));
    }

    [Fact]
    public void EventsAreRead()
    {
        Assert.Equal(new VoiceEvent("partial", 2, "hi", null), VoiceEvent.Parse("{\"type\":\"partial\",\"segment_id\":2,\"text\":\"hi\"}"));
        Assert.Equal("ready", VoiceEvent.Parse("{\"type\":\"ready\",\"sample_rate\":16000}")!.Type);
        Assert.Null(VoiceEvent.Parse("not json"));
        Assert.Null(VoiceEvent.Parse("{\"text\":\"x\"}"));
    }

    // Which Space

    [Fact]
    public void VoiceGoesToOneSpaceOnly()
    {
        Guid a = Guid.NewGuid(), b = Guid.NewGuid(), gone = Guid.NewGuid();
        Assert.Equal(b, VoiceSpace.Choose([a, b], pinned: b, selected: a, fallback: a));
        Assert.Equal(a, VoiceSpace.Choose([a, b], pinned: gone, selected: a, fallback: b));
        Assert.Equal(b, VoiceSpace.Choose([a, b], pinned: null, selected: null, fallback: b));
        Assert.Null(VoiceSpace.Choose([], pinned: null, selected: null, fallback: null));
    }

    [Fact]
    public void WindowsPrivacySettingDecidesTheMicrophone()
    {
        Assert.True(MicrophoneAccess.Allowed(null, null, null));
        Assert.True(MicrophoneAccess.Allowed("Allow", "Allow", "Allow"));
        Assert.False(MicrophoneAccess.Allowed("Deny", "Allow", "Allow"));
        Assert.False(MicrophoneAccess.Allowed("Allow", "Allow", "deny"));
    }

    // Delivery

    [Fact]
    public void TheTranscriptIsPastedUnlessWindowsWouldDropIt()
    {
        Assert.Equal(DictationRules.Delivery.Paste, DictationRules.For(foreground: true, own: false, ownTakesText: false, elevated: false));
        Assert.Equal(DictationRules.Delivery.ClipboardOnly, DictationRules.For(true, false, false, elevated: true));
        Assert.Equal(DictationRules.Delivery.ClipboardOnly, DictationRules.For(foreground: false, false, false, false));
        Assert.Equal(DictationRules.Delivery.Paste, DictationRules.For(true, own: true, ownTakesText: true, false));
        Assert.Equal(DictationRules.Delivery.ClipboardOnly, DictationRules.For(true, own: true, ownTakesText: false, false));
    }

    [Fact]
    public void TheClipboardComesBackOnlyWhenNothingWasCopiedSince()
    {
        Assert.True(DictationRules.Restores(DictationRules.Delivery.Paste, 7, 7));
        Assert.False(DictationRules.Restores(DictationRules.Delivery.Paste, 8, 7));
        Assert.False(DictationRules.Restores(DictationRules.Delivery.ClipboardOnly, 7, 7));
    }

    // The hold key (the Mac's FnHoldRulesTests)

    const int Key = HoldToTalkKeys.VkRControl, C = 0x43, Shift = HoldToTalkKeys.VkLShift;

    static HoldKeyRules Rules() => new(Key);

    [Fact]
    public void HeldAloneStartsAndLettingGoStops()
    {
        var r = Rules();
        var arm = r.Feed(Key, down: true);
        Assert.Equal(K.Arm, arm.Kind);
        Assert.True(r.Holding);
        Assert.Equal(K.Start, r.Elapsed(arm.Token).Kind);
        Assert.True(r.Recording);
        // Windows repeats a held key's down: nothing changes.
        Assert.Equal(K.None, r.Feed(Key, true).Kind);
        Assert.Equal(K.Stop, r.Feed(Key, down: false).Kind);
        Assert.False(r.Holding);
    }

    [Fact]
    public void ATapNeverStarts()
    {
        var r = Rules();
        var arm = r.Feed(Key, true);
        Assert.Equal(K.None, r.Feed(Key, false).Kind);
        Assert.Equal(K.None, r.Elapsed(arm.Token).Kind);
        Assert.False(r.Recording);
    }

    [Fact]
    public void ACombinationNeverStarts()
    {
        var r = Rules();
        var arm = r.Feed(Key, true);
        r.Feed(C, true);
        Assert.Equal(K.None, r.Elapsed(arm.Token).Kind);
        r.Feed(C, false);
        Assert.Equal(K.None, r.Feed(Key, false).Kind);

        // Pressed while another key is held (Shift+Right Ctrl).
        r.Feed(Shift, true);
        Assert.Equal(K.None, r.Feed(Key, true).Kind);
        r.Feed(Shift, false);
        Assert.Equal(K.None, r.Feed(Key, false).Kind);

        // The next press alone works again.
        var again = r.Feed(Key, true);
        Assert.Equal(K.Start, r.Elapsed(again.Token).Kind);
    }

    [Fact]
    public void AKeyPressedWhileRecordingCancelsIt()
    {
        var r = Rules();
        r.Elapsed(r.Feed(Key, true).Token);
        Assert.Equal(K.Cancel, r.Feed(C, true).Kind);
        Assert.Equal(K.None, r.Feed(C, true).Kind);
        Assert.Equal(K.None, r.Feed(C, false).Kind);
        Assert.Equal(K.None, r.Feed(Key, false).Kind);
    }

    [Fact]
    public void AnOldTimerDoesNothing()
    {
        var r = Rules();
        var first = r.Feed(Key, true);
        r.Feed(Key, false);
        var second = r.Feed(Key, true);
        Assert.Equal(K.None, r.Elapsed(first.Token).Kind);
        Assert.Equal(K.Start, r.Elapsed(second.Token).Kind);
    }

    [Fact]
    public void AMissedReleaseOfAnotherKeyIsForgotten()
    {
        var r = Rules();
        r.Feed(Shift, true);
        r.Prune(_ => false);
        Assert.Equal(K.Arm, r.Feed(Key, true).Kind);
    }

    [Fact]
    public void ResetSaysWhetherARecordingWasGoingOn()
    {
        var r = Rules();
        r.Elapsed(r.Feed(Key, true).Token);
        Assert.True(r.Reset());
        Assert.False(r.Holding);
        Assert.False(r.Reset());
    }

    [Fact]
    public void TheKeysAreTheRightHandModifiers()
    {
        Assert.Equal(0xA3, HoldToTalkKeys.VirtualKey(HoldToTalkKey.RightCtrl));
        Assert.Equal(0xA5, HoldToTalkKeys.VirtualKey(HoldToTalkKey.RightAlt));
        Assert.Equal("Right Ctrl", HoldToTalkKeys.Label(HoldToTalkKey.RightCtrl));
    }

    // The live session

    sealed class FakeChannel : IVoiceChannel
    {
        public readonly Channel<string> Incoming = Channel.CreateUnbounded<string>();
        public readonly List<object> Sent = [];
        public bool Disposed;

        public Task SendText(string text, CancellationToken ct)
        {
            lock (Sent) Sent.Add(text);
            return Task.CompletedTask;
        }

        public Task SendBinary(byte[] data, CancellationToken ct)
        {
            lock (Sent) Sent.Add(data);
            return Task.CompletedTask;
        }

        public async Task<string?> Receive(CancellationToken ct)
        {
            try
            {
                return await Incoming.Reader.ReadAsync(ct);
            }
            catch (ChannelClosedException)
            {
                return null;
            }
        }

        public void Say(string json) => Incoming.Writer.TryWrite(json);

        public object[] Snapshot()
        {
            lock (Sent) return [.. Sent];
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    sealed class Uploads
    {
        public readonly List<(byte[] Wav, string Language)> Calls = [];
        public string Answer = "from the clip";
        public Exception? Error;

        public Task<string> Upload(byte[] wav, string language, CancellationToken ct)
        {
            lock (Calls) Calls.Add((wav, language));
            return Error is null ? Task.FromResult(Answer) : Task.FromException<string>(Error);
        }
    }

    static async Task Until(Func<bool> condition)
    {
        for (var i = 0; i < 200 && !condition(); i++) await Task.Delay(10);
        Assert.True(condition());
    }

    static async Task<VoiceOutcome> Within(VoiceSession s) => await s.Outcome.WaitAsync(TimeSpan.FromSeconds(5));

    [Fact]
    public async Task AudioBeforeReadyIsHeldThenSentInFramesThenStop()
    {
        var ch = new FakeChannel();
        var up = new Uploads();
        var s = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch), up.Upload, "zh");
        var texts = new List<string>();
        s.TextChanged += t => { lock (texts) texts.Add(t); };
        s.Start();
        s.Feed(new byte[5000]);
        await Until(() => ch.Snapshot().Length == 1);
        Assert.Equal(VoiceLanguage.StartMessage("zh"), ch.Snapshot()[0]);
        ch.Say("{\"type\":\"loading\"}");
        ch.Say("{\"type\":\"ready\",\"sample_rate\":16000}");
        await Until(() => ch.Snapshot().Length == 2);
        Assert.Equal(3200, ((byte[])ch.Snapshot()[1]).Length);
        s.Feed(new byte[1000]);
        s.Stop();
        await Until(() => ch.Snapshot().Length == 4);
        var sent = ch.Snapshot();
        Assert.Equal(2800, ((byte[])sent[2]).Length);
        Assert.Equal("{\"type\":\"stop\"}", sent[3]);
        ch.Say("{\"type\":\"partial\",\"segment_id\":0,\"text\":\"你好\"}");
        ch.Say("{\"type\":\"final\",\"segment_id\":0,\"text\":\"你好\"}");
        ch.Say("{\"type\":\"final\",\"segment_id\":1,\"text\":\"世界\"}");
        ch.Say("{\"type\":\"done\"}");
        Assert.Equal(new VoiceOutcome.Text("你好世界"), await Within(s));
        Assert.Contains("你好世界", texts);
        Assert.Empty(up.Calls);
        await Until(() => ch.Disposed);
    }

    [Fact]
    public async Task ARefusedSocketSendsTheRecordingAsAClip()
    {
        var up = new Uploads();
        var s = new VoiceSession(_ => Task.FromException<IVoiceChannel>(new System.Net.WebSockets.WebSocketException("503")), up.Upload, "en");
        s.Start();
        await Until(() => !s.Live);
        s.Feed(new byte[] { 1, 2, 3, 4 });
        s.Stop();
        Assert.Equal(new VoiceOutcome.Text("from the clip"), await Within(s));
        var (wav, language) = Assert.Single(up.Calls);
        Assert.Equal("en", language);
        Assert.Equal(48, wav.Length);
    }

    [Fact]
    public async Task AnErrorBeforeReadyFallsBackAndAfterReadyFails()
    {
        var ch = new FakeChannel();
        var up = new Uploads();
        var s = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch), up.Upload, "");
        s.Start();
        s.Feed(new byte[100]);
        ch.Say("{\"type\":\"error\",\"code\":\"unavailable\",\"message\":\"no live provider\"}");
        await Until(() => !s.Live);
        s.Stop();
        Assert.Equal(new VoiceOutcome.Text("from the clip"), await Within(s));
        Assert.Equal("", up.Calls.Single().Language);

        var ch2 = new FakeChannel();
        var s2 = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch2), up.Upload, "");
        s2.Start();
        ch2.Say("{\"type\":\"ready\"}");
        ch2.Say("{\"type\":\"error\",\"code\":\"busy\",\"message\":\"busy\"}");
        Assert.Equal(new VoiceOutcome.Failed(VoiceFailure.Failed, "busy"), await Within(s2));
        Assert.Single(up.Calls);
    }

    [Fact]
    public async Task ASocketThatNeverGetsReadySendsTheClipAfterTheLimit()
    {
        var ch = new FakeChannel();
        var up = new Uploads { Answer = " 你好 世界 " };
        var s = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch), up.Upload, "zh", new VoiceSession.Limits(TimeSpan.FromMilliseconds(50), 10 * 32000, 90 * 32000));
        s.Start();
        s.Feed(new byte[640]);
        s.Stop();
        Assert.Equal(new VoiceOutcome.Text("你好世界"), await Within(s));
        Assert.Equal(44 + 640, up.Calls.Single().Wav.Length);
    }

    [Fact]
    public async Task FinishingTooLongAfterReadyTimesOut()
    {
        var ch = new FakeChannel();
        var s = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch), new Uploads().Upload, "", new VoiceSession.Limits(TimeSpan.FromMilliseconds(50), 10 * 32000, 90 * 32000));
        s.Start();
        ch.Say("{\"type\":\"ready\"}");
        await Until(() => ch.Snapshot().Length >= 1);
        await Task.Delay(20);
        s.Stop();
        Assert.Equal(new VoiceOutcome.Failed(VoiceFailure.TimedOut, ""), await Within(s));
    }

    [Fact]
    public async Task RecordingEndsByItselfAtTheLimit()
    {
        var ch = new FakeChannel();
        var s = new VoiceSession(_ => Task.FromResult<IVoiceChannel>(ch), new Uploads().Upload, "", new VoiceSession.Limits(TimeSpan.FromSeconds(5), 10_000, 4_000));
        var ended = 0;
        s.RecordingEnded += () => Interlocked.Increment(ref ended);
        s.Start();
        s.Feed(new byte[3000]);
        Assert.Equal(0, ended);
        s.Feed(new byte[1000]);
        Assert.Equal(1, ended);
        // Audio after the end is not taken.
        s.Feed(new byte[1000]);
        ch.Say("{\"type\":\"ready\"}");
        await Until(() => ch.Snapshot().Length == 4);
        Assert.Equal(3200, ((byte[])ch.Snapshot()[1]).Length);
        Assert.Equal(800, ((byte[])ch.Snapshot()[2]).Length);
        s.Cancel();
        Assert.IsType<VoiceOutcome.Cancelled>(await Within(s));
    }

    [Fact]
    public async Task AFailedUploadSaysSo()
    {
        var up = new Uploads { Error = new SpaceApiException(SpaceApiFailure.Http, "no provider", 503) };
        var s = new VoiceSession(_ => Task.FromException<IVoiceChannel>(new IOException("down")), up.Upload, "");
        s.Start();
        s.Feed(new byte[10]);
        await Until(() => !s.Live);
        s.Stop();
        Assert.Equal(new VoiceOutcome.Failed(VoiceFailure.UploadFailed, "no provider"), await Within(s));
    }

    [Fact]
    public async Task NothingRecordedIsAnEmptyText()
    {
        var s = new VoiceSession(_ => Task.FromException<IVoiceChannel>(new IOException("down")), new Uploads().Upload, "");
        s.Start();
        await Until(() => !s.Live);
        s.Stop();
        Assert.Equal(new VoiceOutcome.Text(""), await Within(s));
    }

    [Fact]
    public async Task TheSpaceSaysWhetherItTranscribes()
    {
        static SpaceApi Api(Func<HttpRequestMessage, HttpResponseMessage> answer) => new(new Uri("https://space.example.com"), _ => Task.FromResult<string?>(null), new ScriptedHandler(answer));
        Assert.True(await Api(_ => ScriptedHandler.Json("{\"ok\":true,\"transcribe\":true}")).VoiceAvailable());
        Assert.False(await Api(_ => ScriptedHandler.Json("{\"ok\":true,\"transcribe\":false}")).VoiceAvailable());
        Assert.Null(await Api(_ => new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized)).VoiceAvailable());
        Assert.Null(await Api(_ => throw new HttpRequestException("down")).VoiceAvailable());
    }

    [Fact]
    public async Task TheClipGoesUpWithItsLanguageCookiesAndOrigin()
    {
        var handler = new ScriptedHandler(_ => ScriptedHandler.Json("{\"ok\":true,\"text\":\" hello \"}"));
        var api = new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>("space_session=b"), handler);
        Assert.Equal(" hello ", await api.Transcribe(VoiceText.Wav(new byte[2]), "ja"));
        var r = handler.Requests.Single();
        Assert.Equal(HttpMethod.Post, r.Method);
        Assert.Equal("https://space.example.com/api/voice/transcribe", r.RequestUri!.AbsoluteUri);
        Assert.Equal("https://space.example.com", string.Join("", r.Headers.GetValues("Origin")));
        Assert.Equal("space_session=b", string.Join("", r.Headers.GetValues("Cookie")));
        var body = handler.Bodies.Single()!;
        Assert.Contains("name=file; filename=voice.wav", body);
        Assert.Contains("name=language", body);
        Assert.Contains("ja", body);

        var detect = new ScriptedHandler(_ => ScriptedHandler.Json("{\"ok\":false,\"error\":\"no provider\"}", System.Net.HttpStatusCode.ServiceUnavailable));
        var e = await Assert.ThrowsAsync<SpaceApiException>(() => new SpaceApi(new Uri("https://space.example.com/"), _ => Task.FromResult<string?>(null), detect).Transcribe([1], ""));
        Assert.Equal("no provider", e.Message);
        Assert.DoesNotContain("name=language", detect.Bodies.Single());
    }

    [Fact]
    public void TheLiveAddressFollowsTheSpacesScheme()
    {
        var api = new SpaceApi(new Uri("https://space.example.com/x"), _ => Task.FromResult<string?>(null));
        Assert.Equal("wss://space.example.com/api/voice/realtime", api.VoiceSocketUrl().ToString());
        var local = new SpaceApi(new Uri("http://127.0.0.1:8700"), _ => Task.FromResult<string?>(null));
        Assert.Equal("ws://127.0.0.1:8700/api/voice/realtime", local.VoiceSocketUrl().ToString());
    }
}
