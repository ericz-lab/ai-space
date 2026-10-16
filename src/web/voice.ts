/** Provisional text replaces its segment; final events commit even an empty correction. */
export class VoiceTranscript {
  private segments = new Map<number, { text: string; final: boolean }>();
  constructor(private prefix: string) {}
  update(id: number, text: string, final: boolean): string {
    if (!this.segments.get(id)?.final) this.segments.set(id, { text, final });
    return [this.prefix.trimEnd(), ...[...this.segments].sort(([a], [b]) => a - b).map(([, s]) => s.text.trim())].filter(Boolean).join(" ");
  }
}

// AudioContext resamples to 16 kHz and the node downmixes to mono. Outputs stay silent.
export const captureProcessor = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = []; this.stopped = false;
    this.port.onmessage = () => { this.flush(); this.stopped = true; this.port.postMessage("stopped"); };
  }
  flush() {
    if (!this.samples.length) return;
    const buffer = new ArrayBuffer(this.samples.length * 2), view = new DataView(buffer);
    this.samples.forEach((v, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true));
    this.port.postMessage(buffer, [buffer]); this.samples = [];
  }
  process(inputs) {
    if (this.stopped) return false;
    for (const value of inputs[0]?.[0] ?? []) {
      this.samples.push(value);
      if (this.samples.length === 1600) this.flush();
    }
    return true;
  }
}
registerProcessor("space-voice", Capture);
`;

export type VoiceState = "connecting" | "recording" | "transcribing" | "idle";

/** One cancellable session; no callbacks or microphone tracks survive disposal. */
export class LiveVoice {
  private socket?: WebSocket;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private stopping = false;
  private ready = false;
  private transcript: VoiceTranscript;
  constructor(prefix: string, private onText: (text: string) => void, private onState: (state: VoiceState) => void, private onError: (error: string) => void) {
    this.transcript = new VoiceTranscript(prefix);
  }
  private deadline(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("Voice connection timed out"), ms);
  }
  private fail(message: string) {
    if (this.disposed) return;
    this.onError(message);
    this.finish();
  }
  private releaseAudio() {
    const { source, node, stream, context } = this;
    this.source = undefined;
    this.node = undefined;
    this.stream = undefined;
    this.context = undefined;
    source?.disconnect();
    node?.disconnect();
    stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.releaseAudio();
    this.socket?.close();
  }
  private finish() {
    this.dispose();
    this.onState("idle");
  }
  stop() {
    if (this.disposed || this.stopping) return;
    if (!this.ready) { this.finish(); return; }
    this.stopping = true;
    this.onState("transcribing");
    this.deadline(70_000);
    // Flush the worklet's last short frame before sending stop on the socket.
    this.node?.port.postMessage("stop");
  }
  async start() {
    this.onState("connecting");
    this.deadline(130_000);
    try {
      const context = this.context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      if (this.disposed) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (this.disposed) { stream.getTracks().forEach((t) => t.stop()); return; }
      this.stream = stream;
      if (context.sampleRate !== 16000) throw new Error("16 kHz audio is unavailable");
      const module = URL.createObjectURL(new Blob([captureProcessor], { type: "text/javascript" }));
      try { await context.audioWorklet.addModule(module); } finally { URL.revokeObjectURL(module); }
      if (this.disposed) return;
      const node = this.node = new AudioWorkletNode(context, "space-voice", { channelCount: 1, channelCountMode: "explicit" });
      node.onprocessorerror = () => this.fail("Microphone processing failed");
      const source = this.source = context.createMediaStreamSource(stream);
      stream.getAudioTracks().forEach((track) => { track.onended = () => this.fail("Microphone disconnected"); });
      const url = new URL("/api/voice/realtime", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = this.socket = new WebSocket(url);
      node.port.onmessage = ({ data }) => {
        if (this.disposed || socket.readyState !== WebSocket.OPEN) return;
        if (data === "stopped") {
          this.releaseAudio();
          socket.send(JSON.stringify({ type: "stop" }));
        } else if (socket.bufferedAmount > 512_000) this.fail("Voice connection is too slow");
        else socket.send(data);
      };
      socket.onopen = () => socket.send(JSON.stringify({ type: "start", format: "pcm_s16le", sample_rate: 16000, channels: 1, language: "" }));
      socket.onmessage = ({ data }) => {
        if (this.disposed) return;
        try {
          const event = JSON.parse(data);
          if (event.type === "ready" && !this.ready) {
            this.ready = true;
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.stop(), 90_000);
            source.connect(node); node.connect(context.destination);
            this.onState("recording");
          } else if ((event.type === "partial" || event.type === "final") && Number.isInteger(event.segment_id) && typeof event.text === "string") {
            this.onText(this.transcript.update(event.segment_id, event.text, event.type === "final"));
          } else if (event.type === "done") this.finish();
          else if (event.type === "error") this.fail(event.message || "Transcription failed");
        } catch { this.fail("Invalid voice response"); }
      };
      socket.onerror = () => this.fail("Voice connection failed");
      socket.onclose = () => { if (!this.disposed) this.fail("Voice connection closed before completion"); };
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }
}
