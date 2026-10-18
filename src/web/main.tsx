import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { startDeviceUsage } from "./device-usage.ts";
import App from "./App.tsx";
import { type AuthState, SIGNED_OUT, SignIn, loadAuth, safeNext, watchSignOut } from "./Auth.tsx";
import { LOCALE, LangContext, loadLang } from "./i18n.ts";
import { initAppearance } from "./theme.ts";

// The saved appearance is applied before the first render; index.html's inline script has
// already painted it from the boot record, so this confirms it and starts listening.
initAppearance();
watchSignOut();

/** The root owns the page language (saved preference, else the browser's) and provides it; see docs/i18n.md. */
function Root() {
  const [lang, setLang] = useState(loadLang);
  // Under SPACE_AUTH=builtin the panel waits for a session (docs/auth.md#the-panel); an expired one
  // opens the sign-in card over the page, so what is open stays open.
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [expired, setExpired] = useState(false);
  const ready = auth !== null && (auth.mode === "external" || auth.signedIn === true);
  useEffect(() => {
    void loadAuth().then(setAuth);
    const onSignedOut = () => setExpired(true);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);
  useEffect(() => (ready ? startDeviceUsage() : undefined), [ready]);
  useEffect(() => {
    document.documentElement.lang = LOCALE[lang];
  }, [lang]);
  const signedIn = () => {
    const next = safeNext(location.search);
    if (next) return location.assign(next);
    setExpired(false);
    setAuth((a) => (a ? { ...a, signedIn: true } : a));
  };
  return (
    <LangContext.Provider value={lang}>
      {ready && <App onLang={setLang} />}
      {auth && auth.mode === "builtin" && (!auth.signedIn || expired) && <SignIn state={auth} onSignedIn={signedIn} />}
    </LangContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
