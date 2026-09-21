/**
 * Data model of the chat service: a thread is one conversation an app keeps
 * under a scope of its own choosing (`note:12`, `calendar`); a message is
 * one side of one turn; an attachment is an image the person put into a
 * message. The model call behind an answer is a ledger row (`docs/model.md`),
 * referenced by id rather than copied.
 */

export const SCOPE_PATTERN = /^[a-z0-9][a-z0-9:._/-]{0,127}$/i;

/** Image types the runtime's Read tool can look at; anything else is refused at upload. */
export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_PER_THREAD = 24;
/** Files shipped to the runtime on one turn: the current message's, then the newest earlier ones. Every shipped image is read again each turn; this bounds the cost. */
export const MAX_FILES_PER_TURN = 8;
export const MAX_FILES_BYTES_PER_TURN = 20 * 1024 * 1024;
/** An attachment uploaded but never sent is removed after this long. */
export const ORPHAN_TTL_MS = 60 * 60_000;

export const MAX_MESSAGE_CHARS = 40_000;
export const MAX_CONTEXT_CHARS = 500_000;
export const MAX_ACK_CHARS = 2_000;
export const MAX_TITLE_CHARS = 80;
/** Messages replayed on a turn before the character budget trims further. */
export const HISTORY_WINDOW = 40;
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MAX_OUTPUT_TOKENS = 8_000;
/** Tools a page may ask for: a browser reaches the turn route through its app's proxy, so nothing that touches the machine. */
export const CHAT_TOOLS = new Set(["Read", "WebSearch", "WebFetch"]);

export type Role = "user" | "assistant";

export type Thread = {
  id: number;
  app: string;
  scope: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type Message = {
  id: number;
  threadId: number;
  role: Role;
  content: string;
  error?: string;
  /** The ledger row of the call that produced an answer. */
  callId?: number;
  createdAt: number;
};

export type Attachment = {
  id: number;
  app: string;
  threadId: number;
  /** Set once the message carrying it is stored. */
  messageId?: number;
  /** The person's file name, for display. */
  name: string;
  type: string;
  size: number;
  /** Where the bytes are on this machine. */
  path: string;
  createdAt: number;
};

/** What a turn asks for, after validation. */
export type TurnInput = {
  message: string;
  context?: { system?: string; text?: string; ack?: string };
  attachments: number[];
  model?: string;
  tools: string[];
  thinking?: number;
  timeoutMs: number;
};
