import { useEffect, useMemo, useRef, useState } from "react";
import { isImgIcon, type AgentInfo, type AppInfo, type BuiltinIcons, type WidgetInfo } from "./api.ts";
import { type Key, localized, useLang, withLang } from "./i18n.ts";
import { BUILTINS, type Builtin, WIDGET_SIZES, type EntryKind, type Screen, entryKey, matches } from "./screens.ts";
import { Icon } from "./Tiles.tsx";

// The library: the screen left of home, with every app, agent and widget whether pinned or not.
// One search over the three kinds, a filter by kind, and an Add button per entry that pins it to
// the chosen screen and keeps the library open, so several can be added in a row. The icon, the
// name and an Open button open the entry straight from here.

type Filter = "all" | "app" | "agent" | "widget";
const FILTERS: { value: Filter; label: Key }[] = [
  { value: "all", label: "library.all" },
  { value: "app", label: "library.apps" },
  { value: "agent", label: "library.agents" },
  { value: "widget", label: "library.widgets" },
];
const BUILTIN_TEXT: Record<Builtin, { title: Key; blurb: Key; fallback: string }> = {
  inbox: { title: "inbox.title", blurb: "inbox.blurb", fallback: "📥" },
  terminal: { title: "term.title", blurb: "term.blurb", fallback: "⌨️" },
  settings: { title: "settings.title", blurb: "settings.blurb", fallback: "⚙️" },
};

type Entry = { key: string; kind: EntryKind; icon: string; fallback: string; title: string; text: string; kindLabel: string; peer?: string; href?: string; size?: string };

export default function Library({
  apps,
  agents,
  widgets,
  builtins,
  screens,
  screenName,
  target,
  onTarget,
  onPin,
  onOpen,
  onGoTo,
  onAddLink,
  focusSignal,
}: {
  apps: AppInfo[];
  agents: AgentInfo[];
  widgets: WidgetInfo[];
  builtins: BuiltinIcons;
  screens: Screen[];
  screenName: (s: Screen) => string;
  /** The screen Add pins to. */
  target: string;
  onTarget: (id: string) => void;
  onPin: (key: string, screenId: string, size?: string) => void;
  /** Agents and the panel's own tiles open in the page; apps and widgets are links. */
  onOpen: (key: string) => void;
  onGoTo: (screenId: string) => void;
  onAddLink: () => void;
  /** Changes whenever the search field should take the focus (⌘K, the dock's search). */
  focusSignal: number;
}) {
  const { lang, t } = useLang();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ name: string; screen: string; n: number } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
    search.current?.select();
  }, [focusSignal]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const a of apps) {
      const shown = localized(lang, a);
      out.push({ key: entryKey("app", a.id), kind: "app", icon: a.icon, fallback: "📦", title: shown.title, text: [shown.description, a.name].join(" "), kindLabel: t("library.kindApp"), peer: a.peer, href: a.url ? withLang(a.url, lang) : undefined });
    }
    for (const b of BUILTINS) {
      const x = BUILTIN_TEXT[b];
      out.push({ key: entryKey("builtin", b), kind: "builtin", icon: builtins[b], fallback: x.fallback, title: t(x.title), text: t(x.blurb), kindLabel: t("status.builtIn") });
    }
    for (const a of agents) {
      const shown = localized(lang, a);
      out.push({ key: entryKey("agent", a.id), kind: "agent", icon: a.avatar, fallback: "🦾", title: shown.title, text: [shown.description, a.id].join(" "), kindLabel: t("library.kindAgent"), peer: a.peer });
    }
    for (const w of widgets) {
      const shown = localized(lang, w);
      out.push({ key: entryKey("widget", w.id), kind: "widget", icon: w.icon, fallback: "📦", title: shown.title, text: w.id, kindLabel: t("library.kindWidget"), peer: w.peer, href: w.link ? withLang(w.link, lang) : undefined, size: w.size });
    }
    return out;
  }, [apps, agents, widgets, builtins, lang, t]);

  const kindOf = (e: Entry): Filter => (e.kind === "builtin" ? "app" : e.kind);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, app: 0, agent: 0, widget: 0 };
    for (const e of entries) if (matches(q, e.title, e.text, e.peer)) {
      c.all++;
      c[kindOf(e)]++;
    }
    return c;
  }, [entries, q]);
  const shown = entries.filter((e) => (filter === "all" || kindOf(e) === filter) && matches(q, e.title, e.text, e.peer));
  const targetScreen = screens.find((s) => s.id === target) ?? screens[0];
  const nameOf = (id: string) => {
    const s = screens.find((x) => x.id === id);
    return s ? screenName(s) : id;
  };

  const add = (e: Entry) => {
    if (!targetScreen) return;
    const size = e.kind === "widget" ? sizes[e.key] ?? e.size : undefined;
    onPin(e.key, targetScreen.id, size !== e.size ? size : undefined);
    setToast((cur) => ({ name: e.title, screen: targetScreen.id, n: (cur?.n ?? 0) + 1 }));
  };
  // Enter in the search adds the only match left, so a name typed after ⌘K is one keystroke from home.
  const onSearchKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== "Enter" || shown.length !== 1) return;
    const only = shown[0] as Entry;
    if (!targetScreen?.items.includes(only.key)) add(only);
  };

  return (
    <div className="library">
      <div className="lib-bar">
        <input
          ref={search}
          className="lib-search"
          type="search"
          value={q}
          placeholder={t("library.search")}
          aria-label={t("library.search")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
        />
        <div className="lib-filters" role="tablist">
          {FILTERS.map((f) => (
            <button key={f.value} role="tab" aria-selected={filter === f.value} className={`lib-chip${filter === f.value ? " on" : ""}`} onClick={() => setFilter(f.value)}>
              {t(f.label)}
              <span>{counts[f.value]}</span>
            </button>
          ))}
        </div>
        <div className="lib-tools">
          {screens.length > 1 && (
            <label className="lib-target">
              {t("library.target")}
              <select className="setselect" value={targetScreen?.id} onChange={(e) => onTarget(e.target.value)}>
                {screens.map((s) => (
                  <option key={s.id} value={s.id}>
                    {screenName(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn2" onClick={onAddLink}>
            ＋ {t("library.addLink")}
          </button>
        </div>
      </div>
      <div className="lib-grid">
        {shown.map((e) => {
          const pinnedHere = !!targetScreen?.items.includes(e.key);
          const on = screens.filter((s) => s.items.includes(e.key)).map(screenName);
          const opener =
            e.kind === "agent" || e.kind === "builtin"
              ? { onClick: () => onOpen(e.key) }
              : e.href
                ? { href: e.href, target: "_blank", rel: "noopener noreferrer" }
                : null;
          const icon = (
            <span className={`tile-icon${isImgIcon(e.icon) ? "" : " solid"}`}>
              <Icon icon={e.icon} fallback={e.fallback} />
            </span>
          );
          const text = (
            <span className="lib-text">
              <b>{e.title}</b>
              <span className="lib-kind">
                {e.kindLabel}
                {e.peer && <span className="widget-peer">{e.peer}</span>}
              </span>
              {on.length > 0 && <span className="lib-on">{t("library.onScreens", { screens: on.join(lang === "zh" ? "、" : ", ") })}</span>}
            </span>
          );
          return (
            <div key={e.key} className={`lib-card${pinnedHere ? " pinned" : ""}`}>
              {opener ? (
                <a className="lib-open" {...opener}>
                  {icon}
                  {text}
                </a>
              ) : (
                <span className="lib-open off">
                  {icon}
                  {text}
                </span>
              )}
              <div className="lib-act">
                {opener && (
                  <a className="btn2" {...opener}>
                    {t("library.open")}
                  </a>
                )}
                {e.kind === "widget" && !pinnedHere && (
                  <select className="setselect lib-size" aria-label={t("library.size")} title={t("library.size")} value={sizes[e.key] ?? e.size} onChange={(ev) => setSizes((cur) => ({ ...cur, [e.key]: ev.target.value }))}>
                    {WIDGET_SIZES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace("x", "×")}
                      </option>
                    ))}
                  </select>
                )}
                <button className={`btn2${pinnedHere ? " done" : " primary"}`} disabled={pinnedHere} onClick={() => add(e)}>
                  {pinnedHere ? `✓ ${t("library.added")}` : t("library.add")}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {!shown.length && q && <div className="empty">{t("library.none", { q })}</div>}
      {toast && (
        <div className="lib-toast" role="status" key={toast.n}>
          <span>{t("library.addedTo", { name: toast.name, screen: nameOf(toast.screen) })}</span>
          <button onClick={() => onGoTo(toast.screen)}>{t("screens.goTo", { name: nameOf(toast.screen) })} →</button>
        </div>
      )}
    </div>
  );
}
