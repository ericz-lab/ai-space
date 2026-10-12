import { createGunzip, gzipSync } from "node:zlib";
import { packagePath } from "./contract.ts";

const BLOCK = 512;
export const DEFAULT_ARCHIVE_LIMIT = 128 * 1024 ** 2;
export type ArchiveEntry = { path: string; bytes: Uint8Array; executable: boolean };

/** Deterministic regular-file USTAR: no platform tar process, links, ownership or timestamps. */
export function writeArchive(entries: ArchiveEntry[], limit = DEFAULT_ARCHIVE_LIMIT): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 2 * BLOCK;
  for (const entry of entries) {
    packagePath(entry.path);
    const header = Buffer.alloc(BLOCK);
    let name = entry.path;
    let prefix = "";
    if (name.length > 100) {
      const split = name.lastIndexOf("/", 155);
      if (split < 1 || name.length - split - 1 > 100) throw new Error(`path exceeds USTAR limits: ${name}`);
      prefix = name.slice(0, split);
      name = name.slice(split + 1);
    }
    header.write(name, 0, 100, "ascii");
    octal(header, 100, 8, entry.executable ? 0o755 : 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.bytes.length);
    octal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.write(prefix, 345, 155, "ascii");
    octal(header, 148, 8, header.reduce((n, b) => n + b, 0));
    const padding = (BLOCK - entry.bytes.length % BLOCK) % BLOCK;
    size += BLOCK + entry.bytes.length + padding;
    if (size > limit) throw new Error("archive exceeds unpacked limit");
    chunks.push(header, entry.bytes, new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(2 * BLOCK));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** Limit actual decompressed output before parsing or allocating entries from untrusted sizes. */
export async function readArchive(bytes: Uint8Array, limit = DEFAULT_ARCHIVE_LIMIT): Promise<ArchiveEntry[]> {
  if (bytes.length > limit || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error("invalid or oversized gzip package");
  const unzip = createGunzip({ chunkSize: 64 * 1024 });
  const chunks: Buffer[] = [];
  let size = 0;
  unzip.end(bytes);
  try {
    for await (const chunk of unzip) {
      size += chunk.length;
      if (size > limit) throw new Error("archive exceeds unpacked limit");
      chunks.push(chunk);
    }
  } finally {
    unzip.destroy();
  }
  return readTar(Buffer.concat(chunks, size));
}

function readTar(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      if (tar.length - offset < 2 * BLOCK || tar.length % BLOCK || !tar.subarray(offset).every((b) => b === 0)) throw new Error("invalid tar end marker");
      return entries;
    }
    const checksum = number(header, 148, 8);
    const calculated = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (checksum !== calculated) throw new Error("invalid tar checksum");
    if (header.toString("ascii", 257, 263) !== "ustar\0" || header.toString("ascii", 263, 265) !== "00") throw new Error("only USTAR packages are supported");
    if (header[156] !== 48 && header[156] !== 0) throw new Error("package entries must be regular files (no links or extensions)");
    if (field(header, 157, 100)) throw new Error("regular package files cannot have link targets");
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    const path = packagePath(prefix ? `${prefix}/${name}` : name);
    if (seen.has(path.toLowerCase())) throw new Error(`duplicate archive path: ${path}`);
    seen.add(path.toLowerCase());
    const length = number(header, 124, 12);
    const mode = number(header, 100, 8);
    if (mode !== 0o644 && mode !== 0o755) throw new Error("package files must have mode 0644 or 0755");
    const start = offset + BLOCK;
    const end = start + length;
    const next = start + Math.ceil(length / BLOCK) * BLOCK;
    if (next > tar.length || !tar.subarray(end, next).every((b) => b === 0)) throw new Error("truncated file or invalid tar padding");
    entries.push({ path, bytes: tar.subarray(start, end), executable: mode === 0o755 });
    if (entries.length > 100_002) throw new Error("too many archive entries");
    offset = next;
  }
  throw new Error("missing tar end marker");
}

function field(header: Buffer, offset: number, width: number): string {
  const b = header.subarray(offset, offset + width);
  const zero = b.indexOf(0);
  if (zero >= 0 && !b.subarray(zero).every((v) => v === 0)) throw new Error("non-canonical tar string");
  const content = zero < 0 ? b : b.subarray(0, zero);
  if (content.some((v) => v > 127)) throw new Error("package paths must be ASCII");
  return content.toString("ascii");
}

function number(header: Buffer, offset: number, width: number): number {
  const raw = header.subarray(offset, offset + width).toString("latin1");
  if (!/^[0-7]+[\x00 ]*$/.test(raw)) throw new Error("invalid tar numeric field");
  const n = parseInt(raw, 8);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid tar size");
  return n;
}

function octal(buffer: Buffer, offset: number, width: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length >= width) throw new Error("tar numeric field overflow");
  buffer.write(digits.padStart(width - 1, "0") + "\0", offset, width, "ascii");
}
