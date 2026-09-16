import { type Backend, type RunInput, type RunOutcome, type Usage } from "./types.ts";

/**
 * One model call on one of three backends, chosen once for the workspace:
 *
 *   api          SPACE_MODEL_API_KEY set: the Messages API, no CLI, no login state
 *   ssh:<host>   SPACE_MODEL_SSH_HOST set: `ssh <host> claude -p …`, borrowing that machine's login
 *   local        neither: this machine's `claude -p`
 *
 * The prompt travels on stdin, never on the command line. The CLI runs with
 * `--output-format json` so the real token counts and the CLI's own cost
 * figure come back; an older CLI that answers in plain text still works, with
 * no usage recorded (nothing is estimated). Tools are a CLI-only feature: the
 * API backend refuses a call that asks for them instead of quietly dropping
 * them.
 *
 * The CLI is started lean. Left alone, `claude -p` sends its own system prompt,
 * every built-in tool's description, the MCP servers of the machine and the
 * CLAUDE.md files it finds: measured at 24K tokens ahead of a one-line prompt.
 * `--system-prompt` replaces the prompt, `--tools ""` drops the tool set,
 * `--strict-mcp-config` drops the servers; the same one-line prompt then costs
 * 393 tokens. A call that asks for tools gets exactly those (about 1.1K more
 * per tool) and nothing else. Thinking is the other fixed cost: the CLI thinks
 * before every answer (500-800 tokens on that same translation, ten times the
 * answer); a request's `thinking` cap becomes `MAX_THINKING_TOKENS` in the
 * runtime's environment, 0 turning it off (46 output tokens, a third of the
 * cost, a third of the time).
 */

export type RunnerOptions = {
  /** The CLI command; `SPACE_MODEL_BIN` overrides it (tests, a wrapper script). */
  bin?: string[];
  sshHost?: string;
  apiKey?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
};

export type Runner = {
  backend: Backend;
  run: (input: RunInput, signal?: AbortSignal) => Promise<RunOutcome>;
};

/** Aliases the CLI understands, mapped to API model ids. Anything else is passed to the API as is. */
export const API_MODELS: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

/** Command line for the CLI on this machine; exported for tests. */
export function cliArgs(bin: string[], input: RunInput): string[] {
  const tools = input.tools.join(",");
  return [...bin, "-p", "--output-format", "json", "--model", input.model, "--strict-mcp-config", "--tools", tools, ...(tools ? ["--allowedTools", tools] : []), "--system-prompt", input.system];
}

const SAFE_ARG = /^[A-Za-z0-9._:/@,()*-]+$/;

/**
 * The same command as one shell string for `ssh <host> bash -lc '…'`. Every
 * bare word is checked against SAFE_ARG; the system prompt, which is free
 * text, travels base64-encoded and is decoded by the remote shell, so no byte
 * of it is interpreted. Returns the offending word instead of a command when
 * one fails the check.
 */
export function remoteCommand(bin: string[], input: RunInput): { command: string } | { bad: string } {
  const tools = input.tools.join(",");
  const words = [...bin, "-p", "--output-format", "json", "--model", input.model, "--strict-mcp-config"];
  const bad = [...words, ...(tools ? [tools] : [])].find((w) => !SAFE_ARG.test(w));
  if (bad) return { bad };
  const system = Buffer.from(input.system, "utf8").toString("base64");
  const env = input.thinking === undefined ? [] : [`MAX_THINKING_TOKENS=${Math.trunc(input.thinking)}`];
  const parts = [...env, ...words, "--tools", tools ? tools : '""', ...(tools ? ["--allowedTools", tools] : []), "--system-prompt", `"$(printf %s ${system} | base64 -d)"`];
  return { command: parts.join(" ") };
}

/** Environment of a local CLI run: the process's own plus the thinking cap. */
export function cliEnv(input: RunInput, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return input.thinking === undefined ? base : { ...base, MAX_THINKING_TOKENS: String(Math.trunc(input.thinking)) };
}

export function createRunner(opts: RunnerOptions = {}): Runner {
  const env = opts.env ?? process.env;
  const bin = opts.bin ?? (env.SPACE_MODEL_BIN?.trim() ? env.SPACE_MODEL_BIN.trim().split(/\s+/) : ["claude"]);
  const sshHost = opts.sshHost ?? env.SPACE_MODEL_SSH_HOST?.trim() ?? "";
  const apiKey = opts.apiKey ?? env.SPACE_MODEL_API_KEY?.trim() ?? "";
  const doFetch = opts.fetch ?? fetch;
  const apiUrl = opts.apiUrl ?? "https://api.anthropic.com/v1/messages";

  if (apiKey) {
    return { backend: "api", run: (input, signal) => runApi(input, { apiKey, apiUrl, fetch: doFetch, signal }) };
  }
  if (sshHost) {
    if (!/^[A-Za-z0-9._@-]+$/.test(sshHost)) throw new Error(`SPACE_MODEL_SSH_HOST is not a host name: ${sshHost}`);
    const backend: Backend = `ssh:${sshHost}`;
    return {
      backend,
      run: (input, signal) => {
        const remote = remoteCommand(bin, input);
        if ("bad" in remote) return Promise.resolve({ ok: false, error: `argument not allowed over ssh: ${remote.bad}`, backend });
        return runProcess(["ssh", "-o", "BatchMode=yes", sshHost, `bash -lc '${remote.command}'`], input, backend, signal);
      },
    };
  }
  return { backend: "local", run: (input, signal) => runProcess(cliArgs(bin, input), input, "local", signal) };
}

// ---------------------------------------------------------------- cli

type CliResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

/** Read the CLI's json envelope; exported for the scheduler's agent runs, which produce the same shape. */
export function parseCliOutput(raw: string): { text?: string; error?: string; usage?: Usage; costUsd?: number } | undefined {
  let j: CliResult;
  try {
    j = JSON.parse(raw) as CliResult;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object" || j.type !== "result") return undefined;
  const u = j.usage;
  const usage: Usage | undefined = u
    ? { inputTokens: u.input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }
    : undefined;
  const costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
  if (j.is_error) return { error: (j.result ?? j.subtype ?? "the runtime reported an error").trim(), usage, costUsd };
  const text = j.result?.trim() ?? "";
  if (!text) return { error: "empty answer", usage, costUsd };
  return { text, usage, costUsd };
}

async function runProcess(cmd: string[], input: RunInput, backend: Backend, signal?: AbortSignal): Promise<RunOutcome> {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: cliEnv(input) });
  } catch (e) {
    return { ok: false, error: `could not start ${cmd[0]}: ${(e as Error).message}`, backend };
  }
  proc.stdin.write(input.prompt);
  proc.stdin.end();
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, input.timeoutMs);
  const onAbort = () => proc.kill("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  const code = await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  if (timedOut) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
  if (signal?.aborted) return { ok: false, error: "aborted", backend };
  const out = (await stdout).trim();
  const err = (await stderr).trim();
  if (code !== 0) return { ok: false, error: (err || out || `exited with ${code}`).slice(-800), backend };
  const parsed = parseCliOutput(out);
  if (!parsed) {
    // A CLI without `--output-format json`: the whole output is the answer, no usage is known.
    return out ? { ok: true, text: out, backend } : { ok: false, error: "empty answer", backend };
  }
  if (parsed.error !== undefined) return { ok: false, error: parsed.error, usage: parsed.usage, costUsd: parsed.costUsd, backend };
  return { ok: true, text: parsed.text!, usage: parsed.usage, costUsd: parsed.costUsd, backend };
}

// ---------------------------------------------------------------- api

/** API list prices in USD per million tokens: input, cache write, cache read, output. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-4-5": [1, 1.25, 0.1, 5],
  "claude-sonnet-5": [2, 2.5, 0.2, 10],
  "claude-opus-5": [5, 6.25, 0.5, 25],
};

/** Cost of one API call from its usage, for the models whose prices are listed. */
export function apiCost(model: string, u: Usage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (u.inputTokens * p[0] + u.cacheWriteTokens * p[1] + u.cacheReadTokens * p[2] + u.outputTokens * p[3]) / 1e6;
}

async function runApi(input: RunInput, o: { apiKey: string; apiUrl: string; fetch: typeof fetch; signal?: AbortSignal }): Promise<RunOutcome> {
  const backend: Backend = "api";
  if (input.tools.length) return { ok: false, error: "tools need the CLI backend; the API backend has none", backend };
  const model = API_MODELS[input.model] ?? input.model;
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(input.timeoutMs)]) : AbortSignal.timeout(input.timeoutMs);
  let res: Response;
  try {
    res = await o.fetch(o.apiUrl, {
      method: "POST",
      headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: input.maxTokens, system: input.system, messages: [{ role: "user", content: input.prompt }] }),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? `timed out after ${Math.round(input.timeoutMs / 1000)}s` : err.message, backend };
  }
  const body = (await res.json().catch(() => ({}))) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    error?: { message?: string };
  };
  if (!res.ok) return { ok: false, error: `API ${res.status}: ${body.error?.message ?? "request failed"}`, backend };
  const u = body.usage;
  const usage: Usage | undefined = u
    ? { inputTokens: u.input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }
    : undefined;
  const costUsd = usage ? apiCost(model, usage) : undefined;
  const text = (body.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
  if (!text) return { ok: false, error: "empty answer", usage, costUsd, backend };
  return { ok: true, text, usage, costUsd, backend };
}
