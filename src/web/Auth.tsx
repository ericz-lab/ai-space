import { useEffect, useState } from "react";
import { getJson, sendJson } from "./api.ts";
import { useLang } from "./i18n.ts";

/**
 * The built-in sign-in (docs/auth.md#the-panel): the sign-in card, the watch for a
 * session that ends while the page is open, and the account rows of the settings.
 * Under `SPACE_AUTH=external` none of it shows.
 */

export type AuthState = { mode: "external" | "builtin"; initialized?: boolean; signedIn?: boolean };

export const SIGNED_OUT = "space:signed-out";

/** Fetches the session state; a failure counts as external, so the panel never locks itself out over a network error. */
export async function loadAuth(): Promise<AuthState> {
  try {
    const r = await fetch("/api/auth/session", { cache: "no-store" });
    return r.ok ? ((await r.json()) as AuthState) : { mode: "external" };
  } catch {
    return { mode: "external" };
  }
}

/**
 * Any same-origin API call answered with "sign-in required" announces it, so the sign-in
 * card can open over the page without losing what is on it.
 */
export function watchSignOut(): void {
  const original = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await original(input, init);
    if (r.status === 401 && r.headers.get("content-type")?.includes("application/json")) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) {
        void r.clone().json().then((b: { auth?: string }) => b?.auth && window.dispatchEvent(new Event(SIGNED_OUT)), () => {});
      }
    }
    return r;
  }) as typeof fetch;
}

/** `?next=` only when it is a path on this origin, never another site. */
export function safeNext(search: string): string | undefined {
  const next = new URLSearchParams(search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  try {
    const u = new URL(next, location.origin);
    return u.origin === location.origin ? u.pathname + u.search + u.hash : undefined;
  } catch {
    return undefined;
  }
}

export function SignIn({ state, onSignedIn }: { state: AuthState; onSignedIn: () => void }) {
  const { t } = useLang();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (r.ok) return onSignedIn();
      setErr(r.status === 429 ? t("auth.limited") : r.status === 409 ? t("auth.uninitialized") : t("auth.wrong"));
    } catch {
      setErr(t("auth.network"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay auth-overlay">
      <form className="modal" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <h3>{t("auth.title")}</h3>
        {state.initialized === false ? (
          <div className="form-hint">{t("auth.uninitialized")}</div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="space-password">{t("auth.password")}</label>
              <input id="space-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
            </div>
            {err && <div className="form-err" role="alert">{err}</div>}
            <div className="actions">
              <button type="submit" className="btn2 primary" disabled={busy || !password}>
                {busy ? t("auth.signingIn") : t("auth.signIn")}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

type SessionView = { id: number; createdAt: string; lastSeenAt: string; userAgent: string; current: boolean };

/** Sign out, change the password, and the live sessions; only under builtin. */
export function AccountSettings() {
  const { t, lang } = useLang();
  const [state, setState] = useState<AuthState | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = () => getJson<{ sessions: SessionView[] }>("/api/auth/sessions").then((d) => setSessions(d.sessions)).catch(() => {});
  useEffect(() => {
    void loadAuth().then((s) => {
      setState(s);
      if (s.mode === "builtin" && s.signedIn) void refresh();
    });
  }, []);
  if (state?.mode !== "builtin" || !state.signedIn) return null;

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
  };
  const change = async () => {
    setBusy(true);
    setMsg("");
    try {
      await sendJson("POST", "/api/auth/password", { current, next });
      setChanging(false);
      setCurrent("");
      setNext("");
      setMsg(t("auth.changed"));
      void refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: number) => {
    await sendJson("DELETE", `/api/auth/sessions/${id}`).catch(() => {});
    void refresh();
  };
  const when = (iso: string) => new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });

  return (
    <>
      <button className="setrow setlink" onClick={() => setChanging((v) => !v)}>
        {t("auth.changePassword")}
        <span>{changing ? "−" : "›"}</span>
      </button>
      {changing && (
        <form className="auth-change" onSubmit={(e) => (e.preventDefault(), void change())}>
          <div className="field">
            <label htmlFor="space-current">{t("auth.current")}</label>
            <input id="space-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="space-next">{t("auth.new")}</label>
            <input id="space-next" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} />
          </div>
          <p className="setnote">{t("auth.changeHelp")}</p>
          <div className="actions">
            <button type="submit" className="btn2 primary" disabled={busy || !current || next.length < 8}>
              {t("common.save")}
            </button>
          </div>
        </form>
      )}
      {msg && <p className="setnote" role="status">{msg}</p>}
      <p className="setnote">{t("auth.sessions", { n: sessions.length })}</p>
      {sessions.map((s) => (
        <div key={s.id} className="setrow">
          <span className="auth-session">
            {s.userAgent || t("auth.unknownClient")}
            <small>{s.current ? t("auth.thisSession") : t("auth.lastSeen", { at: when(s.lastSeenAt) })}</small>
          </span>
          {!s.current && (
            <button className="btn2" onClick={() => void revoke(s.id)}>
              {t("auth.revoke")}
            </button>
          )}
        </div>
      ))}
      <button className="setrow setlink" onClick={() => void signOut()}>
        {t("auth.signOut")}
        <span>›</span>
      </button>
    </>
  );
}
