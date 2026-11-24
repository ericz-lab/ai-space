import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { bearer, isOperator, tokenEquals } from "../auth.ts";
import { addGatewayRuntimeText, writeAtomic } from "../model/inventory.ts";
import { editEnvFile } from "../peers/rename.ts";
import { RUNTIMES_FILE, parseRuntimesYaml } from "../runtimes/config.ts";
import type { RuntimeRegistry } from "../runtimes/registry.ts";
import type { RuntimeSpec } from "../runtimes/types.ts";
import { readWorkspaceEnv } from "../workspace.ts";
import { GATEWAY_FILE, GATEWAY_PRESETS, parseGatewayYaml, setGatewayTiersText, splitModelId, tierProblem } from "./config.ts";
import { GatewayEditError, PAGE_KEY_PREFIX, type ProviderEntry, editProblem, pageKeyVar, removeEnvKeysText, setEnvKeyText, setGroupsText, setProviderText } from "./edit.ts";
import type { ModelGateway } from "./service.ts";
import { GATEWAY_AUTH, GATEWAY_KINDS, type GatewayKind, GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN, GATEWAY_TIERS, type GatewayAuth, type GatewayConfig, type GatewayProvider, type GatewayTier, type GatewayTiers } from "./types.ts";
import { PRICES_FILE } from "./prices.ts";
import { createGatewayMediaRoutes, type MediaOptions } from "./settings-media.ts";
import { documentedIds, documentedKind, kindOf, servesOf } from "./kinds.ts";
import { VENDORS, customList, fetchModelList, presetList, redact, testProvider } from "./vendors.ts";

/**
 * Settings → Gateway (docs/model-gateway.md#settings): the built-in model gateway configured from
 * the browser. Every route is the operator's (the owner's session, a device credential or the
 * operator token) and refuses an app's or a consumer's credential whatever `SPACE_AUTH` is.
 * `gateway.yaml` stays the source of truth: each change edits its text (edit.ts), then the running
 * gateway reads it again, so the next call uses it without a restart.
 *
 *   GET    /api/model/gateway                          the section: file, providers (with key state, never the key), groups, tiers, presets, runtimes
 *   POST   /api/model/gateway/providers                {name, preset?, messages?, openai?, auth?, key?, apiKeyEnv?, models}
 *   PUT    /api/model/gateway/providers/:name          {messages?, openai?, auth?, models?, disabled?}
 *   PUT    /api/model/gateway/providers/:name/key      {key}: replace (or set) its key
 *   DELETE /api/model/gateway/providers/:name?key=delete|keep   remove it; groups lose its members, tiers naming it are cleared
 *   POST   /api/model/gateway/providers/:name/test     {model?}: one minimal request per base, with latency
 *   POST   /api/model/gateway/models                   {provider} or {preset|messages|openai, auth?, key?}: the vendor's model list
 *   PUT    /api/model/gateway/groups                   {groups: {name: [provider/model, …]}}
 *   PUT    /api/model/gateway/tiers                    {tiers}
 *   POST   /api/model/gateway/runtimes                 {kind: claude-code | anthropic-api}: a runtime through it, in runtimes.yaml
 *
 * Keys: a key typed in the page goes to the workspace `.env` (mode kept, 0600 when created) under
 * `SPACE_GATEWAY_<NAME>_KEY`, and into the running environment, the way a hub's token is stored
 * by peers/adopt.ts. `gateway.yaml` names the variable. No answer, log line or error carries a key:
 * the page sees whether one is set, where from, and its last four characters.
 */

export type GatewaySettingsOptions = {
  gateway: ModelGateway;
  runtimes: RuntimeRegistry;
  /** The workspace, where gateway.yaml and runtimes.yaml live. */
  home: string;
  /** The workspace `.env`. */
  envFile: string;
  /** The running environment: keys written here apply at once. */
  env: Record<string, string | undefined>;
  token: string;
  /** An app's token or an external consumer's key: refused here in every mode. */
  isAppCredential: (token: string) => Promise<boolean>;
  /** Claude Code on this machine (its absolute path), for the runtime offer. */
  claude: () => string | undefined;
  /** Why the built-in gateway cannot exist on this space (ai-space does not listen on loopback); undefined when it can. */
  unavailable?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /** A runtime was added while ai-space runs (probe it). */
  onRuntimeAdded?: (name: string) => void;
  /** The speech service as it runs, and how to have it read providers.yaml again (the Speech group; settings-media.ts). */
  speech?: MediaOptions["speech"];
  reloadSpeech?: () => Promise<void>;
};

/** A provider's key as the page sees it: never the value. */
export type KeyState = { state: "workspace" | "environment" | "none"; last4?: string; page: boolean; variable?: string };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
type Req = Request & { params?: Record<string, string> };

export function createGatewaySettingsRoutes(o: GatewaySettingsOptions) {
  const file = join(o.home, GATEWAY_FILE);
  const runtimesFile = join(o.home, RUNTIMES_FILE);
  const doFetch = o.fetch ?? fetch;
  const log = o.log ?? ((l: string) => console.log(`[model-gateway] ${l}`));

  /** The operator, and never an app: undefined when the request may go on. */
  async function refuse(req: Request): Promise<Response | undefined> {
    const presented = bearer(req);
    // Under SPACE_AUTH=external with no operator token every request is the operator; an app's credential still is not.
    if (presented && !tokenEquals(presented, o.token) && (await o.isAppCredential(presented))) return json({ ok: false, error: "apps may not configure the model gateway" }, 403);
    if (!isOperator(req, o.token)) return json({ ok: false, error: "unauthorized" }, 401);
    return undefined;
  }

  const read = async (): Promise<string | undefined> => {
    const f = Bun.file(file);
    return (await f.exists()) ? await f.text() : undefined;
  };

  const workspaceEnv = () => readWorkspaceEnv({ envFile: o.envFile } as Parameters<typeof readWorkspaceEnv>[0]);

  async function keyState(variable: string | undefined): Promise<KeyState> {
    if (!variable) return { state: "none", page: false };
    const value = o.env[variable]?.trim();
    const page = variable.startsWith(PAGE_KEY_PREFIX);
    if (!value) return { state: "none", page, variable };
    const fromFile = (await workspaceEnv())[variable];
    return { state: fromFile !== undefined && fromFile.trim() === value ? "workspace" : "environment", page, variable, ...(value.length >= 12 ? { last4: value.slice(-4) } : {}) };
  }

  /** Write gateway.yaml (its mode kept) and have the running gateway read it again. */
  async function apply(text: string): Promise<void> {
    let mode: number | undefined;
    try {
      mode = (await stat(file)).mode & 0o777;
    } catch { /* a new file */ }
    await writeAtomic(file, text, mode);
    reload(text);
    // Speech through the gateway checks its providers at load (one removed or turned off is off there too).
    await o.reloadSpeech?.().catch((e) => log(`speech did not reload: ${(e as Error).message}`));
  }
  function reload(text: string | undefined): void {
    if (text === undefined) return o.gateway.reload({});
    try {
      const loaded = parseGatewayYaml(text, o.env);
      o.gateway.reload({ config: loaded.config });
      for (const w of loaded.warnings) log(w);
    } catch (e) {
      o.gateway.reload({ error: (e as Error).message });
    }
  }

  function setKey(variable: string, value: string): void {
    editEnvFile(o.envFile, (text) => setEnvKeyText(text, variable, value), { create: true });
    o.env[variable] = value;
  }
  function deleteKey(variable: string): void {
    try {
      editEnvFile(o.envFile, (text) => removeEnvKeysText(text, [variable]));
    } catch { /* no .env */ }
    delete o.env[variable];
  }

  /** The file's config, or a refusal: no file, or one the page cannot edit. */
  async function editable(): Promise<{ text: string; config: GatewayConfig } | Response> {
    const text = await read();
    if (text === undefined) return json({ ok: false, error: `there is no ${GATEWAY_FILE} yet: add a provider first` }, 404);
    const why = editProblem(text, o.env);
    if (why) return json({ ok: false, error: `${GATEWAY_FILE} cannot be edited here: ${why}` }, 409);
    return { text, config: parseGatewayYaml(text, o.env).config };
  }

  const failed = (e: unknown, key?: string) => json({ ok: false, error: redact((e as Error).message, key) }, e instanceof GatewayEditError ? 409 : 400);

  /** The fields of a parsed provider the file states itself (a base equal to its preset's is the preset's). */
  function entryOf(p: GatewayProvider): ProviderEntry {
    const preset = p.preset ? GATEWAY_PRESETS[p.preset] : undefined;
    return {
      ...(p.preset ? { preset: p.preset } : {}),
      ...(p.messages && p.messages !== preset?.messages ? { messages: p.messages } : {}),
      ...(p.openai && p.openai !== preset?.openai ? { openai: p.openai } : {}),
      ...(p.auth !== (preset?.auth ?? "bearer") ? { auth: p.auth } : {}),
      ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
      models: [...p.models],
      ...(p.disabled ? { disabled: true } : {}),
      ...(p.kinds ? { kinds: { ...p.kinds } } : {}),
    };
  }

  /**
   * The kinds a request asks for, as the file keeps them: only where they differ from what the
   * vendor's documented rule (or text) already gives, so the file says only what the owner decided.
   */
  const kindsBody = (v: unknown, list: string[], preset: string | undefined): Record<string, GatewayKind> | undefined | Response => {
    if (v === undefined) return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) return json({ ok: false, error: `kinds must map a model to ${GATEWAY_KINDS.join(", ")}` }, 400);
    const out: Record<string, GatewayKind> = {};
    for (const [m, k] of Object.entries(v as Record<string, unknown>)) {
      if (typeof k !== "string" || !(GATEWAY_KINDS as readonly string[]).includes(k)) return json({ ok: false, error: `kinds.${m} must be one of ${GATEWAY_KINDS.join(", ")}` }, 400);
      if (!list.includes(m)) continue;
      if (k !== (documentedKind(preset, m) ?? "text")) out[m] = k as GatewayKind;
    }
    return out;
  };

  /** Where a provider is used: groups with its members, tiers naming it (directly, or a group that would be emptied). */
  function usedBy(config: GatewayConfig, name: string): { groups: string[]; tiers: GatewayTier[]; emptied: string[] } {
    const groups = Object.entries(config.groups).filter(([, m]) => m.some((id) => splitModelId(id)?.provider === name)).map(([g]) => g);
    const emptied = groups.filter((g) => config.groups[g]!.every((id) => splitModelId(id)?.provider === name));
    const tiers = GATEWAY_TIERS.filter((t) => {
      const v = config.tiers[t];
      return v !== undefined && (splitModelId(v)?.provider === name || emptied.includes(v));
    });
    return { groups, tiers, emptied };
  }

  async function view(): Promise<Response> {
    const text = await read();
    const live = o.gateway.view();
    let config: GatewayConfig | undefined;
    let error: string | undefined;
    if (text !== undefined) {
      try {
        config = parseGatewayYaml(text, o.env).config;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    const readOnly = text !== undefined ? editProblem(text, o.env) : undefined;
    await o.gateway.prices?.reload().catch(() => {});
    /** Each listed model's effective price and where it came from (null: none, its calls go unpriced), then the price file's other models of it. */
    const pricesOf = (p: GatewayProvider) => Object.fromEntries([...new Set([...p.models, ...(o.gateway.prices?.fileModels(p.name) ?? [])])].map((m) => {
      const found = o.gateway.prices?.lookupSync(p, m);
      return [m, found ? { ...found.price, source: found.source } : null];
    }));
    const providers = await Promise.all(
      (config?.providers ?? []).map(async (p) => {
        const l = live.providers.find((x) => x.name === p.name);
        return {
          name: p.name,
          ...(p.preset ? { preset: p.preset, label: VENDORS[p.preset]?.label ?? p.preset } : {}),
          ...(p.messages ? { messages: p.messages } : {}),
          ...(p.openai ? { openai: p.openai } : {}),
          auth: p.auth,
          key: await keyState(p.apiKeyEnv),
          disabled: Boolean(p.disabled),
          ...(config!.off[p.name] ? { off: config!.off[p.name] } : {}),
          ...(l?.resting ? { resting: l.resting } : {}),
          models: p.models,
          // What each listed model is for, and whether the file says so or a documented rule does.
          kinds: Object.fromEntries(p.models.map((m) => [m, kindOf(p, m)])),
          kindSet: Object.keys(p.kinds ?? {}),
          serves: servesOf(p),
          // Picture models the vendor documents that the provider does not list yet: the Pictures group adds one in a click.
          ...(servesOf(p).image === true ? { imageOffer: documentedIds(p.preset, "image").filter((m) => !p.models.includes(m)) } : {}),
          ...(o.gateway.prices ? { prices: pricesOf(p) } : {}),
          usedBy: usedBy(config!, p.name),
        };
      }),
    );
    const rconfig = await runtimesConfig();
    const loaded = new Set(o.runtimes.list().map((r) => r.name));
    const specs = rconfig ? rconfig.runtimes : o.runtimes.list().map((r) => o.runtimes.spec(r.name)).filter((x): x is RuntimeSpec => Boolean(x));
    const runtimes = specs.filter(throughSpace).map((s) => ({ runtime: s.name, kind: s.kind, models: { ...s.models }, loaded: loaded.has(s.name) }));
    return json({
      ok: true,
      file,
      exists: text !== undefined,
      ...(o.unavailable ? { unavailable: o.unavailable } : {}),
      ...(readOnly ? { readOnly, text } : {}),
      ...(error ?? live.problem ? { problem: error ?? live.problem } : {}),
      answers: Boolean(config) && !live.problem,
      providers,
      groups: config?.groups ?? {},
      tiers: config?.tiers ?? {},
      models: live.models,
      imageModels: live.imageModels,
      textModels: live.textModels,
      asrModels: live.asrModels,
      ttsModels: live.ttsModels,
      presets: presetList(),
      ...(o.gateway.prices ? { pricing: { file: join(o.home, PRICES_FILE), ...o.gateway.prices.status() } } : {}),
      runtimes,
      offer: { claude: Boolean(o.claude()) },
    });
  }

  async function runtimesConfig() {
    const f = Bun.file(runtimesFile);
    if (!(await f.exists())) return undefined;
    try {
      return parseRuntimesYaml(await f.text(), o.env).config;
    } catch {
      return undefined;
    }
  }

  const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
  const models = (v: unknown): string[] | Response => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((m) => typeof m === "string" && GATEWAY_MODEL_PATTERN.test(m.trim()))) return json({ ok: false, error: "models must be a list of model ids" }, 400);
    return [...new Set((v as string[]).map((m) => m.trim()))];
  };

  async function addProvider(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const key = str(body?.key);
    if (!body) return json({ ok: false, error: "the body must be JSON" }, 400);
    const name = str(body.name) ?? "";
    if (!GATEWAY_NAME_PATTERN.test(name)) return json({ ok: false, error: "name: lowercase letters, digits and -, starting with a letter" }, 400);
    const preset = str(body.preset) || undefined;
    if (preset && !GATEWAY_PRESETS[preset]) return json({ ok: false, error: `preset must be one of ${Object.keys(GATEWAY_PRESETS).join(", ")}` }, 400);
    const auth = str(body.auth) || undefined;
    if (auth && !(GATEWAY_AUTH as readonly string[]).includes(auth)) return json({ ok: false, error: "auth must be x-api-key or bearer" }, 400);
    const list = models(body.models);
    if (list instanceof Response) return list;
    const apiKeyEnvAsked = str(body.apiKeyEnv) || undefined;
    if (apiKeyEnvAsked && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnvAsked)) return json({ ok: false, error: "apiKeyEnv must name an environment variable" }, 400);
    if (preset && !key && !apiKeyEnvAsked) return json({ ok: false, error: "paste the provider's API key" }, 400);
    const text = await read();
    if (text !== undefined) {
      const why = editProblem(text, o.env);
      if (why) return json({ ok: false, error: `${GATEWAY_FILE} cannot be edited here: ${why}` }, 409);
      if (parseGatewayYaml(text, o.env).config.providers.some((p) => p.name === name)) return json({ ok: false, error: `there is already a provider ${name}` }, 409);
    }
    let variable = apiKeyEnvAsked;
    let wrote = false;
    if (key) {
      variable = pageKeyVar(name);
      const state = await keyState(variable);
      if (state.state === "environment") return json({ ok: false, error: `${variable} is set by the environment ai-space runs in; change it there, or remove it, then add the key here` }, 409);
      setKey(variable, key);
      wrote = true;
    }
    const kinds = kindsBody(body.kinds, list, preset);
    if (kinds instanceof Response) {
      if (wrote) deleteKey(variable!);
      return kinds;
    }
    const entry: ProviderEntry = { ...(preset ? { preset } : {}), ...(str(body.messages) ? { messages: str(body.messages)!.replace(/\/+$/, "") } : {}), ...(str(body.openai) ? { openai: str(body.openai)!.replace(/\/+$/, "") } : {}), ...(auth ? { auth: auth as GatewayAuth } : {}), ...(variable ? { apiKeyEnv: variable } : {}), models: list, ...(kinds && Object.keys(kinds).length ? { kinds } : {}) };
    try {
      const next = setProviderText(text, name, entry, o.env);
      await apply(next);
    } catch (e) {
      if (wrote) deleteKey(variable!);
      return failed(e, key);
    }
    log(`provider ${name} added from Settings${variable ? ` (key in ${variable})` : ""}`);
    return json({ ok: true, provider: name, created: text === undefined });
  }

  async function editProvider(req: Req): Promise<Response> {
    const name = req.params?.name ?? "";
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ ok: false, error: "the body must be JSON" }, 400);
    const f = await editable();
    if (f instanceof Response) return f;
    const p = f.config.providers.find((x) => x.name === name);
    if (!p) return json({ ok: false, error: `no provider ${name}` }, 404);
    const entry = entryOf(p);
    for (const base of ["messages", "openai"] as const) {
      if (body[base] === undefined) continue;
      const v = str(body[base]);
      if (v) entry[base] = v.replace(/\/+$/, "");
      else delete entry[base];
    }
    if (body.auth !== undefined) {
      const auth = str(body.auth);
      if (!auth || !(GATEWAY_AUTH as readonly string[]).includes(auth)) return json({ ok: false, error: "auth must be x-api-key or bearer" }, 400);
      entry.auth = auth as GatewayAuth;
    }
    if (body.models !== undefined) {
      const list = models(body.models);
      if (list instanceof Response) return list;
      entry.models = list;
      // Kinds of models no longer listed go with them.
      if (entry.kinds) entry.kinds = Object.fromEntries(Object.entries(entry.kinds).filter(([m]) => list.includes(m)));
    }
    if (body.kinds !== undefined) {
      const kinds = kindsBody(body.kinds, entry.models, p.preset);
      if (kinds instanceof Response) return kinds;
      entry.kinds = { ...(entry.kinds ?? {}), ...kinds };
      // A kind set back to what the rule gives leaves the file.
      for (const [m, k] of Object.entries(body.kinds as Record<string, string>)) if (k === (documentedKind(p.preset, m) ?? "text")) delete entry.kinds[m];
    }
    if (entry.kinds && !Object.keys(entry.kinds).length) delete entry.kinds;
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return json({ ok: false, error: "disabled must be true or false" }, 400);
      if (body.disabled) entry.disabled = true;
      else delete entry.disabled;
    }
    try {
      await apply(setProviderText(f.text, name, entry, o.env));
    } catch (e) {
      return failed(e);
    }
    return json({ ok: true, provider: name });
  }

  async function replaceKey(req: Req): Promise<Response> {
    const name = req.params?.name ?? "";
    const body = (await req.json().catch(() => null)) as { key?: unknown } | null;
    const key = str(body?.key);
    if (!key) return json({ ok: false, error: "paste the new key" }, 400);
    const f = await editable();
    if (f instanceof Response) return f;
    const p = f.config.providers.find((x) => x.name === name);
    if (!p) return json({ ok: false, error: `no provider ${name}` }, 404);
    const variable = p.apiKeyEnv ?? pageKeyVar(name);
    const state = await keyState(variable);
    if (state.state === "environment") return json({ ok: false, error: `${variable} is set by the environment ai-space runs in; change it there` }, 409);
    setKey(variable, key);
    try {
      if (!p.apiKeyEnv) await apply(setProviderText(f.text, name, { ...entryOf(p), apiKeyEnv: variable }, o.env));
      else reload(f.text);
    } catch (e) {
      return failed(e, key);
    }
    log(`provider ${name}: key replaced from Settings (${variable})`);
    return json({ ok: true, provider: name, key: await keyState(variable) });
  }

  async function removeProvider(req: Req): Promise<Response> {
    const name = req.params?.name ?? "";
    const keyMode = new URL(req.url).searchParams.get("key") ?? "auto";
    if (!["auto", "delete", "keep"].includes(keyMode)) return json({ ok: false, error: "key must be delete, keep or auto" }, 400);
    const f = await editable();
    if (f instanceof Response) return f;
    const p = f.config.providers.find((x) => x.name === name);
    if (!p) return json({ ok: false, error: `no provider ${name}` }, 404);
    const used = usedBy(f.config, name);
    const groups: Record<string, string[]> = {};
    for (const [g, members] of Object.entries(f.config.groups)) {
      const left = members.filter((id) => splitModelId(id)?.provider !== name);
      if (left.length) groups[g] = left;
    }
    const tiers: GatewayTiers = { ...f.config.tiers };
    for (const t of used.tiers) delete tiers[t];
    let text = f.text;
    try {
      if (used.groups.length) text = setGroupsText(text, groups, o.env);
      if (used.tiers.length) text = setGatewayTiersText(text, tiers, o.env);
      text = setProviderText(text, name, null, o.env);
      await apply(text);
    } catch (e) {
      return failed(e);
    }
    // Asked, or by default only a key this page created; one from the environment is never touched.
    const state = await keyState(p.apiKeyEnv);
    const shared = f.config.providers.some((x) => x.name !== name && x.apiKeyEnv === p.apiKeyEnv);
    const del = p.apiKeyEnv && state.state === "workspace" && !shared && (keyMode === "delete" || (keyMode === "auto" && state.page));
    if (del) deleteKey(p.apiKeyEnv!);
    log(`provider ${name} removed from Settings${del ? `, its key ${p.apiKeyEnv} deleted` : ""}`);
    return json({ ok: true, provider: name, cleared: { groups: used.groups, emptied: used.emptied, tiers: used.tiers }, keyDeleted: Boolean(del) });
  }

  async function listModels(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ ok: false, error: "the body must be JSON" }, 400);
    let key = str(body.key) || undefined;
    let preset = str(body.preset) || undefined;
    let bases: { messages?: string; openai?: string; auth: GatewayAuth };
    const providerName = str(body.provider);
    if (providerName) {
      const text = await read();
      const p = text === undefined ? undefined : parseGatewayYaml(text, o.env).config.providers.find((x) => x.name === providerName);
      if (!p) return json({ ok: false, error: `no provider ${providerName}` }, 404);
      preset = p.preset;
      bases = { ...(p.messages ? { messages: p.messages } : {}), ...(p.openai ? { openai: p.openai } : {}), auth: p.auth };
      key ??= p.apiKeyEnv ? o.env[p.apiKeyEnv]?.trim() || undefined : undefined;
    } else {
      if (preset && !GATEWAY_PRESETS[preset]) return json({ ok: false, error: "unknown preset" }, 400);
      const pre: { messages?: string; openai?: string; auth?: GatewayAuth } = preset ? GATEWAY_PRESETS[preset]! : {};
      const auth = (str(body.auth) || pre.auth || "bearer") as GatewayAuth;
      if (!(GATEWAY_AUTH as readonly string[]).includes(auth)) return json({ ok: false, error: "auth must be x-api-key or bearer" }, 400);
      const m = str(body.messages)?.replace(/\/+$/, "") || pre.messages;
      const oa = str(body.openai)?.replace(/\/+$/, "") || pre.openai;
      for (const u of [m, oa]) if (u && !/^https?:\/\/[^\s?#]+$/.test(u)) return json({ ok: false, error: "a base must be an http(s) URL" }, 400);
      bases = { ...(m ? { messages: m } : {}), ...(oa ? { openai: oa } : {}), auth };
    }
    const vendor = preset ? VENDORS[preset] : undefined;
    const defaults = vendor?.defaults ?? [];
    const list = vendor ? vendor.list(bases) : customList(bases);
    // Kinds: what the vendor's list said, else a documented rule for the id; the rest is text, for the owner to change.
    const documented = (ids: string[]) => Object.fromEntries(ids.flatMap((m) => (documentedKind(preset, m) ? [[m, documentedKind(preset, m)!]] : [])));
    if (!list) return json({ ok: true, source: "defaults", models: defaults, defaults, kinds: documented(defaults), note: "this vendor documents no model list: pick from its documented models or type ids" });
    const r = await fetchModelList(list, key, doFetch);
    if (!r.ok) return json({ ok: true, source: "defaults", models: defaults, defaults, kinds: documented(defaults), error: redact(r.error, key) });
    return json({ ok: true, source: "vendor", models: r.models, defaults, kinds: { ...documented(r.models), ...r.kinds } });
  }

  async function test(req: Req): Promise<Response> {
    const name = req.params?.name ?? "";
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    const text = await read();
    const p = text === undefined ? undefined : parseGatewayYaml(text, o.env).config.providers.find((x) => x.name === name);
    if (!p) return json({ ok: false, error: `no provider ${name}` }, 404);
    const key = p.apiKeyEnv ? o.env[p.apiKeyEnv]?.trim() || undefined : undefined;
    const model = (typeof body.model === "string" && GATEWAY_MODEL_PATTERN.test(body.model) ? body.model : undefined) ?? p.models[0];
    const results = await testProvider(p, key, model, doFetch);
    return json({ ok: true, provider: name, results: results.map((r) => ({ ...r, ...(r.error ? { error: redact(r.error, key) } : {}) })) });
  }

  async function saveGroups(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { groups?: unknown } | null;
    const g = body?.groups;
    if (!g || typeof g !== "object" || Array.isArray(g)) return json({ ok: false, error: "groups must map a name to a list of provider/model" }, 400);
    const f = await editable();
    if (f instanceof Response) return f;
    const groups: Record<string, string[]> = {};
    for (const [name, members] of Object.entries(g as Record<string, unknown>)) {
      if (!GATEWAY_NAME_PATTERN.test(name)) return json({ ok: false, error: `group ${name}: lowercase letters, digits and -` }, 400);
      if (f.config.providers.some((p) => p.name === name)) return json({ ok: false, error: `group ${name} is named like a provider` }, 400);
      if (!Array.isArray(members) || !members.length || !members.every((m) => typeof m === "string" && GATEWAY_MODEL_PATTERN.test(m) && splitModelId(m))) return json({ ok: false, error: `group ${name} needs one or more provider/model members` }, 400);
      const bad = (members as string[]).find((m) => !f.config.providers.some((p) => p.name === splitModelId(m)!.provider));
      if (bad) return json({ ok: false, error: `group ${name}: ${bad} names a provider that is not in ${GATEWAY_FILE}` }, 400);
      if (new Set(members).size !== members.length) return json({ ok: false, error: `group ${name} lists a member twice` }, 400);
      groups[name] = members as string[];
    }
    // A tier on a group that goes away would name nothing.
    const gone = GATEWAY_TIERS.filter((t) => f.config.tiers[t] && f.config.groups[f.config.tiers[t]!] && !groups[f.config.tiers[t]!]);
    if (gone.length) return json({ ok: false, error: `tier ${gone.join(", ")} uses that group; pick another model for it first` }, 409);
    try {
      await apply(setGroupsText(f.text, groups, o.env));
    } catch (e) {
      return failed(e);
    }
    return json({ ok: true, groups });
  }

  async function saveTiers(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { tiers?: unknown } | null;
    if (!body?.tiers || typeof body.tiers !== "object" || Array.isArray(body.tiers)) return json({ ok: false, error: "tiers must map basic, junior, intermediate, advanced and image to a model or a group" }, 400);
    const f = await editable();
    if (f instanceof Response) return f;
    const tiers: GatewayTiers = {};
    for (const [tier, raw] of Object.entries(body.tiers as Record<string, unknown>)) {
      if (!(GATEWAY_TIERS as readonly string[]).includes(tier)) return json({ ok: false, error: `unknown tier ${tier}` }, 400);
      if (raw === "" || raw === null || raw === undefined) continue;
      const value = typeof raw === "string" ? raw.trim() : raw;
      if (typeof value !== "string" || !GATEWAY_MODEL_PATTERN.test(value)) return json({ ok: false, error: `${tier}: not a model id` }, 400);
      if (value !== f.config.tiers[tier as GatewayTier]) {
        const why = tierProblem(tier as GatewayTier, value, f.config.providers, f.config.groups);
        if (why) return json({ ok: false, error: `${tier}: ${why}` }, 400);
      }
      tiers[tier as GatewayTier] = value;
    }
    try {
      await apply(setGatewayTiersText(f.text, tiers, o.env));
    } catch (e) {
      return failed(e);
    }
    return json({ ok: true, tiers, applied: true });
  }

  async function addRuntime(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
    const kind = body?.kind;
    if (kind !== "claude-code" && kind !== "anthropic-api") return json({ ok: false, error: "kind must be claude-code or anthropic-api" }, 400);
    if (o.unavailable) return json({ ok: false, error: o.unavailable }, 409);
    // Only what this space found itself: the path never comes from the request.
    const claude = kind === "claude-code" ? o.claude() : undefined;
    if (kind === "claude-code" && !claude) return json({ ok: false, error: "Claude Code was not found on this machine; install it, then check again in Settings → Models" }, 409);
    const f = Bun.file(runtimesFile);
    let next: { text: string; name: string };
    try {
      next = addGatewayRuntimeText((await f.exists()) ? await f.text() : undefined, { kind, ...(claude ? { claude } : {}) }, o.env);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 409);
    }
    const spec = parseRuntimesYaml(next.text, o.env).config.runtimes.find((r) => r.name === next.name)!;
    const tmp = `${runtimesFile}.${process.pid}.tmp`;
    await Bun.write(tmp, next.text);
    await rename(tmp, runtimesFile);
    let applied = false;
    try {
      applied = o.runtimes.add(spec);
    } catch { /* a restart loads it */ }
    if (applied) o.onRuntimeAdded?.(next.name);
    return json({ ok: true, runtime: next.name, kind, applied, ...(applied ? {} : { restart: true }) });
  }

  const guarded = (h: (req: Req) => Promise<Response>) => async (req: Req) => (await refuse(req)) ?? h(req);
  return {
    ...createGatewayMediaRoutes({ gateway: o.gateway, home: o.home, env: o.env, ...(o.speech ? { speech: o.speech } : {}), ...(o.reloadSpeech ? { reloadSpeech: o.reloadSpeech } : {}), ...(o.fetch ? { fetch: o.fetch } : {}), log }, guarded),
    "/api/model/gateway": { GET: guarded(view) },
    "/api/model/gateway/providers": { POST: guarded(addProvider) },
    "/api/model/gateway/providers/:name": { PUT: guarded(editProvider), DELETE: guarded(removeProvider) },
    "/api/model/gateway/providers/:name/key": { PUT: guarded(replaceKey) },
    "/api/model/gateway/providers/:name/test": { POST: guarded(test) },
    "/api/model/gateway/models": { POST: guarded(listModels) },
    "/api/model/gateway/groups": { PUT: guarded(saveGroups) },
    "/api/model/gateway/tiers": { PUT: guarded(saveTiers) },
    "/api/model/gateway/runtimes": { POST: guarded(addRuntime) },
  };
}

function throughSpace(spec: RuntimeSpec): boolean {
  return (spec.kind === "claude-code" || spec.kind === "anthropic-api") && spec.gateway === "space";
}
