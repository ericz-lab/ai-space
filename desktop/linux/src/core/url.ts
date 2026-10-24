/**
 * URL rules of the Linux client, without the WHATWG `URL` class: GJS does not have it, and this
 * core runs under GJS (the app) and Bun (the tests) alike. The rules are the Mac client's
 * `ConnectionRules` (desktop/macos/AISpace/Services/Connection.swift): HTTPS anywhere, plain HTTP
 * only to this computer's loopback.
 */

export type ParsedUrl = {
  scheme: string;
  /** Lower-cased; an IPv6 literal keeps its brackets. */
  host: string;
  port?: number;
  path: string;
  query: string;
  fragment: string;
  userinfo?: string;
};

const URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

export function parseUrl(text: string): ParsedUrl | undefined {
  const m = URL_RE.exec(text.trim());
  if (!m) return undefined;
  const port = m[4] ? Number(m[4]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port > 65535)) return undefined;
  return {
    scheme: m[1]!.toLowerCase(),
    host: (m[3] ?? "").toLowerCase(),
    ...(port !== undefined ? { port } : {}),
    path: m[5] ?? "",
    query: m[6] ?? "",
    fragment: m[7] ?? "",
    ...(m[2] !== undefined ? { userinfo: m[2] } : {}),
  };
}

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 };

export function isLoopback(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1") return true;
  const parts = h.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return false;
  return parts[0] === "127";
}

/** A package app's isolated loopback origin (`<app>.localhost`, docs/app-packages.md). */
export function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

export type UrlError = "empty" | "invalid" | "unsupported-scheme" | "credentials" | "insecure-remote";

export class ConnectionUrlError extends Error {
  constructor(readonly code: UrlError) {
    super(code);
  }
}

function format(u: ParsedUrl, withQuery = true): string {
  const port = u.port !== undefined && u.port !== DEFAULT_PORT[u.scheme] ? `:${u.port}` : "";
  const q = withQuery && u.query ? `?${u.query}` : "";
  const f = withQuery && u.fragment ? `#${u.fragment}` : "";
  return `${u.scheme}://${u.host}${port}${u.path || "/"}${q}${f}`;
}

/**
 * What the operator typed, as a panel URL, or why it cannot be one. A missing scheme means HTTP
 * for loopback and HTTPS otherwise; query and fragment are dropped.
 */
export function normalizeConnectionUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new ConnectionUrlError("empty");
  if (!text.includes("://")) {
    const host = text.split("/")[0] ?? text;
    const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? host);
    text = (isLoopback(bare) ? "http://" : "https://") + text;
  }
  const u = parseUrl(text);
  if (!u) throw new ConnectionUrlError("invalid");
  if (u.scheme !== "http" && u.scheme !== "https") throw new ConnectionUrlError("unsupported-scheme");
  if (!u.host) throw new ConnectionUrlError("invalid");
  if (u.userinfo !== undefined) throw new ConnectionUrlError("credentials");
  if (u.scheme === "http" && !isLoopback(u.host)) throw new ConnectionUrlError("insecure-remote");
  return format({ ...u, query: "", fragment: "" }, false);
}

/** `scheme://host[:port]`, without a trailing slash; the default port is left out. */
export function origin(url: string): string | undefined {
  const u = parseUrl(url);
  if (!u || !u.host) return undefined;
  const port = u.port !== undefined && u.port !== DEFAULT_PORT[u.scheme] ? `:${u.port}` : "";
  return `${u.scheme}://${u.host}${port}`;
}

/** Whether two URLs share scheme, host and effective port. */
export function sameOrigin(a: string, b: string): boolean {
  const x = parseUrl(a);
  const y = parseUrl(b);
  if (!x || !y || x.scheme !== y.scheme || x.host !== y.host) return false;
  return (x.port ?? DEFAULT_PORT[x.scheme]) === (y.port ?? DEFAULT_PORT[y.scheme]);
}

export function hostOf(url: string): string {
  return parseUrl(url)?.host ?? "";
}

export function pathOf(url: string): string {
  return parseUrl(url)?.path || "/";
}

/**
 * A reference resolved against a base, for the forms the Space hands out: an absolute URL, a
 * scheme-relative `//host/x`, an absolute path `/x`, or a relative `x` (against the base's directory).
 */
export function resolveUrl(ref: string, base: string): string | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(r)) return r;
  const b = parseUrl(base);
  if (!b) return undefined;
  if (r.startsWith("//")) return `${b.scheme}:${r}`;
  const o = origin(base)!;
  if (r.startsWith("/")) return o + r;
  if (r.startsWith("?") || r.startsWith("#")) return o + (b.path || "/") + r;
  const dir = (b.path || "/").replace(/[^/]*$/, "");
  return o + dir + r;
}

/** One path segment, escaped as the Mac's `SpacePath.escape`: letters, digits and `-._~` stay. */
export function escapeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `a=1&b=2`, each value escaped. */
export function queryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

/** The query of a URL as pairs, decoded; `+` is a space as in a form. */
export function queryParams(url: string): Record<string, string> {
  const q = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0]! : "";
  const out: Record<string, string> = {};
  for (const part of q.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const key = decode(i < 0 ? part : part.slice(0, i));
    if (!(key in out)) out[key] = decode(i < 0 ? "" : part.slice(i + 1));
  }
  return out;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}
