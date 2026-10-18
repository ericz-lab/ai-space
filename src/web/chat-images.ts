import { CHAT_IMAGE_TYPES, MAX_CHAT_IMAGE_BYTES, parseChatImages, type ChatImage } from "../space/agents/images.ts";
export type { ChatImage };
export const imageURL = (image: ChatImage) => `data:${image.mediaType};base64,${image.data}`;

export async function readChatImages(files: File[], current: ChatImage[]): Promise<ChatImage[]> {
  if (current.length + files.length > 4) throw new Error("limit");
  const added = await Promise.all(files.map(async (file) => {
    if (!CHAT_IMAGE_TYPES.includes(file.type) || file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("format");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]!);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { name: file.name.slice(0, 200) || "image.png", mediaType: file.type, data };
  }));
  return parseChatImages([...current, ...added]);
}
