import { useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, type CliInfo, type MachineInventory } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key } from "./messages.ts";

/**
 * Settings → Models: which agent CLIs each machine has (docs/model-machines.md#inventory), with its
 * version, whether it is signed in and which runtime uses it. A CLI found on this machine that no
 * runtime uses can be added to runtimes.yaml; a peer's row is only shown, it is changed there.
 */

type T = (key: Key, vars?: Record<string, string | number>) => string;

export default function MachineClis() {
  const { lang, t } = useLang();
  const [rows, setRows] = useState<MachineInventory[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  // Kinds added here and not running until ai-space restarts: their button goes.
  const [pending, setPending] = useState<string[]>([]);
  const load = useCallback(() => {
    getJson<{ machines: MachineInventory[] }>("/api/model/inventory")
      .then((d) => setRows(d.machines))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  const recheck = async () => {
    setBusy(true);
    setError("");
    try {
      setRows((await sendJson<{ machines: MachineInventory[] }>("POST", "/api/model/status/probe", {})).machines);
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
                    return <td key={name}>{r.old ? <span className="cli-dim">—</span> : <CliCell c={c} local={r.via === "local" && !pending.includes(c?.kind ?? "")} busy={busy} onAdd={add} t={t} />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
