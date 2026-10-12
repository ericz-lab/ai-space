import { useCallback, useEffect, useState } from "react";
import { getJson, sendJson } from "./api.ts";
import { useLang } from "./i18n.ts";

type App = { app: string; title: string; version: string; url: string; page?: boolean; state?: string; offline?: { features: string[]; online: string[] }; sourceIncluded?: boolean };
type Catalogue = { spaceId: string; apps: App[]; remotes: { connectionId: string; spaceId: string; available: boolean; apps: App[] }[] };
type Connection = { id: string; remoteSpaceId: string; direction: string; apps: string[]; enabled: boolean; connected: boolean };
type Operation = { id: string; app: string; version: string; state: string };

export default function Packages({ onChange }: { onChange?: () => void }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false), [data, setData] = useState<Catalogue | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]), [operations, setOperations] = useState<Operation[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [file, setFile] = useState<File | null>(null), [unsigned, setUnsigned] = useState(false), [upgrade, setUpgrade] = useState(false);
  const [direction, setDirection] = useState("outgoing"), [remote, setRemote] = useState(""), [endpoint, setEndpoint] = useState(""), [credential, setCredential] = useState("");
  const [invite, setInvite] = useState("");
  const [pending, setPending] = useState<{ id: string; upgrade: boolean } | null>(() => {
    try { return JSON.parse(localStorage.getItem("package-operation") ?? "null"); } catch { return null; }
  });
  const [progress, setProgress] = useState("");
  const remember = (operation: { id: string; upgrade: boolean } | null) => {
    setPending(operation);
    if (operation) localStorage.setItem("package-operation", JSON.stringify(operation)); else localStorage.removeItem("package-operation");
  };
  const load = useCallback(async () => {
    const [catalogue, peers, packages] = await Promise.all([
      getJson<Catalogue>("/api/panel/package-catalogue"),
      getJson<{ connections: Connection[] }>("/api/panel/connections"),
      getJson<{ operations: Operation[] }>("/api/panel/packages"),
    ]);
    setData(catalogue); setConnections(peers.connections); setOperations(packages.operations);
  }, []);
  useEffect(() => { if (open) void load().catch((e: Error) => setError(e.message)); }, [open, load]);
  useEffect(() => {
    if (!open || !pending || busy) return;
    let active = true;
    const check = async () => {
      try {
        const rows = pending.upgrade ? (await getJson<{ changes: { id: string; state: string }[] }>("/api/panel/packages/changes")).changes : (await getJson<{ operations: Operation[] }>("/api/panel/packages")).operations;
        if (!active) return;
        const operation = rows.find((o) => o.id === pending.id);
        setProgress(operation ? t(`packages.state.${operation.state}` as Parameters<typeof t>[0]) : t("packages.notRecorded"));
        if (operation && !["pending", "installing"].includes(operation.state)) { remember(null); await load(); }
      } catch (e) { if (active) setError((e as Error).message); }
    };
    void check(); const timer = setInterval(() => void check(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [open, pending, busy, load, t]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await work(); await load(); onChange?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const upload = async () => {
    if (!file || pending) return;
    const operation = { id: crypto.randomUUID(), upgrade }; remember(operation);
    setProgress(t("packages.working"));
    const response = await fetch("/api/panel/packages", { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "idempotency-key": operation.id, ...(unsigned ? { "x-space-allow-unsigned": "true" } : {}), ...(upgrade ? { "x-space-upgrade": "true" } : {}) } });
    const result = await response.json() as { ok: boolean; error?: string; change?: { error?: string; state?: string }; operation?: { error?: string; state?: string } };
    const state = result.change?.state ?? result.operation?.state;
    if (state && !["pending", "installing"].includes(state)) remember(null);
    setProgress("");
    if (!response.ok || !result.ok) throw new Error(result.error ?? result.change?.error ?? result.operation?.error ?? t("packages.failed"));
    setFile(null);
  };
  const cards = (apps: App[], local: boolean) => apps.map((a) => (
    <div className="package-card" key={a.app}>
      <div className="package-line"><b>{a.title}</b><span>{a.version}</span>{a.page !== false && <a href={a.url} target="_blank" rel="noopener noreferrer">{t("packages.open")}</a>}</div>
      {a.offline && <p className="setnote">{t("packages.offline")}: {a.offline.features.join(" · ") || t("packages.none")}<br />{t("packages.online")}: {a.offline.online.join(" · ") || t("packages.none")}</p>}
      {local && <>
        <p className="setnote">{t(`packages.runtime.${a.state ?? "unavailable"}` as Parameters<typeof t>[0])}</p>
        <p className="setnote">{t(a.sourceIncluded ? "packages.sourceYes" : "packages.sourceNo")}</p>
        <div className="package-line">
          <select aria-label={t("packages.rollback")} disabled={busy} defaultValue="" onChange={(e) => {
            const operationId = e.target.value; e.target.value = "";
            if (operationId && window.confirm(t("packages.rollbackConfirm"))) void act(() => sendJson("POST", `/api/panel/packages/apps/${a.app}/rollback`, { operationId }));
          }}>
            <option value="">{t("packages.rollback")}</option>
            {operations.filter((o) => o.app === a.app && o.state === "retired").map((o) => <option key={o.id} value={o.id}>{o.version} · {o.id.slice(0, 8)}</option>)}
          </select>
          <button disabled={busy} onClick={() => { if (window.confirm(t("packages.removeConfirm"))) void act(() => sendJson("DELETE", `/api/panel/packages/apps/${a.app}`)); }}>{t("packages.remove")}</button>
        </div>
      </>}
    </div>
  ));
  return <>
    <p className="sethead">{t("packages.title")}</p>
    <button className="setrow setlink" aria-expanded={open} onClick={() => setOpen(!open)}><span>{t("packages.manage")}</span><span className={`setchev${open ? " open" : ""}`}>›</span></button>
    {open && <div className="package-settings">
      {error && <p role="alert" className="setnote">{error}</p>}
      {pending && <div className="package-card"><p className="setnote">{t("packages.operation")}: {pending.id}<br />{progress || t("packages.uncertain")}</p><button disabled={busy} onClick={() => void act(async () => {
        const list = pending.upgrade ? (await getJson<{ changes: { id: string; state: string }[] }>("/api/panel/packages/changes")).changes : (await getJson<{ operations: Operation[] }>("/api/panel/packages")).operations;
        const operation = list.find((o) => o.id === pending.id);
        if (!operation) { setProgress(t("packages.notRecorded")); return; }
        setProgress(t(`packages.state.${operation.state}` as Parameters<typeof t>[0]));
        if (!["installing", "pending"].includes(operation.state)) remember(null);
      })}>{t("packages.checkOperation")}</button><button disabled={busy} onClick={() => { if (window.confirm(t("packages.dismissConfirm"))) remember(null); }}>{t("packages.dismiss")}</button></div>}
      <form onSubmit={(e) => { e.preventDefault(); void act(upload); }}>
        <label>{t("packages.file")}<input type="file" accept=".spaceapp" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        <label><input type="checkbox" checked={upgrade} onChange={(e) => setUpgrade(e.target.checked)} />{t("packages.upgrade")}</label>
        <label><input type="checkbox" checked={unsigned} onChange={(e) => setUnsigned(e.target.checked)} />{t("packages.unsigned")}</label>
        <button type="submit" disabled={busy || !file || !!pending}>{t(busy ? "common.loading" : "packages.install")}</button>
      </form>
      <p className="sethead sub">{t("packages.local")}</p>
      {data ? <><p className="setnote">{t("packages.identity")}: {data.spaceId}</p>{cards(data.apps, true)}</> : <p>{t("common.loading")}</p>}
      <p className="sethead sub">{t("packages.remote")}</p>
      {data?.remotes.map((r) => <div key={r.connectionId}><p className="setnote">{r.spaceId} · {t(r.available ? "status.up" : "status.down")}</p>{cards(r.apps, false)}</div>)}
      <p className="sethead sub">{t("packages.connections")}</p>
      <p className="setnote">{t("packages.grantHint")}</p>
      {connections.map((c) => <div className="package-card" key={c.id}>
        <p className="setnote">{c.remoteSpaceId} · {t(c.connected ? "status.up" : "status.down")}</p>
        <label><input type="checkbox" checked={c.enabled} disabled={busy} onChange={(e) => void act(() => sendJson("PATCH", `/api/panel/connections/${c.id}`, { enabled: e.target.checked }))} />{t("packages.connected")}</label>
        {data?.apps.map((a) => <label key={a.app}><input type="checkbox" disabled={busy} checked={c.apps.includes(a.app)} onChange={(e) => void act(() => sendJson("PATCH", `/api/panel/connections/${c.id}`, { apps: e.target.checked ? [...c.apps, a.app] : c.apps.filter((v) => v !== a.app) }))} />{a.title}</label>)}
      </div>)}
      <form onSubmit={(e) => { e.preventDefault(); void act(async () => {
        const result = await sendJson<{ token?: string }>("POST", "/api/panel/connections", { remoteSpaceId: remote.trim(), direction, apps: [], ...(direction === "outgoing" ? { url: endpoint.trim(), tokenEnv: credential.trim() } : {}) });
        setInvite(result.token ?? "");
      }); }}>
        <label>{t("packages.direction")}<select value={direction} onChange={(e) => setDirection(e.target.value)}><option value="outgoing">{t("packages.connectHub")}</option><option value="incoming">{t("packages.acceptPeer")}</option></select></label>
        <label>{t("packages.remoteId")}<input required value={remote} onChange={(e) => setRemote(e.target.value)} /></label>
        {direction === "outgoing" && <><label>{t("packages.endpoint")}<input required type="url" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} /></label><label>{t("packages.credential")}<input required value={credential} onChange={(e) => setCredential(e.target.value)} /></label></>}
        <button disabled={busy}>{t("packages.addConnection")}</button>
      </form>
      {invite && <label>{t("packages.invite")}<textarea readOnly value={invite} /><button onClick={() => setInvite("")}>{t("common.close")}</button></label>}
    </div>}
  </>;
}
