import type { RunRegistry } from "../agents/runs.ts";
import { finalText } from "./prompt.ts";
import type { FixerPort, RunEnd } from "./service.ts";

/**
 * How the feedback service reaches the Fix Engineer (`space/ui-fixer`): on this machine through the
 * agents' own chat route, called in process, so the run is an ordinary background run the panel
 * lists; on a peer through the peer's `/api/peer/agents/...` routes, polled until the run ends.
 */

export const FIXER_ID = { app: "space", agent: "ui-fixer" } as const;

type ChatHandler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type PeerRequest = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>;

/** Start a turn through a chat route's answer: its `x-run-id`, the stream itself let go (the run goes on). */
async function runIdOf(res: Response): Promise<string> {
  const id = res.headers.get("x-run-id");
  if (!res.ok || !id) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch { /* plain text */ }
    throw new Error(msg.slice(0, 300) || `HTTP ${res.status}`);
  }
  await res.body?.cancel().catch(() => {});
  return id;
}

export function localFixer(chat: ChatHandler, runs: RunRegistry): Pick<FixerPort, "start" | "wait"> {
  return {
    async start(_machine, body) {
      const req = Object.assign(
        new Request(`http://space.local/api/agents/${FIXER_ID.app}/${FIXER_ID.agent}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        { params: { app: FIXER_ID.app, agent: FIXER_ID.agent } },
      );
      return runIdOf(await chat(req));
    },
    wait(_machine, runId) {
      return new Promise<RunEnd>((resolve) => {
        const lines: string[] = [];
        const off = runs.subscribe(runId, 0, {
          onEvent: (ev) => lines.push(ev.line),
          onEnd: (run) => resolve({ status: run.status, error: run.error, text: finalText(lines) }),
        });
        if (!off) {
          const run = runs.get(runId);
          resolve({ status: run?.status ?? "error", error: run?.error ?? "the run is gone", text: "" });
        }
      });
    },
  };
}

/** A finished run's events from its SSE replay: the `data:` lines, without the stream's own markers. */
export function sseData(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((l) => l !== '{"type":"done"}');
}

export function peerFixer(peer: (name: string) => PeerRequest | undefined, opts: { pollMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Pick<FixerPort, "start" | "wait"> {
  const base = `/api/peer/agents/${FIXER_ID.app}/${FIXER_ID.agent}`;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  const req = (machine: string): PeerRequest => {
    const r = peer(machine);
    if (!r) throw new Error(`${machine} is not a peer of this space`);
    return r;
  };
  return {
    async start(machine, body) {
      const res = await req(machine)(`${base}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 404) throw new Error(`${machine} has no Fix Engineer yet (its ai-space is older)`);
      return runIdOf(res);
    },
    async wait(machine, runId) {
      const deadline = Date.now() + (opts.maxMs ?? 4 * 3600_000);
      let status = "running";
      let error: string | null = null;
      while (status === "running") {
        if (Date.now() > deadline) return { status: "timeout", error: "no end of the run on the peer", text: "" };
        await sleep(opts.pollMs ?? 20_000);
        try {
          const res = await req(machine)(`${base}/runs/${encodeURIComponent(runId)}`);
          if (res.status === 404) return { status: "error", error: "the peer no longer has the run", text: "" };
          if (!res.ok) continue;
          const d = (await res.json()) as { run?: { status?: string; error?: string | null } };
          status = d.run?.status ?? "running";
          error = d.run?.error ?? null;
        } catch {
          // The link may be down for a while; the run goes on there.
        }
      }
      let text = "";
      try {
        const res = await req(machine)(`${base}/runs/${encodeURIComponent(runId)}/events?after=0`);
        if (res.ok) text = finalText(sseData(await res.text()));
      } catch { /* no report */ }
      return { status, error, text };
    },
  };
}

/** One port over both: "" is this machine, anything else a peer. */
export function fixerPort(local: Pick<FixerPort, "start" | "wait">, remote: Pick<FixerPort, "start" | "wait">): FixerPort {
  return {
    start: (machine, body) => (machine ? remote : local).start(machine, body),
    wait: (machine, runId) => (machine ? remote : local).wait(machine, runId),
  };
}
