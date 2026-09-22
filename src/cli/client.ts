import { ApiError, Unreachable } from "./types.ts";

/**
 * The running ai-space, as the CLI sees it: one base URL, the operator token
 * for everything, and the app's own token for the routes that identify the
 * caller by app (notify, events, model, chat) when the command runs inside a
 * task. Errors are typed so `main.ts` can map them to exit codes.
 */

export type Target = { url: string; token: string; appToken: string; app?: string };

export const DEFAULT_URL = "http://127.0.0.1:8700";

/**
 * URL: `--url`, `SPACE_API_URL` (a task's command, an app's `space.env`), `SPACE_HOST`/`SPACE_PORT`
 * from the environment or the workspace `.env`, then loopback. Token: `--token`, `SPACE_API_TOKEN`
 * from the environment or the `.env`. `SPACE_APP_TOKEN` and `SPACE_APP` are kept for the routes
 * that take an app's identity. The `.env` is read only for what is not already set.
 */
export async function resolveTarget(
  flags: { url?: string; token?: string },
  env: Record<string, string | undefined>,
  readEnvFile: () => Promise<Record<string, string>>,
): Promise<Target> {
  let file: Record<string, string> | undefined;
  const fromFile = async (key: string) => (file ??= await readEnvFile().catch(() => ({}) as Record<string, string>))[key]?.trim();
  const pick = async (key: string) => env[key]?.trim() || (await fromFile(key));

  let url = flags.url?.trim() || env.SPACE_API_URL?.trim();
  if (!url) {
    const host = await pick("SPACE_HOST");
    const port = await pick("SPACE_PORT");
    url = host || port ? `http://${host || "127.0.0.1"}:${port || 8700}` : DEFAULT_URL;
  }
  const token = flags.token?.trim() || (await pick("SPACE_API_TOKEN")) || "";
  return { url: url.replace(/\/+$/, ""), token, appToken: env.SPACE_APP_TOKEN?.trim() ?? "", app: env.SPACE_APP?.trim() || undefined };
}

export type RequestOptions = {
  /** Present the app's own token when there is one (routes that identify the caller by app). */
  asApp?: boolean;
  timeoutMs?: number;
  /** Accept these statuses as answers instead of throwing. */
  accept?: number[];
};

export type SseEvent = { event: string; data: string };

export class Client {
  constructor(
    readonly target: Target,
    private readonly fetchImpl: typeof fetch,
  ) {}

  get url(): string {
    return this.target.url;
  }

  private headers(opts: RequestOptions, body: boolean): Record<string, string> {
    const token = opts.asApp && this.target.appToken ? this.target.appToken : this.target.token;
    return { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  }

  /** One request; throws `Unreachable` when nothing answers. */
  async raw(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
    const url = `${this.target.url}${path.startsWith("/") ? "" : "/"}${path}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers: this.headers(opts, body !== undefined),
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new Unreachable(this.target.url, (e as Error).message ?? String(e));
    }
  }

  /** A JSON request; the parsed body when the answer is ok, `ApiError` otherwise. */
  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, body, opts);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    const ok = res.ok || opts.accept?.includes(res.status);
    if (!ok) throw new ApiError(res.status, describe(res.status, parsed), parsed);
    return parsed as T;
  }

  get<T = Record<string, unknown>>(path: string, opts?: RequestOptions): Promise<T> {
    return this.json<T>("GET", path, undefined, opts);
  }
  post<T = Record<string, unknown>>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.json<T>("POST", path, body ?? {}, opts);
  }
  patch<T = Record<string, unknown>>(path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    return this.json<T>("PATCH", path, body, opts);
  }
  delete<T = Record<string, unknown>>(path: string, opts?: RequestOptions): Promise<T> {
    return this.json<T>("DELETE", path, undefined, opts);
  }

  /** A text answer (logs). */
  async text(path: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.raw("GET", path, undefined, opts);
    const text = await res.text();
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
      throw new ApiError(res.status, describe(res.status, parsed), parsed);
    }
    return text;
  }

  /** Server-sent events, one by one, until the stream ends. A non-2xx answer throws before the first event. */
  async *events(method: string, path: string, body?: unknown, opts: RequestOptions = {}): AsyncGenerator<SseEvent> {
    const res = await this.raw(method, path, body, { timeoutMs: 24 * 3600_000, ...opts });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
      throw new ApiError(res.status, describe(res.status, parsed), parsed);
    }
    if (!res.body) return;
    yield* parseSse(res.body);
  }
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const flush = function* () {
    if (data.length) yield { event, data: data.join("\n") };
    event = "message";
    data = [];
  };
  for await (const chunk of chunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, "");
      buffer = buffer.slice(i + 1);
      if (line === "") yield* flush();
      else if (line.startsWith(":")) continue;
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  yield* flush();
}

/** A stream as an async iterable, for runtimes whose ReadableStream has no iterator. */
export async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function describe(status: number, body: unknown): string {
  const b = body as { error?: unknown; raw?: unknown } | null;
  const msg = b && typeof b === "object" ? (typeof b.error === "string" ? b.error : typeof b.raw === "string" ? b.raw.slice(0, 200) : "") : "";
  return msg ? `${status}: ${msg}` : `${status}`;
}
