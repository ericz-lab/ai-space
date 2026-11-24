import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson, untilTime, type GatewayInfo, type GatewayModelList, type GatewayPreset, type GatewayProviderInfo, type GatewaySite, type GatewayTest, type GatewayTiers, type MagpieInfo, type MagpieTiers } from "./api.ts";
import { useLang } from "./i18n.ts";
import { MagpieRow, TierPickers, type T } from "./MachineClis.tsx";
import type { Lang } from "./messages.ts";

/**
 * Settings → Gateway (docs/model-gateway.md#settings): the model gateways this space has, apart
 * from Models. The built-in one is configured here end to end: providers (a preset vendor and its
 * key, or a custom base), the models each exposes, a test, groups, the tiers every runtime through
 * it uses, and a runtime that answers through it. Every change is saved to gateway.yaml (and a
 * typed key to the workspace .env) and applies to the next call. magpie, an external gateway, keeps
 * its own row with the same tier pickers.
 */

type Card = "providers" | "groups" | "tiers" | "runtimes";
type Run = (what: () => Promise<unknown>, done?: string) => Promise<boolean>;

export default function GatewaySettings() {
  const { lang, t } = useLang();
  const [g, setG] = useState<GatewayInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [adding, setAdding] = useState(false);
  // The card whose action wrote the last message: it is shown there only.
  const [where, setWhere] = useState<Card>("providers");
  const load = useCallback(() => {
    getJson<GatewayInfo & { ok: boolean }>("/api/model/gateway").then(setG).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const runIn = (card: Card): Run => (what, done) => {
    setWhere(card);
    return run(what, done);
  };
  const run: Run = async (what, done) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await what();
      if (done) setStatus(done);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!g) return <div className="setcard"><p className="setnote">{error || t("common.loading")}</p></div>;
  const editable = !g.readOnly && !g.unavailable;
  const messages = (card: Card) => where === card && (
    <>
      {status && <p className="setnote" role="status">{status}</p>}
      {error && <p className="setnote err" role="alert">{error}</p>}
    </>
  );
  return (
    <>
      <div className="setcard gw">
        <p className="sethead">{t("gateway.title")}</p>
        <p className="setnote">{t("gateway.intro")}</p>
        {g.unavailable ? (
          <p className="setnote err">{t("gateway.unavailable", { why: g.unavailable })}</p>
        ) : !g.exists ? (
          <p className="setnote">{t("gateway.empty")}</p>
        ) : g.answers ? (
          <p className="setnote"><span className="status ok"><i />{t("gateway.up", { n: g.models.length })}</span></p>
        ) : (
          <p className="setnote"><span className="status paused"><i />{t("gateway.down", { why: g.problem ?? "" })}</span></p>
        )}
        {g.readOnly && (
          <>
            <p className="setnote err">{t("gateway.readOnly", { why: g.readOnly })}</p>
            <pre className="gateway-example">{g.text}</pre>
          </>
        )}
        <p className="setnote"><small>{t("gateway.file", { file: g.file })}</small></p>
      </div>

      {!g.unavailable && (
        <div className="setcard gw">
          <p className="sethead">{t("gateway.providers")}</p>
          {g.providers.length === 0 && <p className="setnote">{t("gateway.noProviders")}</p>}
          {g.providers.map((p) => <ProviderRow key={p.name} p={p} sites={g.presets.find((x) => x.name === p.preset)?.sites} editable={editable} busy={busy} run={runIn("providers")} lang={lang} t={t} />)}
          {editable && (adding ? (
            <AddProvider presets={g.presets} taken={g.providers.map((p) => p.name)} busy={busy} run={runIn("providers")} onDone={() => setAdding(false)} t={t} />
          ) : (
            <div className="setbtns">
              <span className="setbtns-gap" />
              <button className="btn2" disabled={busy} onClick={() => setAdding(true)}>{t("gateway.add")}</button>
            </div>
          ))}
          {messages("providers")}
        </div>
      )}

      {g.providers.length > 0 && (
        <div className="setcard gw">
          <p className="sethead">{t("gateway.groups")}</p>
          <p className="setnote">{t("gateway.groupsHelp")}</p>
          <GroupsEditor key={JSON.stringify(g.groups)} groups={g.groups} models={g.models.filter((m) => !g.groups[m])} tiers={g.tiers} editable={editable} busy={busy} onSave={(groups) => void runIn("groups")(() => sendJson("PUT", "/api/model/gateway/groups", { groups }), t("gateway.groupsSaved"))} t={t} />
          {messages("groups")}
        </div>
      )}

      {g.providers.length > 0 && (
        <div className="setcard gw">
          <p className="sethead">{t("gateway.tiersTitle")}</p>
          <p className="setnote">{t("gateway.tiersHelp")}</p>
          <div className="gw-pad">
            <TierPickers
              key={JSON.stringify(g.tiers)}
              list={{ models: g.models, groups: Object.keys(g.groups), running: g.answers }}
              start={g.tiers}
              empty={t("magpie.noTier")}
              stale={t("gateway.staleWarn")}
              save={{ label: t("magpie.save"), mustChange: true, needOne: false }}
              typed={editable}
              image={g.imageModels.length || g.tiers.image ? g.imageModels : undefined}
              busy={busy || !editable}
              onSave={(tiers: GatewayTiers) => void runIn("tiers")(() => sendJson("PUT", "/api/model/gateway/tiers", { tiers }), t("gateway.saved"))}
              t={t}
            />
          </div>
          {messages("tiers")}
        </div>
      )}

      {g.providers.length > 0 && (
        <div className="setcard gw">
          <p className="sethead">{t("gateway.runtimes")}</p>
          <p className="setnote">{g.runtimes.length ? t("gateway.used", { names: g.runtimes.map((r) => (r.loaded ? r.runtime : `${r.runtime} (${t("magpie.pending")})`)).join(", ") }) : t("gateway.unused")}</p>
          <div className="setbtns">
            <span className="setbtns-gap" />
            {g.offer.claude && <button className="btn2" disabled={busy || !!g.unavailable} onClick={() => void addRuntime("claude-code")}>{t("gateway.addClaude")}</button>}
            <button className="btn2" disabled={busy || !!g.unavailable} onClick={() => void addRuntime("anthropic-api")}>{t("gateway.addApi")}</button>
          </div>
          <p className="setnote">{t(g.offer.claude ? "gateway.runtimeHelp" : "gateway.runtimeHelpNoClaude")}</p>
          {messages("runtimes")}
        </div>
      )}

      <MagpieCard t={t} />
    </>
  );

  async function addRuntime(kind: "claude-code" | "anthropic-api") {
    let msg = "";
    await runIn("runtimes")(async () => {
      const r = await sendJson<{ runtime: string; applied: boolean }>("POST", "/api/model/gateway/runtimes", { kind });
      msg = t(r.applied ? "gateway.runtimeAdded" : "gateway.runtimeRestart", { name: r.runtime });
    });
    if (msg) setStatus(msg);
  }
}

/** One provider: its state, key and models, and what can be done to it. */
export function ProviderRow({ p, sites, editable, busy, run, lang, t }: { p: GatewayProviderInfo; sites?: GatewayPreset["sites"]; editable: boolean; busy: boolean; run: Run; lang: Lang; t: T }) {
  const [open, setOpen] = useState<"" | "edit" | "key" | "remove">("");
  const [tests, setTests] = useState<GatewayTest[] | null>(null);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    try {
      setTests((await sendJson<{ results: GatewayTest[] }>("POST", `/api/model/gateway/providers/${p.name}/test`, {})).results);
    } catch (e) {
      setTests([{ base: "messages", ok: false, ms: 0, error: (e as Error).message }]);
    } finally {
      setTesting(false);
    }
  };
  const state = p.disabled ? t("gateway.turnedOff") : p.off ? t("gateway.off", { why: p.off }) : p.resting ? t("gateway.resting", { time: untilTime(p.resting.until, lang), kind: restKind(p.resting.kind, t) }) : t("gateway.on");
  return (
    <div className="gw-prov">
      <div className="gw-prov-head">
        <b>{p.name}</b>
        {p.label && <small>{p.label}</small>}
        <span className={`status ${p.off ? "paused" : p.resting ? "" : "ok"}`}><i />{state}</span>
      </div>
      <small>{[p.messages && `messages ${p.messages}`, p.openai && `openai ${p.openai}`].filter(Boolean).join(" · ")}</small>
      <small>{keyText(p, t)}</small>
      <small>{p.models.length ? t("gateway.models", { n: p.models.length, list: p.models.slice(0, 6).join(", ") + (p.models.length > 6 ? ", …" : "") }) : t("gateway.noModels")}</small>
      <div className="gw-actions">
        <button className="btn2" disabled={busy || testing} onClick={() => void test()}>{testing ? t("gateway.testing") : t("gateway.test")}</button>
        {editable && <button className="btn2" disabled={busy} onClick={() => setOpen(open === "edit" ? "" : "edit")}>{t("gateway.edit")}</button>}
        {editable && <button className="btn2" disabled={busy || p.key.state === "environment"} onClick={() => setOpen(open === "key" ? "" : "key")}>{t("gateway.replaceKey")}</button>}
        {editable && <button className="btn2" disabled={busy} onClick={() => void run(() => sendJson("PUT", `/api/model/gateway/providers/${p.name}`, { disabled: !p.disabled }), t(p.disabled ? "gateway.turnedOnDone" : "gateway.turnedOffDone", { name: p.name }))}>{p.disabled ? t("gateway.turnOn") : t("gateway.turnOff")}</button>}
        {editable && <button className="btn2" disabled={busy} onClick={() => setOpen(open === "remove" ? "" : "remove")}>{t("gateway.remove")}</button>}
      </div>
      {tests && (
        <ul className="gw-tests">
          {tests.map((r) => (
            <li key={r.base} className={r.ok ? "ok" : "err"}>
              <b>{r.base}</b> {r.ok ? t("gateway.testOk", { ms: r.ms, detail: r.detail ?? "" }) : t("gateway.testFail", { ms: r.ms, error: r.error ?? "" })}
            </li>
          ))}
        </ul>
      )}
      {tests === null && p.messages && <small className="cli-dim">{t("gateway.testCost")}</small>}
      {open === "edit" && <ProviderEditor p={p} sites={sites} busy={busy} run={run} onDone={() => setOpen("")} t={t} />}
      {open === "key" && <KeyForm busy={busy} onSave={(key) => void run(() => sendJson("PUT", `/api/model/gateway/providers/${p.name}/key`, { key }), t("gateway.keyReplaced", { name: p.name })).then((ok) => ok && setOpen(""))} t={t} />}
      {open === "remove" && <RemoveForm p={p} busy={busy} onRemove={(key) => void run(() => sendJson("DELETE", `/api/model/gateway/providers/${p.name}?key=${key}`), t("gateway.removed", { name: p.name }))} onCancel={() => setOpen("")} t={t} />}
    </div>
  );
}

function keyText(p: GatewayProviderInfo, t: T): string {
  if (p.key.state === "environment") return t("gateway.keyEnv", { variable: p.key.variable ?? "", last4: p.key.last4 ? `…${p.key.last4}` : "" });
  if (p.key.state === "workspace") return t("gateway.keySet", { last4: p.key.last4 ? `…${p.key.last4}` : "" });
  return p.key.variable ? t("gateway.keyMissing", { variable: p.key.variable }) : t("gateway.keyNone");
}

function restKind(kind: string, t: T): string {
  return ["credit", "quota", "rate", "transport"].includes(kind) ? t(`gateway.rest.${kind as "credit" | "quota" | "rate" | "transport"}`) : kind;
}

/** A key field: written, never read back. */
function KeyForm({ busy, onSave, t }: { busy: boolean; onSave: (key: string) => void; t: T }) {
  const [key, setKey] = useState("");
  return (
    <div className="gw-form">
      <label className="gw-field">
        <span>{t("gateway.newKey")}</span>
        <input className="setselect" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} />
      </label>
      <div className="setbtns"><span className="setbtns-gap" /><button className="btn2" disabled={busy || !key.trim()} onClick={() => onSave(key.trim())}>{t("magpie.save")}</button></div>
    </div>
  );
}

/** Removing a provider: what names it goes too, and whether its stored key does. */
export function RemoveForm({ p, busy, onRemove, onCancel, t }: { p: GatewayProviderInfo; busy: boolean; onRemove: (key: "delete" | "keep") => void; onCancel: () => void; t: T }) {
  const canDelete = p.key.state === "workspace";
  const [del, setDel] = useState(canDelete && p.key.page);
  const used = p.usedBy;
  return (
    <div className="gw-form">
      {(used.groups.length > 0 || used.tiers.length > 0) && <p className="setnote err" role="alert">{t("gateway.removeUsed", { groups: used.groups.join(", ") || "—", tiers: used.tiers.join(", ") || "—" })}</p>}
      {canDelete ? (
        <label className="gw-check"><input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} disabled={busy} /> {t("gateway.removeKey", { variable: p.key.variable ?? "" })}</label>
      ) : p.key.state === "environment" ? (
        <p className="setnote">{t("gateway.removeKeyEnv", { variable: p.key.variable ?? "" })}</p>
      ) : null}
      <div className="setbtns">
        <span className="setbtns-gap" />
        <button className="btn2" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
        <button className="btn2 danger" disabled={busy} onClick={() => onRemove(del ? "delete" : "keep")}>{t("gateway.removeConfirm", { name: p.name })}</button>
      </div>
    </div>
  );
}

/**
 * Which models a provider exposes: the vendor's list (or its documented ids where it has none),
 * each ticked or not, plus ids typed by hand. Refresh asks the vendor again.
 */
export function ModelChooser({ selected, onChange, fetchList, busy, t }: { selected: string[]; onChange: (m: string[]) => void; fetchList: () => Promise<GatewayModelList>; busy: boolean; t: T }) {
  const [list, setList] = useState<GatewayModelList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [typed, setTyped] = useState("");
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setList(await fetchList());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const all = [...new Set([...(list?.models ?? []), ...selected])];
  const toggle = (m: string) => onChange(selected.includes(m) ? selected.filter((x) => x !== m) : [...selected, m]);
  const addTyped = () => {
    const ids = typed.split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(x));
    if (ids.length) onChange([...new Set([...selected, ...ids])]);
    setTyped("");
  };
  return (
    <div className="gw-models">
      <div className="gw-models-head">
        <span>{t("gateway.modelsPick")}</span>
        <button className="btn2" disabled={busy || loading} onClick={() => void refresh()}>{loading ? t("gateway.loading") : list ? t("gateway.refresh") : t("gateway.loadModels")}</button>
      </div>
      {list?.source === "vendor" && <small className="cli-dim">{t("gateway.fromVendor", { n: list.models.length })}</small>}
      {list?.source === "defaults" && <small className={list.error ? "err" : "cli-dim"}>{list.error ? t("gateway.listFailed", { error: list.error }) : t("gateway.noList")}</small>}
      {error && <small className="err">{error}</small>}
      {all.length > 0 && (
        <div className="gw-model-list">
          {all.map((m) => (
            <label key={m} className="gw-check"><input type="checkbox" checked={selected.includes(m)} onChange={() => toggle(m)} disabled={busy} /> {m}</label>
          ))}
        </div>
      )}
      <div className="gw-typed">
        <input className="setselect" placeholder={t("gateway.typeModels")} aria-label={t("gateway.typeModels")} value={typed} spellCheck={false} autoCapitalize="off" onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTyped()} disabled={busy} />
        <button className="btn2" disabled={busy || !typed.trim()} onClick={addTyped}>{t("gateway.addModel")}</button>
      </div>
    </div>
  );
}

const fetchModels = (body: Record<string, unknown>) => sendJson<GatewayModelList & { ok: boolean }>("POST", "/api/model/gateway/models", body);

/** The site a base belongs to, when it is one of the vendor's two. */
function siteOf(sites: GatewayPreset["sites"], messages: string | undefined): GatewaySite | undefined {
  if (!sites || !messages) return undefined;
  const m = messages.replace(/\/+$/, "");
  return (Object.keys(sites) as GatewaySite[]).find((k) => sites[k].messages === m);
}

/** International / China: one account works on one site only, so the key decides which. */
function SiteSwitch({ sites, current, onPick, busy, t }: { sites: NonNullable<GatewayPreset["sites"]>; current: GatewaySite | undefined; onPick: (site: GatewaySite) => void; busy: boolean; t: T }) {
  return (
    <div className="gw-field">
      <span>{t("gateway.site")}</span>
      <div className="gw-sites">
        {(["intl", "cn"] as const).map((k) => (
          <button key={k} type="button" className={`btn2${current === k ? " primary" : ""}`} aria-pressed={current === k} disabled={busy} title={sites[k].messages} onClick={() => onPick(k)}>
            {t(k === "intl" ? "gateway.siteIntl" : "gateway.siteCn")}
          </button>
        ))}
        <small className="cli-dim">{t("gateway.siteNote")}</small>
      </div>
    </div>
  );
}

/** Add a provider: a preset (just the key) or a custom base; then its models. */
export function AddProvider({ presets, taken, busy, run, onDone, t }: { presets: GatewayPreset[]; taken: string[]; busy: boolean; run: Run; onDone: () => void; t: T }) {
  const [preset, setPreset] = useState(presets[0]?.name ?? "");
  const p = presets.find((x) => x.name === preset);
  const freeName = (base: string) => {
    let n = base;
    for (let i = 2; taken.includes(n); i++) n = `${base}-${i}`;
    return n;
  };
  const [name, setName] = useState(freeName(presets[0]?.name ?? ""));
  const [key, setKey] = useState("");
  const [messages, setMessages] = useState("");
  const [openai, setOpenai] = useState("");
  const [auth, setAuth] = useState<"bearer" | "x-api-key">("bearer");
  const [models, setModels] = useState<string[]>(p?.defaults ?? []);
  const [advanced, setAdvanced] = useState(false);
  const pick = (next: string) => {
    setPreset(next);
    const q = presets.find((x) => x.name === next);
    setName(freeName(q ? q.name : ""));
    setModels(q?.defaults ?? []);
    setMessages("");
    setOpenai("");
  };
  const custom = !p;
  const body = () => ({ ...(p ? { preset: p.name } : { auth }), ...(messages.trim() ? { messages: messages.trim() } : {}), ...(openai.trim() ? { openai: openai.trim() } : {}), ...(key.trim() ? { key: key.trim() } : {}) });
  const ready = /^[a-z][a-z0-9-]{0,31}$/.test(name) && !taken.includes(name) && (custom ? Boolean(messages.trim() || openai.trim()) : Boolean(key.trim()));
  return (
    <div className="gw-form gw-add">
      <label className="gw-field">
        <span>{t("gateway.vendor")}</span>
        <select className="setselect" value={preset} onChange={(e) => pick(e.target.value)} disabled={busy}>
          {presets.map((x) => <option key={x.name} value={x.name}>{x.label}</option>)}
          <option value="">{t("gateway.custom")}</option>
        </select>
      </label>
      <label className="gw-field">
        <span>{t("gateway.name")}</span>
        <input className="setselect" value={name} spellCheck={false} autoCapitalize="off" onChange={(e) => setName(e.target.value.toLowerCase())} disabled={busy} />
      </label>
      <label className="gw-field">
        <span>{t("gateway.key")}</span>
        <input className="setselect" type="password" autoComplete="off" spellCheck={false} placeholder={custom ? t("gateway.keyOptional") : ""} value={key} onChange={(e) => setKey(e.target.value)} disabled={busy} />
      </label>
      {p?.sites && (
        <SiteSwitch
          sites={p.sites}
          current={siteOf(p.sites, messages.trim() || p.messages)}
          // The preset's own site needs no override; the other one is written as the base.
          onPick={(k) => { const b = p.sites![k].messages ?? ""; setMessages(b === p.messages ? "" : b); }}
          busy={busy}
          t={t}
        />
      )}
      {custom || advanced ? (
        <>
          <label className="gw-field">
            <span>{t("gateway.messagesBase")}</span>
            <input className="setselect" value={messages} spellCheck={false} placeholder={p?.messages ?? "https://…/anthropic"} onChange={(e) => setMessages(e.target.value)} disabled={busy} />
          </label>
          <label className="gw-field">
            <span>{t("gateway.openaiBase")}</span>
            <input className="setselect" value={openai} spellCheck={false} placeholder={p?.openai ?? "https://…/v1"} onChange={(e) => setOpenai(e.target.value)} disabled={busy} />
          </label>
          {custom && (
            <label className="gw-field">
              <span>{t("gateway.auth")}</span>
              <select className="setselect" value={auth} onChange={(e) => setAuth(e.target.value as "bearer" | "x-api-key")} disabled={busy}>
                <option value="bearer">Authorization: Bearer</option>
                <option value="x-api-key">x-api-key</option>
              </select>
            </label>
          )}
        </>
      ) : (
        <small className="cli-dim gw-bases">
          {[(messages.trim() || p?.messages) && `messages ${messages.trim() || p?.messages}`, p?.openai && `openai ${p.openai}`].filter(Boolean).join(" · ")} <button className="linkbtn" onClick={() => setAdvanced(true)}>{t("gateway.otherBase")}</button>
        </small>
      )}
      <ModelChooser selected={models} onChange={setModels} fetchList={() => fetchModels(body())} busy={busy} t={t} />
      <p className="setnote">{t("gateway.keyWhere")}</p>
      <div className="setbtns">
        <span className="setbtns-gap" />
        <button className="btn2" disabled={busy} onClick={onDone}>{t("common.cancel")}</button>
        <button className="btn2 primary" disabled={busy || !ready} onClick={() => void run(() => sendJson("POST", "/api/model/gateway/providers", { name, models, ...body() }), t("gateway.added", { name })).then((ok) => ok && onDone())}>{t("gateway.addConfirm")}</button>
      </div>
    </div>
  );
}

/** Edit a provider: its models, and its bases. */
function ProviderEditor({ p, sites, busy, run, onDone, t }: { p: GatewayProviderInfo; sites?: GatewayPreset["sites"]; busy: boolean; run: Run; onDone: () => void; t: T }) {
  const [models, setModels] = useState(p.models);
  const [messages, setMessages] = useState(p.messages ?? "");
  const [openai, setOpenai] = useState(p.openai ?? "");
  const save = () => {
    const body: Record<string, unknown> = { models };
    if (messages.trim() !== (p.messages ?? "")) body.messages = messages.trim();
    if (openai.trim() !== (p.openai ?? "")) body.openai = openai.trim();
    void run(() => sendJson("PUT", `/api/model/gateway/providers/${p.name}`, body), t("gateway.edited", { name: p.name })).then((ok) => ok && onDone());
  };
  return (
    <div className="gw-form">
      <ModelChooser selected={models} onChange={setModels} fetchList={() => fetchModels({ provider: p.name })} busy={busy} t={t} />
      {sites && <SiteSwitch sites={sites} current={siteOf(sites, messages.trim())} onPick={(k) => setMessages(sites[k].messages ?? "")} busy={busy} t={t} />}
      <label className="gw-field">
        <span>{t("gateway.messagesBase")}</span>
        <input className="setselect" value={messages} spellCheck={false} onChange={(e) => setMessages(e.target.value)} disabled={busy} />
      </label>
      <label className="gw-field">
        <span>{t("gateway.openaiBase")}</span>
        <input className="setselect" value={openai} spellCheck={false} onChange={(e) => setOpenai(e.target.value)} disabled={busy} />
      </label>
      {p.preset && <small className="cli-dim">{t("gateway.baseClear")}</small>}
      <div className="setbtns">
        <span className="setbtns-gap" />
        <button className="btn2" disabled={busy} onClick={onDone}>{t("common.cancel")}</button>
        <button className="btn2 primary" disabled={busy} onClick={save}>{t("magpie.save")}</button>
      </div>
    </div>
  );
}

/** Groups: a name and its members in order (tried in that order), reordered with ↑ ↓. */
export function GroupsEditor({ groups, models, tiers, editable, busy, onSave, t }: { groups: Record<string, string[]>; models: string[]; tiers: GatewayTiers; editable: boolean; busy: boolean; onSave: (g: Record<string, string[]>) => void; t: T }) {
  const [draft, setDraft] = useState<Record<string, string[]>>(groups);
  const [newName, setNewName] = useState("");
  const changed = JSON.stringify(draft) !== JSON.stringify(groups);
  const set = (name: string, members: string[]) => setDraft((d) => ({ ...d, [name]: members }));
  const move = (name: string, i: number, by: number) => {
    const m = [...draft[name]!];
    const [x] = m.splice(i, 1);
    m.splice(i + by, 0, x!);
    set(name, m);
  };
  const drop = (name: string) => setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== name)));
  const empty = Object.entries(draft).some(([, m]) => !m.length);
  const inUse = (name: string) => Object.values(tiers).includes(name);
  return (
    <div className="gw-pad">
      {Object.keys(draft).length === 0 && <p className="setnote">{t("gateway.noGroups")}</p>}
      {Object.entries(draft).map(([name, members]) => (
        <div key={name} className="gw-group">
          <div className="gw-prov-head">
            <b>{name}</b>
            {editable && <button className="btn2 danger" disabled={busy || inUse(name)} title={inUse(name) ? t("gateway.groupInUse") : undefined} onClick={() => drop(name)}>{t("gateway.remove")}</button>}
          </div>
          <ol>
            {members.map((m, i) => (
              <li key={m}>
                <span>{m}</span>
                {editable && (
                  <span className="gw-order">
                    <button className="btn2" aria-label={t("gateway.up1")} disabled={busy || i === 0} onClick={() => move(name, i, -1)}>↑</button>
                    <button className="btn2" aria-label={t("gateway.down1")} disabled={busy || i === members.length - 1} onClick={() => move(name, i, 1)}>↓</button>
                    <button className="btn2" aria-label={t("gateway.removeMember")} disabled={busy} onClick={() => set(name, members.filter((x) => x !== m))}>✕</button>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {editable && (
            <select className="setselect" value="" aria-label={t("gateway.addMember")} disabled={busy} onChange={(e) => e.target.value && set(name, [...members, e.target.value])}>
              <option value="">{t("gateway.addMember")}</option>
              {models.filter((m) => !members.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      ))}
      {editable && (
        <div className="gw-typed">
          <input className="setselect" placeholder={t("gateway.newGroup")} aria-label={t("gateway.newGroup")} value={newName} spellCheck={false} autoCapitalize="off" onChange={(e) => setNewName(e.target.value.toLowerCase())} disabled={busy} />
          <button className="btn2" disabled={busy || !/^[a-z][a-z0-9-]{0,31}$/.test(newName) || newName in draft} onClick={() => { set(newName, []); setNewName(""); }}>{t("gateway.addGroup")}</button>
          <span className="setbtns-gap" />
          <button className="btn2 primary" disabled={busy || !changed || empty} onClick={() => onSave(draft)}>{t("magpie.save")}</button>
        </div>
      )}
      {empty && <small className="cli-dim">{t("gateway.groupEmpty")}</small>}
    </div>
  );
}

/** magpie on this machine: its row, moved here from Models (the same tier pickers and saves). */
function MagpieCard({ t }: { t: T }) {
  const [m, setM] = useState<MagpieInfo | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const load = useCallback(() => {
    getJson<{ magpie?: MagpieInfo }>("/api/model/inventory").then((d) => setM(d.magpie)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const act = async (what: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      setStatus(await what());
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!m) return null;
  return (
    <div className="setcard gw">
      <p className="sethead">magpie</p>
      <MagpieRow
        m={m}
        busy={busy}
        onAdd={(models: MagpieTiers) => void act(async () => t("clis.added", { name: (await sendJson<{ runtime: string }>("POST", "/api/model/runtimes", { kind: "magpie", models })).runtime }))}
        onSave={(runtime, models) => void act(async () => t((await sendJson<{ applied: boolean }>("PUT", "/api/model/runtimes/models", { runtime, models })).applied ? "magpie.saved" : "magpie.savedRestart", { name: runtime }))}
        t={t}
      />
      {status && <p className="setnote" role="status">{status}</p>}
      {error && <p className="setnote err" role="alert">{error}</p>}
    </div>
  );
}
