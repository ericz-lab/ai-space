import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteFile } from "../runtimes/types.ts";

/**
 * Images an app sends with one call. They come inside the request as base64,
 * never as URLs for ai-space to fetch: the service runs on loopback next to
 * every app, and fetching what a request names would let one reach the
 * others. The bytes are written to a directory of their own for the length of
 * the call and handed to the runtime as files, the path the chat service's
 * attachments take (`docs/model.md`).
 */

export const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 20 * 1024 * 1024;

export type RunImage = { name: string; bytes: Uint8Array };

/** Sniff the image type from the first bytes; a declared type is not trusted. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `images: [{ data: "<base64>" }, …]` from a request body, decoded and checked.
 * Each is named `img<n>.<ext>` by its sniffed type, which is how the prompt
 * refers to it ("the first image" is `img1`).
 */
export function parseImages(raw: unknown): RunImage[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("images must be an array of { data: base64 }");
  if (raw.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images`);
  let total = 0;
  return raw.map((item, i) => {
    const data = typeof item === "object" && item !== null ? (item as { data?: unknown }).data : undefined;
    if (typeof data !== "string" || !data) throw new Error(`images[${i}].data must be a base64 string`);
    const clean = data.replace(/^data:image\/[a-z]+;base64,/, "").replace(/\s+/g, "");
    if (!BASE64.test(clean)) throw new Error(`images[${i}].data is not base64`);
    const bytes = new Uint8Array(Buffer.from(clean, "base64"));
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`images[${i}] is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    total += bytes.byteLength;
    if (total > MAX_IMAGES_BYTES) throw new Error(`images are larger than ${MAX_IMAGES_BYTES / 1024 / 1024} MB together`);
    const type = sniffImage(bytes);
    if (!type) throw new Error(`images[${i}] is not a png, jpeg, gif or webp image`);
    return { name: `img${i + 1}.${IMAGE_EXT[type]}`, bytes };
  });
}

/** Write the images to a fresh directory; `cleanup` removes it and is safe to call twice. */
export async function spoolImages(images: RunImage[]): Promise<{ files: CompleteFile[]; cleanup: () => Promise<void> }> {
  if (!images.length) return { files: [], cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "space-model-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const files: CompleteFile[] = [];
    for (const img of images) {
      const path = join(dir, img.name);
      await Bun.write(path, img.bytes);
      files.push({ name: img.name, path });
    }
    return { files, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
