import { createRoot } from "react-dom/client";
import { initAppearance } from "./theme.ts";
import { accentVars, type PreviewData, PreviewApp } from "./widget-preview-app.tsx";

// The preview page's script (bundled by widget-preview.tsx): mounts the real cards over the
// server's markup so they respond.

const data = JSON.parse(document.getElementById("preview-data")!.textContent!) as PreviewData;

// The cards read the panel's appearance (the `{accent}` of a link), which paints the saved theme
// on the page. The preview's look comes from its query string instead, so it is put back.
initAppearance();
const root = document.documentElement;
for (const p of [...root.style]) if (p !== "--widget-alpha") root.style.removeProperty(p);
// The preview's accent, painted as the panel paints an operator's accent; the picker changes it live.
const paintAccent = (hex: string) => {
  for (const [k, v] of Object.entries(accentVars(hex, data.scheme))) root.style.setProperty(k, v);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".accent-pick button")) b.setAttribute("aria-pressed", String(b.dataset.accent === hex));
  const input = document.querySelector<HTMLInputElement>(".accent-pick input");
  if (input) input.value = hex;
};
const chooseAccent = (hex: string) => {
  paintAccent(hex);
  const url = new URL(location.href);
  url.searchParams.set("accent", hex.slice(1));
  history.replaceState(null, "", url);
};
paintAccent(data.accent);
for (const b of document.querySelectorAll<HTMLButtonElement>(".accent-pick button")) b.addEventListener("click", () => chooseAccent(b.dataset.accent!));
document.querySelector<HTMLInputElement>(".accent-pick input")?.addEventListener("input", (e) => chooseAccent((e.target as HTMLInputElement).value.toLowerCase()));
root.dataset.theme = data.scheme;
root.dataset.backdrop = "orbit";
root.style.colorScheme = data.scheme;

createRoot(document.getElementById("preview-root")!).render(<PreviewApp data={data} />);
