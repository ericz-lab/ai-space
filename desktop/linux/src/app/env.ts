import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";
import WebKit from "gi://WebKit?version=6.0";
import { type Key, type Lang, detectLang, translate } from "../core/i18n.ts";
import type { Permission } from "../core/chat.ts";

/**
 * What every part of the app shares: its identity, its directories (XDG, apart from any Space
 * workspace), file helpers on Gio, the language, timers as promises, and the person's preferences.
 */

export const APP_ID = "dev.ai_space.Desktop";
export const DEBUG = GLib.getenv("AISPACE_DEBUG") === "1";

// Async GIO calls as promises, once for the whole app.
Gio._promisify(Gio.File.prototype, "load_contents_async", "load_contents_finish");
Gio._promisify(Gio.File.prototype, "replace_contents_bytes_async", "replace_contents_finish");
Gio._promisify(Gio.Subprocess.prototype, "communicate_utf8_async", "communicate_utf8_finish");
Gio._promisify(Gio.InputStream.prototype, "close_async", "close_finish");
Gio._promisify(Gio.DataInputStream.prototype, "read_line_async", "read_line_finish");
Gio._promisify(Soup.Session.prototype, "send_and_read_async", "send_and_read_finish");
Gio._promisify(Soup.Session.prototype, "send_async", "send_finish");
Gio._promisify(WebKit.CookieManager.prototype, "get_cookies", "get_cookies_finish");
Gio._promisify(WebKit.CookieManager.prototype, "add_cookie", "add_cookie_finish");
Gio._promisify(WebKit.CookieManager.prototype, "get_all_cookies", "get_all_cookies_finish");
Gio._promisify(WebKit.WebView.prototype, "evaluate_javascript", "evaluate_javascript_finish");

/** Where the bundle runs from: `<root>/main.js`, with `data/` and `terminal/` beside it and, in the Local edition, `space/`. */
export const APP_ROOT: string = Gio.File.new_for_uri(import.meta.url).get_parent().get_path();

export const dirs = {
  config: GLib.build_filenamev([GLib.get_user_config_dir(), "ai-space"]),
  data: GLib.build_filenamev([GLib.get_user_data_dir(), "ai-space", "desktop"]),
  cache: GLib.build_filenamev([GLib.get_user_cache_dir(), "ai-space"]),
};

export const path = (...parts: string[]) => GLib.build_filenamev(parts);

export const lang: Lang = detectLang(GLib.get_language_names());

export const t = (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function bytesToText(bytes: Uint8Array | { get_data(): Uint8Array | null } | null): string {
  if (!bytes) return "";
  const data = bytes instanceof Uint8Array ? bytes : bytes.get_data();
  return data ? decoder.decode(data) : "";
}

export const textToBytes = (text: string) => new GLib.Bytes(encoder.encode(text));

export async function readText(file: string): Promise<string | undefined> {
  try {
    const [contents] = (await Gio.File.new_for_path(file).load_contents_async(null)) as [Uint8Array];
    return decoder.decode(contents);
  } catch {
    return undefined;
  }
}

export function readTextSync(file: string): string | undefined {
  try {
    const [ok, contents] = GLib.file_get_contents(file) as [boolean, Uint8Array];
    return ok ? decoder.decode(contents) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes atomically (a temporary file renamed over the old one), making the directory first. */
export async function writeText(file: string, text: string, mode?: number): Promise<void> {
  GLib.mkdir_with_parents(GLib.path_get_dirname(file), 0o700);
  const f = Gio.File.new_for_path(file);
  // A file only its owner may read is never readable by others, not even while it is written.
  const flags = Gio.FileCreateFlags.REPLACE_DESTINATION | (mode !== undefined && !(mode & 0o077) ? Gio.FileCreateFlags.PRIVATE : 0);
  await f.replace_contents_bytes_async(textToBytes(text), null, false, flags, null);
  if (mode !== undefined) GLib.chmod(file, mode);
}

export function exists(file: string): boolean {
  return GLib.file_test(file, GLib.FileTest.EXISTS);
}

export const newId = (): string => GLib.uuid_string_random();

export const sleep = (ms: number) =>
  new Promise<void>((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
      resolve();
      return GLib.SOURCE_REMOVE;
    }),
  );

/** Runs `fn` at most once per frame-ish interval, however often it is asked for. */
export function coalesce(fn: () => void, ms = 40): () => void {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ms, () => {
      pending = 0;
      fn();
      return GLib.SOURCE_REMOVE;
    });
  };
}

/** Opens a URI with the desktop's default handler (the browser for web pages). */
export function openExternally(uri: string): void {
  try {
    Gio.AppInfo.launch_default_for_uri(uri, null);
  } catch (e) {
    logError(e, `could not open ${uri}`);
  }
}

export function log(...parts: unknown[]): void {
  if (DEBUG) print(`[ai-space] ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`);
}

export function logError(e: unknown, what: string): void {
  printerr(`[ai-space] ${what}: ${e instanceof Error ? e.message : String(e)}`);
}

/** The person's choices on this computer, one JSON file beside the saved Spaces. */
export type Prefs = {
  background: boolean;
  notifications: boolean;
  permission: Permission;
  /** Agent CLIs chosen by path for the Local edition, by name. */
  chosenRuntimes: Record<string, string>;
  window: { width: number; height: number; maximized: boolean };
  lastAgent?: string;
  /** Settings › Peer: how the hub reaches this computer (the tunnel itself lives in its unit file). */
  peer?: { reach: "ssh" | "address"; target: string; hubPort: number; address: string; headers: string };
};

const PREFS_FILE = path(dirs.config, "preferences.json");

function loadPrefs(): Prefs {
  const base: Prefs = { background: true, notifications: true, permission: "", chosenRuntimes: {}, window: { width: 1180, height: 780, maximized: false } };
  try {
    const raw = JSON.parse(readTextSync(PREFS_FILE) ?? "{}") as Partial<Prefs>;
    return { ...base, ...raw, window: { ...base.window, ...(raw.window ?? {}) }, chosenRuntimes: { ...(raw.chosenRuntimes ?? {}) } };
  } catch {
    return base;
  }
}

export const prefs: Prefs = loadPrefs();

export function savePrefs(): void {
  void writeText(PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`).catch((e) => logError(e, "could not save preferences"));
}
