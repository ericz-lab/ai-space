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
