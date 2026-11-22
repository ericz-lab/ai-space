import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The catalog every Space reads unless `SPACE_APP_CATALOG` says otherwise (docs/app-catalog.md): the
 * ai-space-apps repository's `catalog.json`, published under ai-space.me so that a Space needs no
 * route to GitHub to list or install apps.
 */
export const DEFAULT_CATALOG_URL = "https://ai-space.me/store/index.json";

/**
 * `SPACE_APP_CATALOG`: unset, the default catalog; `none` or empty, no catalog; otherwise a comma
 * list read in order, where `default` stands for the default catalog, an https URL is fetched
 * (plain http only on loopback) and a path is a local file (relative to the workspace).
 * The first catalog that lists an app wins.
 */
export function catalogSources(raw: string | undefined, home: string): string[] {
  if (raw === undefined) return [DEFAULT_CATALOG_URL];
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length || (items.length === 1 && items[0] === "none")) return [];
  const out: string[] = [];
  for (const item of items) {
    // An absolute path first: a Windows one (`C:\...`) would otherwise pass for a URL scheme.
    const url = item === "default" ? DEFAULT_CATALOG_URL : isAbsolute(item) ? pathToFileURL(item).href : /^[a-z][a-z0-9+.-]*:/i.test(item) ? item : pathToFileURL(resolve(home, item)).href;
    if (!allowedLocation(new URL(url))) throw new Error(`SPACE_APP_CATALOG: ${item} is not an https URL, a loopback http URL or a file`);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** https anywhere, http only on this machine, files only when named by the operator. */
export function allowedLocation(url: URL, allowFile = true): boolean {
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return allowFile && url.protocol === "file:";
}
