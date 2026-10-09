import { useEffect, useRef, useState } from "react";
import { AddForm, UninstallForm } from "./AppForms.tsx";
import ModelPreference from "./ModelPreference.tsx";
import Chat from "./Chat.tsx";
import Pet, { DEFAULT_SHEET } from "./Pet.tsx";
import Tasks from "./Tasks.tsx";
import Terminal from "./Terminal.tsx";
import Usage from "./Usage.tsx";
import Activity from "./Activity.tsx";
import AppModels from "./AppModels.tsx";
import Events from "./Events.tsx";
import Inbox from "./Inbox.tsx";
import Library from "./Library.tsx";
import ScreenNav from "./ScreenNav.tsx";
import { type Builtin, HOME, type Screen, addScreen, entryKey, move, parseKey, pin, removeScreen, seedScreens, unpin } from "./screens.ts";
import { BUILTIN_ICONS, fmtDuration, getJson, recordOpen, relTime, repoUrl, sendJson, type AgentInfo, type AppInfo, type BuiltinIcons, type InboxSummary, type UsageKind, type UsageRow, type WidgetInfo } from "./api.ts";
import { LANGS, type Lang, localized, saveLang, useLang, withLang } from "./i18n.ts";
import PetField from "./PetField.tsx";
import { type PetChoice, resolvePet } from "./petdex.ts";
import SettingsStatus from "./SettingsStatus.tsx";
import { useAppearance } from "./theme.ts";
import ThemeSettings from "./ThemeSettings.tsx";
import { type DragProps, HEALTH, STATUS, Tile, Widget } from "./Tiles.tsx";

// Launcher-style panel: App and Agent tiles with hover details, widget cards, a chat window.
// The page is a row of screens (docs/panel.md#screens): the library with everything on the left,
// the home screen the panel opens on, then the operator's own; each screen shows only what is
// pinned to it. Settings, the inbox and the terminal are built-in tiles; they, the chat and the
// tasks list open as floating panels over the page (an overlay that closes on a click outside).
// Edit mode (long-press the background): add an app from a link, unpin, drag to reorder, uninstall.
// Everything comes from the apps' manifests through the panel API; the browser holds no secrets.
// Entries from peer machines say where they run in their hover details and are muted while that peer is down.
// Every string the panel owns goes through `t` (i18n.ts); manifest text is picked with `localized`.

type Prefs = { noPop?: boolean; noPet?: boolean; noWidget?: boolean; pet?: PetChoice };

/** Floating panels over the page; one at a time. */
type Panel = "settings" | "chat" | "tasks" | "usage" | "activity" | "appModels" | "events" | "terminal" | "inbox";

/** `onLang` changes the language of the whole page; the root (main.tsx) owns the value and provides it. */
export default function App({ onLang }: { onLang: (lang: Lang) => void }) {
  const { lang, t } = useLang();
  const [apps, setApps] = useState<AppInfo[]>([]);
  // The built-in tiles' icons: the active icon pack's when it has them (docs/panel.md#icon-packs).
  const [builtins, setBuiltins] = useState<BuiltinIcons>(BUILTIN_ICONS);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The app and agent lists arrived (not just the attempt ended): a first home screen is seeded from them.
  const [listed, setListed] = useState(false);
  // Embedded widgets get the resolved scheme only, never the panel's colors (theme.ts).
  const { scheme } = useAppearance();
  const [editing, setEditing] = useState(false);
  // The screen an app added from a link is pinned to; `null` when added from the library.
  const [adding, setAdding] = useState<{ pinTo: string | null } | null>(null);
  // The app dropped on the uninstall zone, awaiting confirmation; `zoneHot` while a tile hovers the zone.
  const [uninstalling, setUninstalling] = useState<AppInfo | null>(null);
  const [zoneHot, setZoneHot] = useState(false);
  // One floating panel at a time: opening one closes the others.
  const [panel, setPanel] = useState<Panel | null>(null);
  const close = () => setPanel(null);
  // The chat opens on the space agent by default; an agent tile switches to that agent.
  const [chatAgent, setChatAgent] = useState<AgentInfo>({ id: "space/assistant", app: "space", name: "assistant", title: "Space Assistant", i18n: { zh: { title: "空间助手" } }, avatar: "/assistant.svg", appIcon: "✨", runtime: "claude" });
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
        setListed(true);
        if (p.apps.some((x) => x.service?.health === "unknown"))
          setTimeout(() => getJson<{ apps: AppInfo[] }>("/api/apps").then((d) => setApps(d.apps)).catch(() => {}), PROBE_MS);
      })
      .catch(() => setLoaded(true));

  useEffect(() => {
    reload();
  }, []);

  // Widgets: once on load, then every 5 minutes while visible; the server caches per widget refresh.
  const [widgets, setWidgets] = useState<WidgetInfo[]>([]);
  // Ids of the widgets removed from the panel; the settings can show them again.
  const [hiddenWidgets, setHiddenWidgets] = useState<string[]>([]);
  const [widgetsTried, setWidgetsTried] = useState(false);
  const pullWidgets = () =>
    getJson<{ widgets: WidgetInfo[]; hidden?: string[] }>("/api/widgets")
      .then((d) => {
        setWidgets(d.widgets || []);
        setHiddenWidgets(d.hidden || []);
      })
      .catch(() => {})
      .finally(() => setWidgetsTried(true));
  useEffect(() => {
    const pull = () => {
      if (!document.hidden) void pullWidgets();
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

  // The last 30 days of use (docs/usage.md), for the hover line and the library's "Most used"
  // order: on load, every 5 minutes while visible, and each time the library opens.
  const [usage, setUsage] = useState<Map<string, UsageRow>>(new Map());
  const pullUsage = () =>
    getJson<{ usage: UsageRow[] }>("/api/usage?window=30d")
      .then((d) => setUsage(new Map(d.usage.map((r) => [entryKey(r.kind, r.key), r]))))
      .catch(() => {});
  useEffect(() => {
    const pull = () => {
      if (!document.hidden) void pullUsage();
    };
    pull();
    const t = setInterval(pull, 300_000);
    document.addEventListener("visibilitychange", pull);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", pull);
    };
  }, []);
  const usageHint = (key: string) => {
    const u = usage.get(key);
    if (!u || (!u.opens && !u.activeMs)) return null;
    const parts = [t("activity.hint", { n: u.opens }), ...(u.activeMs ? [fmtDuration(u.activeMs, lang)] : []), ...(u.lastAt ? [relTime(u.lastAt, lang)] : [])];
    return <p className="pop-hint">{parts.join(" · ")}</p>;
  };

  // Long-press (550 ms, under 8 px of movement) on the background enters edit mode; a click on the
  // background leaves it. The listeners mount once and read `editing` through a ref: remounting on
  // every change would reset the `fired` flag and mistake the long-press release for an exit click.
  const editingRef = useRef(editing);
  useEffect(() => {
    editingRef.current = editing;
  }, [editing]);
  useEffect(() => {
    const blank = (e: MouseEvent) => e.button === 0 && !(e.target as Element).closest(".tile, .modal, .overlay, .pop, .empty, .pet, .widget, .lib-card, .screens-hint, .lib-toast, a, button, input, select, textarea");
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

  // The screens, home first; `null` until the layout has answered. A panel that never stored any
  // gets a home screen seeded from what it showed before, stored at once, so that what is installed
  // later goes to the library and does not crowd the home screen.
  const [screens, setScreens] = useState<Screen[] | null>(null);
  const [layoutState, setLayoutState] = useState<"loading" | "ok" | "failed">("loading");
  useEffect(() => {
    getJson<{ layout: { screens: Screen[] | null } }>("/api/panel/layout")
      .then((d) => {
        if (d.layout.screens) setScreens(d.layout.screens);
        setLayoutState("ok");
      })
      .catch(() => setLayoutState("failed"));
  }, []);
  // The new order or size stays on screen either way; a failed save only shows after a reload, so say it in the console.
  const layoutNotSaved = (e: unknown) => console.warn("panel layout not saved:", e);
  // Changes go through the latest list, not the render's: two Adds before a re-render both land.
  const screensRef = useRef(screens);
  screensRef.current = screens;
  const saveScreens = (next: Screen[]) => {
    screensRef.current = next;
    setScreens(next);
    sendJson("PUT", "/api/panel/layout", { screens: next }).catch(layoutNotSaved);
  };
  const updateScreens = (fn: (cur: Screen[]) => Screen[]) => {
    if (screensRef.current) saveScreens(fn(screensRef.current));
  };
  useEffect(() => {
    if (screens || layoutState === "loading" || !listed || !widgetsTried) return;
    const seeded = seedScreens(
      apps.map((a) => a.id),
      agents.map((a) => a.id),
      widgets.map((w) => w.id),
    );
    // Only over a layout that answered: one that could not be read may hold screens already.
    if (layoutState === "ok") saveScreens(seeded);
    else setScreens(seeded);
  }, [screens, layoutState, listed, widgetsTried]);

  // Position in the row: -1 the library, 0 home, then the operator's screens. The panel always
  // opens on home. `dir` picks the side the new screen slides in from.
  const [pos, setPos] = useState(0);
  const [dir, setDir] = useState<"from-left" | "from-right">("from-right");
  const [libTarget, setLibTarget] = useState(HOME);
  const [libFocus, setLibFocus] = useState(0);
  // The library opens entries by default; add mode turns its cards into Add buttons.
  const [libAdd, setLibAdd] = useState(false);
  const rows = screens ?? [];
  const screen = pos >= 0 ? rows[pos] : undefined;
  const go = (next: number) => {
    const to = Math.max(-1, Math.min(rows.length - 1, next));
    if (to === pos) return;
    setDir(to < pos ? "from-left" : "from-right");
    setPos(to);
    if (to !== -1) setLibAdd(false);
    window.scrollTo({ top: 0 });
  };
  const goToScreen = (id: string) => go(rows.findIndex((s) => s.id === id));
  /** The library, with Add pointed at `target`, the search focused when `search` is set, and in add mode when `add` is. */
  const openLibrary = (target = HOME, search = false, add = false) => {
    void pullUsage();
    setLibTarget(target);
    setLibAdd(add);
    if (search) setLibFocus((n) => n + 1);
    go(-1);
  };
  // Screens carry no names on the page: home, then "Screen 2", "Screen 3"… by position, the
  // numbers the dock shows. These names are for the library's target menu and screen readers.
  const screenName = (s: Screen) => (s.id === HOME ? t("screens.home") : t("screens.defaultName", { n: rows.indexOf(s) + 1 }));
  // A new screen is made at once, empty, and shown; deleting one asks once more in edit mode.
  const newScreen = () => {
    const cur = screensRef.current;
    if (!cur) return;
    const made = addScreen(cur, "");
    saveScreens(made.screens);
    setDir("from-right");
    setPos(made.screens.length - 1);
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [pos, editing]);
  const deleteScreen = (id: string) => {
    updateScreens((cur) => removeScreen(cur, id));
    setDir("from-left");
    setPos((p) => p - 1);
  };
  const pinEntry = (key: string, screenId: string, size?: string) => {
    updateScreens((cur) => pin(cur, screenId, key));
    if (size) {
      const id = parseKey(key)?.id;
      const w = widgets.find((x) => x.id === id);
      if (w) resizeWidget(w, size, true);
    }
  };
  const unpinEntry = (key: string) => {
    if (screen) updateScreens((cur) => unpin(cur, screen.id, key));
  };

  // Keys: ⌘K / Ctrl+K opens the library's search from anywhere; ← and → move between screens and
  // Escape leaves the library, while nothing floats over the page and no field has the focus.
  const floating = panel !== null || adding !== null || uninstalling !== null;
  const keyState = useRef({ pos, floating, editing, go, openLibrary });
  keyState.current = { pos, floating, editing, go, openLibrary };
  useEffect(() => {
    const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const onKey = (e: KeyboardEvent) => {
      const k = keyState.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!k.floating) k.openLibrary(HOME, true);
        return;
      }
      // Escape in the library's empty search field leaves the library too.
      const emptySearch = e.target instanceof HTMLInputElement && e.target.classList.contains("lib-search") && !e.target.value;
      if (e.key === "Escape" && k.pos === -1 && !k.floating && (emptySearch || !typing(e.target))) return k.go(0);
      if (k.floating || k.editing || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "ArrowLeft") k.go(k.pos - 1);
      else if (e.key === "ArrowRight") k.go(k.pos + 1);
    };
    // A horizontal swipe moves one screen (phones and tablets have no edge to hover).
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      start = e.touches.length === 1 && touch && !keyState.current.floating && !keyState.current.editing && !typing(e.target) ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      start = null;
      if (Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) / 2) keyState.current.go(keyState.current.pos + (dx > 0 ? -1 : 1));
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchend", onEnd);
    };
  }, []);

  // Drag to reorder in edit mode (HTML5 DnD), within the tiles or the widgets of the screen. The
  // list is not reordered while the drag is in progress: moving the dragged node in the DOM makes
  // the browser end the drag, which limited a drag to one step. The tile under the pointer is
  // marked instead (`data-drop`), and the move happens when the tile is dropped.
  const dragRef = useRef<{ kind: string; group: string[]; index: number; over: number } | null>(null);
  const [dragOver, setDragOver] = useState<{ kind: string; index: number } | null>(null);
  // A widget size dragged in edit mode: shown while the drag goes on, stored in the layout (as an
  // override of the manifest's) when the handle is released.
  const resizeWidget = (w: WidgetInfo, size: string, commit: boolean) => {
    setWidgets((cur) => cur.map((x) => (x.id === w.id ? { ...x, size } : x)));
    if (commit) sendJson("PUT", "/api/panel/layout", { sizes: { [w.id]: size } }).catch(layoutNotSaved);
  };
  const showHiddenWidgets = () => {
    const ids = hiddenWidgets;
    setHiddenWidgets([]);
    sendJson("PUT", "/api/panel/layout", { hiddenWidgets: Object.fromEntries(ids.map((id) => [id, false])) })
      .catch(layoutNotSaved)
      .then(() => pullWidgets());
  };
  const dragProps = (kind: "tiles" | "widgets", group: string[], i: number): DragProps =>
    editing
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            dragRef.current = { kind, group, index: i, over: i };
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
            if (!d || d.over === d.index || !screen) return;
            updateScreens((cur) => move(cur, screen.id, d.group, d.index, d.over));
          },
          "data-drop": dragOver?.kind === kind && dragOver.index === i ? (i < (dragRef.current?.index ?? -1) ? "before" : "after") : undefined,
        }
      : undefined;

  /** Opens an agent's chat or one of the panel's own windows, from the library. */
  const openEntry = (key: string) => {
    const e = parseKey(key);
    if (e?.kind === "agent") {
      const a = agents.find((x) => x.id === e.id);
      if (a) openChat(a);
    } else if (e?.kind === "builtin") setPanel(e.id === "settings" ? "settings" : e.id === "inbox" ? "inbox" : "terminal");
  };

  // One screen: its tiles (apps, agents, the panel's own) in a grid, then its widget cards. A key
  // whose entry is gone (uninstalled, a peer that left) is skipped and stays in the layout.
  const builtinTile = (b: Builtin, key: string, onRemove: () => void, drag: DragProps) => {
    const open = b === "inbox" ? openInbox : b === "terminal" ? openTerminal : openSettings;
    const text = b === "inbox" ? { title: t("inbox.title"), blurb: t("inbox.blurb"), fallback: "📥" } : b === "terminal" ? { title: t("term.title"), blurb: t("term.blurb"), fallback: "⌨️" } : { title: t("settings.title"), blurb: t("settings.blurb"), fallback: "⚙️" };
    return (
      <Tile
        key={key}
        icon={builtins[b]}
        fallback={text.fallback}
        name={text.title}
        editing={editing}
        onOpen={open}
        onUse={() => recordOpen("builtin", b, "panel")}
        onRemove={onRemove}
        removeTitle={t("screens.unpin")}
        showPop={!prefs.noPop}
        dragProps={drag}
        className="builtin"
        badge={b === "inbox" && inbox ? { n: inbox.unread, title: t("inbox.badge", { n: inbox.unread }) } : undefined}
      >
        <p className="pop-title">
          {text.title}
          <span className="status">
            <i />
            {t("status.builtIn")}
          </span>
        </p>
        {b === "inbox" && inbox && <p className="pop-hint">{t("inbox.summary", { unread: inbox.unread, open: inbox.open })}</p>}
        <p className="pop-body">{text.blurb}</p>
        {usageHint(key)}
      </Tile>
    );
  };
  const appTile = (p: AppInfo, key: string, onRemove: () => void, drag: DragProps) => {
    const shown = localized(lang, p);
    const statusKey = p.service ? HEALTH[p.service.health] ?? STATUS[p.status] : STATUS[p.status];
    return (
      <Tile
        key={key}
        icon={p.icon}
        fallback="📦"
        name={shown.title}
        href={p.url ? withLang(p.url, lang) : undefined}
        onUse={p.url ? () => recordOpen("app", p.id, "panel") : undefined}
        editing={editing}
        onRemove={onRemove}
        removeTitle={t("screens.unpin")}
        showPop={!prefs.noPop}
        dragProps={drag}
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
        {usageHint(key)}
        {p.repo && (
          <p className="pop-entry">
            <a href={repoUrl(p.repo)} target="_blank" rel="noopener noreferrer">
              {t("apps.repo")}
            </a>
          </p>
        )}
      </Tile>
    );
  };
  const agentTile = (a: AgentInfo, key: string, onRemove: () => void, drag: DragProps) => {
    const shown = localized(lang, a);
    return (
      <Tile
        key={key}
        icon={a.avatar}
        fallback="🦾"
        name={shown.title}
        editing={editing}
        onOpen={() => openChat(a)}
        onRemove={onRemove}
        removeTitle={t("screens.unpin")}
        showPop={!prefs.noPop}
        dragProps={drag}
        corner={a.app !== "space" && a.appIcon !== a.avatar ? a.appIcon : undefined}
        className="agent"
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
        {usageHint(key)}
        <p className="pop-hint">{t("agents.clickToChat")}</p>
      </Tile>
    );
  };
  const renderScreen = (s: Screen) => {
    const appOf = new Map(apps.map((a) => [a.id, a]));
    const agentOf = new Map(agents.map((a) => [a.id, a]));
    const widgetOf = new Map(widgets.map((w) => [w.id, w]));
    const exists = (key: string) => {
      const e = parseKey(key);
      if (!e) return false;
      if (e.kind === "app") return appOf.has(e.id);
      if (e.kind === "agent") return agentOf.has(e.id);
      if (e.kind === "widget") return widgetOf.has(e.id) && !prefs.noWidget;
      return (["inbox", "terminal", "settings"] as string[]).includes(e.id);
    };
    const tiles = s.items.filter((k) => exists(k) && !k.startsWith("widget:"));
    const cards = s.items.filter((k) => exists(k) && k.startsWith("widget:"));
    if (!tiles.length && !cards.length)
      return loaded ? (
        <div className="empty">
          <p>{s.items.length || s.id !== HOME || apps.length ? t("screens.empty") : t("apps.empty")}</p>
          <button className="btn2 primary" onClick={() => openLibrary(s.id, false, true)}>
            {t("screens.emptyAction")}
          </button>
        </div>
      ) : null;
    return (
      <>
        {tiles.length > 0 && (
          <div className={`launcher ${editing ? "editing" : ""}`}>
            {tiles.map((key, i) => {
              const e = parseKey(key)!;
              const remove = () => unpinEntry(key);
              const drag = dragProps("tiles", tiles, i);
              if (e.kind === "app") return appTile(appOf.get(e.id)!, key, remove, drag);
              if (e.kind === "agent") return agentTile(agentOf.get(e.id)!, key, remove, drag);
              return builtinTile(e.id as Builtin, key, remove, drag);
            })}
            {editing && (
              <button className="tile add" onClick={() => setAdding({ pinTo: s.id })}>
                <span className="tile-icon">＋</span>
                <span className="tile-name">{t("apps.add")}</span>
              </button>
            )}
          </div>
        )}
        {editing && (
          <div
            className={`dropzone${zoneHot ? " hot" : ""}`}
            onDragOver={(e) => {
              const d = dragRef.current;
              if (d?.kind !== "tiles" || !d.group[d.index]?.startsWith("app:")) return;
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
              const key = d?.group[d.index];
              if (d?.kind === "tiles" && key?.startsWith("app:")) {
                d.over = d.index;
                setUninstalling(appOf.get(parseKey(key)!.id) ?? null);
              }
            }}
          >
            <span className="dropzone-icon">🗑</span>
            <span>
              <b>{t("uninstall.action")}</b> · {t("uninstall.zoneHint")}
            </span>
          </div>
        )}
        {cards.length > 0 && (
          <div className={`widgets ${editing ? "editing" : ""}`}>
            {cards.map((key, i) => {
              const w = widgetOf.get(parseKey(key)!.id)!;
              return (
                <Widget
                  key={key}
                  w={w}
                  theme={scheme}
                  dragProps={dragProps("widgets", cards, i)}
                  onResize={editing ? (size, commit) => resizeWidget(w, size, commit) : undefined}
                  onRemove={editing ? () => unpinEntry(key) : undefined}
                />
              );
            })}
          </div>
        )}
      </>
    );
  };

  /** An entry's title for the App usage window; a key whose entry is gone shows as itself. */
  const nameOf = (kind: UsageKind, key: string) => {
    if (kind === "builtin") return key === "inbox" ? t("inbox.title") : key === "terminal" ? t("term.title") : key === "settings" ? t("settings.title") : key;
    const found = kind === "app" ? apps.find((a) => a.id === key) : agents.find((a) => a.id === key);
    return found ? localized(lang, found).title : key;
  };

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
      <div className={`shell${pos === -1 ? " wide" : ""}`}>
        {pos === -1 ? (
          <section className={`screen ${dir}`} key="library">
            <h2>{t("screens.library")}</h2>
            <Library
              apps={apps}
              agents={agents}
              widgets={widgets}
              builtins={builtins}
              screens={rows}
              screenName={screenName}
              target={libTarget}
              onTarget={setLibTarget}
              addMode={libAdd}
              onAddMode={setLibAdd}
              onPin={pinEntry}
              onUnpin={(key, screenId) => updateScreens((cur) => unpin(cur, screenId, key))}
              onOpen={openEntry}
              usage={usage}
              onGoTo={goToScreen}
              onAddLink={() => setAdding({ pinTo: null })}
              focusSignal={libFocus}
              theme={scheme}
            />
          </section>
        ) : screen ? (
          <section className={`screen ${dir}`} key={screen.id}>
            {/* No visible titles: a screen is the page itself, and the dock says which one it is. */}
            <h2 className="sr-only">{screenName(screen)}</h2>
            {editing && screen.id !== HOME && (
              <div className="screen-tools">
                <button className={`btn2${confirmDelete ? " danger" : ""}`} onClick={() => (confirmDelete ? deleteScreen(screen.id) : setConfirmDelete(true))}>
                  {confirmDelete ? t("screens.deleteConfirm") : t("screens.delete")}
                </button>
              </div>
            )}
            {renderScreen(screen)}
          </section>
        ) : null}
      </div>
      {screens && <ScreenNav pos={pos} names={rows.map(screenName)} onGo={go} onNew={newScreen} onSearch={() => openLibrary(HOME, true)} />}
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
          onClose={() => setAdding(null)}
          onSaved={(app) => {
            if (app && adding.pinTo) pinEntry(entryKey("app", app.id), adding.pinTo);
            setAdding(null);
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
              {hiddenWidgets.length > 0 && (
                <button className="setrow setlink" onClick={showHiddenWidgets}>
                  {t("settings.hiddenWidgets", { n: hiddenWidgets.length })}
                  <span>{t("settings.showAgain")}</span>
                </button>
              )}
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
              <button className="setrow setlink" onClick={() => setPanel("activity")}>
                {t("settings.activity")}
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
      <Activity open={panel === "activity"} onClose={close} onBack={openSettings} nameOf={nameOf} />
      <AppModels open={panel === "appModels"} onClose={close} onBack={openSettings} />
      <Events open={panel === "events"} onClose={close} onBack={openSettings} />
      <Terminal open={panel === "terminal"} onClose={close} />
      <Inbox open={panel === "inbox"} onClose={close} onSummary={setInbox} />
      <Chat open={panel === "chat"} agent={chatAgent} agents={agents} onClose={close} onSwitch={openChat} />
    </>
  );
}
