import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, type CliInfo, type GatewayTiers, type MachineInventory, type MagpieInfo, type MagpiePins, type MagpieTiers } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key } from "./messages.ts";

/**
 * Settings → Models: which agent CLIs each machine has (docs/model-machines.md#inventory), with its
 * version, whether it is signed in and which runtime uses it. A CLI found on this machine that no
 * runtime uses can be added to runtimes.yaml; a peer's row is only shown, it is changed there.
 * Model gateways have their own section (Settings → Gateway, GatewaySettings.tsx); below the table
 * a line names the runtimes that take their tiers from one and opens it. The tier pickers and
 * magpie's row live here and are used there.
 */

export const TIERS = ["basic", "junior", "intermediate", "advanced"] as const;

export type T = (key: Key, vars?: Record<string, string | number>) => string;

export default function MachineClis({ onGateway }: { onGateway?: () => void }) {
  const { lang, t } = useLang();
  const [rows, setRows] = useState<MachineInventory[] | null>(null);
  const [through, setThrough] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  // Kinds added here and not running until ai-space restarts: their button goes.
  const [pending, setPending] = useState<string[]>([]);
  type Inventory = { machines: MachineInventory[]; magpie?: MagpieInfo; gatewayRuntimes?: string[] };
  const show = (d: Inventory) => {
    setRows(d.machines);
    setThrough([...(d.gatewayRuntimes ?? []), ...(d.magpie?.runtimes ?? [])]);
  };
  const load = useCallback(() => {
    getJson<Inventory>("/api/model/inventory").then(show).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      show(await sendJson<Inventory>("POST", "/api/model/status/probe", {}));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = async (kind: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ runtime: string }>("POST", "/api/model/runtimes", { kind });
      setAdded(r.runtime);
      setPending((p) => [...p, kind]);
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
                    return <td key={name}>{r.old ? <span className="cli-dim">—</span> : <CliCell c={c} local={r.via === "local" && !pending.includes(c?.kind ?? "")} busy={busy} onAdd={(kind) => void add(kind)} t={t} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onGateway && rows !== null && <GatewayLink names={through} onOpen={onGateway} t={t} />}
      <div className="setbtns">
        {checked && <span className="setnote">{t("clis.checked", { time: relTime(checked, lang) })}</span>}
        <span className="setbtns-gap" />
        <button className="btn2" disabled={busy} onClick={() => void recheck()}>{busy ? t("clis.checking") : t("clis.recheck")}</button>
      </div>
      {added && <p className="setnote" role="status">{t("clis.added", { name: added })}</p>}
      {error && <p className="setnote err" role="alert">{error}</p>}
    </div>
  );
}

/** Where the runtimes through a model gateway get their tiers: Settings → Gateway, not here. */
export function GatewayLink({ names, onOpen, t }: { names: string[]; onOpen: () => void; t: T }) {
  return (
    <div className="magpie-row">
      <b>{t("gateway.linkTitle")}</b>
      <div className="cli-cell">
        <span>{names.length ? t("gateway.linkUsed", { names: names.join(", ") }) : t("gateway.linkNone")}</span>
        <button className="btn2" onClick={onOpen}>{t("gateway.open")}</button>
      </div>
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
