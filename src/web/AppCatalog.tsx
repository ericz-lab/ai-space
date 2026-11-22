import { useEffect, useRef, useState } from "react";
import { useLang } from "./i18n.ts";

// The app catalog's client side (docs/app-catalog.md): the answer's shapes, `useCatalog` (reading
// the catalog, install, upgrade, rebuild and uninstall with the owner's yes to an untrusted
// publisher and to taking an update over source they changed), and the home screen's first-use
// card. The App Store page (Store.tsx) is built on it.

export type Localized = { en: string; zh?: string };
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
  installed: { version: string; origin: "package" | "source" | "local"; ref: string | null; dev: boolean; source?: "pristine" | "modified" | "own" } | null;
  state: "available" | "installed" | "update" | "unreleased" | "legacy";
};
export type CatalogView = { sources: { url: string; ok: boolean; stale?: boolean; error?: string; fetchedAt?: string; apps: number }[]; apps: CatalogEntry[]; git: boolean };
type Answer = { ok: boolean; error?: string; code?: string; publisher?: { name: string; keyId: string; url?: string } };
export type CatalogRequest = { from?: "package" | "source"; withSource?: boolean; replaceSource?: boolean; trust?: boolean };

export const loc = (l: Localized, lang: string) => (lang === "zh" && l.zh ? l.zh : l.en);

async function send(method: "POST" | "DELETE", path: string, body?: unknown): Promise<Answer> {
  const r = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as Answer;
}
const post = (path: string, body: unknown) => send("POST", path, body);

/** Where an install or upgrade in flight is (`GET /api/app-catalog/progress`). */
export type CatalogProgress = { app: string; kind: "install" | "upgrade"; stage: "download" | "verify" | "install" | "source" | "clone" | "pull" | "build"; received?: number; total?: number; since: string };

/** What a change did, for the page around the store (a new tile, a reload). */
export type CatalogChange = { app: string; action: "installed" | "upgraded" | "rebuilt" | "removed" };
/** The app being changed and how, so only the button that started it says so. */
export type Working = { app: string; how: "install" | "upgrade" | "source" | "remove" };
export type TrustAsk = { app: string; publisher: NonNullable<Answer["publisher"]>; resolve: (yes: boolean) => void };
export type SourceAsk = { app: string; resolve: (yes: boolean) => void };

/**
 * The catalog and every change to it, one at a time. `initial` is a catalog already read (tests);
 * without it the catalog is read on mount. Each change answers whether it went through; a refusal
 * lands in `err`, and the catalog is read again after every change.
 */
export function useCatalog({ initial, onChange }: { initial?: CatalogView; onChange?: (c: CatalogChange) => void } = {}) {
  const [view, setView] = useState<CatalogView | null>(initial ?? null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<Working | null>(null);
  const [done, setDone] = useState<string[]>([]);
  // A publisher the Space does not trust yet: the owner's yes, then the same request again.
  const [ask, setAsk] = useState<TrustAsk | null>(null);
  // Source the owner changed: taking the release over it is theirs to decide.
  const [askSource, setAskSource] = useState<SourceAsk | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  // The step of the change in flight, read every half second while its request waits.
  const [progress, setProgress] = useState<CatalogProgress | null>(null);
  const workingApp = working?.how === "install" || working?.how === "upgrade" || working?.how === "source" ? working.app : null;
  useEffect(() => {
    setProgress(null);
    if (!workingApp) return;
    let live = true;
    const pull = () =>
      fetch("/api/app-catalog/progress")
        .then((r) => r.json() as Promise<{ ok: boolean; progress?: CatalogProgress[] }>)
        .then((d) => live && setProgress(d.progress?.find((p) => p.app === workingApp) ?? null))
        .catch(() => {});
    const timer = setInterval(pull, 500);
    void pull();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workingApp]);
  /** A refusal joins the ones before it in the same run, so "update all" reports every app that failed. */
  const fail = (msg: string) => setErr((prev) => (prev ? `${prev}\n${msg}` : msg));

  const load = async (refresh = false): Promise<CatalogView | null> => {
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
    if (!initial) void load();
  }, []);

  const report = (c: CatalogChange) => {
    setDone((d) => [...d.filter((n) => n !== c.app), c.app]);
    changed.current?.(c);
  };

  /** One install or upgrade, asking about an untrusted publisher and changed source on the way. */
  const change = async (app: string, kind: "install" | "upgrade", req: CatalogRequest): Promise<boolean> => {
    setWorking({ app, how: req.from === "source" ? "source" : kind });
    try {
      const path = `/api/app-catalog/${encodeURIComponent(app)}/${kind}`;
      let a = await post(path, req);
      if (!a.ok && a.code === "trust-required" && a.publisher) {
        const publisher = a.publisher;
        const yes = await new Promise<boolean>((resolve) => setAsk({ app, publisher, resolve }));
        setAsk(null);
        if (!yes) return false;
        req = { ...req, trust: true };
        a = await post(path, req);
      }
      if (!a.ok && a.code === "source-modified") {
        const yes = await new Promise<boolean>((resolve) => setAskSource({ app, resolve }));
        setAskSource(null);
        if (!yes) return false;
        a = await post(path, { ...req, replaceSource: true });
      }
      if (!a.ok) {
        fail(`${app}: ${a.error ?? "failed"}`);
        return false;
      }
      report({ app, action: kind === "install" ? "installed" : "upgraded" });
      return true;
    } catch (e) {
      fail(`${app}: ${String((e as Error).message || e)}`);
      return false;
    } finally {
      setWorking(null);
    }
  };

  /** Build what is in app-src/<app> and run it in place of the installed version. */
  const rebuildOne = async (app: string): Promise<boolean> => {
    setWorking({ app, how: "source" });
    try {
      const a = await post(`/api/studio/apps/${encodeURIComponent(app)}/build`, {});
      if (!a.ok) fail(`${app}: ${a.error ?? "failed"}`);
      else report({ app, action: "rebuilt" });
      return a.ok;
    } finally {
      setWorking(null);
    }
  };

  /** The package lifecycle's removal: the app stops and leaves the panel; its data and app-src/<app> stay. */
  const removeOne = async (app: string): Promise<boolean> => {
    setWorking({ app, how: "remove" });
    try {
      const a = await send("DELETE", `/api/panel/packages/apps/${encodeURIComponent(app)}`);
      if (!a.ok) fail(`${app}: ${a.error ?? "failed"}`);
      else report({ app, action: "removed" });
      return a.ok;
    } finally {
      setWorking(null);
    }
  };

  /** Runs changes with the store busy, then reads the catalog again. */
  const run = async <T,>(work: () => Promise<T>): Promise<T> => {
    setErr("");
    setBusy(true);
    try {
      return await work();
    } finally {
      await load();
      setBusy(false);
    }
  };

  return {
    view,
    err,
    setErr,
    busy,
    working,
    progress,
    done,
    ask,
    askSource,
    load,
    install: (app: string, req: CatalogRequest = {}) => run(() => change(app, "install", req)),
    upgrade: (app: string, req: CatalogRequest = {}) => run(() => change(app, "upgrade", req)),
    rebuild: (app: string) => run(() => rebuildOne(app)),
    remove: (app: string) => run(() => removeOne(app)),
    /** Several changes in a row under one busy state; `change` is the single step. */
    batch: run,
    change,
  };
}
export type Catalog = ReturnType<typeof useCatalog>;

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

/** The home screen's first-use card: the catalog's apps, all ticked in the App Store, one click away. */
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

