/**
 * A ustar archive built in memory: what the claude-code adapter sends over ssh
 * when a call carries files, so the prompt and the images arrive in one stdin
 * stream and `tar -xf -` puts them where the command expects them. Plain
 * files only, at most 8 GB each, names under 100 bytes.
 */

export type TarEntry = { name: string; bytes: Uint8Array };

const BLOCK = 512;

export function ustar(entries: TarEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    if (name.byteLength > 100) throw new Error(`tar: name longer than 100 bytes: ${e.name}`);
    if (e.bytes.byteLength >= 8 ** 11) throw new Error(`tar: file too large: ${e.name}`);
    const h = new Uint8Array(BLOCK);
    h.set(name, 0);
    h.set(enc.encode("0000644\0"), 100);
    h.set(enc.encode("0000000\0"), 108);
    h.set(enc.encode("0000000\0"), 116);
    h.set(enc.encode(`${e.bytes.byteLength.toString(8).padStart(11, "0")}\0`), 124);
    h.set(enc.encode(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`), 136);
    h.set(enc.encode("        "), 148); // checksum field counts as spaces while summing
    h[156] = 0x30; // '0': a regular file
    h.set(enc.encode("ustar\0"), 257);
    h.set(enc.encode("00"), 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    parts.push(h, e.bytes);
    const rest = e.bytes.byteLength % BLOCK;
    if (rest) parts.push(new Uint8Array(BLOCK - rest));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}
