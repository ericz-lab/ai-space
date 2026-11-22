import { type ReactNode, useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, type CliInfo, type MachineInventory, type MagpieInfo, type MagpiePins, type MagpieTiers } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key } from "./messages.ts";

/**
 * Settings → Models: which agent CLIs each machine has (docs/model-machines.md#inventory), with its
 * version, whether it is signed in and which runtime uses it. A CLI found on this machine that no
 * runtime uses can be added to runtimes.yaml; a peer's row is only shown, it is changed there.
 * Below the table, magpie on this machine (docs/runtimes.md#magpie): one gateway for GLM, Kimi,
 * MiniMax and the rest of its providers. Each runtime through it gets a picker per tier, filled from
 * the gateway's model list (routing groups apart), saved to that runtime's `models:` in runtimes.yaml.
 */

const TIERS = ["basic", "junior", "intermediate", "advanced"] as const;

type T = (key: Key, vars?: Record<string, string | number>) => string;

export default function MachineClis() {
  const { lang, t } = useLang();
  const [rows, setRows] = useState<MachineInventory[] | null>(null);
  const [magpie, setMagpie] = useState<MagpieInfo | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  const [saved, setSaved] = useState("");
  // Kinds added here and not running until ai-space restarts: their button goes.
  const [pending, setPending] = useState<string[]>([]);
  const load = useCallback(() => {
    getJson<{ machines: MachineInventory[]; magpie?: MagpieInfo }>("/api/model/inventory")
      .then((d) => {
        setRows(d.machines);
        setMagpie(d.magpie);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      const d = await sendJson<{ machines: MachineInventory[]; magpie?: MagpieInfo }>("POST", "/api/model/status/probe", {});
      setRows(d.machines);
      setMagpie(d.magpie);
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

/**
 * One picker per tier, from the gateway's list: its routing groups first, then its models. With
 * `pins` it edits a runtime's saved pins (a saved model magpie no longer lists stays, marked; while
 * the gateway does not answer the saved values are only shown); without, it picks what adding
 * magpie writes, starting from the suggested groups. An empty tier is Claude Code's own model.
 */
export function MagpieTierPickers({ m, pins, busy, onSave, t }: { m: MagpieInfo; pins?: MagpiePins; busy: boolean; onSave: (models: MagpieTiers) => void; t: T }) {
  const start = pins ? pins.models : m.suggested;
  const [picked, setPicked] = useState<MagpieTiers>(start);
  const kind = pins ? pins.kind : m.adds;
  const claude = kind === "claude-code";
  const groups = m.models.filter((id) => m.groups.includes(id));
  const plain = m.models.filter((id) => !m.groups.includes(id));
  const changed = TIERS.some((tier) => (picked[tier] ?? "") !== (start[tier] ?? ""));
  const none = TIERS.every((tier) => !picked[tier]);
  const down = !m.running;
  return (
    <div className="magpie-tiers">
      {pins && <span className="magpie-runtime">{t("magpie.runtime", { name: pins.runtime })}{pins.loaded ? "" : ` · ${t("magpie.pending")}`}</span>}
      {TIERS.map((tier) => {
        const value = picked[tier] ?? "";
        const stale = Boolean(value) && m.running && !m.models.includes(value);
        return (
          <label key={tier} className="magpie-tier">
            <span>{t(`modelTier.${tier}`)}</span>
            <select className="setselect" value={value} disabled={busy || down} onChange={(e) => setPicked((p) => ({ ...p, [tier]: e.target.value }))}>
              <option value="">{claude ? t("magpie.claudeDefault") : t("magpie.noTier")}</option>
              {value && !m.models.includes(value) && <option value={value}>{down ? value : t("magpie.notListed", { model: value })}</option>}
              {groups.length > 0 && (
                <optgroup label={t("magpie.groups")}>
                  {groups.map((id) => <option key={id} value={id}>{t("magpie.groupOption", { model: id })}</option>)}
                </optgroup>
              )}
              {plain.length > 0 && (
                <optgroup label={t("magpie.models")}>
                  {plain.map((id) => <option key={id} value={id}>{id}</option>)}
                </optgroup>
              )}
            </select>
            {stale && <small className="err" role="alert">{t("magpie.staleWarn")}</small>}
          </label>
        );
      })}
      <span className="magpie-add">
        {pins ? (
          <button className="btn2" disabled={busy || down || !changed || (!claude && none)} onClick={() => onSave(picked)}>{t("magpie.save")}</button>
        ) : (
          <button className="btn2" disabled={busy || (!claude && none)} onClick={() => onSave(picked)}>{t("magpie.add")}</button>
        )}
      </span>
    </div>
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
