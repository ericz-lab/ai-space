import type { RemoteRuntimes } from "../runtimes/registry.ts";
import { RUNTIME_KINDS, Unsupported, type Backend, type CompleteFile, type CompleteInput, type CompleteOutcome, type ImageInput, type ImageOutcome, type OnDelta, type RuntimeAdapter, type RuntimeKind, type Usage } from "../runtimes/types.ts";
import type { PeerClient } from "./client.ts";
import type { PeerHub } from "./hub.ts";

/**
 * A runtime of another space, reached through the peer link
 * (docs/model-machines.md): `box:codex/basic` becomes `POST /api/peer/model/run`
 * on peer "box" with model `codex/basic`. The peer resolves the tier, runs the
 * call with its own login and cap, records it, and returns the ledger row, whose
 * figures this side records again under its own app. Answers and images only:
 * chat and agent tasks run where their app lives.
 */

/** Allowance on top of the call's own timeout for the link and the peer's queue. */
const LINK_MS = 60_000;

type Call = { model?: string; usage?: Usage; costUsd?: number };

export function createPeerRuntime(client: PeerClient, hub: string, runtime: { name: string; kind: RuntimeKind; image: boolean }): RuntimeAdapter {
  const backend: Backend = `peer:${client.name}`;
  const fail = (error: string, call?: Call): CompleteOutcome => ({ ok: false, error, backend, ...figures(call) });
  const post = (path: string, input: { caller?: string; timeoutMs: number }, body: Record<string, unknown>, signal?: AbortSignal) =>
    client.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-space-caller": `${hub}/${input.caller ?? "space"}`, accept: body.stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs + LINK_MS)]) : AbortSignal.timeout(input.timeoutMs + LINK_MS),
    });
  const linkError = (r: Response, j: { error?: unknown } | null): string => {
    if (r.status === 401) return `peer ${client.name} rejected the token`;
    if (r.status === 404) return `peer ${client.name} does not serve model calls (an older ai-space)`;
    return typeof j?.error === "string" ? j.error : `peer ${client.name}: HTTP ${r.status}`;
  };
  return {
    name: runtime.name,
    kind: runtime.kind,
    backend,
    machine: client.name,
    capabilities: { complete: true, agent: false, chat: false, image: runtime.image },
    async complete(input: CompleteInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<CompleteOutcome> {
      let r: Response;
      try {
        const images = await encode(input.files);
        r = await post("/api/peer/model/run", input, {
          prompt: input.prompt, system: input.system, model: `${runtime.name}/${input.model}`, tag: input.tag, tools: input.tools,
          timeoutMs: input.timeoutMs, maxTokens: input.maxTokens,
          ...(input.mode ? { mode: input.mode } : {}), ...(input.thinking !== undefined ? { thinking: input.thinking } : {}), ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
          ...(images.length ? { images } : {}), ...(onDelta ? { stream: true } : {}),
        }, signal);
      } catch (e) {
        return fail(signal?.aborted ? "aborted" : `peer ${client.name}: ${(e as Error).message}`);
      }
      if (r.ok && onDelta && (r.headers.get("content-type") ?? "").startsWith("text/event-stream")) return readStream(r, onDelta, fail, backend);
      const j = (await r.json().catch(() => null)) as { ok?: boolean; text?: unknown; error?: unknown; call?: Call } | null;
      if (r.ok && j?.ok === true && typeof j.text === "string") return { ok: true, text: j.text, backend, ...figures(j.call) };
      return fail(linkError(r, j), j?.call);
    },
    async image(input: ImageInput, signal?: AbortSignal): Promise<ImageOutcome> {
      let r: Response;
      try {
        const images = await encode(input.files);
        r = await post("/api/peer/model/image", input, { prompt: input.prompt, system: input.system, model: `${runtime.name}/${input.model}`, tag: input.tag, timeoutMs: input.timeoutMs, ...(images.length ? { images } : {}) }, signal);
      } catch (e) {
        return { ok: false, error: signal?.aborted ? "aborted" : `peer ${client.name}: ${(e as Error).message}`, backend };
      }
      const j = (await r.json().catch(() => null)) as { ok?: boolean; text?: unknown; error?: unknown; images?: { type?: unknown; data?: unknown }[]; call?: Call } | null;
      if (r.ok && j?.ok === true && typeof j.text === "string" && Array.isArray(j.images)) {
        const images = j.images.filter((i) => typeof i.type === "string" && typeof i.data === "string").map((i) => ({ type: i.type as string, bytes: new Uint8Array(Buffer.from(i.data as string, "base64")) }));
        return { ok: true, text: j.text, images, backend, ...figures(j.call) };
      }
      return { ok: false, error: linkError(r, j), backend, ...figures(j?.call) };
    },
    runAgent() {
      throw new Unsupported(`${client.name}:${runtime.name}`, "agent tasks (an agent task runs where its app lives)");
    },
    chat() {
      throw new Unsupported(`${client.name}:${runtime.name}`, "chat (a chat runs where its app lives)");
    },
  };
}

/** The peers as the registry's remote runtimes: what each one's snapshot says it offers. */
export function peerRuntimes(peers: PeerHub, hub: string): RemoteRuntimes {
  return {
    names: () => peers.names(),
    offered: () =>
      peers.names().flatMap((machine) => (peers.get(machine)?.snapshot?.model?.serves ?? []).map((r) => ({ machine, runtime: r.name, kind: r.kind, image: r.image, tiers: r.tiers }))),
    adapter(machine, runtime) {
      const client = peers.get(machine);
      if (!client) return { error: `unknown peer: ${machine}` };
      if (!client.snapshot) return { error: `peer ${machine} has not answered yet` };
      const info = client.snapshot.model;
      if (!info) return { error: `peer ${machine} offers no runtimes to other spaces (SPACE_PEER_MODEL is unset there, or it runs an older ai-space)` };
      const offered = info.serves.find((r) => r.name === runtime);
      if (!offered) return { error: `peer ${machine} does not offer runtime ${runtime}; it offers ${info.serves.map((r) => r.name).join(", ") || "none"}` };
      const kind = (RUNTIME_KINDS as readonly string[]).includes(offered.kind) ? (offered.kind as RuntimeKind) : "claude-code";
      return createPeerRuntime(client, hub, { name: offered.name, kind, image: offered.image });
    },
  };
}

function figures(call?: Call): { usage?: Usage; costUsd?: number; model?: string } {
  if (!call) return {};
  return { ...(call.usage ? { usage: call.usage } : {}), ...(typeof call.costUsd === "number" ? { costUsd: call.costUsd } : {}), ...(typeof call.model === "string" ? { model: call.model } : {}) };
}

/** Files travel inside the request, under their own names, since the prompt refers to them by name. */
async function encode(files?: CompleteFile[]): Promise<{ name: string; data: string }[]> {
  return Promise.all((files ?? []).map(async (f) => ({ name: f.name, data: Buffer.from(await Bun.file(f.path).arrayBuffer()).toString("base64") })));
}

/** The peer's event stream: `delta` {text} as it comes, then `done` or `error` with the ledger row. */
async function readStream(r: Response, onDelta: OnDelta, fail: (error: string, call?: Call) => CompleteOutcome, backend: Backend): Promise<CompleteOutcome> {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let end: number;
      while ((end = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        let name = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (!data.length) continue;
        const j = JSON.parse(data.join("\n")) as { text?: unknown; error?: unknown; call?: Call };
        if (name === "delta" && typeof j.text === "string") onDelta(j.text);
        else if (name === "done" && typeof j.text === "string") return { ok: true, text: j.text, backend, ...figures(j.call) };
        else if (name === "error") return fail(typeof j.error === "string" ? j.error : "the peer reported an error", j.call);
      }
    }
  } catch (e) {
    return fail(`peer stream: ${(e as Error).message}`);
  }
  return fail("the peer closed the stream without an answer");
}
