import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, untilTime, type CliInfo, type GatewayInfo, type GatewayTiers, type MachineInventory, type MagpieInfo, type MagpiePins, type MagpieTiers } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key, Lang } from "./messages.ts";

/**
 * Settings → Models: which agent CLIs each machine has (docs/model-machines.md#inventory), with its
 * version, whether it is signed in and which runtime uses it. A CLI found on this machine that no
 * runtime uses can be added to runtimes.yaml; a peer's row is only shown, it is changed there.
 * Below the table, one block per model gateway this space has (docs/model-gateway.md#settings): the
 * built-in one (its providers, and its tiers saved to `tiers:` in gateway.yaml) and magpie on this
 * machine (each runtime through it with its tiers saved to that runtime's `models:` in
 * runtimes.yaml). Both use the same tier pickers, filled from the gateway's model list.
 */

const TIERS = ["basic", "junior", "intermediate", "advanced"] as const;

type T = (key: Key, vars?: Record<string, string | number>) => string;

export default function MachineClis() {
  const { lang, t } = useLang();
  const [rows, setRows] = useState<MachineInventory[] | null>(null);
  const [magpie, setMagpie] = useState<MagpieInfo | undefined>(undefined);
  const [gateway, setGateway] = useState<GatewayInfo | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  const [saved, setSaved] = useState("");
  // Kinds added here and not running until ai-space restarts: their button goes.
  const [pending, setPending] = useState<string[]>([]);
  const load = useCallback(() => {
    getJson<{ machines: MachineInventory[]; magpie?: MagpieInfo; gateway?: GatewayInfo }>("/api/model/inventory")
      .then((d) => {
        setRows(d.machines);
        setMagpie(d.magpie);
        setGateway(d.gateway);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await sendJson<{ machines: MachineInventory[]; magpie?: MagpieInfo; gateway?: GatewayInfo }>("POST", "/api/model/status/probe", {});
      setRows(d.machines);
      setMagpie(d.magpie);
      setGateway(d.gateway);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = async (kind: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ runtime: string }>("POST", "/api/model/runtimes", { kind, ...extra });
      setAdded(r.runtime);
      setPending((p) => [...p, kind]);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (runtime: string, models: MagpieTiers) => {
    setBusy(true);
    setError("");
    setAdded("");
    try {
      const r = await sendJson<{ applied: boolean }>("PUT", "/api/model/runtimes/models", { runtime, models });
      setSaved(t(r.applied ? "magpie.saved" : "magpie.savedRestart", { name: runtime }));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveGateway = async (tiers: GatewayTiers) => {
    setBusy(true);
    setError("");
    setAdded("");
    try {
      const r = await sendJson<{ applied: boolean }>("PUT", "/api/model/gateway/tiers", { tiers });
      setSaved(t(r.applied ? "gateway.saved" : "gateway.savedRestart"));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const clis = [...new Set((rows ?? []).flatMap((r) => r.clis.map((c) => c.cli)))];
  const checked = (rows ?? []).flatMap((r) => r.clis.map((c) => c.checkedAt ?? "")).filter(Boolean).sort().pop();
  return (
    <div className="setcard machine-clis">
      <p className="sethead">{t("clis.title")}</p>
      <p className="setnote">{t("clis.help")}</p>
      {rows === null ? (
        <p className="setnote">{t("common.loading")}</p>
      ) : (
        <div className="cli-table-wrap">
          <table className="cli-table">
            <thead>
              <tr>
                <th scope="col">{t("clis.machine")}</th>
                {clis.map((c) => <th key={c} scope="col">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.machine} className={r.stale || r.reachable === false ? "off" : undefined}>
                  <th scope="row">
                    {r.machine || t("runtimes.thisMachine")}
                    <small>{machineNote(r, t)}</small>
                  </th>
                  {clis.map((name) => {
                    const c = r.clis.find((x) => x.cli === name);
                    return <td key={name}>{r.old ? <span className="cli-dim">—</span> : <CliCell c={c} local={r.via === "local" && !pending.includes(c?.kind ?? "")} busy={busy} onAdd={add} t={t} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {gateway && <GatewayBlock key={JSON.stringify(gateway.saved)} g={gateway} busy={busy} onSave={(tiers) => void saveGateway(tiers)} lang={lang} t={t} />}
      {magpie && <MagpieRow m={magpie} busy={busy} onAdd={(models) => void add("magpie", { models })} onSave={save} t={t} />}
      <div className="setbtns">
        {checked && <span className="setnote">{t("clis.checked", { time: relTime(checked, lang) })}</span>}
        <span className="setbtns-gap" />
        <button className="btn2" disabled={busy} onClick={() => void recheck()}>{busy ? t("clis.checking") : t("clis.recheck")}</button>
      </div>
      {added && <p className="setnote" role="status">{t("clis.added", { name: added })}</p>}
      {saved && <p className="setnote" role="status">{saved}</p>}
      {error && <p className="setnote err" role="alert">{error}</p>}
    </div>
  );
}

/**
 * magpie on this machine: absent (a pointer), installed but not answering, answering (the tier
 * pickers and add), or used by runtimes (their tier pickers, saved to runtimes.yaml).
 */
export function MagpieRow({ m, busy, onAdd, onSave, t }: { m: MagpieInfo; busy: boolean; onAdd: (models: MagpieTiers) => void; onSave: (runtime: string, models: MagpieTiers) => void; t: T }) {
  let body: ReactNode;
  if (m.pins.length)
    body = (
      <>
        <span className={m.running ? undefined : "cli-dim"} title={m.error}>{m.running ? t("magpie.used", { url: m.url, names: m.runtimes.join(", ") }) : t("magpie.downSaved", { url: m.url })}</span>
        {m.pins.map((p) => <MagpieTierPickers key={p.runtime} m={m} pins={p} busy={busy} onSave={(models) => onSave(p.runtime, models)} t={t} />)}
      </>
    );
  else if (!m.running && !m.bin) body = <span className="cli-dim">{t("magpie.absent")}</span>;
  else if (!m.running) body = <span className="cli-dim" title={m.error}>{t("magpie.down", { url: m.url })}</span>;
  else if (!m.models.length) body = <span className="cli-dim">{t("magpie.noModels", { url: m.url })}</span>;
  else
    body = (
      <>
        <span>{t("magpie.up", { url: m.url, n: m.models.length })}</span>
        <MagpieTierPickers m={m} busy={busy} onSave={onAdd} t={t} />
        <small>{t(m.adds === "claude-code" ? "magpie.addsClaude" : "magpie.addsApi")}</small>
      </>
    );
  return (
    <div className="magpie-row">
      <b>magpie</b>
      <div className="cli-cell">{body}</div>
    </div>
  );
}

/** What tier pickers pick from: a model gateway's list, its routing groups marked, and whether it answers. */
export type PickList = { models: string[]; groups: string[]; running: boolean };

/** The value a picker takes to show a text field, for an id typed by hand (no model id starts with `_`). */
const TYPE_ID = "_type";

/**
 * One picker per tier, from a model gateway's list: its routing groups first, then its models. A
 * saved value the gateway no longer lists stays, marked and warned; while it does not answer the
 * saved values are only shown. `typed` adds a choice to type a `provider/model` id by hand;
 * `image` adds a picture tier picked from those ids (a text model cannot draw). Used by magpie
 * (per runtime) and by the built-in model gateway (its own tiers).
 */
export function TierPickers({ list, start, heading, empty, stale, save, typed, image, busy, onSave, t }: {
  list: PickList;
  start: GatewayTiers;
  heading?: ReactNode;
  /** The label of an empty tier. */
  empty: string;
  /** The warning under a saved value the gateway no longer lists. */
  stale: string;
  /** The button: its label, whether it waits for a change, whether it needs one tier set. */
  save: { label: string; mustChange: boolean; needOne: boolean };
  typed?: boolean;
  image?: string[];
  busy: boolean;
  onSave: (tiers: GatewayTiers) => void;
  t: T;
}) {
  const [picked, setPicked] = useState<GatewayTiers>(start);
  const [typing, setTyping] = useState<Partial<Record<keyof GatewayTiers, boolean>>>({});
  const tiers: (keyof GatewayTiers)[] = image ? [...TIERS, "image"] : [...TIERS];
  const groups = list.models.filter((id) => list.groups.includes(id));
  const plain = list.models.filter((id) => !list.groups.includes(id));
  const changed = tiers.some((tier) => (picked[tier] ?? "") !== (start[tier] ?? ""));
  const none = TIERS.every((tier) => !picked[tier]);
  const down = !list.running;
  return (
    <div className="magpie-tiers">
      {heading && <span className="magpie-runtime">{heading}</span>}
      {tiers.map((tier) => {
        const value = picked[tier] ?? "";
        const offered = tier === "image" ? image! : list.models;
        const stalePin = Boolean(value) && list.running && !offered.includes(value);
        const set = (v: string) => setPicked((p) => ({ ...p, [tier]: v.trim() }));
        return (
          <label key={tier} className="magpie-tier">
            <span>{tier === "image" ? t("gateway.imageTier") : t(`modelTier.${tier}`)}</span>
            {typing[tier] ? (
              <input className="setselect" value={value} placeholder="provider/model" aria-label={t("gateway.typeId")} disabled={busy} spellCheck={false} autoCapitalize="off" onChange={(e) => set(e.target.value)} />
            ) : (
              <select className="setselect" value={value} disabled={busy || down} onChange={(e) => (e.target.value === TYPE_ID ? setTyping((x) => ({ ...x, [tier]: true })) : set(e.target.value))}>
                <option value="">{empty}</option>
                {value && !offered.includes(value) && <option value={value}>{down ? value : t("magpie.notListed", { model: value })}</option>}
                {tier !== "image" && groups.length > 0 && (
                  <optgroup label={t("magpie.groups")}>
                    {groups.map((id) => <option key={id} value={id}>{t("magpie.groupOption", { model: id })}</option>)}
                  </optgroup>
                )}
                {(tier === "image" ? offered : plain).length > 0 && (
                  <optgroup label={t("magpie.models")}>
                    {(tier === "image" ? offered : plain).map((id) => <option key={id} value={id}>{list.groups.includes(id) ? t("magpie.groupOption", { model: id }) : id}</option>)}
                  </optgroup>
                )}
                {typed && <option value={TYPE_ID}>{t("gateway.typeId")}</option>}
              </select>
            )}
            {stalePin && !typing[tier] && <small className="err" role="alert">{stale}</small>}
          </label>
        );
      })}
      <span className="magpie-add">
        <button className="btn2" disabled={busy || (!typed && down) || (save.mustChange && !changed) || (save.needOne && none)} onClick={() => onSave(picked)}>{save.label}</button>
      </span>
    </div>
  );
}

/**
 * magpie's pickers: with `pins` a runtime's saved pins, else what adding magpie writes, starting
 * from the suggested groups. An empty tier is Claude Code's own model.
 */
export function MagpieTierPickers({ m, pins, busy, onSave, t }: { m: MagpieInfo; pins?: MagpiePins; busy: boolean; onSave: (models: MagpieTiers) => void; t: T }) {
  const claude = (pins ? pins.kind : m.adds) === "claude-code";
  return (
    <TierPickers
      list={m}
      start={pins ? pins.models : m.suggested}
      heading={pins ? `${t("magpie.runtime", { name: pins.runtime })}${pins.loaded ? "" : ` · ${t("magpie.pending")}`}` : undefined}
      empty={claude ? t("magpie.claudeDefault") : t("magpie.noTier")}
      stale={t("magpie.staleWarn")}
      save={pins ? { label: t("magpie.save"), mustChange: true, needOne: !claude } : { label: t("magpie.add"), mustChange: false, needOne: !claude }}
      busy={busy}
      onSave={onSave}
      t={t}
    />
  );
}

/**
 * The built-in model gateway (docs/model-gateway.md#settings): whether it answers, each provider
 * of gateway.yaml with its bases, on or off and why, resting until when, and its models; then its
 * tiers, the same pickers as magpie's plus a picture tier, saved to `tiers:` in gateway.yaml. A
 * runtime's own `models:` pin wins over them and is listed. No file: where to write it, and what.
 */
export function GatewayBlock({ g, busy, onSave, lang, t }: { g: GatewayInfo; busy: boolean; onSave: (tiers: GatewayTiers) => void; lang: Lang; t: T }) {
  let body: ReactNode;
  if (!g.exists) {
    body = (
      <>
        <span className="cli-dim">{t("gateway.absent", { file: g.file })}</span>
        <pre className="gateway-example">{GATEWAY_EXAMPLE}</pre>
      </>
    );
  } else {
    const running = g.configured && !g.problem;
    body = (
      <>
        <span className={running ? undefined : "cli-dim"}>{running ? t("gateway.up", { n: g.models.length }) : t("gateway.down", { why: g.problem ?? "" })}</span>
        {g.providers.length > 0 && (
          <ul className="gateway-providers">
            {g.providers.map((p) => (
              <li key={p.name}>
                <b>{p.name}</b>
                <span className={`status ${p.off ? "paused" : p.resting ? "" : "ok"}`}>
                  <i />
                  {p.off ? t("gateway.off", { why: p.off }) : p.resting ? t("gateway.resting", { time: untilTime(p.resting.until, lang), kind: restKind(p.resting.kind, t) }) : t("gateway.on")}
                </span>
                <small>{[p.messages && `messages ${p.messages}`, p.openai && `openai ${p.openai}`].filter(Boolean).join(" · ")}</small>
                {p.models.length > 0 && <small>{p.models.join(", ")}</small>}
              </li>
            ))}
          </ul>
        )}
        {g.configured ? (
          <TierPickers
            list={{ models: g.models, groups: Object.keys(g.groups), running }}
            start={g.saved}
            heading={t("gateway.tiers")}
            empty={t("magpie.noTier")}
            stale={t("gateway.staleWarn")}
            save={{ label: t("magpie.save"), mustChange: true, needOne: false }}
            typed
            image={g.imageModels.length || g.saved.image ? g.imageModels : undefined}
            busy={busy}
            onSave={onSave}
            t={t}
          />
        ) : null}
        <small>{g.pins.length ? t("gateway.used", { names: g.pins.map((p) => pinNote(p)).join("; ") }) : t("gateway.unused")}</small>
      </>
    );
  }
  return (
    <div className="magpie-row">
      <b>{t("gateway.title")}</b>
      <div className="cli-cell">{body}</div>
    </div>
  );
}

/** Why a provider rests, in the reader's words; an unknown kind as it came. */
function restKind(kind: string, t: T): string {
  return ["credit", "quota", "rate", "transport"].includes(kind) ? t(`gateway.rest.${kind as "credit" | "quota" | "rate" | "transport"}`) : kind;
}

/** A runtime through the built-in gateway, with its own pins (which win) when it has any. */
function pinNote(p: MagpiePins): string {
  const own = TIERS.filter((tier) => p.models[tier]).map((tier) => `${tier} ${p.models[tier]}`);
  return own.length ? `${p.runtime} (${own.join(", ")})` : p.runtime;
}

/** What to write when there is no gateway.yaml: one provider by its preset, and tiers. */
const GATEWAY_EXAMPLE = `providers:
  deepseek:
    preset: deepseek
    apiKeyEnv: DEEPSEEK_API_KEY   # the key goes in .env
    models: [deepseek-chat]
tiers:
  intermediate: deepseek/deepseek-chat`;

function machineNote(r: MachineInventory, t: T): string {
  if (r.old) return t("clis.old");
  if (r.stale) return t("clis.offline");
  if (r.reachable === false) return t("clis.unreachable");
  return r.via === "local" ? "" : r.via === "ssh" ? "ssh" : t("clis.peer");
}

export function CliCell({ c, local, busy, onAdd, t }: { c?: CliInfo; local: boolean; busy: boolean; onAdd: (kind: string) => void; t: T }) {
  if (!c || c.installed === undefined) return <span className="cli-dim" title={c?.detail}>{t("clis.unknown")}</span>;
  if (!c.installed) return <span className="cli-dim" title={c.detail}>{t("clis.missing")}</span>;
  return (
    <span className="cli-cell" title={[c.path, c.detail].filter(Boolean).join("\n") || undefined}>
      <b>{c.version ?? "✓"}</b>
      <span className={`status ${c.signedIn === false ? "paused" : c.signedIn ? "ok" : ""}`}>
        <i />
        {t(c.signedIn === false ? "clis.signedOut" : c.signedIn ? "clis.signedIn" : "clis.unknown")}
      </span>
      {c.configured ? (
        <small>{t("clis.runtime", { names: c.runtimes.join(", ") })}</small>
      ) : local ? (
        <button className="btn2" disabled={busy} onClick={() => onAdd(c.kind)}>{t("clis.add")}</button>
      ) : (
        <small>{t("clis.notConfigured")}</small>
      )}
    </span>
  );
}
