import { MAX_SORT_PROMPT, MAX_TITLE, type Topic } from "./types.ts";

/**
 * Which topic an order belongs to (docs/orders.md#topics): one plain model call that answers
 * `{"continue": <topic id>}` or `{"new": "<title>"}`. Anything else (a failed call, a timeout,
 * unusable output, an id that was not offered) opens a new topic titled from the order's first
 * words: no order is lost.
 */

export type Candidate = Pick<Topic, "id" | "title" | "lastActiveAt"> & {
  /** The topic waits for the person's answer. */
  waiting: boolean;
  /** Its last three orders, oldest first. */
  orders: string[];
  /** Its last three messages, oldest first (`person:` or `director:`). */
  messages: string[];
};

export type Decision = { kind: "continue"; topicId: number } | { kind: "new"; title: string };

export const SORT_SYSTEM = [
  "You sort a person's orders into topics. Each topic is one ongoing matter with its own conversation.",
  "Answer with exactly one line of JSON and nothing else: {\"continue\": <topic id>} or {\"new\": \"<short title>\"}.",
  "Rules:",
  "- Continue a topic only when the order is clearly the same matter: a follow-up, a correction, or an answer to what was asked there.",
  "- When unsure, it is a new topic.",
  "- A short answer-like order (yes, no, ok, the second one, go ahead, 好的, 可以, 不用了) goes to the topic that is waiting for the person; when several wait, the most recently active of them.",
  "- A new topic's title names the matter in at most 8 words, in the language of the order.",
].join("\n");

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The call's prompt: the order, then each candidate, cut to fit about MAX_SORT_PROMPT characters. */
export function sortPrompt(order: { text: string; image: boolean }, candidates: Candidate[], now = Date.now()): string {
  const head = ["The new order:", clip(order.text, 1500)];
  if (order.image) head.push("(It came with a screenshot of the person's screen.)");
  head.push("", candidates.length ? "Open topics, most recently active first:" : "There are no open topics.");
  const ago = (t: number) => {
    const min = Math.max(0, Math.round((now - t) / 60_000));
    return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
  };
  const firsts = candidates.map((c) => `Topic ${c.id}: ${clip(c.title, MAX_TITLE)} (last active ${ago(c.lastActiveAt)}${c.waiting ? ", WAITING for the person's answer" : ""})`);
  // Every offered topic's own line first; its orders and messages as far as the rest goes, newest topics first.
  let budget = MAX_SORT_PROMPT - head.join("\n").length - 60 - firsts.reduce((n, l) => n + l.length + 1, 0);
  const blocks = candidates.map((c, i) => {
    const detail = [...c.orders.slice(-3).map((o) => `  order: ${clip(o, 240)}`), ...c.messages.slice(-3).map((m) => `  ${clip(m, 240)}`)];
    const fit: string[] = [];
    for (const line of detail) {
      if (line.length + 1 > budget) break;
      fit.push(line);
      budget -= line.length + 1;
    }
    return [firsts[i]!, ...fit].join("\n");
  });
  return [...head, ...blocks, "", "Answer with one line of JSON."].join("\n");
}

/** The model's answer as a decision, or undefined when it is unusable or names a topic that was not offered. */
export function parseDecision(answer: string, offered: number[]): Decision | undefined {
  const m = /\{[^{}]*\}/.exec(answer);
  if (!m) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if ("continue" in o) {
    const id = Number(o.continue);
    return Number.isInteger(id) && offered.includes(id) ? { kind: "continue", topicId: id } : undefined;
  }
  if (typeof o.new === "string") {
    const title = clip(o.new, MAX_TITLE);
    return title ? { kind: "new", title } : undefined;
  }
  return undefined;
}

/** A new topic's title from the order's first words, when the model gave none. */
export function fallbackTitle(text: string): string {
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return clip(first, 40) || "Order";
}
