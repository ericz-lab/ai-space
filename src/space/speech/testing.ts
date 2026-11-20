/** Stand-ins the speech tests share. */

/** A mono 16-bit PCM WAV of `seconds` of silence. */
export function wav(seconds = 0.5, rate = 16000): ArrayBuffer {
  const data = Math.round(seconds * rate) * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, "RIFF"); v.setUint32(4, 36 + data, true); put(8, "WAVE"); put(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  put(36, "data"); v.setUint32(40, data, true);
  return buf;
}
