import type { FeedbackImage } from "./types.ts";

/**
 * Where feedback becomes a task: ai-todo's capabilities (its `space.yaml` `provides`), called
 * through this space's bus when ai-todo runs here, or through a peer that has it (docs/feedback.md).
 * A capability ai-todo does not provide yet (`status`, added with this feature) is skipped, so an
 * older ai-todo still gets the task and its records.
 */

export const TODO_APP = "ai-todo";

/** One capability call: status and the answer's text. Throws when the call could not be made. */
export type Caller = (capability: string, body: { json: unknown } | { form: FormData }) => Promise<{ status: number; text: string }>;

export type TodoTask = { status: string; records: { content: string; source: string; createdAt: string }[] };

export class TodoSink {
  constructor(
    private readonly call: Caller,
    /** "" for this space, else the peer that holds ai-todo. */
    readonly peer: string,
    /** ai-todo's page, for links to a task; undefined when unknown. */
    private readonly pageUrl?: string,
  ) {}

  url(id: number): string | null {
    if (!this.pageUrl) return null;
    try {
      const u = new URL(this.pageUrl.replace("{lang}", ""));
      u.search = "";
      u.searchParams.set("todo", String(id));
      return u.toString();
    } catch {
      return null;
    }
  }

  private async json<T>(capability: string, body: unknown): Promise<T> {
    const r = await this.call(capability, { json: body });
    let parsed: { ok?: boolean; error?: string } & T;
    try {
      parsed = JSON.parse(r.text) as typeof parsed;
    } catch {
      throw new Error(`${TODO_APP}/${capability}: HTTP ${r.status}, not JSON`);
    }
    if (r.status >= 300 || parsed.ok === false) throw Object.assign(new Error(`${TODO_APP}/${capability}: ${parsed.error ?? `HTTP ${r.status}`}`), { status: r.status });
    return parsed;
  }

  async add(draft: { title: string; notes: string; tags: string[] }): Promise<number> {
    const r = await this.json<{ todos: { id: number }[] }>("add", { drafts: [{ title: draft.title, notes: draft.notes, tags: draft.tags }], source: "ai" });
    const id = r.todos?.[0]?.id;
    if (typeof id !== "number") throw new Error(`${TODO_APP}/add answered no task`);
    return id;
  }

  async plan(id: number, content: string): Promise<void> {
    await this.json("plan", { id, content, source: "ai" });
  }

  async record(id: number, content: string, images: FeedbackImage[] = []): Promise<void> {
    const form = new FormData();
    form.set("todoId", String(id));
    form.set("content", content);
    form.set("source", "ai");
    for (const img of images) form.append("images", new File([new Uint8Array(img.bytes)], img.name, { type: img.type }));
    const r = await this.call("record", { form });
    if (r.status >= 300) throw new Error(`${TODO_APP}/record: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }

  /** Move the task to doing or review; false when this ai-todo has no `status` capability yet. */
  async status(id: number, status: "doing" | "review"): Promise<boolean> {
    try {
      await this.json("status", { id, status, source: "ai" });
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 404 || /does not provide/.test((e as Error).message)) return false;
      throw e;
    }
  }

  /**
   * The task's status in ai-todo ("open", "doing", "review", "deferred", "done", "dropped"), "gone"
   * when ai-todo says there is no such task, or null when it could not be read.
   */
  async taskStatus(id: number): Promise<string | "gone" | null> {
    try {
      const r = await this.json<{ todo?: { status?: unknown } }>("task", { id });
      return typeof r.todo?.status === "string" ? r.todo.status : null;
    } catch (e) {
      // ai-todo's own "no such todo"; a 404 from the bus (no ai-todo, no capability) says nothing about the task.
      return (e as { status?: number }).status === 404 && /no such todo/i.test((e as Error).message) ? "gone" : null;
    }
  }

  async task(id: number): Promise<TodoTask | null> {
    try {
      const r = await this.json<{ todo: { status: string }; records?: { content: string; source: string; createdAt: string }[] }>("task", { id });
      return { status: r.todo.status, records: (r.records ?? []).map((x) => ({ content: String(x.content ?? ""), source: String(x.source ?? ""), createdAt: String(x.createdAt ?? "") })) };
    } catch {
      return null;
    }
  }
}

/** A bus or peer answer as status and text, from a body built for either. */
export async function encode(body: { json: unknown } | { form: FormData }): Promise<{ contentType: string; bytes: ArrayBuffer }> {
  if ("json" in body) return { contentType: "application/json", bytes: new TextEncoder().encode(JSON.stringify(body.json)).buffer as ArrayBuffer };
  const r = new Response(body.form);
  return { contentType: r.headers.get("content-type") ?? "multipart/form-data", bytes: await r.arrayBuffer() };
}

type BusLike = { call(caller: string, app: string, name: string, req: { body?: ArrayBuffer | string | null; contentType?: string; accept?: string }): Promise<{ status: number; body: ArrayBuffer }> };
type PeerLike = { provides(app: string, capability?: string): boolean; request(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>; snapshot?: { apps: { name: string; url?: string }[] } };

/**
 * ai-todo here when it is registered and provides `add`, else the first peer whose snapshot says it
 * does (calls go as `<this space>/space`, as the hub's forwarded calls do). Undefined when neither.
 * With `at`, only that place: "" for this space, else the peer of that name (where a row's task is).
 */
export function todoSinkFor(opts: {
  name: string;
  bus: BusLike;
  local: () => { provides: boolean; url?: string } | undefined;
  peers: () => { name: string; client: PeerLike }[];
}, at?: string): TodoSink | undefined {
  const here = at === undefined || at === "" ? opts.local() : undefined;
  if (here?.provides) {
    return new TodoSink(async (capability, body) => {
      const { contentType, bytes } = await encode(body);
      const r = await opts.bus.call("space", TODO_APP, capability, { body: bytes, contentType, accept: "application/json" });
      return { status: r.status, text: new TextDecoder().decode(r.body) };
    }, "", here.url);
  }
  if (at === "") return undefined;
  for (const p of opts.peers()) {
    if (at !== undefined && p.name !== at) continue;
    if (!p.client.provides(TODO_APP, "add")) continue;
    const url = p.client.snapshot?.apps.find((a) => a.name === TODO_APP)?.url;
    return new TodoSink(async (capability, body) => {
      const { contentType, bytes } = await encode(body);
      const r = await p.client.request(`/api/peer/call/${TODO_APP}/${encodeURIComponent(capability)}`, { method: "POST", headers: { "content-type": contentType, accept: "application/json", "x-space-caller": `${opts.name}/space` }, body: bytes });
      return { status: r.status, text: await r.text() };
    }, p.name, url);
  }
  return undefined;
}
