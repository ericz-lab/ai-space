import { useEffect, useMemo, useState } from "react";
import { relTime } from "./api.ts";
import { type Catalog, type CatalogChange, type CatalogEntry, type CatalogView, loc, useCatalog } from "./AppCatalog.tsx";
import { type Key, useLang } from "./i18n.ts";
import { PAGE } from "./panel-link.ts";
import { matches } from "./screens.ts";

// The App Store (docs/app-catalog.md#the-app-store): the panel's built-in tile for the app
// catalog, a page of its own like the inbox. Discover lists every catalog app, recommended first,
// with a search; Installed the catalog apps on this Space; Updates those with a newer release. A
// card opens the app's details, where every change is: install (with or without its source), from
// source, rebuild, update, update over changed source, uninstall. Batch Install, at the top right
// of Discover, puts a tick on every installable card and a button that installs the ticked ones.

export type Tab = "discover" | "installed" | "updates";
const TABS: { id: Tab; key: Key }[] = [
  { id: "discover", key: "store.discover" },
  { id: "installed", key: "store.installedTab" },
  { id: "updates", key: "store.updates" },
];

/** Recommended apps first, otherwise the catalog's order. */
export const discoverOrder = (apps: CatalogEntry[]) => apps.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.recommended) - Number(x.a.recommended) || x.i - y.i).map((x) => x.a);

/** What a tab lists, narrowed by the search: every word somewhere in the name, titles, descriptions or publisher. */
export function tabApps(apps: CatalogEntry[], tab: Tab, query = ""): CatalogEntry[] {
  const list = tab === "discover" ? discoverOrder(apps) : tab === "installed" ? apps.filter((a) => a.installed) : apps.filter((a) => a.state === "update");
  return query.trim() ? list.filter((a) => matches(query, a.name, a.title.en, a.title.zh, a.description.en, a.description.zh, a.publisher.name)) : list;
}

export default function Store({ open, onClose, onChange, openUrl, selecting: startSelecting = false, initial }: {
  open: boolean;
  onClose: () => void;
  /** Called after each change that went through: the launcher pins a new app and reloads its lists. */
  onChange?: (c: CatalogChange) => void;
  /** The address an installed app opens at, when the panel lists it. */
  openUrl?: (app: string) => string | undefined;
  /** Opens in Batch Install, with the ticks shown (tests). */
  selecting?: boolean;
  /** A catalog already read (tests). */
  initial?: CatalogView;
}) {
  const { lang, t } = useLang();
  const cat = useCatalog({ initial, onChange });
  const [tab, setTab] = useState<Tab>("discover");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<string | null>(null);
  // Batch Install: the ticks show only while it is on, and leaving it forgets them.
  const [selecting, setSelecting] = useState(startSelecting);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const select = (on: boolean) => {
    setSelecting(on);
    setPicked(new Set());
  };

  useEffect(() => {
    if (!open || PAGE) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (detail ? setDetail(null) : onClose());
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, detail]);

  const v = cat.view;
  const updates = v?.apps.filter((a) => a.state === "update") ?? [];
  const shown = useMemo(() => (v ? tabApps(v.apps, tab, query) : []), [v, tab, query]);
  const current = detail ? v?.apps.find((a) => a.name === detail) : undefined;
  const canSelect = !current && tab === "discover" && !!v?.apps.some((a) => a.state === "available");
  const ticking = selecting && canSelect;

  const installPicked = () =>
    cat.batch(async () => {
      for (const name of [...picked]) {
        if (!(await cat.change(name, "install", { withSource: true }))) break;
        setPicked((p) => new Set([...p].filter((n) => n !== name)));
      }
      setSelecting(false);
    });

  const broken = v?.sources.filter((s) => !s.ok) ?? [];
  const readAt = v?.sources.map((s) => s.fetchedAt).filter((x): x is string => !!x).sort()[0];

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks store" role="dialog" aria-label={t("store.title")}>
        <div className="task-head">
          <b>{t("store.title")}</b>
          <span className="chat-sub">{readAt ? t("store.asOf", { time: relTime(readAt, lang) }) : ""}</span>
          {canSelect && (
            <button className={`inbox-pill${ticking ? " on" : ""}`} disabled={cat.busy} aria-pressed={ticking} onClick={() => select(!ticking)}>
              {ticking ? t("common.cancel") : t("store.batch")}
            </button>
          )}
          <button className="inbox-pill" disabled={cat.busy || !v} onClick={() => void cat.load(true)}>
            {t("catalog.refresh")}
          </button>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {!current && v && v.sources.length > 0 && (
          <div className="inbox-filters store-bar">
            {TABS.map((x) => (
              <button key={x.id} className={`inbox-pill${tab === x.id ? " on" : ""}`} onClick={() => setTab(x.id)}>
                {t(x.key)}
                {x.id === "updates" && updates.length > 0 && <span className="store-count">{updates.length}</span>}
              </button>
            ))}
            <label className="lib-search store-search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input type="search" value={query} placeholder={t("store.search")} aria-label={t("store.search")} onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
        )}
        <div className="task-body store-body">
          {!v && <p className="task-note">{cat.err ? t("common.unavailable", { error: cat.err }) : t("catalog.loading")}</p>}
          {v && !v.sources.length && <p className="task-note">{t("catalog.none")}</p>}
          {broken.map((s) => (
            <p key={s.url} className="task-note">
              {s.stale ? t("catalog.stale") : t("catalog.unreachable")} <span className="cat-mono">{s.error}</span>
            </p>
          ))}
          {v && v.sources.length > 0 && !v.apps.length && !broken.length && <p className="task-note">{t("catalog.empty")}</p>}
          {v && cat.err && <p className="form-err">{cat.err}</p>}
          {current ? (
            <Detail a={current} cat={cat} git={v!.git} openUrl={openUrl} onBack={() => setDetail(null)} />
          ) : (
            v && (
              <>
                {tab === "updates" && updates.length > 0 && <UpdateAll cat={cat} apps={updates} />}
                {v.apps.length > 0 && !shown.length && (
                  <p className="task-note">{query.trim() ? t("store.noMatch") : tab === "installed" ? t("store.noneInstalled") : t("store.noUpdates")}</p>
                )}
                <ul className="store-grid">
                  {shown.map((a) => (
                    <Card key={a.name} a={a} cat={cat} git={v.git} openUrl={openUrl} ticking={ticking} picked={picked.has(a.name)} onPick={() => setPicked((p) => toggle(p, a.name))} onOpen={() => setDetail(a.name)} />
                  ))}
                </ul>
                {ticking && picked.size > 0 && (
                  <div className="store-picked">
                    <button className="btn2 primary" disabled={cat.busy} onClick={() => void installPicked()}>
                      {cat.busy ? t("catalog.installing") : t("catalog.installPicked", { n: String(picked.size) })}
                    </button>
                  </div>
                )}
              </>
            )
          )}
          {cat.done.length > 0 && <p className="task-note">{t("catalog.done", { names: cat.done.join(", ") })}</p>}
        </div>
      </div>
      <Asks cat={cat} />
    </div>
  );
}

const toggle = (set: Set<string>, name: string) => {
  const next = new Set(set);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
};

function Icon({ a, large }: { a: CatalogEntry; large?: boolean }) {
  const cls = `cat-icon${large ? " store-icon-lg" : ""}`;
  return a.icon ? <img className={cls} src={a.icon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <span className={`${cls} store-icon-none`}>📦</span>;
}

function useNeedText() {
  const { t } = useLang();
  return (n: string) => {
    const key = `catalog.need.${n}`;
    const text = t(key as Key);
    return text === key ? n : text;
  };
}

/** A card's one button: what the app's state asks for. */
function StateButton({ a, cat, git, openUrl }: { a: CatalogEntry; cat: Catalog; git: boolean; openUrl?: (app: string) => string | undefined }) {
  const { t } = useLang();
  const doing = cat.working?.app === a.name ? cat.working.how : null;
  if (a.state === "available")
    return (
      <button className="btn2 primary" disabled={cat.busy} onClick={() => void cat.install(a.name, { withSource: true })}>
        {doing === "install" ? t("catalog.installing") : t("catalog.install")}
      </button>
    );
  if (a.state === "update")
    return (
      <button className="btn2 primary" disabled={cat.busy} onClick={() => void cat.upgrade(a.name)}>
        {doing === "upgrade" ? t("catalog.upgrading") : t("catalog.upgrade", { version: a.latest!.version })}
      </button>
    );
  if (a.state === "installed") {
    const url = openUrl?.(a.name);
    return url ? (
      <a className="btn2" href={url} target="_blank" rel="noopener noreferrer">
        {t("store.open")}
      </a>
    ) : (
      <span className="cat-state">{t("store.installedShort")}</span>
    );
  }
  if (a.state === "unreleased" && git)
    return (
      <button className="btn2" disabled={cat.busy} title={t("catalog.sourceHint")} onClick={() => void cat.install(a.name, { from: "source" })}>
        {doing === "source" ? t("catalog.building") : t("catalog.source")}
      </button>
    );
  return <span className="cat-state">{a.state === "legacy" ? t("store.legacyShort") : t("catalog.unreleased")}</span>;
}

function Card({ a, cat, git, openUrl, ticking, picked, onPick, onOpen }: { a: CatalogEntry; cat: Catalog; git: boolean; openUrl?: (app: string) => string | undefined; ticking: boolean; picked: boolean; onPick: () => void; onOpen: () => void }) {
  const { lang, t } = useLang();
  const needText = useNeedText();
  const title = loc(a.title, lang);
  return (
    <li className="store-card">
      <button className="store-card-main" onClick={onOpen} aria-label={t("store.details", { name: title })}>
        <Icon a={a} />
        <span className="store-card-text">
          <span className="store-card-title">
            <strong>{title}</strong>
            {a.recommended && <span className="cat-need">{t("store.recommended")}</span>}
          </span>
          <span className="cat-meta">
            {a.publisher.name}
            {a.latest ? ` · v${a.latest.version}` : ` · ${t("catalog.unreleased")}`}
            {!a.publisher.trusted && ` · ${t("catalog.untrusted")}`}
          </span>
          <span className="cat-desc store-card-desc">{loc(a.description, lang)}</span>
          {a.needs.length > 0 && (
            <span className="cat-needs">
              {a.needs.map((n) => (
                <span key={n} className="cat-need">{needText(n)}</span>
              ))}
            </span>
          )}
        </span>
      </button>
      <div className="store-card-foot">
        {a.installed ? <span className="cat-state">{t("catalog.installed", { version: a.installed.version })}</span> : ticking && a.state === "available" ? (
          <label className="cat-check">
            <input type="checkbox" className="cat-pick" aria-label={t("catalog.pick", { name: title })} checked={picked} disabled={cat.busy} onChange={onPick} />
            {t("store.pick")}
          </label>
        ) : <span />}
        <StateButton a={a} cat={cat} git={git} openUrl={openUrl} />
      </div>
      <ProgressLine a={a} cat={cat} />
    </li>
  );
}

/** Everything about one app, and every change it can take. */
export function Detail({ a, cat, git, openUrl, onBack }: { a: CatalogEntry; cat: Catalog; git: boolean; openUrl?: (app: string) => string | undefined; onBack: () => void }) {
  const { lang, t } = useLang();
  const needText = useNeedText();
  const [withSource, setWithSource] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const doing = cat.working?.app === a.name ? cat.working.how : null;
  const title = loc(a.title, lang);
  const i = a.installed;
  const url = i ? openUrl?.(a.name) : undefined;
  const canInstall = a.state === "available";
  const fromSource = git && (canInstall || a.state === "unreleased" || (i && i.origin !== "source"));
  const originText = i ? (i.origin === "source" ? (i.dev ? t("catalog.dev", { ref: i.ref ?? "" }) : t("catalog.fromSource")) : i.origin === "package" ? t("store.origin.package") : t("store.origin.local")) : "";
  const sourceText = i?.source === "modified" ? t("store.source.modified", { app: a.name }) : i?.source === "pristine" ? t("store.source.pristine", { app: a.name }) : i?.source === "own" ? t("store.source.own", { app: a.name }) : t("store.noSource");

  return (
    <div className="store-detail">
      <button className="setpage-back" onClick={onBack}>
        <span aria-hidden="true">‹</span> {t("store.title")}
      </button>
      <div className="store-detail-head">
        <Icon a={a} large />
        <div>
          <h3>{title}</h3>
          <div className="cat-meta">
            {a.publisher.name} · {a.publisher.trusted ? t("store.trusted") : t("catalog.untrusted")}
          </div>
        </div>
        {url && (
          <a className="btn2" href={url} target="_blank" rel="noopener noreferrer">
            {t("store.open")}
          </a>
        )}
      </div>
      <p className="store-detail-desc">{loc(a.description, lang)}</p>

      <div className="cat-actions store-actions">
        {a.state === "legacy" && <span className="cat-state">{t("catalog.legacy")}</span>}
        {canInstall && (
          <button className="btn2 primary" disabled={cat.busy} onClick={() => void cat.install(a.name, { withSource })}>
            {doing === "install" ? t("catalog.installing") : t("catalog.install")}
          </button>
        )}
        {canInstall && a.latest?.sourcePackage && (
          <label className="cat-check">
            <input type="checkbox" checked={withSource} disabled={cat.busy} onChange={() => setWithSource((x) => !x)} />
            {t("catalog.withSource")}
          </label>
        )}
        {a.state === "update" && (
          <button className="btn2 primary" disabled={cat.busy} onClick={() => void cat.upgrade(a.name)}>
            {doing === "upgrade" ? t("catalog.upgrading") : t("catalog.upgrade", { version: a.latest!.version })}
          </button>
        )}
        {a.state === "update" && i?.source === "modified" && (
          <button className="btn2" disabled={cat.busy} title={t("store.replaceHint", { app: a.name })} onClick={() => void cat.upgrade(a.name, { replaceSource: true })}>
            {t("store.replaceUpdate")}
          </button>
        )}
        {fromSource && (
          <button className="btn2" disabled={cat.busy} title={t("catalog.sourceHint")} onClick={() => void cat.install(a.name, { from: "source" })}>
            {doing === "source" ? t("catalog.building") : t("catalog.source")}
          </button>
        )}
        {i?.source && (
          <button className="btn2" disabled={cat.busy} title={t("catalog.rebuildHint", { app: a.name })} onClick={() => void cat.rebuild(a.name)}>
            {doing === "source" ? t("catalog.building") : t("catalog.rebuild")}
          </button>
        )}
        {i && !confirmRemove && (
          <button className="btn2" disabled={cat.busy} onClick={() => setConfirmRemove(true)}>
            {t("store.remove")}
          </button>
        )}
      </div>
      <ProgressLine a={a} cat={cat} />
      {confirmRemove && i && (
        <div className="cat-trust" role="alertdialog">
          <div>{t("store.removeAsk", { name: title, app: a.name })}</div>
          <div className="cat-actions">
            <button className="btn2 danger" disabled={cat.busy} onClick={() => void cat.remove(a.name).then(() => setConfirmRemove(false))}>
              {doing === "remove" ? t("store.removing") : t("store.remove")}
            </button>
            <button className="btn2" disabled={cat.busy} onClick={() => setConfirmRemove(false)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <dl className="store-facts">
        <dt>{t("store.version")}</dt>
        <dd>{a.latest ? `v${a.latest.version} (${a.latest.tag})` : t("catalog.unreleased")}</dd>
        <dt>{t("store.installedAs")}</dt>
        <dd>{i ? `${t("catalog.installed", { version: i.version })} · ${originText}` : t("store.notInstalled")}</dd>
        {i && (
          <>
            <dt>{t("store.sourceDir")}</dt>
            <dd>{sourceText}</dd>
          </>
        )}
        <dt>{t("store.publisher")}</dt>
        <dd>
          {a.publisher.url ? (
            <a href={a.publisher.url} target="_blank" rel="noopener noreferrer">
              {a.publisher.name}
            </a>
          ) : (
            a.publisher.name
          )}{" "}
          · {a.publisher.trusted ? t("store.trusted") : t("catalog.untrusted")} · <span className="cat-mono">{a.publisher.keyId.slice(0, 16)}…</span>
        </dd>
        <dt>{t("store.needs")}</dt>
        <dd>
          {a.needs.length ? (
            <span className="cat-needs">
              {a.needs.map((n) => (
                <span key={n} className="cat-need">{needText(n)}</span>
              ))}
            </span>
          ) : (
            t("store.needsNothing")
          )}
        </dd>
        <dt>{t("store.online")}</dt>
        <dd>
          {a.online.length ? (
            <span className="cat-needs">
              {a.online.map((o, k) => (
                <span key={k} className="cat-online">{loc(o, lang)}</span>
              ))}
            </span>
          ) : (
            t("store.onlineNothing")
          )}
        </dd>
        <dt>{t("store.license")}</dt>
        <dd>{a.license}</dd>
        <dt>{t("store.repo")}</dt>
        <dd>
          <a className="cat-link" href={a.repo} target="_blank" rel="noopener noreferrer">
            {a.repo}
          </a>
        </dd>
      </dl>
    </div>
  );
}

/** "Update all": every app with a newer release, one after the other; a refusal stops none of the others. */
export function UpdateAll({ cat, apps }: { cat: Catalog; apps: CatalogEntry[] }) {
  const { t } = useLang();
  const all = () =>
    cat.batch(async () => {
      for (const a of apps) await cat.change(a.name, "upgrade", {});
    });
  return (
    <div className="store-updateall">
      <span className="cat-state">{t("store.updatesWaiting", { n: apps.length })}</span>
      <button className="btn2 primary" disabled={cat.busy} onClick={() => void all()}>
        {cat.busy && cat.working?.how === "upgrade" ? t("store.updatingOne", { name: cat.working.app }) : t("store.updateAll")}
      </button>
    </div>
  );
}

/** The step an install or upgrade is on, with the bytes downloaded so far. */
export function ProgressLine({ a, cat }: { a: CatalogEntry; cat: Catalog }) {
  const { t } = useLang();
  const p = cat.working?.app === a.name ? cat.progress : null;
  if (!p || p.app !== a.name) return null;
  const pct = p.stage === "download" && p.total ? Math.min(100, Math.round(((p.received ?? 0) / p.total) * 100)) : null;
  return (
    <div className="store-progress" role="status">
      <span>
        {t(`store.stage.${p.stage}` as Key)}
        {p.stage === "download" && p.received ? ` · ${p.total ? t("store.bytes", { received: mb(p.received), total: mb(p.total) }) : mb(p.received)}` : ""}
      </span>
      <span className="store-bar-track" aria-hidden="true">
        <i className={pct === null ? "busy" : ""} style={pct === null ? undefined : { width: `${pct}%` }} />
      </span>
    </div>
  );
}
const mb = (n: number) => `${(n / 1_048_576).toFixed(n < 10_485_760 ? 1 : 0)} MB`;

/** The owner's yes, asked over the page: a publisher this Space does not trust yet, or source they changed. */
function Asks({ cat }: { cat: Catalog }) {
  const { t } = useLang();
  if (cat.ask)
    return (
      <div className="overlay store-ask">
        <div className="modal" role="alertdialog">
          <p>{t("catalog.trustAsk", { name: cat.ask.publisher.name, key: cat.ask.publisher.keyId.slice(0, 16) })}</p>
          <div className="actions">
            <button className="btn2" onClick={() => cat.ask!.resolve(false)}>{t("common.cancel")}</button>
            <button className="btn2 primary" onClick={() => cat.ask!.resolve(true)}>{t("catalog.trust")}</button>
          </div>
        </div>
      </div>
    );
  if (cat.askSource)
    return (
      <div className="overlay store-ask">
        <div className="modal" role="alertdialog">
          <p>{t("catalog.sourceAsk", { app: cat.askSource.app })}</p>
          <div className="actions">
            <button className="btn2" onClick={() => cat.askSource!.resolve(false)}>{t("catalog.sourceKeep")}</button>
            <button className="btn2 primary" onClick={() => cat.askSource!.resolve(true)}>{t("catalog.sourceReplace")}</button>
          </div>
        </div>
      </div>
    );
  return null;
}
