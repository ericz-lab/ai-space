import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { LOCALE, LangContext, loadLang } from "./i18n.ts";
import { initAppearance } from "./theme.ts";

// The saved appearance is applied before the first render; index.html's inline script has
// already painted it from the boot record, so this confirms it and starts listening.
initAppearance();

/** The root owns the page language (saved preference, else the browser's) and provides it; see docs/i18n.md. */
function Root() {
  const [lang, setLang] = useState(loadLang);
  useEffect(() => {
    document.documentElement.lang = LOCALE[lang];
  }, [lang]);
  return (
    <LangContext.Provider value={lang}>
      <App onLang={setLang} />
    </LangContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
