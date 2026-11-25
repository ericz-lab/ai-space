import { classifyFailure, REST_KINDS, REST_MS, restFor, type FailureKind } from "../model/failure.ts";
import { retryAfterSeconds } from "../runtimes/anthropic-api.ts";
import { splitModelId } from "./config.ts";
import { carriesThinking, downstreamHeaders, errorText, readUsage, tapMessagesStream, upstreamHeaders } from "./forward.ts";
import { GatewayTokens } from "./tokens.ts";
import { costOf, pricedAnswer, type Price, type PriceBook } from "../prices/index.ts";
import { TraceStore } from "./trace.ts";
import { forwardsOf, kindOf } from "./kinds.ts";
import type { Usage } from "../runtimes/types.ts";
import type { GatewayBase, GatewayConfig, GatewayKind, GatewayLink, GatewayProvider, GatewayTiers } from "./types.ts";

const NO_USAGE: Usage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

/**
 * The built-in model gateway (docs/model-gateway.md): for one request, the providers that can take
 * it, in order; the request forwarded to the first, and to the next only when that one failed on
 * credit, quota, rate or transport (`REST_KINDS`, failure.ts) before any byte of its answer was
 * sent back. A provider that failed so rests (`restFor`) and goes after the others until its rest
 * ends. Within one run, a group keeps the member that first answered it, and a request that
 * carries a provider's signed thinking blocks goes to no other.
 */

/** One forwarded operation: the kind of base, the path under it, and how its answer is read. */
export type GatewayOperation = {
  base: GatewayBase;
  /** Appended to the base: `/v1/messages` on a messages base, `/audio/speech` on an openai one. */
  path: string;
  /** Read the answer's usage: from a Messages answer (JSON or SSE), an OpenAI JSON answer, or not at all. */
  usage: "messages" | "openai" | "none";
  /** A group's member that answers is kept for the run (conversations, not token counts). */
  pin: boolean;
  /** Errors the gateway itself answers are written in this protocol's shape. */
  errors: "anthropic" | "openai";
};

export type ModelGatewayOptions = {
  config?: GatewayConfig;
  /** Why `gateway.yaml` did not load; the gateway answers 503 with it. */
  error?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  tokens?: GatewayTokens;
  traces?: TraceStore;
  /** Prices for what answers cost (prices.ts); without one, runs carry tokens and no cost. */
  prices?: PriceBook;
};

type Rest = { until: number; streak: number; kind: FailureKind };

/** One provider as Settings shows it: its bases, whether it is on (and why not), and its rest. */
export type GatewayProviderView = {
  name: string;
  preset?: string;
  messages?: string;
  openai?: string;
  /** Why it is off (its key variable is empty); absent when it is on. */
  off?: string;
  /** Resting after a credit, quota, rate or transport failure: until when (ISO) and why. */
  resting?: { until: string; kind: FailureKind };
  /** Its `provider/model` ids in the model list. */
  models: string[];
};

/** The built-in model gateway as Settings shows it (docs/model-gateway.md#settings). */
export type GatewayView = {
  configured: boolean;
  /** Why it cannot answer; absent when it can. */
  problem?: string;
  providers: GatewayProviderView[];
  groups: Record<string, string[]>;
  /** `/v1/models` ids: groups first, then provider/model. */
  models: string[];
  /** The ids a picture can go to: a model of kind image on a provider that can draw (a group: one of its members). */
  imageModels: string[];
  /** Text models and groups: what the four tiers offer. */
  textModels: string[];
  /** Speech models (`provider/model`) on a provider that serves them: transcription and speech. */
  asrModels: string[];
  ttsModels: string[];
  tiers: GatewayTiers;
};

type Target = { id: string; provider: GatewayProvider; model: string };

type Body = { kind: "json"; value: Record<string, unknown> } | { kind: "form"; value: FormData };

export class ModelGateway {
  readonly tokens: GatewayTokens;
  readonly traces: TraceStore;
  readonly prices: PriceBook | undefined;
  private config: GatewayConfig | undefined;
  private error: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly rests = new Map<string, Rest>();
  private baseUrl: string | undefined;
  private offReason: string | undefined;
  private tierTable: GatewayTiers;

  constructor(opts: ModelGatewayOptions = {}) {
    this.config = opts.config;
    this.tierTable = { ...opts.config?.tiers };
    this.error = opts.error;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(`[model-gateway] ${l}`));
    this.tokens = opts.tokens ?? new GatewayTokens();
    this.traces = opts.traces ?? new TraceStore({ now: this.now });
    this.prices = opts.prices;
  }

  /** Configured (a `gateway.yaml` that loaded). */
  get enabled(): boolean {
    return Boolean(this.config);
  }

  /** Why a provider of the file is off (its key is empty, or it is turned off); undefined when it is on or unknown. */
  providerOff(name: string): string | undefined {
    return this.config?.off[name];
  }

  /**
   * Where ai-space listens, as its child processes reach the gateway; undefined (with the reason)
   * when it does not listen on loopback, since the gateway answers loopback only.
   */
  listen(base: string | undefined, reason?: string): void {
    this.baseUrl = base?.replace(/\/+$/, "");
    this.offReason = base ? undefined : reason;
  }

  /** What runtimes and the speech service hold of it. */
  readonly link: GatewayLink = {
    base: () => (this.config ? this.baseUrl : undefined),
    issue: () => this.tokens.issue(),
    trace: (run) => this.traces.get(run),
    provider: (name) => this.config?.providers.find((p) => p.name === name),
    price: (served) => this.priceOf(served),
    has: (base) => Boolean(this.config?.providers.some((p) => p[base] && !this.config!.off[p.name])),
    problem: () => this.problem(),
    tiers: () => ({ ...this.tierTable }),
    kindsOf: (id) => this.kindsOf(id),
    choices: () => {
      const v = this.view();
      return { text: v.textModels, image: v.imageModels };
    },
  };

  /** See `GatewayLink.kindsOf`. */
  kindsOf(id: string): GatewayKind[] | undefined {
    const config = this.config;
    if (!config) return undefined;
    const one = (member: string): GatewayKind | undefined => {
      const split = splitModelId(member);
      const p = split && config.providers.find((x) => x.name === split.provider);
      return p ? kindOf(p, split!.model) : undefined;
    };
    const members = config.groups[id];
    if (members) return [...new Set(members.map(one).filter((k): k is GatewayKind => Boolean(k)))];
    const k = one(id);
    return k ? [k] : undefined;
  }

  /** The price of `provider/model` now; null when that provider is not in gateway.yaml (or there are no prices). */
  priceOf(served: string): Price | undefined | null {
    const id = splitModelId(served);
    const provider = id && this.config?.providers.find((p) => p.name === id.provider);
    if (!id || !provider || !this.prices) return null;
    return this.prices.lookupSync(provider, id.model)?.price;
  }

  /**
   * gateway.yaml as it is now, read again after Settings → Gateway changed it (or the file is
   * gone: off). The next request uses it; a request already forwarded finishes as it started.
   * Rests of providers that are still there stay; traces stay.
   */
  reload(next: { config?: GatewayConfig; error?: string }): void {
    this.config = next.config;
    this.error = next.error;
    this.tierTable = { ...next.config?.tiers };
    for (const name of [...this.rests.keys()]) if (!next.config?.providers.some((p) => p.name === name)) this.rests.delete(name);
    for (const l of this.reloaded) l();
  }

  private readonly reloaded: (() => void)[] = [];

  /** Called after gateway.yaml was read again: a provider's site or preset decides its prices. */
  onReload(listener: () => void): void {
    this.reloaded.push(listener);
  }

  /**
   * New tiers, as Settings saved them to gateway.yaml: the next call of every runtime with
   * `gateway: space` resolves its tiers from them, without a restart. False when it is off.
   */
  setTiers(tiers: GatewayTiers): boolean {
    if (!this.config) return false;
    this.tierTable = { ...tiers };
    return true;
  }

  /** What Settings shows: whether it answers, each provider with its bases, state and models, the model list and the tiers. */
  view(): GatewayView {
    const problem = this.problem();
    const list = this.models().data;
    const models = list.map((m) => String(m.id));
    if (!this.config) return { configured: false, ...(problem ? { problem } : {}), providers: [], groups: {}, models, imageModels: [], textModels: [], asrModels: [], ttsModels: [], tiers: {} };
    const config = this.config;
    const now = this.now();
    const providers = config.providers.map((p): GatewayProviderView => {
      const r = this.rests.get(p.name);
      return {
        name: p.name,
        ...(p.preset ? { preset: p.preset } : {}),
        ...(p.messages ? { messages: p.messages } : {}),
        ...(p.openai ? { openai: p.openai } : {}),
        ...(config.off[p.name] ? { off: config.off[p.name] } : {}),
        ...(r && r.until > now ? { resting: { until: new Date(r.until).toISOString(), kind: r.kind } } : {}),
        models: models.filter((id) => id.startsWith(`${p.name}/`)),
      };
    });
    // A model counts for a kind when it is of that kind and the gateway forwards it to its provider (kinds.ts).
    const is = (kind: GatewayKind) => (id: string) => {
      const split = splitModelId(id);
      const p = split && config.providers.find((x) => x.name === split.provider);
      return Boolean(p && kindOf(p, split!.model) === kind && forwardsOf(p)[kind] === true);
    };
    const ofKind = (kind: GatewayKind, groups: boolean) => models.filter((id) => (config.groups[id] ? groups && config.groups[id]!.some(is(kind)) : is(kind)(id)));
    return {
      configured: true, ...(problem ? { problem } : {}), providers, groups: { ...config.groups }, models,
      imageModels: ofKind("image", true), textModels: ofKind("text", true), asrModels: ofKind("asr", false), ttsModels: ofKind("tts", false),
      tiers: { ...this.tierTable },
    };
  }

  problem(): string | undefined {
    if (this.error) return this.error;
    if (!this.config) return "no gateway.yaml in the workspace: the built-in model gateway is off";
    if (!this.baseUrl) return this.offReason ?? "the built-in model gateway is not listening yet";
    if (!this.config.providers.length) return "gateway.yaml has no provider yet";
    if (this.config.providers.every((p) => this.config!.off[p.name])) return `every provider of gateway.yaml is off (${Object.values(this.config.off).join("; ")})`;
    return undefined;
  }

  /** The model list, in the OpenAI-style shape magpie's `/v1/models` answers (`readCatalog` reads it). */
  models(): { object: "list"; data: Record<string, unknown>[] } {
    const data: Record<string, unknown>[] = [];
    if (!this.config) return { object: "list", data };
    const seen = new Set<string>();
    for (const [name, members] of Object.entries(this.config.groups)) {
      data.push({ id: name, object: "model", owned_by: "group", kind: "group", members });
      seen.add(name);
    }
    for (const p of this.config.providers) {
      if (this.config.off[p.name]) continue;
      const ids = [...p.models.map((m) => `${p.name}/${m}`), ...Object.values(this.config.groups).flat().filter((id) => id.startsWith(`${p.name}/`))];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        // `kind` says what the model is for (text, asr, tts, image); magpie's reader takes only `kind: "group"` as a group.
        data.push({ id, object: "model", owned_by: p.name, bases: (["messages", "openai"] as const).filter((b) => p[b]), kind: kindOf(p, id.slice(p.name.length + 1)) });
      }
    }
    return { object: "list", data };
  }

  /**
   * Forward one request under a run token. `req` is the caller's; its body is read here and sent
   * on with only `model` changed. The answer is the provider's, unchanged, or the gateway's own
   * error in the operation's protocol when no provider could take the request.
   */
  async forward(req: Request, op: GatewayOperation, run: string): Promise<Response> {
    if (!this.config) return this.refuse(op, 503, this.problem() ?? "the built-in model gateway is off");
    let body: Body;
    try {
      body = await readBody(req);
    } catch (e) {
      return this.refuse(op, 400, (e as Error).message);
    }
    const requested = body.kind === "json" ? body.value.model : body.value.get("model");
    if (typeof requested !== "string" || !requested.trim()) return this.refuse(op, 400, "the request names no model: send provider/model or a group of gateway.yaml");
    const plan = this.plan(requested.trim(), op, run, body);
    if ("error" in plan) {
      this.traces.note(run, { tried: [], error: plan.error });
      return this.refuse(op, plan.status, plan.error);
    }

    const tried: string[] = [];
    let last: { status: number; headers: Headers; bytes: ArrayBuffer; served: string } | undefined;
    let lastError = "";
    for (const [i, t] of plan.targets.entries()) {
      if (req.signal.aborted) break;
      tried.push(t.id);
      const url = `${t.provider[op.base]}${op.path}${new URL(req.url).search}`;
      const outgoing = rewrite(body, t.model);
      let res: Response;
      try {
        res = await this.fetch(url, { method: "POST", headers: upstreamHeaders(req.headers, { apiKey: t.provider.apiKey, auth: op.base === "openai" ? "bearer" : t.provider.auth }, { dropContentType: outgoing instanceof FormData }), body: outgoing, signal: req.signal, redirect: "manual" });
      } catch (e) {
        if (req.signal.aborted) break;
        lastError = `${t.id}: unreachable: ${(e as Error).message}`;
        last = undefined;
        this.rest(t.provider.name, classifyFailure(`fetch failed: ${(e as Error).message}`, this.now()).kind);
        if (i < plan.targets.length - 1) this.log(`${t.id} unreachable; trying ${plan.targets[i + 1]!.id}`);
        continue;
      }
      if (res.ok) {
        this.rests.delete(t.provider.name);
        this.traces.note(run, { tried, served: t.id, requested: plan.requested, pin: op.pin && plan.group });
        return this.answer(res, op, run, t);
      }
      const bytes = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
      const wait = retryAfterSeconds(res.headers.get("retry-after"));
      lastError = `API ${res.status}: ${errorText(new Uint8Array(bytes))}${wait !== undefined ? ` (retry after ${wait}s)` : ""}`;
      last = { status: res.status, headers: res.headers, bytes, served: t.id };
      const failure = classifyFailure(lastError, this.now());
      if (!REST_KINDS.has(failure.kind)) break;
      this.rest(t.provider.name, failure.kind, failure.resetsAt);
      if (i < plan.targets.length - 1) this.log(`${t.id} failed (${failure.kind}); trying ${plan.targets[i + 1]!.id}`);
    }
    this.traces.note(run, { tried, error: lastError || "aborted" });
    // Every provider refused: the last refusal goes back as the provider wrote it.
    if (last) return new Response(last.bytes, { status: last.status, headers: downstreamHeaders(last.headers, last.served) });
    if (req.signal.aborted) return this.refuse(op, 499, "the caller went away");
    return this.refuse(op, 502, lastError || "no provider could take the request");
  }

  /** The providers that can take this request, in the order they are tried. */
  private plan(requested: string, op: GatewayOperation, run: string, body: Body): { targets: Target[]; requested: string; group: boolean } | { error: string; status: number } {
    const config = this.config!;
    const group = config.groups[requested];
    const ids = group ?? (splitModelId(requested) ? [requested] : undefined);
    if (!ids) return { error: `unknown model ${requested}: name it provider/model or one of the groups of gateway.yaml (${Object.keys(config.groups).join(", ") || "none"})`, status: 400 };
    const skipped: string[] = [];
    const usable: Target[] = [];
    for (const id of ids) {
      const { provider: name, model } = splitModelId(id)!;
      const provider = config.providers.find((p) => p.name === name);
      if (!provider) skipped.push(`${id}: no provider ${name} in gateway.yaml`);
      else if (config.off[name]) skipped.push(`${id}: provider ${name} is off (${config.off[name]})`);
      else if (!provider[op.base]) skipped.push(`${id}: provider ${name} has no ${op.base} base`);
      else usable.push({ id, provider, model });
    }
    if (!usable.length) return { error: `no provider can take ${requested}: ${skipped.join("; ")}`, status: skipped.some((s) => s.includes(" is off ")) ? 503 : 400 };
    // Resting providers go after the others, each group in its configured order; never dropped.
    const now = this.now();
    let order = [...usable.filter((t) => !this.resting(t.provider.name, now)), ...usable.filter((t) => this.resting(t.provider.name, now))];
    const pinned = group ? this.traces.pinned(run, requested) : undefined;
    if (pinned) {
      const first = order.find((t) => t.id === pinned);
      if (first) {
        // A provider's signed thinking blocks are refused by another one: such a request stays put.
        order = body.kind === "json" && carriesThinking(body.value) ? [first] : [first, ...order.filter((t) => t !== first)];
      }
    }
    return { targets: order, requested, group: Boolean(group) };
  }

  private resting(provider: string, now: number): boolean {
    const r = this.rests.get(provider);
    return Boolean(r && r.until > now);
  }

  private rest(provider: string, kind: FailureKind, resetsAt?: number): void {
    if (!REST_KINDS.has(kind)) return;
    const now = this.now();
    const prev = this.rests.get(provider);
    const streak = prev && prev.kind === kind && now - prev.until < REST_MS.forget ? prev.streak + 1 : 1;
    const r = restFor({ kind, ...(resetsAt ? { resetsAt } : {}) }, now, streak);
    if (r) this.rests.set(provider, { until: r.until, streak, kind });
  }

  /** The provider's answer, its bytes unchanged, its usage read on the side. */
  private async answer(res: Response, op: GatewayOperation, run: string, t: Target): Promise<Response> {
    const served = t.id;
    const headers = downstreamHeaders(res.headers, served);
    // The price of the model that answered, at this provider (the file re-read only when it changed).
    await this.prices?.reload().catch(() => {});
    const found = this.prices?.lookupSync(t.provider, t.model);
    const record = (u: Usage | undefined, images = 0) => {
      const answer = pricedAnswer(served, u, { images });
      const costUsd = found ? costOf(found.price, answer) : undefined;
      this.traces.addUsage(run, u ?? NO_USAGE, this.prices ? { answer, ...(costUsd !== undefined ? { costUsd } : {}) } : undefined);
    };
    const type = res.headers.get("content-type") ?? "";
    if (!res.body || op.usage === "none") return new Response(res.body, { status: res.status, headers });
    if (op.usage === "messages" && type.includes("text/event-stream")) {
      return new Response(tapMessagesStream(res.body, (u) => u && record(u)), { status: res.status, headers });
    }
    if (!type.includes("json")) return new Response(res.body, { status: res.status, headers });
    const bytes = await res.arrayBuffer();
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { usage?: unknown; data?: unknown };
      const u = readUsage(body.usage);
      // Pictures are counted: a vendor that prices per picture often reports no tokens for them.
      const images = op.path.startsWith("/images/") && res.ok && Array.isArray(body.data) ? body.data.length : 0;
      if (u || images) record(u, images);
    } catch {
      /* not JSON after all: passed on as it is */
    }
    return new Response(bytes, { status: res.status, headers });
  }

  /** An error the gateway answers itself, in the caller's protocol. */
  refuse(op: Pick<GatewayOperation, "errors">, status: number, message: string): Response {
    const body = op.errors === "anthropic"
      ? { type: "error", error: { type: status === 401 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error", message } }
      : { error: { message, type: status === 401 ? "invalid_api_key" : status === 400 ? "invalid_request_error" : "api_error" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}

/** The request body: a JSON object, or a multipart form (audio transcriptions, image edits). */
async function readBody(req: Request): Promise<Body> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    try {
      return { kind: "form", value: await req.formData() };
    } catch {
      throw new Error("the body is not a valid multipart form");
    }
  }
  let value: unknown;
  try {
    value = await req.json();
  } catch {
    throw new Error("the body must be JSON or a multipart form");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the body must be a JSON object");
  return { kind: "json", value: value as Record<string, unknown> };
}

/** The body for one provider: the same, with its own name for the model. */
function rewrite(body: Body, model: string): string | FormData {
  if (body.kind === "json") return JSON.stringify({ ...body.value, model });
  const form = new FormData();
  for (const [k, v] of body.value) {
    if (k === "model") form.append(k, model);
    else if (typeof v === "string") form.append(k, v);
    else form.append(k, v, (v as File).name);
  }
  return form;
}
