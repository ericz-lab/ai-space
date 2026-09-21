import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ModelService } from "../model/service.ts";
import { DEFAULT_SYSTEM, type ModelCall } from "../model/types.ts";
import type { CompleteFile, OnDelta } from "../runtimes/types.ts";
import { buildPrompt } from "./prompt.ts";
import type { ChatStore } from "./store.ts";
import {
  IMAGE_TYPES, MAX_ATTACHMENTS_PER_THREAD, MAX_ATTACHMENT_BYTES, MAX_FILES_BYTES_PER_TURN, MAX_FILES_PER_TURN, MAX_OUTPUT_TOKENS, MAX_TITLE_CHARS, ORPHAN_TTL_MS,
  type Attachment, type Message, type Thread, type TurnInput,
} from "./types.ts";

/**
 * The service: one turn = store the person's message, replay the thread into
 * one prompt, run it through the model service (so the ledger sees it, tagged
 * `chat`), store the answer. A turn that fails is stored too, with whatever
 * text arrived and the reason, and is left out of later replays. One turn at
 * a time per thread. Attachments are images on disk under the app's data
 * directory; a turn ships the current message's plus the newest earlier ones
 * up to a cap, since the runtime reads every shipped image again.
 */

export type ChatServiceOptions = {
  store: ChatStore;
  model: ModelService;
  /** Directory for an app's attachment files (`<workspace>/data/<app>/chat`). */
  fileDir: (app: string) => string;
  /** Model when a turn names none (SPACE_MODEL_DEFAULT). */
  defaultModel: string;
  log?: (message: string) => void;
  now?: () => number;
};

export type TurnResult = { ok: boolean; error?: string; user: Message; assistant: Message; thread: Thread; call?: ModelCall };

export class Locked extends Error {
  constructor() {
    super("this thread is still answering");
  }
}

export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Sniff the image type from the first bytes; the browser's declared type is not trusted. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** The name a file has for the runtime: short, unique in the call, shell-safe. */
export const fileNameOf = (a: Attachment): string => `a${a.id}.${IMAGE_TYPES[a.type] ?? "png"}`;

export class ChatService {
  readonly store: ChatStore;
  private readonly model: ModelService;
  private readonly fileDir: (app: string) => string;
  readonly defaultModel: string;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly running = new Set<number>();

  constructor(opts: ChatServiceOptions) {
    this.store = opts.store;
    this.model = opts.model;
    this.fileDir = opts.fileDir;
    this.defaultModel = opts.defaultModel;
    this.log = opts.log ?? ((m) => console.log(`[chat] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  isRunning(threadId: number): boolean {
    return this.running.has(threadId);
  }

  /** The ledger row behind an answer, for the backend and cost a message shows. */
  callOf(id: number): ModelCall | undefined {
    return this.model.store.get(id);
  }

  // ---------------------------------------------------------------- attachments

  /** Store an uploaded image for a thread; it belongs to no message until a turn sends it. */
  async addAttachment(app: string, thread: Thread, name: string, bytes: Uint8Array): Promise<Attachment> {
    await this.pruneOrphans();
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Refused(413, `image larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
    const type = sniffImage(bytes);
    if (!type) throw new Refused(415, "not a png, jpeg, gif or webp image");
    if (this.store.countAttachments(thread.id) >= MAX_ATTACHMENTS_PER_THREAD) throw new Refused(409, `a thread holds at most ${MAX_ATTACHMENTS_PER_THREAD} images`);
    const row = this.store.addAttachment({ app, threadId: thread.id, name: (name.trim() || "image").slice(0, 120), type, size: bytes.byteLength }, this.now());
    const dir = join(this.fileDir(app), String(thread.id));
    const path = join(dir, fileNameOf(row));
    try {
      await mkdir(dir, { recursive: true });
      await Bun.write(path, bytes);
    } catch (e) {
      this.store.removeAttachment(row.id);
      throw e;
    }
    this.store.setAttachmentPath(row.id, path);
    return { ...row, path };
  }

  /** Refuse ids that are not unsent uploads of this thread, before a turn starts (the turn binds them for real). */
  assertAttachments(app: string, thread: Thread, ids: number[]): void {
    for (const id of ids) {
      const a = this.store.getAttachment(app, id);
      if (!a || a.threadId !== thread.id || a.messageId !== undefined) throw new Refused(400, "attachments must be unsent uploads of this thread");
    }
  }

  async deleteThread(app: string, id: number): Promise<boolean> {
    const paths = this.store.deleteThread(app, id);
    if (!paths) return false;
    await this.unlinkAll(paths);
    return true;
  }

  async deleteScope(app: string, scope: string): Promise<number> {
    const paths = this.store.deleteScope(app, scope);
    await this.unlinkAll(paths);
    return paths.length;
  }

  private async pruneOrphans(): Promise<void> {
    await this.unlinkAll(this.store.pruneOrphans(this.now() - ORPHAN_TTL_MS));
  }

  private async unlinkAll(paths: string[]): Promise<void> {
    for (const p of paths) await unlink(p).catch(() => {});
  }

  // ---------------------------------------------------------------- turns

  /**
   * Run one turn. Throws `Locked` while the thread is answering and `Refused`
   * for attachments that are not this thread's; a model failure is a result
   * with `ok: false`, stored like a success.
   */
  async turn(app: string, thread: Thread, input: TurnInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<TurnResult> {
    if (this.running.has(thread.id)) throw new Locked();
    this.running.add(thread.id);
    try {
      await this.pruneOrphans();
      const history = this.store.listMessages(thread.id);
      const startedAt = this.now();
      const user = this.store.addMessage(thread.id, { role: "user", content: input.message }, startedAt);
      if (!this.store.bindAttachments(input.attachments, thread.id, user.id)) {
        this.store.db.query("DELETE FROM chat_messages WHERE id = ?").run(user.id);
        throw new Refused(400, "attachments must be unsent uploads of this thread");
      }
      this.store.touchThread(thread.id, startedAt, thread.title ? undefined : titleOf(input.message));

      const all = this.store.listAttachments(thread.id);
      const byMessage = new Map<number, Attachment[]>();
      for (const a of all) if (a.messageId !== undefined) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
      const shipped = pickFiles(all, user.id);
      const files: CompleteFile[] = shipped.map((a) => ({ name: fileNameOf(a), path: a.path }));
      const prompt = buildPrompt({
        context: input.context, history, attachments: byMessage, shipped: new Set(shipped.map((a) => a.id)), fileName: fileNameOf,
        message: input.message, messageAttachments: byMessage.get(user.id) ?? [],
      });

      let partial = "";
      const { outcome, call } = await this.model.run(
        app,
        {
          prompt, system: input.context?.system ?? DEFAULT_SYSTEM, model: input.model ?? this.defaultModel, tag: "chat", tools: input.tools,
          timeoutMs: input.timeoutMs, maxTokens: MAX_OUTPUT_TOKENS, ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(files.length ? { files } : {}),
        },
        signal,
        (text) => {
          partial += text;
          onDelta?.(text);
        },
      );
      const at = this.now();
      const assistant = outcome.ok
        ? this.store.addMessage(thread.id, { role: "assistant", content: outcome.text, callId: call.id }, at)
        : this.store.addMessage(thread.id, { role: "assistant", content: partial, error: outcome.error.slice(0, 500), callId: call.id }, at);
      this.store.touchThread(thread.id, at);
      if (!outcome.ok) this.log(`${app} thread ${thread.id}: ${outcome.error}`);
      const after = this.store.getThread(app, thread.id)!;
      return outcome.ok ? { ok: true, user, assistant, thread: after, call } : { ok: false, error: outcome.error, user, assistant, thread: after, call };
    } finally {
      this.running.delete(thread.id);
    }
  }
}

/** A thread's title from its first message: the first line without Markdown marks, cut short. */
export function titleOf(message: string): string {
  const line = message.trim().split("\n")[0] ?? "";
  return line.replace(/^[#>\s-]+/, "").replace(/[*_`]/g, "").trim().slice(0, MAX_TITLE_CHARS);
}

/** Which attachments travel this turn: the new message's, then the newest earlier ones, within the caps. */
export function pickFiles(all: Attachment[], messageId: number): Attachment[] {
  const bound = all.filter((a) => a.messageId !== undefined && a.path);
  const current = bound.filter((a) => a.messageId === messageId);
  const earlier = bound.filter((a) => a.messageId !== messageId).sort((x, y) => y.id - x.id);
  const out: Attachment[] = [];
  let bytes = 0;
  for (const a of [...current, ...earlier]) {
    if (out.length >= MAX_FILES_PER_TURN || bytes + a.size > MAX_FILES_BYTES_PER_TURN) break;
    out.push(a);
    bytes += a.size;
  }
  return out;
}
