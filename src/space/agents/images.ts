/** Shared wire format for native and Web agent chat. No paths or URLs supplied by clients. */
export type ChatImage = { name: string; mediaType: string; data: string };
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_IMAGES_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export function parseChatImages(value: unknown): ChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error("Attach at most 4 images");
  let total = 0;
  return value.map((image) => {
    if (!image || typeof image !== "object" || typeof image.name !== "string" || !image.name.trim() || image.name.length > 200 ||
        !CHAT_IMAGE_TYPES.includes(image.mediaType) || typeof image.data !== "string" || !image.data.length ||
        image.data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 || (image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.data) || !/^[^=]*={0,2}$/.test(image.data))) {
      throw new Error("Use PNG, JPEG, GIF or WebP images up to 5 MB each");
    }
    const bytes = atob(image.data);
    total += bytes.length;
    if (bytes.length > MAX_CHAT_IMAGE_BYTES || total > MAX_CHAT_IMAGES_BYTES) throw new Error("Images must total at most 10 MB");
    const type = bytes.startsWith("\x89PNG\r\n\x1a\n") ? "image/png" : bytes.startsWith("\xff\xd8\xff") ? "image/jpeg" :
      /^GIF8[79]a/.test(bytes) ? "image/gif" : bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP" ? "image/webp" : undefined;
    if (!type || type !== image.mediaType) throw new Error("Image content does not match its format");
    return { name: image.name, mediaType: type, data: image.data };
  });
}

/** Bound even chunked JSON requests before parsing base64 attachments. */
export async function chatBody(req: Request): Promise<Record<string, unknown>> {
  const limit = 15 * 1024 * 1024;
  if (Number(req.headers.get("content-length")) > limit) throw new Error("Chat request is too large");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("body must be JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error("Chat request is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be JSON");
  return body;
}
