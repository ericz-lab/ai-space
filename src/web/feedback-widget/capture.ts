import { cleanHtml, redact } from "../../space/feedback/context.ts";

/**
 * What the button learns about the page it sits on (docs/feedback.md#context): a selector for a
 * picked element, the element as cleaned data, the page's theme, and a position for the button that
 * stays inside the window. Nothing reads input values, cookies or storage.
 */

/** Class names worth keeping in a selector: not hashed or generated ones (`css-1x2y3z`, `_a1b2`). */
export function stableClasses(names: string[]): string[] {
  return names.filter((c) => /^[A-Za-z][\w-]{0,40}$/.test(c) && !/\d{3,}|^css-|^jsx-|^sc-|^_|[A-Z].*\d/.test(c)).slice(0, 2);
}

const cssEscape = (s: string): string => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));

/** The shortest selector, up to five levels deep, that names `el` alone in its document. */
export function selectorOf(el: Element): string {
  const doc = el.ownerDocument;
  const unique = (sel: string) => {
    try {
      return doc.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && unique(`#${cssEscape(el.id)}`)) return `#${cssEscape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && cur !== doc.documentElement && depth < 5; depth++) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) part = `#${cssEscape(cur.id)}`;
    else {
      const cls = stableClasses([...cur.classList]);
      if (cls.length) part += cls.map((c) => `.${cssEscape(c)}`).join("");
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
    }
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (unique(sel)) return sel;
    if (part.startsWith("#")) break;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

export type Picked = { selector: string; tag: string; text: string; html: string; rect: { x: number; y: number; w: number; h: number } };

/** A picked element as data: selector, tag, a little text, cleaned HTML and where it sits. */
export function describe(el: Element): Picked {
  const r = el.getBoundingClientRect();
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
  return {
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    text: redact(text.slice(0, 200)),
    html: cleanHtml(el.outerHTML.slice(0, 6000)),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  };
}

/** The page's colour theme as the app set it (`data-theme`, a `dark`/`light` class), else the system's. */
export function pageTheme(doc: Document, win: Window): "light" | "dark" {
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const t = el.getAttribute("data-theme") ?? el.getAttribute("data-color-scheme") ?? el.getAttribute("data-mode");
    if (t === "dark" || t === "light") return t;
    if (el.classList.contains("dark")) return "dark";
    if (el.classList.contains("light")) return "light";
  }
  return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** The button's corner offsets, kept inside the window. */
export function clampPosition(p: { right: number; bottom: number }, size: number, vw: number, vh: number, margin = 8): { right: number; bottom: number } {
  const maxR = Math.max(margin, vw - size - margin);
  const maxB = Math.max(margin, vh - size - margin);
  return { right: Math.round(Math.min(maxR, Math.max(margin, p.right))), bottom: Math.round(Math.min(maxB, Math.max(margin, p.bottom))) };
}

/** A data URL's base64 part and its size in bytes. */
export function base64Of(dataUrl: string): { data: string; bytes: number } {
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { data, bytes: Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) };
}
