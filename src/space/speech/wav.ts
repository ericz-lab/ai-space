/**
 * The length of a WAV in seconds, from its `fmt ` byte rate and its `data` chunk, for the ledger's
 * `audioSeconds` of a speech answer. Undefined for anything that is not a RIFF/WAVE file with both chunks;
 * a streamed WAV whose `data` size is unknown (0 or 0xFFFFFFFF) counts the bytes that follow.
 */
export function wavSeconds(audio: ArrayBuffer): number | undefined {
  const view = new DataView(audio);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (audio.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let byteRate: number | undefined;
  for (let at = 12; at + 8 <= audio.byteLength; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 16 <= audio.byteLength) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      if (!byteRate) return undefined;
      const rest = audio.byteLength - (at + 8);
      const bytes = size === 0 || size === 0xffffffff ? rest : Math.min(size, rest);
      return Math.round((bytes / byteRate) * 1000) / 1000;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** The `fmt ` fields and where the samples are, for a RIFF/WAVE file; undefined for anything else. */
export function wavLayout(audio: ArrayBuffer): { fmt: Uint8Array; byteRate: number; blockAlign: number; dataAt: number; dataBytes: number } | undefined {
  const view = new DataView(audio);
  const tag = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (audio.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  let fmt: Uint8Array | undefined;
  for (let at = 12; at + 8 <= audio.byteLength; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && size >= 16 && at + 8 + size <= audio.byteLength) fmt = new Uint8Array(audio.slice(at + 8, at + 8 + size));
    if (id === "data") {
      if (!fmt) return undefined;
      const f = new DataView(fmt.buffer);
      const byteRate = f.getUint32(8, true);
      const blockAlign = f.getUint16(12, true);
      if (!byteRate || !blockAlign) return undefined;
      const rest = audio.byteLength - (at + 8);
      return { fmt, byteRate, blockAlign, dataAt: at + 8, dataBytes: size === 0 || size === 0xffffffff ? rest : Math.min(size, rest) };
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** A WAV of `fmt` and these sample bytes. */
export function wavFile(fmt: Uint8Array, data: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(12 + 8 + fmt.byteLength + 8 + data.byteLength);
  const view = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, out.byteLength - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, fmt.byteLength, true);
  out.set(fmt, 20);
  const d = 20 + fmt.byteLength;
  put(d, "data");
  view.setUint32(d + 4, data.byteLength, true);
  out.set(data, d + 8);
  return out.buffer;
}

/** Raw little-endian 16-bit PCM wrapped as a WAV. */
export function pcm16Wav(pcm: Uint8Array, sampleRate: number, channels: number): ArrayBuffer {
  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, 1, true);
  f.setUint16(2, channels, true);
  f.setUint32(4, sampleRate, true);
  f.setUint32(8, sampleRate * channels * 2, true);
  f.setUint16(12, channels * 2, true);
  f.setUint16(14, 16, true);
  return wavFile(fmt, pcm.subarray(0, pcm.byteLength - (pcm.byteLength % (channels * 2))));
}

/**
 * A WAV cut into WAVs of at most `maxSeconds` and `maxBytes` each, on sample boundaries, with each
 * piece's start in seconds; undefined when it is not a WAV or already fits.
 */
export function splitWav(audio: ArrayBuffer, maxSeconds: number, maxBytes: number): { start: number; audio: ArrayBuffer }[] | undefined {
  const w = wavLayout(audio);
  if (!w) return undefined;
  const room = Math.min(Math.floor(maxSeconds * w.byteRate), maxBytes - 64 - w.fmt.byteLength);
  const step = Math.max(w.blockAlign, room - (room % w.blockAlign));
  if (w.dataBytes <= step) return undefined;
  const bytes = new Uint8Array(audio, w.dataAt, w.dataBytes);
  const out: { start: number; audio: ArrayBuffer }[] = [];
  for (let at = 0; at < w.dataBytes; at += step) out.push({ start: at / w.byteRate, audio: wavFile(w.fmt, bytes.subarray(at, Math.min(at + step, w.dataBytes))) });
  return out;
}
