import { useEffect, useRef, useState } from "react";
import { AddForm, UninstallForm } from "./AppForms.tsx";
import ModelPreference from "./ModelPreference.tsx";
import Chat from "./Chat.tsx";
import Pet, { DEFAULT_SHEET } from "./Pet.tsx";
import Tasks from "./Tasks.tsx";
import Terminal from "./Terminal.tsx";
import Usage from "./Usage.tsx";
import AppModels from "./AppModels.tsx";
import Events from "./Events.tsx";
import Inbox from "./Inbox.tsx";
import { BUILTIN_ICONS, getJson, repoUrl, sendJson, type AgentInfo, type AppInfo, type BuiltinIcons, type InboxSummary, type WidgetInfo } from "./api.ts";
import { LANGS, type Lang, localized, saveLang, useLang, withLang } from "./i18n.ts";
import PetField from "./PetField.tsx";
import { type PetChoice, resolvePet } from "./petdex.ts";
import SettingsStatus from "./SettingsStatus.tsx";
import { useAppearance } from "./theme.ts";
import ThemeSettings from "./ThemeSettings.tsx";
import { type DragProps, HEALTH, STATUS, Tile, Widget } from "./Tiles.tsx";

// Launcher-style panel: App and Agent tiles with hover details, widget cards, a chat window.
// Settings is a built-in tile at the end of the Apps grid; it, the chat and the tasks list open as
// floating panels over the page (an overlay that closes on a click outside).
// Edit mode (long-press the background): add an app from a link, hide or delete, drag to reorder.
// Everything comes from the apps' manifests through the panel API; the browser holds no secrets.
// Entries from peer machines say where they run in their hover details and are muted while that peer is down.
// Every string the panel owns goes through `t` (i18n.ts); manifest text is picked with `localized`.

type Prefs = { noPop?: boolean; noPet?: boolean; noWidget?: boolean; pet?: PetChoice };

/** Floating panels over the page; one at a time. */
type Panel = "settings" | "chat" | "tasks" | "usage" | "appModels" | "events" | "terminal" | "inbox";

/** `onLang` changes the language of the whole page; the root (main.tsx) owns the value and provides it. */
export default function App({ onLang }: { onLang: (lang: Lang) => void }) {
  const { lang, t } = useLang();
  const [apps, setApps] = useState<AppInfo[]>([]);
  // The built-in tiles' icons: the active icon pack's when it has them (docs/panel.md#icon-packs).
  const [builtins, setBuiltins] = useState<BuiltinIcons>(BUILTIN_ICONS);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Embedded widgets get the resolved scheme only, never the panel's colors (theme.ts).
  const { scheme } = useAppearance();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  // The app dropped on the uninstall zone, awaiting confirmation; `zoneHot` while a tile hovers the zone.
  const [uninstalling, setUninstalling] = useState<AppInfo | null>(null);
  const [zoneHot, setZoneHot] = useState(false);
  // One floating panel at a time: opening one closes the others.
  const [panel, setPanel] = useState<Panel | null>(null);
  const close = () => setPanel(null);
  // The chat opens on the space agent by default; an agent tile switches to that agent.
  const [chatAgent, setChatAgent] = useState<AgentInfo>({ id: "space/assistant", app: "space", name: "assistant", title: "Base", i18n: { zh: { title: "基础" } }, avatar: "✨", appIcon: "✨", runtime: "claude" });
  const [prefs, setPrefs] = useState<Prefs>(() => {
    try {
      return (JSON.parse(localStorage.getItem("panel-prefs") || "{}") as Prefs) || {};
    } catch {
      return {};
    }
  });
  const savePrefs = (n: Prefs) => {
    localStorage.setItem("panel-prefs", JSON.stringify(n));
    return n;
  };
  const togglePref = (k: "noPop" | "noPet" | "noWidget") => setPrefs((p) => savePrefs({ ...p, [k]: !p[k] }));
  const setPet = (pet: PetChoice | undefined) => setPrefs((p) => savePrefs({ ...p, pet }));
  // A chosen sheet that no longer loads (the pet was re-uploaded, or petdex is down): look the name up
  // again and keep the new URL; until then the default pet stands in. The choice itself is kept.
  const [petBroken, setPetBroken] = useState<string | null>(null);
  const petSheet = prefs.pet && prefs.pet.url !== petBroken ? prefs.pet.url : DEFAULT_SHEET;
  const onPetError = (url: string) => {
    setPetBroken(url);
    const slug = prefs.pet?.slug;
    if (!slug) return;
    resolvePet(slug)
      .then((p) => {
        if (p && p.url !== url) setPet(p);
      })
      .catch(() => {});
  };
  const setsOpen = panel === "settings";
  useEffect(() => {
    if (!setsOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setsOpen]);
  const openSettings = () => setPanel("settings");
  const openTerminal = () => setPanel("terminal");
  const openInbox = () => setPanel("inbox");
  const openChat = (a: AgentInfo) => {
    setChatAgent(a);
    setPanel("chat");
  };

  // The app list answers at once with the health the server has cached; a service it has not
  // probed yet comes back "unknown", so the list is asked once more after the probes had their
  // timeout to turn those dots green or red.
  const PROBE_MS = 2_500;
  const reload = () =>
    Promise.all([getJson<{ apps: AppInfo[]; builtins?: BuiltinIcons }>("/api/apps"), getJson<{ agents: AgentInfo[] }>("/api/agents")])
      .then(([p, a]) => {
        setApps(p.apps);
        if (p.builtins) setBuiltins(p.builtins);
        setAgents(a.agents);
        setChatAgent((current) => a.agents.find((agent) => agent.id === current.id) ?? current);
        setLoaded(true);
        if (p.apps.some((x) => x.service?.health === "unknown"))
          setTimeout(() => getJson<{ apps: AppInfo[] }>("/api/apps").then((d) => setApps(d.apps)).catch(() => {}), PROBE_MS);
      })
      .catch(() => setLoaded(true));

  useEffect(() => {
    reload();
  }, []);

  // Widgets: once on load, then every 5 minutes while visible; the server caches per widget refresh.
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  useEffect(() => {
    const pull = () => {
      if (!document.hidden)
        getJson<{ widgets: WidgetInfo[] }>("/api/widgets")
          .then((d) => setWidgets(d.widgets || []))
          .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 300_000);
    document.addEventListener("visibilitychange", pull);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);

  // The inbox tile's badge: unread threads, once on load and every minute while visible; the inbox
  // window reports every change it makes.
  const [inbox, setInbox] = useState<InboxSummary | null>(null);
  useEffect(() => {
    const pull = () => {
      if (!document.hidden)
        getJson<{ summary: InboxSummary }>("/api/inbox?filter=unread&limit=1")
          .then((d) => setInbox(d.summary))
          .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 60_000);
    document.addEventListener("visibilitychange", pull);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);

  // Long-press (550 ms, under 8 px of movement) on the background enters edit mode; a click on the
  // background leaves it. The listeners mount once and read `editing` through a ref: remounting on
  // every change would reset the `fired` flag and mistake the long-press release for an exit click.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  useEffect(() => {
    const blank = (e: MouseEvent) => e.button === 0 && !(e.target as Element).closest(".tile, .modal, .overlay, .pop, .empty, .pet, .widget, a, button, input, select, textarea");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sx = 0;
    let sy = 0;
    let fired = false;
    const down = (e: MouseEvent) => {
      if (editingRef.current || !blank(e)) return;
      sx = e.clientX;
      sy = e.clientY;
      timer = setTimeout(() => {
        fired = true;
        setEditing(true);
      }, 550);
    };
    const move = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) clearTimeout(timer);
    };
    const up = () => {
      clearTimeout(timer);
      setTimeout(() => {
        fired = false;
      }, 0);
    };
    const click = (e: MouseEvent) => {
      if (fired) return;
      if (editingRef.current && blank(e)) setEditing(false);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.addEventListener("click", click);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("click", click);
    };
  }, []);

  // Remove from the panel: manifest-only apps are deleted, apps with code are hidden; a peer's app is
  // hidden on this panel only (the peer is never changed from here).
  const removeApp = async (app: AppInfo) => {
    try {
      if (app.peer) await sendJson("PATCH", `/api/peers/${encodeURIComponent(app.peer)}/apps/${encodeURIComponent(app.name)}`, { hidden: true });
      else if (app.manifestOnly) await sendJson("DELETE", `/api/apps/${encodeURIComponent(app.name)}`);
      else await sendJson("PATCH", `/api/apps/${encodeURIComponent(app.name)}`, { hidden: true });
    } catch {
      /* the reload shows the real state */
    }
    reload();
  };

  // Drag to reorder in edit mode (HTML5 DnD). The list is not reordered while the drag is in
  // progress: moving the dragged node in the DOM makes the browser end the drag, which limited a
  // drag to one step. The tile under the pointer is marked instead (`data-drop`), and the move
  // happens when the tile is dropped.
  const dragRef = useRef<{ kind: string; index: number; over: number } | null>(null);
  const [dragOver, setDragOver] = useState<{ kind: string; index: number } | null>(null);
  const arrMove = <T,>(arr: T[], from: number, to: number) => {
    const a = arr.slice();
    const [x] = a.splice(from, 1);
    a.splice(to, 0, x as T);
    return a;
  };
  // The new order or size stays on screen either way; a failed save only shows after a reload, so say it in the console.
  const layoutNotSaved = (e: unknown) => console.warn("panel layout not saved:", e);
  const saveOrder = (kind: string, ids: string[]) => sendJson("PUT", "/api/panel/layout", { order: { [kind]: ids } }).catch(layoutNotSaved);
  // A widget size dragged in edit mode: shown while the drag goes on, stored in the layout (as an
  // override of the manifest's) when the handle is released.
  const resizeWidget = (w: WidgetInfo, size: string, commit: boolean) => {
    setWidgets((cur) => cur.map((x) => (x.id === w.id ? { ...x, size } : x)));
    if (commit) sendJson("PUT", "/api/panel/layout", { sizes: { [w.id]: size } }).catch(layoutNotSaved);
  };
  const dragProps = <T extends { name?: string; id?: string }>(kind: string, setItems: (fn: (cur: T[]) => T[]) => void, i: number): DragProps =>
    editing
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            dragRef.current = { kind, index: i, over: i };
            e.dataTransfer.effectAllowed = "move";
          },
          onDragOver: (e: React.DragEvent) => {
            const d = dragRef.current;
            if (!d || d.kind !== kind) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (d.over === i) return;
            d.over = i;
            setDragOver(i === d.index ? null : { kind, index: i });
          },
          onDragEnd: () => {
            const d = dragRef.current;
            dragRef.current = null;
            setDragOver(null);
            if (!d || d.over === d.index) return;
            setItems((cur) => {
              const next = arrMove(cur, d.index, d.over);
              saveOrder(
                kind,
                next.map((x) => x.id ?? x.name ?? ""),
              );
              return next;
            });
          },
          "data-drop": dragOver?.kind === kind && dragOver.index === i ? (i < (dragRef.current?.index ?? -1) ? "before" : "after") : undefined,
        }
      : undefined;

  const empty = (text: string) => (loaded ? <div className="empty">{text}</div> : null);
  const pickLang = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as Lang;
    saveLang(next);
    onLang(next);
  };

  return (
    <>
      <div className="aurora">
        <i />
        <i />
        <i />
      </div>
      <div className="shell">
        <section>
          <h2>{t("apps.heading")}</h2>
          <div className={`launcher ${editing ? "editing" : ""}`}>
              {apps.map((p, i) => {
                const shown = localized(lang, p);
                const statusKey = p.service ? HEALTH[p.service.health] ?? STATUS[p.status] : STATUS[p.status];
                return (
                <Tile
                  key={p.id}
                  icon={p.icon}
                  fallback="📦"
                  name={shown.title}
                  href={p.url ? withLang(p.url, lang) : undefined}
                  editing={editing}
                  onRemove={() => removeApp(p)}
                  removeTitle={p.manifestOnly ? t("common.delete") : t("common.hide")}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("apps", setApps, i)}
                  stale={p.stale}
                >
                  <p className="pop-title">
                    {shown.title}
                    <span className={`status ${p.service?.health ?? p.status}`}>
                      <i />
                      {statusKey ? t(statusKey) : p.status}
                    </span>
                  </p>
                  {p.peer && <p className="pop-hint">{t(p.stale ? "common.onPeerStale" : "common.onPeer", { peer: p.peer })}</p>}
                  {shown.description && <p className="pop-body">{shown.description}</p>}
                  {p.repo && (
                    <p className="pop-entry">
                      <a href={repoUrl(p.repo)} target="_blank" rel="noopener noreferrer">
                        {t("apps.repo")}
                      </a>
                    </p>
                  )}
                </Tile>
                );
              })}
              <Tile
                icon={builtins.inbox}
                fallback="📥"
                name={t("inbox.title")}
                editing={editing}
                onOpen={openInbox}
                showPop={!prefs.noPop}
                className="builtin"
                badge={inbox ? { n: inbox.unread, title: t("inbox.badge", { n: inbox.unread }) } : undefined}
              >
                <p className="pop-title">
                  {t("inbox.title")}
                  <span className="status">
                    <i />
                    {t("status.builtIn")}
                  </span>
                </p>
                {inbox && <p className="pop-hint">{t("inbox.summary", { unread: inbox.unread, open: inbox.open })}</p>}
                <p className="pop-body">{t("inbox.blurb")}</p>
              </Tile>
              <Tile icon={builtins.terminal} fallback="⌨️" name={t("term.title")} editing={editing} onOpen={openTerminal} showPop={!prefs.noPop} className="builtin">
                <p className="pop-title">
                  {t("term.title")}
                  <span className="status">
                    <i />
                    {t("status.builtIn")}
                  </span>
                </p>
                <p className="pop-body">{t("term.blurb")}</p>
              </Tile>
              <Tile icon={builtins.settings} fallback="⚙️" name={t("settings.title")} editing={editing} onOpen={openSettings} showPop={!prefs.noPop} className="builtin">
                <p className="pop-title">
                  {t("settings.title")}
                  <span className="status">
                    <i />
                    {t("status.builtIn")}
                  </span>
                </p>
                <p className="pop-body">{t("settings.blurb")}</p>
              </Tile>
              {editing && (
                <button className="tile add" onClick={() => setAdding(true)}>
                  <span className="tile-icon">＋</span>
                  <span className="tile-name">{t("apps.add")}</span>
                </button>
              )}
          </div>
          {!apps.length && empty(t("apps.empty"))}
          {editing && (
            <div
              className={`dropzone${zoneHot ? " hot" : ""}`}
              onDragOver={(e) => {
                const d = dragRef.current;
                if (d?.kind !== "apps") return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                d.over = d.index;
                setDragOver(null);
                setZoneHot(true);
              }}
              onDragLeave={() => setZoneHot(false)}
              onDrop={(e) => {
                e.preventDefault();
                setZoneHot(false);
                const d = dragRef.current;
                if (d?.kind === "apps") {
                  d.over = d.index;
                  setUninstalling(apps[d.index] ?? null);
                }
              }}
            >
              <span className="dropzone-icon">🗑</span>
              <span>
                <b>{t("uninstall.action")}</b> · {t("uninstall.zoneHint")}
              </span>
            </div>
          )}
        </section>
        {agents.length > 0 && (
        <section>
          <h2>{t("agents.heading")}</h2>
            <div className={`launcher ${editing ? "editing" : ""}`}>
              {agents.map((a, i) => {
                const shown = localized(lang, a);
                return (
                <Tile
                  key={a.id}
                  icon={a.avatar}
                  fallback="🦾"
                  name={shown.title}
                  editing={editing}
                  onOpen={() => openChat(a)}
                  showPop={!prefs.noPop}
                  dragProps={dragProps("agents", setAgents, i)}
                  corner={a.app !== "space" && a.appIcon !== a.avatar ? a.appIcon : undefined}
                >
                  <p className="pop-title">
                    {shown.title}
                    <span className="status">
                      <i />
                      {a.app === "space" ? t("status.base") : a.id}
                    </span>
                  </p>
                  {a.peer && <p className="pop-hint">{t("common.onPeer", { peer: a.peer })}</p>}
                  {shown.description && <p className="pop-body">{shown.description}</p>}
                  <p className="pop-hint">{t("agents.clickToChat")}</p>
                </Tile>
                );
              })}
            </div>
        </section>
        )}
        {widgets.length > 0 && !prefs.noWidget && (
          <section>
            <h2>{t("widgets.heading")}</h2>
            <div className={`widgets ${editing ? "editing" : ""}`}>
              {widgets.map((w, i) => (
                <Widget key={w.id} w={w} theme={scheme} dragProps={dragProps("widgets", setWidgets, i)} onResize={editing ? (size, commit) => resizeWidget(w, size, commit) : undefined} />
              ))}
            </div>
          </section>
        )}
      </div>
      {!prefs.noPet && <Pet sheet={petSheet} onError={onPetError} />}
      {uninstalling && (
        <UninstallForm
          app={uninstalling}
          onClose={() => setUninstalling(null)}
          onDone={() => {
            setUninstalling(null);
            reload();
          }}
        />
      )}
      {adding && (
        <AddForm
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {setsOpen && (
        <div className="overlay top" onClick={close}>
          <div className="panel settings" role="dialog" aria-label={t("settings.title")} onClick={(e) => e.stopPropagation()}>
            <div className="panel-head">
              <b>{t("settings.title")}</b>
              <button className="chat-hbtn" title={t("common.close")} onClick={close}>
                ✕
              </button>
            </div>
            <div className="setbody">
              <label className="setrow">
                {t("settings.hover")}
                <input type="checkbox" role="switch" checked={!prefs.noPop} onChange={() => togglePref("noPop")} />
              </label>
              <label className="setrow">
                {t("settings.pet")}
                <input type="checkbox" role="switch" checked={!prefs.noPet} onChange={() => togglePref("noPet")} />
              </label>
              {!prefs.noPet && <PetField pet={prefs.pet} onChange={setPet} />}
              <label className="setrow">
                {t("settings.widgets")}
                <input type="checkbox" role="switch" checked={!prefs.noWidget} onChange={() => togglePref("noWidget")} />
              </label>
              <ThemeSettings />
              <label className="setrow">
                {t("settings.language")}
                <select className="setselect" value={lang} onChange={pickLang}>
                  {LANGS.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <ModelPreference onSaved={() => {
                void getJson<{ agents: AgentInfo[] }>("/api/agents").then((d) => {
                  setAgents(d.agents);
                  setChatAgent((current) => d.agents.find((a) => a.id === current.id) ?? current);
                }).catch(() => {});
              }} />
              <p className="sethead">{t("settings.scheduler")}</p>
              <button className="setrow setlink" onClick={() => setPanel("tasks")}>
                {t("settings.tasks")}
                <span>›</span>
              </button>
              <button className="setrow setlink" onClick={() => setPanel("usage")}>
                {t("settings.usage")}
                <span>›</span>
              </button>
              <button className="setrow setlink" onClick={() => setPanel("appModels")}>
                {t("settings.appModels")}
                <span>›</span>
              </button>
              <button className="setrow setlink" onClick={() => setPanel("events")}>
                {t("settings.events")}
                <span>›</span>
              </button>
              <SettingsStatus />
            </div>
          </div>
        </div>
      )}
      <Tasks open={panel === "tasks"} onClose={close} onBack={openSettings} />
      <Usage open={panel === "usage"} onClose={close} onBack={openSettings} />
      <AppModels open={panel === "appModels"} onClose={close} onBack={openSettings} />
      <Events open={panel === "events"} onClose={close} onBack={openSettings} />
      <Terminal open={panel === "terminal"} onClose={close} />
      <Inbox open={panel === "inbox"} onClose={close} onSummary={setInbox} />
      <Chat open={panel === "chat"} agent={chatAgent} onClose={close} onSwitch={openChat} />
    </>
  );
}
