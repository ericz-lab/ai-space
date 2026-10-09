import { useEffect, useState } from "react";
import { useLang } from "./i18n.ts";

// Ways between the screens: an edge on either side that shows its button under the pointer (a faint
// handle stays visible so the way is there without hovering), a dock at the bottom with the
// library, home and one icon per screen, a search button, and a first-use hint. With a mouse the
// dock stays out of sight until the pointer comes near the bottom of the window (or the keyboard
// focus enters it); touch screens always show it.
// Position -1 is the library; 0 is home; the operator's screens follow.

const HINT_KEY = "panel-screens-hint";
/** How close to the bottom of the window, in px, the pointer brings the dock up. */
const DOCK_ZONE = 110;
const hintSeen = () => {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return true;
  }
};

export default function ScreenNav({
  pos,
  names,
  onGo,
  onNew,
  onSearch,
}: {
  pos: number;
  /** Display names of the screens, home first. */
  names: string[];
  onGo: (pos: number) => void;
  onNew: () => void;
  onSearch: () => void;
}) {
  const { t } = useLang();
  const [hint, setHint] = useState(() => !hintSeen());
  const dismiss = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* the hint shows again next time */
    }
  };
  const [near, setNear] = useState(false);
  useEffect(() => {
    const move = (e: MouseEvent) => setNear(window.innerHeight - e.clientY <= DOCK_ZONE);
    const leave = () => setNear(false);
    document.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      document.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
    };
  }, []);
  const last = names.length - 1;
  const prevName = pos === 0 ? t("screens.library") : names[pos - 1];
  const nextName = pos < last ? names[pos + 1] : null;
  const label = (name: string | undefined) => t("screens.goTo", { name: name ?? "" });
  return (
    <>
      {pos >= 0 && (
        <button className="edge left" onClick={() => onGo(pos - 1)} aria-label={label(prevName)}>
          <i className="edge-handle" />
          <span className="edge-btn">‹</span>
        </button>
      )}
      {nextName !== null ? (
        <button className="edge right" onClick={() => onGo(pos + 1)} aria-label={label(nextName)}>
          <i className="edge-handle" />
          <span className="edge-btn">›</span>
        </button>
      ) : (
        <button className="edge right" onClick={onNew} aria-label={t("screens.new")}>
          <i className="edge-handle" />
          <span className="edge-btn">＋</span>
        </button>
      )}
      <nav className={`dock${near || hint ? " shown" : ""}`} aria-label={t("screens.nav")}>
        <button className={`dock-btn${pos === -1 ? " on" : ""}`} onClick={() => onGo(-1)} aria-label={t("screens.library")} aria-current={pos === -1 ? "page" : undefined}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2.5" y="2.5" width="6" height="6" rx="1.6" />
            <rect x="11.5" y="2.5" width="6" height="6" rx="1.6" />
            <rect x="2.5" y="11.5" width="6" height="6" rx="1.6" />
            <rect x="11.5" y="11.5" width="6" height="6" rx="1.6" />
          </svg>
        </button>
        <button className={`dock-btn${pos === 0 ? " on" : ""}`} onClick={() => onGo(0)} aria-label={names[0]} aria-current={pos === 0 ? "page" : undefined}>
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 9.2 10 3l7 6.2V17a.5.5 0 0 1-.5.5h-4v-5h-5v5h-4A.5.5 0 0 1 3 17z" />
          </svg>
        </button>
        {/* The operator's screens: a line square with the screen's position, home being 1. */}
        {names.slice(1).map((n, i) => (
          <button key={i} className={`dock-btn dock-screen${pos === i + 1 ? " on" : ""}`} onClick={() => onGo(i + 1)} aria-label={n} aria-current={pos === i + 1 ? "page" : undefined}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <rect x="3" y="3" width="14" height="14" rx="3.5" />
              <text x="10" y="10.5" textAnchor="middle" dominantBaseline="central">
                {i + 2}
              </text>
            </svg>
          </button>
        ))}
        <span className="dock-sep" />
        <button className="dock-btn" onClick={onSearch} aria-label={t("screens.search")} aria-keyshortcuts="Meta+K Control+K">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5" />
            <path d="m12.5 12.5 4.5 4.5" />
          </svg>
        </button>
      </nav>
      {hint && (
        <div className="screens-hint" role="note">
          <span>{t("screens.hint")}</span>
          <button className="btn2" onClick={dismiss}>
            {t("screens.gotIt")}
          </button>
        </div>
      )}
    </>
  );
}
