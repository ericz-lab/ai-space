import { useEffect, useState } from "react";
import { useLang } from "./i18n.ts";

// The app catalog in the Add dialog (docs/app-catalog.md): what the Space's catalogs list, what is
// installed, what has an update, and what each app needs, with install, install from source and
// upgrade. Opened from the home screen's first-use card, every installable app starts ticked.

type Localized = { en: string; zh?: string };
export type CatalogEntry = {
  name: string;
  title: Localized;
  description: Localized;
  icon?: string;
  repo: string;
  license: string;
  recommended: boolean;
  needs: string[];
  online: Localized[];
  publisher: { id: string; name: string; keyId: string; url?: string; trusted: boolean };
  latest: { version: string; tag: string; sourcePackage: boolean } | null;
  installed: { version: string; origin: "package" | "source" | "local"; ref: string | null; dev: boolean } | null;
  state: "available" | "installed" | "update" | "unreleased" | "legacy";
};
export type CatalogView = { sources: { url: string; ok: boolean; stale?: boolean; error?: string; apps: number }[]; apps: CatalogEntry[]; git: boolean };
type Answer = { ok: boolean; error?: string; code?: string; publisher?: { name: string; keyId: string; url?: string } };
type Request = { from?: "package" | "source"; withSource?: boolean; trust?: boolean };

const loc = (l: Localized, lang: string) => (lang === "zh" && l.zh ? l.zh : l.en);

async function post(path: string, body: unknown): Promise<Answer> {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as Answer;
}

/**
 * How many catalog apps a Space with none of them could install: the home screen's first-use card
 * shows when there are some. A Space that has any catalog app, or an old deployment of one, has
 * chosen already.
 */
export async function catalogOffers(): Promise<number> {
  const r = await fetch("/api/app-catalog").catch(() => null);
  if (!r?.ok) return 0;
  const v = (await r.json().catch(() => null)) as (CatalogView & { ok: boolean }) | null;
  if (!v?.ok || v.apps.some((a) => a.installed || a.state === "legacy")) return 0;
  return v.apps.filter((a) => a.state === "available").length;
}

const WELCOME_KEY = "catalog-welcome-dismissed";

/** The home screen's first-use card: the catalog's apps, all ticked, one click away. */
export function CatalogWelcome({ onOpen }: { onOpen: () => void }) {
  const { t } = useLang();
  const [count, setCount] = useState(0);
  useEffect(() => {
    try {
      if (localStorage.getItem(WELCOME_KEY)) return;
    } catch {
      /* no storage: ask on every load until an app is installed */
    }
    void catalogOffers().then(setCount);
  }, []);
  if (!count) return null;
  const dismiss = () => {
    setCount(0);
    try {
      localStorage.setItem(WELCOME_KEY, "1");
    } catch {
      /* no storage: hidden for this page */
    }
  };
  return (
    <div className="cat-welcome" role="region" aria-label={t("catalog.welcomeTitle")}>
      <div>
        <strong>{t("catalog.welcomeTitle")}</strong>
        <div className="cat-desc">{t("catalog.welcomeText", { n: count })}</div>
      </div>
      <div className="cat-actions">
        <button className="btn2 primary" onClick={() => (setCount(0), onOpen())}>{t("catalog.welcomeOpen")}</button>
        <button className="btn2" onClick={dismiss}>{t("catalog.welcomeLater")}</button>
      </div>
    </div>
  );
}

const installable = (v: CatalogView) => new Set(v.apps.filter((a) => a.state === "available").map((a) => a.name));

/** `initial` is a catalog already read (tests); without it the pane reads one when it opens. */
export function CatalogPane({ preselect, onInstalled, onClose, busy, setBusy, initial }: { preselect: boolean; onInstalled: () => void; onClose: () => void; busy: boolean; setBusy: (b: boolean) => void; initial?: CatalogView }) {
  const { lang, t } = useLang();
  const [view, setView] = useState<CatalogView | null>(initial ?? null);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => (initial && preselect ? installable(initial) : new Set()));
  const [withSource, setWithSource] = useState<Set<string>>(new Set());
  // The app being changed and how, so only the button that started it says so.
  const [working, setWorking] = useState<{ app: string; how: "install" | "upgrade" | "source" } | null>(null);
  const [done, setDone] = useState<string[]>([]);
  // A publisher the Space does not trust yet: the owner's yes, then the same request again.
  const [ask, setAsk] = useState<{ app: string; publisher: NonNullable<Answer["publisher"]>; resolve: (yes: boolean) => void } | null>(null);

  const load = async (refresh = false) => {
    try {
      const r = await fetch(`/api/app-catalog${refresh ? "?refresh=1" : ""}`);
      const v = (await r.json()) as CatalogView & { ok: boolean; error?: string };
      if (!v.ok) throw new Error(v.error || `HTTP ${r.status}`);
      setView(v);
      return v;
    } catch (e) {
      setErr(String((e as Error).message || e));
      return null;
    }
  };
  useEffect(() => {
    void load().then((v) => {
      if (v && preselect) setPicked(installable(v));
    });
  }, []);

  /** One install or upgrade, asking about an untrusted publisher on the way. */
  const change = async (app: string, kind: "install" | "upgrade", req: Request): Promise<boolean> => {
    setWorking({ app, how: req.from === "source" ? "source" : kind });
    try {
      let a = await post(`/api/app-catalog/${encodeURIComponent(app)}/${kind}`, req);
      if (!a.ok && a.code === "trust-required" && a.publisher) {
        const publisher = a.publisher;
        const yes = await new Promise<boolean>((resolve) => setAsk({ app, publisher, resolve }));
        setAsk(null);
        if (!yes) return false;
        a = await post(`/api/app-catalog/${encodeURIComponent(app)}/${kind}`, { ...req, trust: true });
      }
      if (!a.ok) {
        setErr(`${app}: ${a.error ?? "failed"}`);
        return false;
      }
      setDone((d) => [...d, app]);
      return true;
    } finally {
      setWorking(null);
    }
  };

  const run = async (work: () => Promise<unknown>) => {
    setErr("");
    setBusy(true);
    try {
      await work();
    } finally {
      await load();
      setBusy(false);
      onInstalled();
    }
  };
  const installPicked = () =>
    run(async () => {
      for (const name of [...picked]) {
        if (!(await change(name, "install", { withSource: withSource.has(name) }))) break;
        setPicked((p) => new Set([...p].filter((n) => n !== name)));
      }
    });

  const toggle = (set: Set<string>, name: string) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    return next;
  };
  const needText = (n: string) => {
    const key = `catalog.need.${n}`;
    const text = t(key as Parameters<typeof t>[0]);
    return text === key ? n : text;
  };

  if (!view)
    return (
      <>
        <div className={err ? "form-err" : "form-hint"}>{err || t("catalog.loading")}</div>
        <div className="actions">
          <button className="btn2" onClick={onClose}>{t("common.close")}</button>
        </div>
      </>
    );
  const broken = view.sources.filter((s) => !s.ok);
  return (
    <div className="cat">
      {!view.sources.length && <div className="form-hint">{t("catalog.none")}</div>}
      {broken.map((s) => (
        <div key={s.url} className="form-hint">
          {s.stale ? t("catalog.stale") : t("catalog.unreachable")} <span className="cat-mono">{s.error}</span>
        </div>
      ))}
      {view.sources.length > 0 && !view.apps.length && !broken.length && <div className="form-hint">{t("catalog.empty")}</div>}
      <ul className="cat-list">
        {view.apps.map((a) => {
          const doing = working?.app === a.name ? working.how : null;
          const canInstall = a.state === "available";
          return (
            <li key={a.name} className="cat-row">
              {canInstall ? (
                <input type="checkbox" className="cat-pick" aria-label={t("catalog.pick", { name: loc(a.title, lang) })} checked={picked.has(a.name)} disabled={busy} onChange={() => setPicked((p) => toggle(p, a.name))} />
              ) : (
                <span className="cat-pick" />
              )}
              {a.icon ? <img className="cat-icon" src={a.icon} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <span className="cat-icon" />}
              <div className="cat-main">
                <div className="cat-head">
                  <strong>{loc(a.title, lang)}</strong>
                  <span className="cat-meta">
                    {a.latest ? `v${a.latest.version}` : t("catalog.unreleased")} · {a.publisher.name}
                    {!a.publisher.trusted && ` · ${t("catalog.untrusted")}`}
                  </span>
                </div>
                <div className="cat-desc">{loc(a.description, lang)}</div>
                {(a.needs.length > 0 || a.online.length > 0) && (
                  <div className="cat-needs">
                    {a.needs.map((n) => (
                      <span key={n} className="cat-need">{needText(n)}</span>
                    ))}
                    {a.online.map((o, i) => (
                      <span key={i} className="cat-online">{loc(o, lang)}</span>
                    ))}
                  </div>
                )}
                <div className="cat-actions">
                  {a.installed && (
                    <span className="cat-state">
                      {t("catalog.installed", { version: a.installed.version })}
                      {a.installed.origin === "source" && ` · ${a.installed.dev ? t("catalog.dev", { ref: a.installed.ref ?? "" }) : t("catalog.fromSource")}`}
                    </span>
                  )}
                  {a.state === "legacy" && <span className="cat-state">{t("catalog.legacy")}</span>}
                  {canInstall && (
                    <button className="btn2 primary" disabled={busy} onClick={() => run(() => change(a.name, "install", { withSource: withSource.has(a.name) }))}>
                      {doing === "install" ? t("catalog.installing") : t("catalog.install")}
                    </button>
                  )}
                  {a.state === "update" && (
                    <button className="btn2 primary" disabled={busy} onClick={() => run(() => change(a.name, "upgrade", {}))}>
                      {doing === "upgrade" ? t("catalog.upgrading") : t("catalog.upgrade", { version: a.latest!.version })}
                    </button>
                  )}
                  {view.git && (canInstall || a.state === "unreleased" || (a.installed && a.installed.origin !== "source")) && (
                    <button className="btn2" disabled={busy} title={t("catalog.sourceHint")} onClick={() => run(() => change(a.name, "install", { from: "source" }))}>
                      {doing === "source" ? t("catalog.building") : t("catalog.source")}
                    </button>
                  )}
                  {canInstall && a.latest?.sourcePackage && (
                    <label className="cat-check">
                      <input type="checkbox" checked={withSource.has(a.name)} disabled={busy} onChange={() => setWithSource((s) => toggle(s, a.name))} />
                      {t("catalog.withSource")}
                    </label>
                  )}
                  <a className="cat-link" href={a.repo} target="_blank" rel="noreferrer">
                    {t("catalog.repo")}
                  </a>
                </div>
                {ask?.app === a.name && (
                  <div className="cat-trust" role="alertdialog">
                    <div>{t("catalog.trustAsk", { name: ask.publisher.name, key: ask.publisher.keyId.slice(0, 16) })}</div>
                    <div className="cat-actions">
                      <button className="btn2 primary" onClick={() => ask.resolve(true)}>{t("catalog.trust")}</button>
                      <button className="btn2" onClick={() => ask.resolve(false)}>{t("common.cancel")}</button>
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {done.length > 0 && <div className="form-hint">{t("catalog.done", { names: done.join(", ") })}</div>}
      {err && <div className="form-err">{err}</div>}
      <div className="actions">
        <button className="btn2" disabled={busy} onClick={() => void load(true)}>
          {t("catalog.refresh")}
        </button>
        <button className="btn2" disabled={busy} onClick={onClose}>
          {t("common.close")}
        </button>
        {picked.size > 0 && (
          <button className="btn2 primary" disabled={busy} onClick={installPicked}>
            {busy ? t("catalog.installing") : t("catalog.installPicked", { n: String(picked.size) })}
          </button>
        )}
      </div>
    </div>
  );
}
