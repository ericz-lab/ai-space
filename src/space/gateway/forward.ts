import type { Usage } from "../runtimes/types.ts";
import type { GatewayAuth } from "./types.ts";

/**
 * The passthrough itself: which headers go to the provider and come back, the provider's key in
 * place of the caller's token, and the answer's token counts read on the side while its bytes go
 * back to the caller unchanged (an SSE stream chunk by chunk).
 */

/** Never passed on: the caller's own credentials, the connection's, and what a proxy in front added. */
const DROP_REQUEST = new Set([
  "host", "authorization", "x-api-key", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "upgrade",
  "accept-encoding", "cookie", "origin", "referer", "forwarded", "proxy-authorization", "proxy-connection", "x-real-ip",
]);

/** The caller's headers as the provider gets them, with the provider's key. `anthropic-version` and `anthropic-beta` go on verbatim. */
export function upstreamHeaders(incoming: Headers, key: { apiKey?: string; auth: GatewayAuth }, opts: { dropContentType?: boolean } = {}): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    const n = name.toLowerCase();
    if (DROP_REQUEST.has(n) || n.startsWith("x-forwarded-") || n.startsWith("cf-") || n.startsWith("sec-")) continue;
    if (opts.dropContentType && n === "content-type") continue;
    out.set(name, value);
  }
  if (key.apiKey) {
    if (key.auth === "x-api-key") out.set("x-api-key", key.apiKey);
    else out.set("authorization", `Bearer ${key.apiKey}`);
  }
  return out;
}

const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

/** The provider's headers as the caller gets them: the body is re-framed here (and fetch already decoded it). */
export function downstreamHeaders(upstream: Headers, served: string): Headers {
  const out = new Headers();
  for (const [name, value] of upstream) if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  out.set("x-space-gateway-served", served);
  return out;
}

type RawUsage = {
  input_tokens?: unknown; output_tokens?: unknown; cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown;
  prompt_tokens?: unknown; completion_tokens?: unknown;
};

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** An answer's `usage` in either protocol's names (Anthropic's, OpenAI's), or undefined. */
export function readUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as RawUsage;
  const known = ["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].some((k) => k in u);
  if (!known) return undefined;
  return {
    inputTokens: n(u.input_tokens) || n(u.prompt_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    outputTokens: n(u.output_tokens) || n(u.completion_tokens),
  };
}

/**
 * A Messages SSE stream passed through unchanged, its usage read on the side: `message_start`
 * carries the input counts (and a first output count), each `message_delta` the output count so
 * far, and some providers send input counts there too. `onEnd` runs once, when the stream ends or
 * the caller goes away, with what was seen.
 */
export function tapMessagesStream(body: ReadableStream<Uint8Array>, onEnd: (usage: Usage | undefined) => void): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  let usage: Usage | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    onEnd(usage);
  };
  const read = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data.startsWith("{")) return;
    let ev: { type?: string; message?: { usage?: unknown }; usage?: unknown };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const raw = ev.type === "message_start" ? ev.message?.usage : ev.type === "message_delta" ? ev.usage : undefined;
    const u = readUsage(raw);
    if (!u) return;
    // Counts in a later event replace the earlier ones (they are cumulative); a zero is "not said".
    usage = usage
      ? { inputTokens: u.inputTokens || usage.inputTokens, cacheWriteTokens: u.cacheWriteTokens || usage.cacheWriteTokens, cacheReadTokens: u.cacheReadTokens || usage.cacheReadTokens, outputTokens: u.outputTokens || usage.outputTokens }
      : u;
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          pending += decoder.decode();
          if (pending) read(pending.trimEnd());
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
        pending += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = pending.indexOf("\n")) >= 0) {
          read(pending.slice(0, i).replace(/\r$/, ""));
          pending = pending.slice(i + 1);
        }
      } catch (e) {
        finish();
        controller.error(e);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

/** The provider's own words on a refusal: `error.message` in either protocol's shape, else the start of the body. */
export function errorText(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes.slice(0, 4096));
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof j.error === "string") return j.error;
    if (typeof j.error?.message === "string") return j.error.message;
    if (typeof j.message === "string") return j.message;
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 300) || "request failed";
}

/** Whether a Messages request carries a thinking block a provider signed, which another provider would refuse. */
export function carriesThinking(body: unknown): boolean {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => {
    const content = (m as { content?: unknown } | null)?.content;
    return Array.isArray(content) && content.some((c) => {
      const t = (c as { type?: unknown } | null)?.type;
      return t === "thinking" || t === "redacted_thinking";
    });
  });
}
