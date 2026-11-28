/**
 * Delegation to an agent on another machine (docs/orders.md#on-another-machine): what the delegation
 * service needs of the peers, without knowing how they are reached. The implementation over this
 * Space's peer hub is `peers/delegates.ts` (`peerMachines`); tests give their own.
 *
 * Every call goes to the peer's `/api/peer/agents/…` routes through the hub-side peer client, in
 * process: over HTTPS with the hub token (`SPACE_PEER_<NAME>`) or as a `peer` operation on a package
 * connection. On the peer the caller is this Space's link, which the peer treats as its owner.
 */

/** Whether this Space can run agents on a machine now, or what is missing. */
export type MachineAccess =
  | { ok: true }
  | {
      ok: false;
      /**
       * `unlisted`: this Space lists no peer of that name; `no-agents`: a connection peer whose other
       * Space does not grant this one the `agents` scope; `offline`: listed, but it does not answer.
       */
      reason: "unlisted" | "no-agents" | "offline";
      error: string;
    };

export interface RemoteMachines {
  access(machine: string): MachineAccess;
  /** Whether `<app>/<agent>` is one of the machine's agents in its last snapshot. */
  hasAgent(machine: string, agent: string): boolean;
  /** A request to the machine's `/api/peer/...` path; throws when the machine cannot be reached. */
  request(machine: string, path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>;
}

/** `<peer>/<app>/<agent>` → the machine and the agent there; `<app>/<agent>` → this Space's (machine ""). */
export function splitDelegate(agent: string): { machine: string; agent: string } {
  const parts = agent.split("/");
  return parts.length === 3 ? { machine: parts[0]!, agent: `${parts[1]}/${parts[2]}` } : { machine: "", agent };
}

/** The peer path of an agent's route: `/api/peer/agents/<app>/<agent><rest>`. */
export function peerAgentPath(agent: string, rest = ""): string {
  const [app = "", name = ""] = agent.split("/");
  return `/api/peer/agents/${encodeURIComponent(app)}/${encodeURIComponent(name)}${rest}`;
}

/**
 * Read a run's event stream (`id: <seq>` and `data: <line>`): every event line with its seq to
 * `onEvent`, the lines without one (the closing `{"type":"error"}` and `{"type":"done"}`) to `onEnd`.
 * Resolves `true` once `done` arrived, `false` when the stream ended or went quiet for `idleMs`
 * before it did (a heartbeat comes every 20 s while the run runs).
 */
export async function readRunEvents(body: ReadableStream<Uint8Array>, on: { onEvent: (seq: number, line: string) => void; onEnd: (line: string) => void }, idleMs: number, signal?: AbortSignal): Promise<boolean> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let seq: number | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = () => new Promise<"idle">((resolve) => { timer = setTimeout(() => resolve("idle"), idleMs); });
  try {
    for (;;) {
      if (signal?.aborted) return done;
      const r = await Promise.race([reader.read(), idle()]).finally(() => clearTimeout(timer));
      if (r === "idle") return done;
      if (r.done) return done;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const raw of lines) {
        if (raw.startsWith("id: ")) seq = Number(raw.slice(4));
        else if (raw.startsWith("data: ")) {
          const line = raw.slice(6);
          if (seq !== null && Number.isFinite(seq)) on.onEvent(seq, line);
          else {
            on.onEnd(line);
            if (/^\s*\{\s*"type"\s*:\s*"done"/.test(line)) done = true;
          }
          seq = null;
        }
      }
      if (done) return true;
    }
  } catch {
    return done;
  } finally {
    reader.cancel().catch(() => {});
  }
}
