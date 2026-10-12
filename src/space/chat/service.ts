import { mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ModelSource, ResolvedModel } from "../model/app-models.ts";
import { sniffImage } from "../model/images.ts";
import type { ModelService } from "../model/service.ts";
import { DEFAULT_SYSTEM, MODEL_PATTERN, type ModelCall } from "../model/types.ts";
import type { ModelTier } from "../runtimes/types.ts";
import type { CompleteFile, OnDelta } from "../runtimes/types.ts";
import { buildPrompt } from "./prompt.ts";
import type { ChatStore } from "./store.ts";
import {
  IMAGE_TYPES, INTERRUPTED, MAX_ATTACHMENTS_PER_THREAD, MAX_ATTACHMENT_BYTES, MAX_FILES_BYTES_PER_TURN, MAX_FILES_PER_TURN, MAX_OUTPUT_TOKENS, MAX_TITLE_CHARS, ORPHAN_TTL_MS,
  PARTIAL_SAVE_MS, STOPPED,
  type Attachment, type Message, type Thread, type TurnInput, type TurnRecord, type TurnStatus,
} from "./types.ts";

/**
 * The service: one turn = store the person's message, replay the thread into
 * one prompt, run it through the model service (so the ledger sees it, tagged
 * `chat`), store the answer. A turn that fails is stored too, with whatever
 * text arrived and the reason, and is left out of later replays. One turn at
 * a time per thread. Attachments are images on disk under the app's data
 * directory; a turn ships the current message's plus the newest earlier ones
 * up to a cap, since the runtime reads every shipped image again.
 *
 * A turn runs in the background of whoever asked for it: `begin` starts it
 * and returns at once, any number of callers follow it with `subscribe`, and
 * it ends by finishing, by its timeout or by `stop`. Each turn has a row in
 * `chat_turns`, so a second request with the same `requestId` finds the first
 * one instead of running again, and a turn the process did not live to finish
 * is closed as interrupted on the next boot (`settleInterrupted`).
 */

export type ChatServiceOptions = {
  store: ChatStore;
  model: ModelService;
  /** Directory for an app's attachment files (`<workspace>/data/<app>/chat`). */
  fileDir: (app: string) => string;
  /** Model when a turn names none: a fixed name, or the app's layers for the `chat` tag (app-models.ts). */
  defaultModel: string | ((app: string, tag: string) => string | ResolvedModel);
  log?: (message: string) => void;
  now?: () => number;
};

/** One entry of the widget's model picker: a runtime's capability tier and the concrete model it maps to. */
export type ModelOption = { value: string; runtime: string; tier: ModelTier; model: string };

/**
 * The model a turn runs on and why: the person's pick in the widget, the
 * model the app asked for (`context().model` or the mount option), or the
 * space's app default. `runtime`/`model` are the resolved names, absent when
 * the value does not resolve (the turn then fails with the reason).
 */
export type EffectiveModel = { value: string; source: "choice" | "app" | "default"; runtime?: string; model?: string; /** What the ledger records as `modelSource`. */ ledgerSource: ModelSource };

export type TurnResult = { ok: boolean; error?: string; user: Message; assistant: Message; thread: Thread; call?: ModelCall };

/** What a follower of a turn receives: the text as it is produced, then how it ended. `lost` means the answer could not be stored. */
export type TurnEvent = { type: "delta"; text: string } | { type: "end"; result: TurnResult } | { type: "lost"; error: string };

/** A turn as `begin` hands it back. `started` is false when the request id named a turn that already existed. */
export type TurnHandle = { record: TurnRecord; user: Message; started: boolean; done: Promise<TurnResult> };

/** A turn in flight: what followers need to read it and what a stop needs to end it. */
type Live = {
  record: TurnRecord;
  text: string;
  listeners: Set<(e: TurnEvent) => void>;
  aborter: AbortController;
  /** Set by an explicit stop, so the answer is stored as stopped rather than as a failure. */
  stopped: boolean;
  done: Promise<TurnResult>;
};

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

export { sniffImage };

/** The name a file has for the runtime: short, unique in the call, shell-safe. */
export const fileNameOf = (a: Attachment): string => `a${a.id}.${IMAGE_TYPES[a.type] ?? "png"}`;

export class ChatService {
  readonly store: ChatStore;
  private readonly model: ModelService;
  private readonly fileDir: (app: string) => string;
  readonly defaultModel: ChatServiceOptions["defaultModel"];
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  /** Turns in flight, by thread. */
  private readonly live = new Map<number, Live>();

  constructor(opts: ChatServiceOptions) {
    this.store = opts.store;
    this.model = opts.model;
    this.fileDir = opts.fileDir;
    this.defaultModel = opts.defaultModel;
    this.log = opts.log ?? ((m) => console.log(`[chat] ${m}`));
    this.now = opts.now ?? Date.now;
  }

  isRunning(threadId: number): boolean {
    return this.live.has(threadId);
  }

  /** The turn a thread is answering now, with the text so far. */
  liveTurn(threadId: number): { record: TurnRecord; text: string } | undefined {
    const l = this.live.get(threadId);
    return l ? { record: l.record, text: l.text } : undefined;
  }

  /** The ledger row behind an answer, for the backend and cost a message shows. */
  callOf(id: number): ModelCall | undefined {
    return this.model.store.get(id);
  }

  // ---------------------------------------------------------------- model choice

  /** What the picker offers: every runtime/tier pair of a runtime that answers requests. */
  modelOptions(): ModelOption[] {
    return this.model.runtimes.tierOptions().filter((o) => o.capabilities.complete).map(({ value, runtime, tier, model }) => ({ value, runtime, tier, model }));
  }

  /** The space's model for an app's chat that names none: its panel override, its manifest, then Settings → default model (app-models.ts). */
  spaceDefaultModel(app: string): ResolvedModel {
    const d = typeof this.defaultModel === "function" ? this.defaultModel(app, "chat") : this.defaultModel;
    return typeof d === "string" ? { model: d, source: "default" } : d;
  }

  /** A model string's shape only (the app's own model may name a runtime this space lacks; the turn reports that). */
  checkModelShape(raw: unknown): string {
    if (typeof raw !== "string" || !MODEL_PATTERN.test(raw)) throw new Error("model must be a model alias, id or runtime/tier (letters, digits, . _ : -)");
    return raw;
  }

  /** Check a model string the way a turn would resolve it; the error names the reason (unknown runtime, tier without a model). */
  checkModel(raw: unknown): string {
    const model = this.checkModelShape(raw);
    this.model.resolve(model);
    return model;
  }

  /** Store (or with null clear) the person's model for an app's chat. */
  setModelChoice(app: string, raw: unknown): void {
    this.store.setModelChoice(app, raw === null ? null : this.checkModel(raw), this.now());
  }

  /**
   * Which model a turn of this app runs on: the person's pick > the app's
   * `model` > the space default. A stored pick that no longer resolves (its
   * runtime was removed from `runtimes.yaml`) is skipped rather than failing
   * every turn; the picker shows it as unavailable.
   */
  effectiveModel(app: string, requested?: string, opts: { ignoreChoice?: boolean } = {}): EffectiveModel {
    const choice = opts.ignoreChoice ? undefined : this.store.getModelChoice(app);
    const layered = choice !== undefined && this.resolves(choice) ? undefined : requested ? undefined : this.spaceDefaultModel(app);
    const pick: Omit<EffectiveModel, "runtime" | "model"> = layered
      ? { value: layered.model, source: "default", ledgerSource: layered.source }
      : choice !== undefined && this.resolves(choice)
        ? { value: choice, source: "choice", ledgerSource: "choice" }
        : { value: requested!, source: "app", ledgerSource: "request" };
    try {
      const r = this.model.resolve(pick.value);
      return { ...pick, runtime: r.runtime.name, model: r.model };
    } catch {
      return pick;
    }
  }

  private resolves(model: string): boolean {
    try {
      this.model.resolve(model);
      return true;
    } catch {
      return false;
    }
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

  /** Throws `Locked` while the thread is answering: the turn would write its reply into a deleted thread. */
  async deleteThread(app: string, id: number): Promise<boolean> {
    if (this.live.has(id)) throw new Locked();
    const paths = this.store.deleteThread(app, id);
    if (!paths) return false;
    await this.unlinkAll(paths);
    await rm(join(this.fileDir(app), String(id)), { recursive: true, force: true });
    return true;
  }

  /** Throws `Locked`, deleting nothing, while any thread of the scope is answering. */
  async deleteScope(app: string, scope: string): Promise<number> {
    const threads = this.store.listThreads(app, scope, 100_000);
    if (threads.some((t) => this.live.has(t.id))) throw new Locked();
    // Every row goes before the first await, so no turn can start on a thread about to be deleted.
    const removed = threads.map((t) => ({ id: t.id, paths: this.store.deleteThread(app, t.id) ?? [] }));
    let n = 0;
    for (const { id, paths } of removed) {
      n += paths.length;
      await this.unlinkAll(paths);
      await rm(join(this.fileDir(app), String(id)), { recursive: true, force: true });
    }
    return n;
  }

  private async pruneOrphans(): Promise<void> {
    await this.unlinkAll(this.store.pruneOrphans(this.now() - ORPHAN_TTL_MS));
  }

  private async unlinkAll(paths: string[]): Promise<void> {
    for (const p of paths) await unlink(p).catch(() => {});
  }

  // ---------------------------------------------------------------- turns

  /**
   * Start a turn and return at once; `done` settles when the answer is stored.
   * Throws `Locked` while the thread is answering and `Refused` for attachments
   * that are not this thread's. With a `requestId` the thread has already seen,
   * nothing is stored or run again: the handle is the earlier turn's, running
   * or finished.
   */
  begin(app: string, thread: Thread, input: TurnInput): TurnHandle {
    if (input.requestId) {
      const known = this.store.findTurn(thread.id, input.requestId);
      if (known) {
        const live = this.live.get(thread.id);
        const done = live?.record.id === known.id ? live.done : Promise.resolve().then(() => this.resultOf(app, known));
        return { record: known, user: this.store.getMessage(known.userMessageId)!, started: false, done };
      }
    }
    if (this.live.has(thread.id)) throw new Locked();
    // Everything up to the live entry is synchronous, so two requests can never both pass the check above.
    const history = this.store.listMessages(thread.id);
    const startedAt = this.now();
    const user = this.store.addMessage(thread.id, { role: "user", content: input.message }, startedAt);
    if (!this.store.bindAttachments(input.attachments, thread.id, user.id)) {
      this.store.removeMessage(user.id);
      throw new Refused(400, "attachments must be unsent uploads of this thread");
    }
    this.store.touchThread(thread.id, startedAt, thread.title ? undefined : titleOf(input.message));
    const record = this.store.addTurn({ app, threadId: thread.id, userMessageId: user.id, ...(input.requestId ? { requestId: input.requestId } : {}) }, startedAt);
    const live: Live = { record, text: "", listeners: new Set(), aborter: new AbortController(), stopped: false, done: undefined as unknown as Promise<TurnResult> };
    this.live.set(thread.id, live);
    live.done = this.run(app, thread, input, live, history, user).catch((e) => {
      // The answer could not be stored (the database went away under a shutdown): the row stays running and the next boot settles it.
      this.live.delete(thread.id);
      this.emit(live, { type: "lost", error: (e as Error).message ?? String(e) });
      throw e;
    });
    live.done.catch(() => {});
    return { record, user, started: true, done: live.done };
  }

  /**
   * Run one turn and wait for it. `signal` ends the turn like a stop does, but
   * is stored as the failure `aborted`: it is the caller's connection going
   * away, not the person asking to stop. A model failure is a result with
   * `ok: false`, stored like a success.
   */
  async turn(app: string, thread: Thread, input: TurnInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<TurnResult> {
    const h = this.begin(app, thread, input);
    const sub = onDelta ? this.subscribe(thread.id, h.record.id, (e) => e.type === "delta" && onDelta(e.text)) : undefined;
    if (sub?.text) onDelta!(sub.text);
    const onAbort = () => this.abort(thread.id, h.record.id);
    if (h.started && signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await h.done;
    } finally {
      sub?.off();
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Follow a turn in flight: the text so far, then every event until it ends. Undefined when that turn is not running. */
  subscribe(threadId: number, turnId: number, listener: (e: TurnEvent) => void): { text: string; off: () => void } | undefined {
    const live = this.live.get(threadId);
    if (!live || live.record.id !== turnId) return undefined;
    live.listeners.add(listener);
    return { text: live.text, off: () => live.listeners.delete(listener) };
  }

  /** The person's stop: the answer is stored with what arrived and marked stopped. False when the thread is not answering. */
  stop(threadId: number): boolean {
    const live = this.live.get(threadId);
    if (!live) return false;
    live.stopped = true;
    live.aborter.abort();
    return true;
  }

  /** End a turn because its caller went away (a turn posted without a request id). */
  abort(threadId: number, turnId: number): void {
    const live = this.live.get(threadId);
    if (live?.record.id === turnId) live.aborter.abort();
  }

  /** A finished turn as its result, read back from the store. */
  resultOf(app: string, record: TurnRecord): TurnResult {
    const fresh = this.store.getTurn(record.id) ?? record;
    const user = this.store.getMessage(fresh.userMessageId)!;
    // A row still running with nothing behind it was cut by a restart that has not been settled yet.
    const assistant = fresh.assistantMessageId !== undefined ? this.store.getMessage(fresh.assistantMessageId)! : this.settle(fresh);
    const thread = this.store.getThread(app, fresh.threadId)!;
    const call = assistant.callId === undefined ? undefined : this.callOf(assistant.callId);
    return { ok: assistant.error === undefined, ...(assistant.error === undefined ? {} : { error: assistant.error }), user, assistant, thread, ...(call ? { call } : {}) };
  }

  /**
   * Close the turns a restart cut: each gets an answer holding the text saved
   * so far and the reason, so the thread shows what happened and the next turn
   * replays without that pair. Called once at boot, by the process that serves
   * the API; returns how many were closed.
   */
  settleInterrupted(): number {
    let n = 0;
    for (const r of this.store.runningTurns()) {
      if (this.live.get(r.threadId)?.record.id === r.id) continue;
      this.settle(r);
      n++;
    }
    if (n) this.log(`${n} turn(s) were cut by a restart and are stored as interrupted`);
    return n;
  }

  private settle(record: TurnRecord): Message {
    const at = this.now();
    const assistant = this.store.addMessage(record.threadId, { role: "assistant", content: record.partial, error: INTERRUPTED, state: "interrupted" }, at);
    this.store.finishTurn(record.id, "interrupted", assistant.id, at);
    return assistant;
  }

  private emit(live: Live, event: TurnEvent): void {
    for (const l of [...live.listeners]) {
      try {
        l(event);
      } catch {
        /* a follower that fails does not end the turn */
      }
    }
  }

  private async run(app: string, thread: Thread, input: TurnInput, live: Live, history: Message[], user: Message): Promise<TurnResult> {
    const { record } = live;
    let call: ModelCall | undefined;
    let text: string | undefined;
    let error = "";
    try {
      await this.pruneOrphans();
      const all = this.store.listAttachments(thread.id);
      const byMessage = new Map<number, Attachment[]>();
      for (const a of all) if (a.messageId !== undefined) byMessage.set(a.messageId, [...(byMessage.get(a.messageId) ?? []), a]);
      const shipped = pickFiles(all, user.id);
      const omitted = all.filter((a) => a.messageId !== undefined).length - shipped.length;
      if (omitted > 0) this.store.setOmitted(user.id, omitted);
      const files: CompleteFile[] = shipped.map((a) => ({ name: fileNameOf(a), path: a.path }));
      const prompt = buildPrompt({
        context: input.context, history, attachments: byMessage, shipped: new Set(shipped.map((a) => a.id)), fileName: fileNameOf,
        message: input.message, messageAttachments: byMessage.get(user.id) ?? [],
      });

      // The first text is saved at once, later text at most once per interval.
      let savedAt = 0;
      const chosen = this.effectiveModel(app, input.model);
      const r = await this.model.run(
        app,
        {
          prompt, system: input.context?.system ?? DEFAULT_SYSTEM, model: chosen.value, tag: "chat", tools: input.tools,
          timeoutMs: input.timeoutMs, maxTokens: MAX_OUTPUT_TOKENS, ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(files.length ? { files } : {}),
        },
        live.aborter.signal,
        (delta) => {
          live.text += delta;
          this.emit(live, { type: "delta", text: delta });
          const now = this.now();
          if (now - savedAt >= PARTIAL_SAVE_MS) {
            savedAt = now;
            this.store.savePartial(record.id, live.text);
          }
        },
        chosen.ledgerSource,
      );
      call = r.call;
      if (r.outcome.ok) text = r.outcome.text;
      else error = r.outcome.error;
    } catch (e) {
      error = (e as Error).message ?? String(e);
    }

    const at = this.now();
    const ok = text !== undefined;
    const status: Exclude<TurnStatus, "running"> = ok ? "done" : live.stopped ? "stopped" : "failed";
    const callId = call ? { callId: call.id } : {};
    const assistant = ok
      ? this.store.addMessage(thread.id, { role: "assistant", content: text!, ...callId }, at)
      : this.store.addMessage(thread.id, { role: "assistant", content: live.text, error: (live.stopped ? STOPPED : error || "failed").slice(0, 500), ...(live.stopped ? { state: "stopped" as const } : {}), ...callId }, at);
    this.store.finishTurn(record.id, status, assistant.id, at);
    this.store.touchThread(thread.id, at);
    if (status === "failed") this.log(`${app} thread ${thread.id}: ${error}`);
    this.live.delete(thread.id);
    const result: TurnResult = {
      ok, ...(ok ? {} : { error: assistant.error! }), user: this.store.getMessage(user.id) ?? user, assistant, thread: this.store.getThread(app, thread.id)!, ...(call ? { call } : {}),
    };
    this.emit(live, { type: "end", result });
    return result;
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
