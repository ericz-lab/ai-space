import { useEffect, useMemo, useRef, useState } from "react";
import { isImgIcon, recordOpen, type AgentInfo, type AppInfo, type BuiltinIcons, type UsageRow, type WidgetInfo } from "./api.ts";
import { type Key, localized, useLang, withLang } from "./i18n.ts";
import { BUILTINS, type Builtin, WIDGET_SIZES, type EntryKind, type Screen, entryKey, matches, parseKey } from "./screens.ts";
import { Icon, Widget } from "./Tiles.tsx";

// The library: the screen left of home, with every app, agent and widget whether pinned or not.
// One search over the three kinds and a filter by kind. By default a card opens its entry, like a
// launcher; the add-mode button turns the cards into Add buttons that pin to the chosen screen and
// keep the library open, so several can be added in a row. Widgets show as live previews, the
// same cards a screen draws, at the size they would be added at. "Most used" orders the apps,
// agents and built-ins by the last 30 days' time in use, then opens (docs/usage.md).

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

type Entry = { key: string; kind: EntryKind; widget?: WidgetInfo; icon: string; fallback: string; title: string; text: string; kindLabel: string; peer?: string; href?: string; size?: string };

export default function Library({
  apps,
  agents,
  widgets,
  builtins,
  screens,
  screenName,
  target,
  onTarget,
  addMode,
  onAddMode,
  onPin,
  onUnpin,
  onOpen,
  usage,
  onGoTo,
  onAddLink,
  focusSignal,
  theme,
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
  /** Add mode: cards pin to `target` instead of opening. */
  addMode: boolean;
  onAddMode: (on: boolean) => void;
  onPin: (key: string, screenId: string, size?: string) => void;
  /** Takes an entry added by mistake off `target` again. */
  onUnpin: (key: string, screenId: string) => void;
  /** Agents and the panel's own tiles open in the page; apps and widgets are links. */
  onOpen: (key: string) => void;
  /** The last 30 days of use by entry key, for the "Most used" order. */
  usage: Map<string, UsageRow>;
  onGoTo: (screenId: string) => void;
  onAddLink: () => void;
  /** Changes whenever the search field should take the focus (⌘K, the dock's search). */
  focusSignal: number;
  /** The resolved color scheme, for embedded widget previews. */
  theme: string;
}) {
  const { lang, t } = useLang();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [byUse, setByUse] = useState(() => {
    try {
      return localStorage.getItem("library-order") === "used";
    } catch {
      return false;
    }
  });
  const orderByUse = (on: boolean) => {
    setByUse(on);
    try {
      localStorage.setItem("library-order", on ? "used" : "default");
    } catch {
      /* a convenience only */
    }
  };
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
      out.push({ key: entryKey("widget", w.id), kind: "widget", widget: w, icon: w.icon, fallback: "📦", title: shown.title, text: w.id, kindLabel: t("library.kindWidget"), peer: w.peer, href: w.link ? withLang(w.link, lang) : undefined, size: w.size });
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
  const used = (e: Entry) => usage.get(e.key);
  const filtered = entries.filter((e) => (filter === "all" || kindOf(e) === filter) && matches(q, e.title, e.text, e.peer));
  // A stable sort: entries never used keep the default order, after the used ones.
  const shown = byUse ? [...filtered].sort((a, b) => (used(b)?.activeMs ?? 0) - (used(a)?.activeMs ?? 0) || (used(b)?.opens ?? 0) - (used(a)?.opens ?? 0)) : filtered;
  const shownWidgets = shown.filter((e) => e.kind === "widget");
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
  const remove = (e: Entry) => {
    if (targetScreen) onUnpin(e.key, targetScreen.id);
  };
  /** Add, or once added a button that takes the entry off the target screen again. */
  const addButton = (e: Entry, pinnedHere: boolean) =>
    pinnedHere ? (
      <button className="btn2 done" title={t("library.removeTitle")} onClick={() => remove(e)}>
        <span className="on">✓ {t("library.added")}</span>
        <span className="undo">{t("library.remove")}</span>
      </button>
    ) : (
      <button className="btn2 primary" onClick={() => add(e)}>
        {t("library.add")}
      </button>
    );
  /** An app or built-in opened from here counts as a library open; an agent counts its chat turns instead. */
  const use = (e: Entry) => {
    if (e.kind === "app" || e.kind === "builtin") recordOpen(e.kind, parseKey(e.key)!.id, "library");
  };
  /** Agents and the panel's own tiles open in the page; apps and widgets are links in a new tab. */
  const opener = (e: Entry) =>
    e.kind === "agent" || e.kind === "builtin"
      ? {
          onClick: () => {
            use(e);
            onOpen(e.key);
          },
        }
      : e.href
        ? { href: e.href, target: "_blank", rel: "noopener noreferrer", onClick: () => use(e) }
        : null;
  // Enter in the search acts on the only match left: opens it, or in add mode adds it.
  const onSearchKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== "Enter" || shown.length !== 1) return;
    const only = shown[0] as Entry;
    if (addMode) {
      if (!targetScreen?.items.includes(only.key)) add(only);
    } else if (only.kind === "agent" || only.kind === "builtin") {
      use(only);
      onOpen(only.key);
    } else if (only.href) {
      use(only);
      window.open(only.href, "_blank", "noopener,noreferrer");
    }
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
          <label className="lib-target">
            {t("library.sort")}
            <select className="setselect" value={byUse ? "used" : "default"} onChange={(e) => orderByUse(e.target.value === "used")}>
              <option value="default">{t("library.sortDefault")}</option>
              <option value="used">{t("library.sortUsed")}</option>
            </select>
          </label>
          {addMode && screens.length > 1 && (
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
          <button className={`btn2${addMode ? " primary" : ""}`} aria-pressed={addMode} onClick={() => onAddMode(!addMode)}>
            {addMode ? `✓ ${t("library.doneAdding")}` : `＋ ${t("library.addMode")}`}
          </button>
          <button className="btn2" onClick={onAddLink}>
            ＋ {t("library.addLink")}
          </button>
        </div>
      </div>
      <div className="lib-grid">
        {shown.filter((e) => e.kind !== "widget").map((e) => {
          const pinnedHere = !!targetScreen?.items.includes(e.key);
          const on = screens.filter((s) => s.items.includes(e.key)).map(screenName);
          const body = (
            <>
              <span className={`tile-icon${isImgIcon(e.icon) ? "" : " solid"}`}>
                <Icon icon={e.icon} fallback={e.fallback} />
              </span>
              <span className="lib-text">
                <b>{e.title}</b>
                <span className="lib-kind">
                  {e.kindLabel}
                  {e.peer && <span className="widget-peer">{e.peer}</span>}
                </span>
                {on.length > 0 && <span className="lib-on">{t("library.onScreens", { screens: on.join(lang === "zh" ? "、" : ", ") })}</span>}
              </span>
            </>
          );
          if (!addMode) {
            const o = opener(e);
            return o ? (
              <a key={e.key} className={`lib-card lib-link ${e.kind}`} title={t("library.open")} {...o}>
                {body}
              </a>
            ) : (
              <div key={e.key} className={`lib-card off ${e.kind}`}>
                {body}
              </div>
            );
          }
          return (
            <div key={e.key} className={`lib-card ${e.kind}${pinnedHere ? " pinned" : ""}`}>
              {body}
              <div className="lib-act">
                {addButton(e, pinnedHere)}
              </div>
            </div>
          );
        })}
      </div>
      {shownWidgets.length > 0 && (
        <>
          {filter === "all" && <h3 className="lib-section">{t("library.widgets")}</h3>}
          <div className="widgets lib-widgets">
            {shownWidgets.map((e) => {
              const w = e.widget as WidgetInfo;
              const pinnedHere = !!targetScreen?.items.includes(e.key);
              const size = sizes[e.key] ?? w.size;
              const on = screens.filter((s) => s.items.includes(e.key)).map(screenName);
              return (
                <Widget
                  key={e.key}
                  w={addMode && !pinnedHere ? { ...w, size } : w}
                  theme={theme}
                  extra={
                    addMode ? (
                      <>
                        {!pinnedHere && (
                          <select className="setselect lib-size" aria-label={t("library.size")} title={t("library.size")} value={size} onChange={(ev) => setSizes((cur) => ({ ...cur, [e.key]: ev.target.value }))}>
                            {WIDGET_SIZES.map((s) => (
                              <option key={s} value={s}>
                                {s.replace("x", "×")}
                              </option>
                            ))}
                          </select>
                        )}
                        {addButton(e, pinnedHere)}
                      </>
                    ) : on.length > 0 ? (
                      <span className="lib-on">{t("library.onScreens", { screens: on.join(lang === "zh" ? "、" : ", ") })}</span>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        </>
      )}
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
