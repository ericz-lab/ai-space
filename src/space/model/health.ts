import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnCollect } from "../runtimes/process.ts";
import type { RuntimeSpec } from "../runtimes/types.ts";

/**
 * The status table of docs/model-machines.md#status: one cell per machine and
 * runtime, saying whether the CLI is installed on the PATH the service runs
 * with, whether it is signed in, whether the account is limited, and when it
 * last answered. Probes cost no tokens: `claude auth status`, `codex login
 * status`, the harness's key or account file. `limited` comes from the errors
 * calls return; the next success clears it.
 */

export type HealthCell = {
  /** "" for this machine, otherwise a peer or a `machines:` name. */
  machine: string;
  runtime: string;
  kind: string;
  /** False when the machine could not be reached at all (ssh failed); `installed` is then unknown. */
  reachable?: boolean;
  /** Unknown until the first probe; a peer's cell carries what the peer probed. */
  installed?: boolean;
  signedIn?: boolean;
  /** What the probe said when it did not pass (the CLI's own line). */
  detail?: string;
  checkedAt?: string;
  limitedUntil?: string;
  lastError?: string;
  lastOkAt?: string;
};

export type ProbeResult = { reachable?: false; installed?: boolean; signedIn?: boolean; detail?: string };
export type ProbeTarget = { machine: string; spec: RuntimeSpec; ssh?: string };
export type Prober = (target: ProbeTarget) => Promise<ProbeResult>;
export type Spawn = typeof spawnCollect;

/** Errors that mean the account, not the request: the cell is limited until the time below. */
const LIMIT_RE = /usage limit|rate.?limit|too many requests|\b429\b|at capacity|quota|overloaded/i;
const LIMIT_MS = 3_600_000;
const PROBE_TIMEOUT_MS = 30_000;

export class RuntimeHealth {
  private readonly cells = new Map<string, HealthCell>();
  private readonly now: () => number;
  private readonly prober: Prober;

  constructor(opts: { now?: () => number; prober?: Prober } = {}) {
    this.now = opts.now ?? Date.now;
    this.prober = opts.prober ?? probeRuntime();
  }

  private cell(machine: string, runtime: string, kind = ""): HealthCell {
    const key = `${machine}|${runtime}`;
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { machine, runtime, kind }));
    if (kind && !c.kind) c.kind = kind;
    return c;
  }

  /** The ledger's newest successes, at boot (`ModelStore.lastOk`). */
  seed(lastOk: Map<string, number>): void {
    for (const [key, t] of lastOk) {
      const [machine = "", runtime = ""] = key.split("|");
      const c = this.cell(machine, runtime);
      if (!c.lastOkAt || Date.parse(c.lastOkAt) < t) c.lastOkAt = new Date(t).toISOString();
    }
  }

  /** One call's outcome: a success clears a limit, an account error sets one. */
  note(machine: string, runtime: string, error?: string): void {
    const c = this.cell(machine, runtime);
    const at = this.now();
    if (error === undefined) {
      c.lastOkAt = new Date(at).toISOString();
      delete c.limitedUntil;
      delete c.lastError;
      return;
    }
    c.lastError = error.slice(0, 300);
    if (LIMIT_RE.test(error)) c.limitedUntil = new Date(at + LIMIT_MS).toISOString();
  }

  /** Probe every target; one that fails to answer is recorded as such, never thrown. */
  async probe(targets: ProbeTarget[]): Promise<void> {
    await Promise.all(
      targets.map(async (t) => {
        const c = this.cell(t.machine, t.spec.name, t.spec.kind);
        let r: ProbeResult;
        try {
          r = await this.prober(t);
        } catch (e) {
          r = { installed: false, detail: (e as Error).message.slice(0, 200) };
        }
        for (const k of ["reachable", "installed"] as const) {
          if (r[k] === undefined) delete c[k];
          else c[k] = r[k];
        }
        if (r.signedIn === undefined) delete c.signedIn;
        else c.signedIn = r.signedIn;
        if (r.detail) c.detail = r.detail;
        else delete c.detail;
        c.checkedAt = new Date(this.now()).toISOString();
      }),
    );
  }

  /** Every cell; a limit that has run out is not shown. */
  list(): HealthCell[] {
    const at = this.now();
    return [...this.cells.values()]
      .map((c) => (c.limitedUntil && Date.parse(c.limitedUntil) <= at ? (({ limitedUntil: _, ...rest }) => rest)(c) : { ...c }))
      .sort((a, b) => a.machine.localeCompare(b.machine) || a.runtime.localeCompare(b.runtime));
  }
}

/** A cell that is used but cannot answer: what the panel flags. */
export function problemOf(c: HealthCell, now = Date.now()): string | undefined {
  if (c.reachable === false) return "unreachable";
  if (c.installed === false) return "not installed";
  if (c.signedIn === false) return "not signed in";
  if (c.limitedUntil && Date.parse(c.limitedUntil) > now) return "limited";
  return undefined;
}

/** The default prober: no tokens spent, the same command line the adapter itself would run. */
export function probeRuntime(spawn: Spawn = spawnCollect, env: Record<string, string | undefined> = process.env): Prober {
  return async ({ spec, ssh }) => {
    if (spec.kind === "anthropic-api") return { installed: true, signedIn: Boolean(spec.apiKey) };
    const bin = spec.bin.length ? spec.bin : [spec.kind === "claude-code" ? "claude" : spec.kind === "codex-cli" ? "codex" : "dsh"];
    const host = ssh ?? spec.sshHost;
    if (host) return probeRemote(spawn, host, spec, bin);
    // Local: the adapters start the binary from the service's own PATH, so that is the one to search.
    const found = isAbsolute(bin[0]!) ? existsSync(bin[0]!) : Bun.which(bin[0]!, { PATH: env.PATH ?? "" }) !== null;
    if (!found) return { installed: false, detail: `${bin[0]} is not on the service's PATH` };
    if (spec.kind === "deepseek-harness") return dshSignedIn(spec.home, spec.provider, env);
    const r = await spawn([...bin, ...statusArgs(spec.kind)], { timeoutMs: PROBE_TIMEOUT_MS, env });
    return { installed: true, ...readStatus(spec.kind, r.code, r.stdout, r.stderr) };
  };
}

function statusArgs(kind: RuntimeSpec["kind"]): string[] {
  return kind === "claude-code" ? ["auth", "status"] : ["login", "status"];
}

/** `claude auth status` prints JSON with `loggedIn`; `codex login status` exits 0 when signed in. */
export function readStatus(kind: RuntimeSpec["kind"], code: number | null, stdout: string, stderr: string): { signedIn: boolean; detail?: string } {
  const line = (stdout.trim() || stderr.trim()).split("\n")[0]?.slice(0, 200);
  if (kind === "claude-code") {
    try {
      const j = JSON.parse(stdout) as { loggedIn?: unknown };
      return j.loggedIn === true ? { signedIn: true } : { signedIn: false, detail: "claude auth status: not logged in" };
    } catch {
      return code === 0 ? { signedIn: true } : { signedIn: false, ...(line ? { detail: line } : {}) };
    }
  }
  return code === 0 ? { signedIn: true } : { signedIn: false, ...(line ? { detail: line } : {}) };
}

function dshSignedIn(home: string | undefined, provider: string | undefined, env: Record<string, string | undefined>): ProbeResult {
  const dir = home?.trim() || join(homedir(), ".dsh");
  if (provider === "deepseek-account") {
    const ok = existsSync(join(dir, ".credentials.yaml"));
    return { installed: true, signedIn: ok, ...(ok ? {} : { detail: "no signed-in account in the harness home" }) };
  }
  let key = Boolean(env.DEEPSEEK_API_KEY?.trim());
  try {
    key ||= /^DEEPSEEK_API_KEY=\S/m.test(readFileSync(join(dir, ".env"), "utf8"));
  } catch {
    /* no .env */
  }
  return { installed: true, signedIn: key, ...(key ? {} : { detail: "no DEEPSEEK_API_KEY in the harness home" }) };
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Over ssh, through the login shell as the adapters do; exit 127 means the CLI is missing. */
async function probeRemote(spawn: Spawn, host: string, spec: RuntimeSpec, bin: string[]): Promise<ProbeResult> {
  if (spec.kind === "anthropic-api") return { installed: true, signedIn: true };
  const cmd = bin.map(quote).join(" ");
  const check = `command -v ${quote(bin[0]!)} >/dev/null 2>&1 || exit 127; `;
  let script: string;
  if (spec.kind === "deepseek-harness") {
    const dir = spec.home ? quote(spec.home) : '"${DSH_HOME:-$HOME/.dsh}"';
    script = check + (spec.provider === "deepseek-account" ? `test -s ${dir}/.credentials.yaml` : `grep -qs '^DEEPSEEK_API_KEY=.' ${dir}/.env`);
  } else script = check + `${cmd} ${statusArgs(spec.kind).join(" ")}`;
  const r = await spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(script)}`], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.code === 255) return { reachable: false, detail: `ssh ${host}: ${(r.stderr.trim().split("\n").pop() ?? "").slice(0, 160)}` };
  if (r.code === 127) return { installed: false, detail: `${bin[0]} is not on ${host}'s login PATH` };
  if (spec.kind === "deepseek-harness") return { installed: true, signedIn: r.code === 0, ...(r.code === 0 ? {} : { detail: "no DeepSeek key or account on that machine" }) };
  return { installed: true, ...readStatus(spec.kind, r.code, r.stdout, r.stderr) };
}
