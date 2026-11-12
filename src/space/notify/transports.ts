import { createHmac } from "node:crypto";
import { DINGTALK_MARKDOWN, DISCORD_MARKDOWN, HTML, PLAIN, SLACK_MRKDWN, escapeHtml, renderFields, renderText, splitParts, splitText, truncate } from "./render.ts";
import type { Channel, Level, Notification } from "./types.ts";

/**
 * Transports: one function per channel kind that turns a notification into
 * provider requests and interprets the answers. All of them go through the
 * injected `fetch` so tests can stub the network.
 *
 * Errors are classified: `retryAfterMs` set means the provider asked us to
 * wait (429 and provider-specific rate-limit codes); `final` means retrying
 * cannot help (4xx, a rejected payload). Anything else is a transient error
 * the engine retries a few times.
 *
 * A message can take several requests (split parts, several chats, a photo
 * then text). Each one that went through is recorded in the delivery's
 * `progress`, which the engine keeps across its retries, so a retry sends only
 * what has not arrived yet.
 */

export type Fetch = typeof fetch;

export type Outgoing = {
  channel: Channel;
  notification: Notification;
  appTitle: string;
  /** Image bytes when the app uploaded them; the engine reads them from disk. */
  image?: { bytes: Uint8Array; type: string };
  /** What earlier tries of this delivery already sent; the engine passes the same object to each retry. */
  progress?: Progress;
};

export type SendResult = { providerId?: string; /** Set when the image could not be sent and text went out instead. */ degraded?: string };

/** The requests of one delivery that went through, by step, with what they reported. */
export type Progress = { done: Map<string, string>; providerId?: string; degraded?: string };

export function newProgress(): Progress {
  return { done: new Map() };
}

/** Run one request of a delivery unless an earlier try already did; returns what it recorded. */
async function once(p: Progress, step: string, send: () => Promise<string | void>): Promise<string> {
  const before = p.done.get(step);
  if (before !== undefined) return before;
  const outcome = (await send()) ?? "sent";
  p.done.set(step, outcome);
  return outcome;
}

function resultOf(p: Progress, extra: SendResult = {}): SendResult {
  const degraded = p.degraded ?? extra.degraded;
  return { ...(p.providerId ? { providerId: p.providerId } : {}), ...(degraded ? { degraded } : {}) };
}

export class TransportError extends Error {
  readonly retryAfterMs?: number;
  readonly final: boolean;
  constructor(message: string, opts: { retryAfterMs?: number; final?: boolean } = {}) {
    super(message);
    this.retryAfterMs = opts.retryAfterMs;
    this.final = opts.final ?? false;
  }
}

const TEXT_TIMEOUT_MS = 10_000;
const PHOTO_TIMEOUT_MS = 20_000;
const TELEGRAM_CAPTION_MAX = 1024;
const WECOM_IMAGE_MAX = 2 * 1024 * 1024;

export type Transport = (out: Outgoing, fetch: Fetch, log: (m: string) => void) => Promise<SendResult>;

export const TRANSPORTS: Record<Channel["kind"], Transport> = {
  telegram: sendTelegram,
  discord: sendDiscord,
  slack: sendSlack,
  feishu: sendFeishu,
  dingtalk: sendDingtalk,
  wecom: sendWecom,
  bark: sendBark,
  ntfy: sendNtfy,
  webhook: sendWebhook,
  stdout: sendStdout,
};

// ---------------------------------------------------------------- telegram

/** Plain text as an HTML caption of at most `max` characters once escaped: the headline is sent with `parse_mode: HTML`. */
export function htmlCaption(plain: string, max: number): string {
  let cut = truncate(plain, max);
  while (escapeHtml(cut).length > max) cut = truncate(cut, cut.length - (escapeHtml(cut).length - max));
  return escapeHtml(cut);
}

async function sendTelegram(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const t = out.channel.telegram!;
  const text = renderText(out.notification, out.appTitle, HTML);
  const parts = splitText(text, out.channel.limits);
  const api = (method: string) => `https://api.telegram.org/bot${t.token}/${method}`;
  const p = out.progress ?? newProgress();

  for (const chatId of t.chatIds) {
    const common = { chat_id: chatId, parse_mode: "HTML", ...(t.thread ? { message_thread_id: Number(t.thread) } : {}) };
    let textParts = parts;
    const image = out.image ?? (out.notification.imageUrl ? { url: out.notification.imageUrl } : undefined);
    if (image) {
      const caption = parts.length === 1 && text.length <= TELEGRAM_CAPTION_MAX ? text : htmlCaption(splitParts(out.notification, out.appTitle).headline, TELEGRAM_CAPTION_MAX);
      const photo = await once(p, `photo:${chatId}`, async () => {
        const form = new FormData();
        for (const [k, v] of Object.entries(common)) form.set(k, String(v));
        form.set("caption", caption);
        if ("bytes" in image) form.set("photo", new Blob([image.bytes as Uint8Array<ArrayBuffer>], { type: image.type }), `photo.${ext(image.type)}`);
        else form.set("photo", image.url);
        try {
          const body = await telegramCall(fetch, api("sendPhoto"), form, PHOTO_TIMEOUT_MS);
          p.providerId ||= String(body.result?.message_id ?? "");
          return "sent";
        } catch (e) {
          if (e instanceof TransportError && e.retryAfterMs !== undefined) throw e;
          p.degraded = `image dropped: ${(e as Error).message}`;
          return "dropped";
        }
      });
      if (photo === "sent" && caption === text) textParts = [];
    }
    for (const [i, part] of textParts.entries()) {
      await once(p, `text:${chatId}:${i}`, async () => {
        const body = await telegramCall(fetch, api("sendMessage"), JSON.stringify({ ...common, text: part, disable_web_page_preview: true }), TEXT_TIMEOUT_MS);
        p.providerId ||= String(body.result?.message_id ?? "");
      });
    }
  }
  return resultOf(p);
}

type TelegramBody = { ok?: boolean; description?: string; parameters?: { retry_after?: number }; result?: { message_id?: number } };

async function telegramCall(fetch: Fetch, url: string, body: FormData | string, timeoutMs: number): Promise<TelegramBody> {
  const res = await post(fetch, url, body, timeoutMs, typeof body === "string" ? { "content-type": "application/json" } : {});
  const parsed = (await res.json().catch(() => ({}))) as TelegramBody;
  if (res.status === 429) {
    throw new TransportError(`telegram: 429 ${parsed.description ?? ""}`.trim(), { retryAfterMs: (parsed.parameters?.retry_after ?? 1) * 1000 });
  }
  if (!res.ok || parsed.ok === false) {
    throw new TransportError(`telegram: ${res.status} ${parsed.description ?? ""}`.trim(), { final: res.status >= 400 && res.status < 500 });
  }
  return parsed;
}

// ---------------------------------------------------------------- discord

async function sendDiscord(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const url = `${out.channel.discord!.webhook}?wait=true`;
  const parts = splitText(renderText(out.notification, out.appTitle, DISCORD_MARKDOWN), out.channel.limits);
  const p = out.progress ?? newProgress();
  for (const [i, part] of parts.entries()) await once(p, `part:${i}`, async () => {
    let res: Response;
    if (i === 0 && out.image) {
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ content: part }));
      form.set("files[0]", new Blob([out.image.bytes as Uint8Array<ArrayBuffer>], { type: out.image.type }), `image.${ext(out.image.type)}`);
      res = await post(fetch, url, form, PHOTO_TIMEOUT_MS);
      if (!res.ok && res.status !== 429) {
        p.degraded = `image dropped: discord ${res.status} ${await res.text().catch(() => "")}`.trim();
        res = await post(fetch, url, JSON.stringify({ content: part }), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
      }
    } else {
      const content = i === 0 && out.notification.imageUrl ? `${part}\n${out.notification.imageUrl}` : part;
      res = await post(fetch, url, JSON.stringify({ content }), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      throw new TransportError("discord: 429", { retryAfterMs: Math.ceil((body.retry_after ?? 1) * 1000) });
    }
    if (!res.ok) throw new TransportError(`discord: ${res.status} ${await res.text().catch(() => "")}`.trim(), { final: res.status < 500 });
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    p.providerId ||= body.id;
  });
  return resultOf(p);
}

// ---------------------------------------------------------------- slack

async function sendSlack(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const p = splitParts(out.notification, out.appTitle);
  const lines = [SLACK_MRKDWN.bold(SLACK_MRKDWN.escape(p.headline))];
  if (p.body) lines.push(SLACK_MRKDWN.escape(p.body));
  if (p.url) lines.push(`<${p.url}|${SLACK_MRKDWN.escape(p.url)}>`);
  if (out.notification.imageUrl) lines.push(out.notification.imageUrl);
  const progress = out.progress ?? newProgress();
  for (const [i, part] of splitText(lines.join("\n"), out.channel.limits).entries()) {
    await once(progress, `part:${i}`, async () => {
      const res = await post(fetch, out.channel.slack!.webhook, JSON.stringify({ text: part }), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
      await expectOk(res, "slack");
    });
  }
  return imageNote(out);
}

// ---------------------------------------------------------------- feishu

async function sendFeishu(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const f = out.channel.feishu!;
  const text = withImageLink(renderText(out.notification, out.appTitle, PLAIN), out);
  const p = out.progress ?? newProgress();
  for (const [i, part] of splitText(text, out.channel.limits).entries()) await once(p, `part:${i}`, async () => {
    const payload: Record<string, unknown> = { msg_type: "text", content: { text: part } };
    if (f.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = createHmac("sha256", `${timestamp}\n${f.secret}`).update("").digest("base64");
    }
    const res = await post(fetch, f.webhook, JSON.stringify(payload), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
    const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; StatusCode?: number };
    if (!res.ok) throw new TransportError(`feishu: ${res.status}`, { final: res.status < 500 && res.status !== 429, ...(res.status === 429 ? { retryAfterMs: 1000 } : {}) });
    const code = body.code ?? body.StatusCode ?? 0;
    if (code !== 0) throw new TransportError(`feishu: ${code} ${body.msg ?? ""}`.trim(), code === 11232 ? { retryAfterMs: 1000 } : { final: true });
  });
  return imageNote(out);
}

// ---------------------------------------------------------------- dingtalk

async function sendDingtalk(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const d = out.channel.dingtalk!;
  const p = splitParts(out.notification, out.appTitle);
  const lines = [`**${DINGTALK_MARKDOWN.escape(p.headline)}**`];
  if (p.body) lines.push("", DINGTALK_MARKDOWN.escape(p.body).replace(/\n/g, "  \n"));
  if (p.url) lines.push("", p.url);
  if (out.notification.imageUrl) lines.push("", `![](${out.notification.imageUrl})`);
  const progress = out.progress ?? newProgress();
  for (const [i, part] of splitText(lines.join("\n"), out.channel.limits).entries()) await once(progress, `part:${i}`, async () => {
    let url = d.webhook;
    if (d.secret) {
      const timestamp = Date.now();
      const sign = createHmac("sha256", d.secret).update(`${timestamp}\n${d.secret}`).digest("base64");
      url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
    }
    const res = await post(fetch, url, JSON.stringify({ msgtype: "markdown", markdown: { title: p.headline, text: part } }), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok) throw new TransportError(`dingtalk: ${res.status}`, { final: res.status < 500 && res.status !== 429, ...(res.status === 429 ? { retryAfterMs: 60_000 } : {}) });
    if (body.errcode) throw new TransportError(`dingtalk: ${body.errcode} ${body.errmsg ?? ""}`.trim(), body.errcode === 130101 ? { retryAfterMs: 60_000 } : { final: true });
  });
  return imageNote(out);
}

// ---------------------------------------------------------------- wecom

async function sendWecom(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const w = out.channel.wecom!;
  const text = out.notification.imageUrl ? withImageLink(renderText(out.notification, out.appTitle, PLAIN), out) : renderText(out.notification, out.appTitle, PLAIN);
  const call = async (payload: unknown) => {
    const res = await post(fetch, w.webhook, JSON.stringify(payload), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok) throw new TransportError(`wecom: ${res.status}`, { final: res.status < 500 && res.status !== 429, ...(res.status === 429 ? { retryAfterMs: 60_000 } : {}) });
    if (body.errcode) throw new TransportError(`wecom: ${body.errcode} ${body.errmsg ?? ""}`.trim(), body.errcode === 45009 ? { retryAfterMs: 60_000 } : { final: true });
  };
  const p = out.progress ?? newProgress();
  for (const [i, part] of splitText(text, out.channel.limits).entries()) await once(p, `part:${i}`, () => call({ msgtype: "text", text: { content: part } }));
  const image = out.image;
  if (image) {
    if (image.bytes.byteLength > WECOM_IMAGE_MAX) {
      p.degraded = "image dropped: wecom accepts at most 2 MB";
    } else {
      const base64 = Buffer.from(image.bytes).toString("base64");
      const md5 = new Bun.CryptoHasher("md5").update(image.bytes).digest("hex");
      await once(p, "image", async () => {
        try {
          await call({ msgtype: "image", image: { base64, md5 } });
        } catch (e) {
          if (e instanceof TransportError && e.retryAfterMs !== undefined) throw e;
          p.degraded = `image dropped: ${(e as Error).message}`;
          return "dropped";
        }
      });
    }
  }
  return resultOf(p);
}

// ---------------------------------------------------------------- bark / ntfy

const BARK_LEVEL: Record<Level, string> = { alert: "timeSensitive", warn: "active", info: "active", success: "active", report: "passive" };
const NTFY_PRIORITY: Record<Level, number> = { alert: 5, warn: 4, info: 3, success: 3, report: 2 };

async function sendBark(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const b = out.channel.bark!;
  const f = renderFields(out.notification, out.appTitle);
  const p = out.progress ?? newProgress();
  for (const [i, part] of splitText(f.body, out.channel.limits).entries()) await once(p, `part:${i}`, async () => {
    const payload = {
      device_key: b.deviceKey,
      title: f.title,
      body: part,
      level: BARK_LEVEL[out.notification.level],
      ...(f.url ? { url: f.url } : {}),
      ...(out.notification.imageUrl ? { icon: out.notification.imageUrl } : {}),
    };
    const res = await post(fetch, `${b.base}/push`, JSON.stringify(payload), TEXT_TIMEOUT_MS, { "content-type": "application/json" });
    await expectOk(res, "bark");
  });
  return imageNote(out);
}

async function sendNtfy(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const n = out.channel.ntfy!;
  const f = renderFields(out.notification, out.appTitle);
  const p = out.progress ?? newProgress();
  for (const [i, part] of splitText(f.body, out.channel.limits).entries()) await once(p, `part:${i}`, async () => {
    const payload = {
      topic: n.topic,
      title: f.title,
      message: part,
      priority: NTFY_PRIORITY[out.notification.level],
      ...(f.url ? { click: f.url } : {}),
      ...(out.notification.imageUrl ? { attach: out.notification.imageUrl } : {}),
    };
    const res = await post(fetch, n.base, JSON.stringify(payload), TEXT_TIMEOUT_MS, {
      "content-type": "application/json",
      ...(n.token ? { authorization: `Bearer ${n.token}` } : {}),
    });
    await expectOk(res, "ntfy");
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    p.providerId ||= body.id;
  });
  return resultOf(p, imageNote(out));
}

// ---------------------------------------------------------------- webhook / stdout

async function sendWebhook(out: Outgoing, fetch: Fetch): Promise<SendResult> {
  const w = out.channel.webhook!;
  const n = out.notification;
  const payload = {
    id: n.id,
    app: n.app,
    appTitle: out.appTitle,
    level: n.level,
    title: n.title,
    text: n.text,
    url: n.url,
    imageUrl: n.imageUrl,
    key: n.key,
    createdAt: new Date(n.createdAt).toISOString(),
    rendered: renderText(n, out.appTitle, PLAIN),
  };
  const res = await post(fetch, w.endpoint, JSON.stringify(payload), TEXT_TIMEOUT_MS, {
    "content-type": "application/json",
    ...(w.token ? { authorization: `Bearer ${w.token}` } : {}),
  });
  await expectOk(res, "webhook");
  return imageNote(out);
}

async function sendStdout(out: Outgoing, _fetch: Fetch, log: (m: string) => void): Promise<SendResult> {
  log(renderText(out.notification, out.appTitle, PLAIN));
  return {};
}

// ---------------------------------------------------------------- helpers

async function post(fetch: Fetch, url: string, body: string | FormData, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(url, { method: "POST", body, headers: { "user-agent": "ai-space-notify/1", ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new TransportError(`network: ${(e as Error).message ?? String(e)}`);
  }
}

async function expectOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const text = truncate((await res.text().catch(() => "")).trim(), 300);
  if (res.status === 429) throw new TransportError(`${what}: 429 ${text}`.trim(), { retryAfterMs: retryAfterHeader(res) });
  throw new TransportError(`${what}: ${res.status} ${text}`.trim(), { final: res.status < 500 });
}

function retryAfterHeader(res: Response): number {
  const v = Number(res.headers.get("retry-after") ?? "1");
  return Number.isFinite(v) && v > 0 ? v * 1000 : 1000;
}

/** Channels that cannot upload bytes: report the dropped upload; a remote url was already rendered as a link. */
function imageNote(out: Outgoing): SendResult {
  return out.image ? { degraded: `image dropped: ${out.channel.kind} takes image links only` } : {};
}

function withImageLink(text: string, out: Outgoing): string {
  return out.notification.imageUrl ? `${text}\n${out.notification.imageUrl}` : text;
}

function ext(type: string): string {
  return type === "image/jpeg" ? "jpg" : type === "image/gif" ? "gif" : type === "image/webp" ? "webp" : "png";
}
