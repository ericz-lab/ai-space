import { ChatSteps, type ChatStep } from "../../../../src/web/chat-steps.ts";

/**
 * One chat turn's reply, built from the run's events the way the web panel (`src/web/Chat.tsx`,
 * `chat-steps.ts`) and the Mac's `ChatReply` read them: Claude-style stream-json, which every
 * runtime adapter emits, followed by `error` and `done`.
 */

export type { ChatStep };

/** The web panel's three write-access choices; on a live turn the first asks before an edit or a command. */
export type Permission = "" | "acceptEdits" | "bypassPermissions";
export const PERMISSIONS: Permission[] = ["", "acceptEdits", "bypassPermissions"];

/** A shell refusal needs all permissions; an edit first tries acceptEdits. */
export function granting(current: Permission, denied: string[]): Permission {
  return denied.includes("Bash") || current !== "" ? "bypassPermissions" : "acceptEdits";
}

export type ChatImage = { name: string; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };

/** Limits of src/space/agents/images.ts: four images, 5 MB each, 10 MB together. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 10 * 1024 * 1024;

/** The media type of image bytes, by their signature, or undefined for anything the Space refuses. */
export function imageType(bytes: Uint8Array): ChatImage["mediaType"] | undefined {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return undefined;
}

/** The controls captured when a turn is sent; changing them later does not change that turn. */
export type TurnRequest = { message: string; permission: Permission; images: ChatImage[] };

/** Every turn is interactive: the conversation's live process can ask for approvals and take messages while it runs. */
export function turnBody(turn: TurnRequest, sessionId?: string): Record<string, unknown> {
  return {
    message: turn.message,
    interactive: true,
    ...(turn.images.length ? { images: turn.images } : {}),
    ...(turn.permission ? { permissionMode: turn.permission } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export type Activity = { kind: "starting" } | { kind: "reconnecting" } | { kind: "thinking"; model: string } | { kind: "running"; tool: string };

type Block = { type?: string; id?: string; name?: string; text?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = Record<string, unknown> & { type?: string };

const PERMISSION_WORDS = /requires approval|permission|granted|denied/i;

export class TurnReply {
  sessionId: string | undefined;
  finishedText = "";
  streaming = "";
  tools: string[] = [];
  activity: Activity | undefined = { kind: "starting" };
  /** An error result with no text, shown in place of the reply. */
  note: string | undefined;
  /** The run's own error, apart from the reply text, so the client shows it as a failed turn. */
  failure: string | undefined;
  stopped = false;
  finished = false;
  /** Tools refused for lack of permission: Grant and retry raises the permission for them. */
  denied: string[] = [];
  /** One per `steer` event: the messages added during the turn that the agent has read. */
  consumedSteers: string[] = [];
  private readonly work = new ChatSteps();
  private readonly toolNames = new Map<string, string>();

  get steps(): ChatStep[] {
    return this.work.snapshot();
  }

  /** What the agent wrote, without any note. */
  get body(): string {
    return this.finishedText + (this.streaming ? (this.finishedText ? "\n\n" : "") + this.streaming : "");
  }

  get text(): string {
    if (this.note === undefined) return this.body;
    return this.body ? `${this.body}\n\n${this.note}` : this.note;
  }

  apply(line: string): void {
    let ev: Event;
    try {
      ev = JSON.parse(line) as Event;
    } catch {
      return;
    }
    if (typeof ev !== "object" || ev === null || typeof ev.type !== "string") return;
    // ChatSteps reads the ordered work (text, tools, approvals, steers) exactly as the web panel does.
    this.work.apply(ev as Parameters<ChatSteps["apply"]>[0]);
    const content = ((ev.message as { content?: unknown } | undefined)?.content ?? []) as Block[];
    switch (ev.type) {
      case "approval_request":
        // The turn is not running anything now; it waits for the person's answer.
        this.activity = undefined;
        break;
      case "steer":
        this.consumedSteers.push(typeof ev.text === "string" ? ev.text : "");
        break;
      case "system":
        if (ev.subtype === "init") {
          if (typeof ev.session_id === "string") this.sessionId = ev.session_id;
          this.activity = { kind: "thinking", model: typeof ev.model === "string" ? ev.model : "" };
        }
        break;
      case "stream_event": {
        const delta = (ev.event as { delta?: { type?: string; text?: string } } | undefined)?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.streaming += delta.text;
          this.activity = undefined;
        }
        break;
      }
      case "assistant": {
        const text = content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
        if (text) {
          this.finishedText += (this.finishedText ? "\n\n" : "") + text;
          this.streaming = "";
          this.activity = undefined;
        }
        for (const b of content) {
          if (b.type !== "tool_use" || !b.id || this.toolNames.has(b.id)) continue;
          const name = b.name ?? "tool";
          this.toolNames.set(b.id, name);
          this.tools.push(name);
          this.activity = { kind: "running", tool: name };
        }
        break;
      }
      case "user":
        for (const b of content) {
          if (b.type !== "tool_result") continue;
          const running = this.steps.filter((s) => s.kind === "tool" && s.state === "running").at(-1);
          this.activity = running ? { kind: "running", tool: running.name } : { kind: "thinking", model: "" };
          if (b.is_error !== true) continue;
          const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          if (!PERMISSION_WORDS.test(text)) continue;
          const tool = this.toolNames.get(b.tool_use_id ?? "") ?? "tool";
          if (!this.denied.includes(tool)) this.denied.push(tool);
        }
        break;
      case "result":
        if (typeof ev.session_id === "string") this.sessionId = ev.session_id;
        if (ev.is_error === true && !this.finishedText && !this.streaming) this.note = String(ev.result ?? ev.subtype ?? "error");
        break;
      case "error":
        if (ev.status === "stopped") this.stopped = true;
        else {
          this.failure = String(ev.error ?? "error");
          this.note = `⚠️ ${this.failure}`;
        }
        break;
      case "done":
        this.finished = true;
        this.activity = undefined;
        break;
    }
  }

  /** The turn ended: running steps are done or incomplete, unanswered approvals cancelled. */
  end(): void {
    this.work.finish();
    this.activity = undefined;
  }
}

/**
 * A failed turn in words a person can act on (the Mac's `ChatFailure`). The Space hands on what
 * the runtime said; the raw text stays as the detail.
 */
export type FailureKind = "busy" | "signed-out" | "timed-out" | "exited" | "unavailable" | "connection" | "other";
export type Failure = { kind: FailureKind; detail: string; code?: number };

export function classifyFailure(raw: string): Failure {
  const detail = raw.trim();
  const text = detail.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  if (has("429", "too many requests", "rate limit", "rate_limit", "usage limit", "quota", "overloaded", "529", "capacity")) return { kind: "busy", detail };
  if (has("not logged in", "log in", "login", "please run /login", "unauthorized", "401", "invalid api key", "authentication")) return { kind: "signed-out", detail };
  if (has("timed out", "timeout")) return { kind: "timed-out", detail };
  const exit = /exited with (-?\d+)/.exec(text);
  if (exit) return { kind: "exited", detail, code: Number(exit[1]) };
  if (has("could not run", "not found", "enoent", "no such file")) return { kind: "unavailable", detail };
  return { kind: "other", detail };
}

/** Whether sending the same message again may well work: the cause passes by itself. */
export const retryable = (f: Failure) => f.kind !== "signed-out" && f.kind !== "unavailable";

/** A question's answer (src/web/Chat.tsx `answerOf`): one choice is the typed answer or the pick; several are all picks then the typed one. */
export function questionAnswer(multiSelect: boolean, picked: string[], typed: string): string[] {
  const own = typed.trim();
  if (!multiSelect) return own ? [own] : picked.slice(0, 1);
  return [...picked, ...(own ? [own] : [])];
}
