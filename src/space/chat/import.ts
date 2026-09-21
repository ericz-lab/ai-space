import { APP_PATTERN } from "../model/types.ts";
import { parseScope } from "./spec.ts";
import type { ChatStore } from "./store.ts";
import { MAX_MESSAGE_CHARS, MAX_TITLE_CHARS, type Role } from "./types.ts";

/**
 * Import of an app's own conversations, for apps that kept a chat table
 * before the chat service existed. One JSON object per line is one thread:
 *
 *   { "scope": "note:12", "title": "…", "createdAt": ISO, "updatedAt": ISO,
 *     "messages": [{ "role": "user"|"assistant", "content": "…", "error"?: "…", "createdAt": ISO }] }
 *
 * A thread already present (same app, scope and creation time) is skipped,
 * so the command can be run again after an app exported more.
 */

export type ImportThread = {
  scope: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  messages: { role: Role; content: string; error?: string; createdAt: string }[];
};

export type ImportSummary = { read: number; imported: number; skipped: number; messages: number };

const time = (raw: unknown, what: string): number => {
  const t = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t)) throw new Error(`${what} must be an ISO time`);
  return t;
};

export function parseImportLine(raw: unknown, lineNo: number): ImportThread {
  const at = `line ${lineNo}`;
  if (!raw || typeof raw !== "object") throw new Error(`${at}: not an object`);
  const o = raw as Record<string, unknown>;
  const scope = parseScope(o.scope);
  const createdAt = time(o.createdAt, `${at}: createdAt`);
  if (!Array.isArray(o.messages)) throw new Error(`${at}: messages must be an array`);
  const messages = (o.messages as unknown[]).map((m, i) => {
    if (!m || typeof m !== "object") throw new Error(`${at}: message ${i} is not an object`);
    const x = m as Record<string, unknown>;
    if (x.role !== "user" && x.role !== "assistant") throw new Error(`${at}: message ${i}: role must be user or assistant`);
    if (typeof x.content !== "string") throw new Error(`${at}: message ${i}: content must be a string`);
    if (x.error !== undefined && typeof x.error !== "string") throw new Error(`${at}: message ${i}: error must be a string`);
    return { role: x.role as Role, content: x.content.slice(0, MAX_MESSAGE_CHARS), ...(x.error ? { error: x.error.slice(0, 500) } : {}), createdAt: new Date(time(x.createdAt, `${at}: message ${i}: createdAt`)).toISOString() };
  });
  return {
    scope, createdAt: new Date(createdAt).toISOString(), messages,
    ...(typeof o.title === "string" ? { title: o.title.trim().slice(0, MAX_TITLE_CHARS) } : {}),
    ...(o.updatedAt !== undefined ? { updatedAt: new Date(time(o.updatedAt, `${at}: updatedAt`)).toISOString() } : {}),
  };
}

export function importThreads(store: ChatStore, app: string, text: string): ImportSummary {
  if (!APP_PATTERN.test(app)) throw new Error(`not an app name: ${app}`);
  const lines = text.split("\n").map((l, i) => [l.trim(), i + 1] as const).filter(([l]) => l);
  const threads = lines.map(([l, n]) => {
    let raw: unknown;
    try {
      raw = JSON.parse(l);
    } catch {
      throw new Error(`line ${n}: not JSON`);
    }
    return parseImportLine(raw, n);
  });
  const summary: ImportSummary = { read: threads.length, imported: 0, skipped: 0, messages: 0 };
  store.db.transaction(() => {
    for (const t of threads) {
      const createdAt = Date.parse(t.createdAt);
      if (store.findThread(app, t.scope, createdAt)) {
        summary.skipped++;
        continue;
      }
      const thread = store.createThread(app, t.scope, t.title ?? "", createdAt);
      for (const m of t.messages) {
        store.addMessage(thread.id, { role: m.role, content: m.content, ...(m.error ? { error: m.error } : {}) }, Date.parse(m.createdAt));
        summary.messages++;
      }
      store.touchThread(thread.id, t.updatedAt ? Date.parse(t.updatedAt) : createdAt);
      summary.imported++;
    }
  })();
  return summary;
}
