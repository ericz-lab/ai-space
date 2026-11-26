import { createRoot } from "react-dom/client";
import { initAppearance } from "./theme.ts";
import { type PreviewData, PreviewApp } from "./widget-preview-app.tsx";

// The preview page's script (bundled by widget-preview.tsx): mounts the real cards over the
// server's markup so they respond.

const data = JSON.parse(document.getElementById("preview-data")!.textContent!) as PreviewData;

// The cards read the panel's appearance (the `{accent}` of a link), which paints the saved theme
// on the page. The preview's look comes from its query string instead, so it is put back.
initAppearance();
const root = document.documentElement;
for (const p of [...root.style]) if (p !== "--widget-alpha") root.style.removeProperty(p);
root.dataset.theme = data.scheme;
root.dataset.backdrop = "orbit";
root.style.colorScheme = data.scheme;

createRoot(document.getElementById("preview-root")!).render(<PreviewApp data={data} />);
