import { type FeedbackImage, LIMITS, type PageContext, type PickedElement } from "./types.ts";

/**
 * The page's word about itself, cleaned before anything keeps it (docs/feedback.md#context). The
 * page is not trusted: every field is typed, bounded and stripped of what looks like a secret, here
 * as well as in the script, so a page that skips the script's own cleaning gains nothing.
 */

/** Query and fragment parameters whose values are never kept. */
const SECRET_NAME = /token|key|secret|pass|auth|session|sig|code|credential|jwt|bearer|otp|ticket|cookie|csrf|nonce/i;

/** Values that look like credentials wherever they appear in text. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [redacted]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted-jwt]"],
  [/\b(sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})/g, "[redacted-key]"],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token))(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>]+)/gi, "$1$2[redacted]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** A URL without credentials, secret-looking parameters or a fragment that carries them. */
export function cleanUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  u.username = "";
  u.password = "";
  for (const name of [...u.searchParams.keys()]) if (SECRET_NAME.test(name)) u.searchParams.set(name, "redacted");
  if (u.hash.includes("=")) {
    const h = new URLSearchParams(u.hash.slice(1));
    let changed = false;
    for (const name of [...h.keys()]) if (SECRET_NAME.test(name)) { h.set(name, "redacted"); changed = true; }
    if (changed) u.hash = h.toString();
  }
  return u.toString().slice(0, LIMITS.url);
}

/** An element's HTML as data: no scripts or styles, no event handlers, no values or secret-looking attributes. */
export function cleanHtml(html: string): string {
  const attr = /\s([\w:.@-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
  const keep = (all: string, name: string) => (/^on/i.test(name) || /^(value|srcdoc|nonce|integrity)$/i.test(name) || SECRET_NAME.test(name) ? "" : all);
  return redact(
    html
      .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?(script|style)\b[^>]*>/gi, "")
      .replace(/<([a-zA-Z][\w:-]*)([^>]*)>/g, (_all, tag: string, attrs: string) => `<${tag}${attrs.replace(attr, keep)}>`),
  ).slice(0, LIMITS.elementHtml);
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.round(Math.min(hi, Math.max(lo, n)) * 100) / 100;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function element(raw: unknown): PickedElement | null {
  const o = obj(raw);
  const selector = str(o.selector, LIMITS.selector);
  if (!selector) return null;
  const r = obj(o.rect);
  return {
    selector: redact(selector),
    tag: str(o.tag, 40).toLowerCase().replace(/[^a-z0-9-]/g, ""),
    text: redact(str(o.text, LIMITS.elementText)),
    html: cleanHtml(str(o.html, LIMITS.elementHtml * 2)),
    rect: { x: num(r.x, -1e5, 1e5), y: num(r.y, -1e5, 1e5), w: num(r.w, 0, 1e5), h: num(r.h, 0, 1e5) },
  };
}

/** The page context, typed and bounded; unknown fields are dropped. */
export function parseContext(raw: unknown): PageContext {
  const o = obj(raw);
  const url = cleanUrl(str(o.url, LIMITS.url * 2));
  let path = "";
  try {
    if (url) {
      const u = new URL(url);
      path = `${u.pathname}${u.search}${u.hash}`;
    }
  } catch { /* no path */ }
  const vp = obj(o.viewport);
  const lang = str(o.lang, 20);
  return {
    url,
    path: path.slice(0, LIMITS.url),
    title: redact(str(o.title, LIMITS.title)),
    viewport: { w: num(vp.w, 0, 20000), h: num(vp.h, 0, 20000), dpr: num(vp.dpr, 0, 10) },
    touch: o.touch === true,
    theme: o.theme === "dark" ? "dark" : "light",
    lang: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : "",
    elements: (Array.isArray(o.elements) ? o.elements : []).slice(0, LIMITS.elements).map(element).filter((e): e is PickedElement => e !== null),
    errors: (Array.isArray(o.errors) ? o.errors : []).slice(0, LIMITS.errors).map((e) => redact(str(e, LIMITS.errorText))).filter(Boolean),
    tz: /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(str(o.tz, 64)) ? str(o.tz, 64) : "",
  };
}

const IMAGE_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/webp": (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
};

/** Screenshots and attached pictures: base64 in the JSON body, PNG, JPEG or WebP by their bytes, at most two. */
export function parseImages(raw: unknown): FeedbackImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("images must be a list");
  if (raw.length > LIMITS.images) throw new Error(`at most ${LIMITS.images} images`);
  return raw.map((r, i) => {
    const o = obj(r);
    const data = typeof o.data === "string" ? o.data.replace(/^data:[^,]*,/, "") : "";
    if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw new Error(`image ${i + 1}: data must be base64`);
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.length > LIMITS.imageBytes) throw new Error(`image ${i + 1} is larger than ${LIMITS.imageBytes / 1024 / 1024} MiB`);
    const type = Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t]!(bytes));
    if (!type) throw new Error(`image ${i + 1} is not a PNG, JPEG or WebP picture`);
    const ext = type === "image/jpeg" ? "jpg" : type.slice(6);
    const base = str(o.name, 80).replace(/[^\w.-]+/g, "-").replace(/\.[A-Za-z0-9]+$/, "") || `screenshot-${i + 1}`;
    return { name: `${base}.${ext}`, type, bytes };
  });
}
