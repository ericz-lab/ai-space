import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";
import { SpaceError, checkResponse } from "../core/check.ts";
import { type SSEMessage, SSEParser } from "../core/sse.ts";
import { origin, resolveUrl, sameOrigin } from "../core/url.ts";
import type { ChatApi } from "../core/conversation.ts";
import { bytesToText, textToBytes } from "./env.ts";

/**
 * Native calls to one Space (the Mac's `SpaceAPI`). They carry the cookies of the connection's
 * own WebKit network session, so an access layer the person signed in to on the panel page lets
 * them through; no operator token is used. A redirect is never followed: it means "sign in". A
 * write names the Space's origin, as the panel's page does, because the routes that change the
 * Space take writes from that origin only (src/space/auth.ts).
 */

const USER_AGENT = "ai-space-linux";

/** The cookies for a URL, as one `Cookie` header, from the connection's WebKit store. */
export type CookieSource = (uri: string) => Promise<string | undefined>;

/** A `GLib.Bytes`, as far as the app reads one. */
export type GBytes = { get_data(): Uint8Array | null; get_size(): number };

export type Answer = { status: number; body: string; headers: { get(name: string): string | null }; contentType: string };

function networkError(e: unknown): SpaceError {
  return new SpaceError("network", e instanceof Error ? e.message : String(e));
}

export class SpaceClient implements ChatApi {
  readonly base: string;
  private readonly session = new Soup.Session({ user_agent: USER_AGENT, timeout: 30, max_conns_per_host: 6 });
  /** Event streams stay open for minutes; a heartbeat comes every few seconds, so no read timeout. */
  private readonly streams = new Soup.Session({ user_agent: USER_AGENT, timeout: 0, idle_timeout: 0 });

  constructor(
    base: string,
    private readonly cookies: CookieSource,
  ) {
    this.base = origin(base) ?? base;
  }

  url(path: string): string {
    return resolveUrl(path, `${this.base}/`) ?? this.base + path;
  }

  private async message(method: string, path: string, opts: { json?: unknown; accept?: string; headers?: Record<string, string>; body?: { type: string; bytes: Uint8Array } } = {}) {
    const target = this.url(path);
    const msg = Soup.Message.new(method, target);
    if (!msg) throw new SpaceError("invalid", `not a URL: ${target}`);
    msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
    const h = msg.get_request_headers();
    h.replace("Accept", opts.accept ?? "application/json");
    const cookie = sameOrigin(target, this.base) ? await this.cookies(target) : undefined;
    if (cookie) h.replace("Cookie", cookie);
    for (const [k, v] of Object.entries(opts.headers ?? {})) h.replace(k, v);
    if (opts.json !== undefined || opts.body) {
      h.replace("Origin", this.base);
      if (opts.body) msg.set_request_body_from_bytes(opts.body.type, new GLib.Bytes(opts.body.bytes));
      else msg.set_request_body_from_bytes("application/json", textToBytes(JSON.stringify(opts.json)));
    }
    return { msg, target };
  }

  /** The bare answer, whatever its status; throws only when nothing answered. */
  async answer(method: string, path: string, opts: { json?: unknown; accept?: string; headers?: Record<string, string>; body?: { type: string; bytes: Uint8Array } } = {}): Promise<Answer> {
    const { msg } = await this.message(method, path, opts);
    let bytes;
    try {
      bytes = await this.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
      throw networkError(e);
    }
    const headers = msg.get_response_headers();
    return { status: msg.get_status(), body: bytesToText(bytes), headers: { get: (n: string) => headers.get_one(n) }, contentType: headers.get_content_type()?.[0] ?? headers.get_one("content-type") ?? "" };
  }

  async get(path: string): Promise<unknown> {
    const a = await this.answer("GET", path);
    checkResponse(a.status, a.body);
    try {
      return JSON.parse(a.body) as unknown;
    } catch {
      throw new SpaceError("invalid", `${path}: not JSON`);
    }
  }

  async send(method: string, path: string, body: Record<string, unknown>): Promise<unknown> {
    const a = await this.answer(method, path, { json: body });
    checkResponse(a.status, a.body);
    try {
      return JSON.parse(a.body) as unknown;
    } catch {
      return {};
    }
  }

  /** Bytes of an icon or avatar; another origin's are fetched without the Space's cookies. */
  async bytes(path: string): Promise<GBytes> {
    const { msg } = await this.message("GET", path, { accept: "*/*" });
    let bytes;
    try {
      bytes = await this.session.send_and_read_async(msg, GLib.PRIORITY_LOW, null);
    } catch (e) {
      throw networkError(e);
    }
    checkResponse(msg.get_status(), "");
    return bytes;
  }

  /**
   * A server-sent event stream: each `data:` line with the `id:` before it, and the run id from
   * the `x-run-id` header. `close()` cancels the request.
   */
  async events(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ runId?: string; messages: AsyncIterable<SSEMessage>; close(): void }> {
    const { msg } = await this.message(method, path, { accept: "text/event-stream", ...(body ? { json: body } : {}) });
    const cancel = new Gio.Cancellable();
    let stream: any;
    try {
      stream = await this.streams.send_async(msg, GLib.PRIORITY_DEFAULT, cancel);
    } catch (e) {
      throw networkError(e);
    }
    const status = msg.get_status();
    if (status < 200 || status >= 300) {
      const data = new Gio.DataInputStream({ base_stream: stream });
      let text = "";
      try {
        const bytes = data.read_bytes(4096, null);
        text = bytesToText(bytes);
      } catch {}
      checkResponse(status, text);
    }
    const runId = msg.get_response_headers().get_one("x-run-id") ?? undefined;
    const lines = new Gio.DataInputStream({ base_stream: stream, newline_type: Gio.DataStreamNewlineType.ANY });
    const decoder = new TextDecoder();
    async function* read(): AsyncGenerator<SSEMessage> {
      const parser = new SSEParser();
      try {
        for (;;) {
          const [line] = (await lines.read_line_async(GLib.PRIORITY_DEFAULT, cancel)) as [Uint8Array | null, number];
          if (line === null) return;
          const m = parser.feed(decoder.decode(line));
          if (m) yield m;
        }
      } catch (e) {
        if (cancel.is_cancelled()) return;
        throw networkError(e);
      } finally {
        try {
          stream.close(null);
        } catch {}
      }
    }
    return { ...(runId ? { runId } : {}), messages: read(), close: () => cancel.cancel() };
  }

  /** A multipart upload, as the panel's page sends a file (voice clips, pictures). */
  async upload(path: string, field: string, filename: string, type: string, data: Uint8Array): Promise<unknown> {
    const boundary = `aispace-${GLib.uuid_string_random()}`;
    const enc = new TextEncoder();
    const head = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`);
    const tail = enc.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + data.length + tail.length);
    body.set(head, 0);
    body.set(data, head.length);
    body.set(tail, head.length + data.length);
    const a = await this.answer("POST", path, { body: { type: `multipart/form-data; boundary=${boundary}`, bytes: body } });
    checkResponse(a.status, a.body);
    return JSON.parse(a.body || "{}") as unknown;
  }
}

/** A request outside any Space's session (another origin's icon, the device sign-in). */
export async function plainRequest(method: string, url: string, headers: Record<string, string> = {}): Promise<{ status: number; bytes: GBytes; msg: any }> {
  const session = new Soup.Session({ user_agent: USER_AGENT, timeout: 15 });
  const msg = Soup.Message.new(method, url);
  if (!msg) throw new SpaceError("invalid", `not a URL: ${url}`);
  msg.set_flags(Soup.MessageFlags.NO_REDIRECT);
  for (const [k, v] of Object.entries(headers)) msg.get_request_headers().replace(k, v);
  try {
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    return { status: msg.get_status(), bytes, msg };
  } catch (e) {
    throw networkError(e);
  }
}
