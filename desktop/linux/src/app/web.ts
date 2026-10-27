import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Soup from "gi://Soup?version=3.0";
import WebKit from "gi://WebKit?version=6.0";
import { decideNavigation, grantsMicrophone } from "../core/navigation.ts";
import { sameOrigin } from "../core/url.ts";
import { APP_ROOT, DEBUG, dirs, log, path, readTextSync } from "./env.ts";

/**
 * Web content of one saved Space: a WebKit network session of its own, persistent, apart from
 * every other Space and from the person's browser, so the panel's sign-in, the app pages and the
 * native calls share one set of cookies. No page gets a bridge to native code.
 */

const sessions = new Map<string, any>();

export function networkSession(connectionId: string): any {
  let s = sessions.get(connectionId);
  if (s) return s;
  const data = path(dirs.data, "web", connectionId);
  const cache = path(dirs.cache, "web", connectionId);
  GLib.mkdir_with_parents(data, 0o700);
  GLib.mkdir_with_parents(cache, 0o700);
  s = WebKit.NetworkSession.new(data, cache);
  const cookies = s.get_cookie_manager();
  cookies.set_persistent_storage(path(data, "cookies.sqlite"), WebKit.CookiePersistentStorage.SQLITE);
  cookies.set_accept_policy(WebKit.CookieAcceptPolicy.NO_THIRD_PARTY);
  sessions.set(connectionId, s);
  return s;
}

/** The connection's cookies for a URL as one `Cookie` header. */
export async function cookieHeader(connectionId: string, uri: string): Promise<string | undefined> {
  try {
    const list = (await networkSession(connectionId).get_cookie_manager().get_cookies(uri, null)) as unknown[];
    if (!list?.length) return undefined;
    return Soup.cookies_to_cookie_header(list) || undefined;
  } catch {
    return undefined;
  }
}

/** Cookies a response set (the device sign-in), stored in the connection's session. */
export async function storeResponseCookies(connectionId: string, msg: any): Promise<number> {
  const list = (Soup.cookies_from_response(msg) ?? []) as unknown[];
  const manager = networkSession(connectionId).get_cookie_manager();
  for (const c of list) await manager.add_cookie(c, null);
  return list.length;
}

export async function allCookies(connectionId: string): Promise<{ name: string; domain: string; expires?: number }[]> {
  try {
    const list = (await networkSession(connectionId).get_cookie_manager().get_all_cookies(null)) as any[];
    return list.map((c) => {
      const exp = c.get_expires();
      return { name: c.get_name(), domain: c.get_domain(), ...(exp ? { expires: exp.to_unix() * 1000 } : {}) };
    });
  } catch {
    return [];
  }
}

/** Forgets a removed Space's web data (cookies, storage, cache). */
export function forgetSession(connectionId: string): void {
  sessions.delete(connectionId);
  for (const dir of [path(dirs.data, "web", connectionId), path(dirs.cache, "web", connectionId)]) removeTree(Gio.File.new_for_path(dir));
}

function removeTree(file: any): void {
  try {
    const children = file.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = children.next_file(null))) {
      const child = file.get_child(info.get_name());
      if (info.get_file_type() === Gio.FileType.DIRECTORY) removeTree(child);
      else child.delete(null);
    }
  } catch {}
  try {
    file.delete(null);
  } catch {}
}

export type WebViewOptions = {
  connectionId: string;
  /** The connection's panel URL: its origin may use the microphone too. */
  connection: string;
  /** Where a link the person clicks goes when it leaves the page: an app's tab, or the browser. */
  onExternal: (uri: string) => void;
  onFinished?: (uri: string) => void;
  onFailed?: (uri: string, message: string) => void;
  onTitle?: (title: string) => void;
  /** For pages the app writes itself (the terminal) that talk back through a message handler. */
  contentManager?: any;
};

/** This build's version for the user agent, a plain token ("dev" when unknown). */
let uaVersion: string | undefined;
function clientVersion(): string {
  if (uaVersion === undefined) {
    try {
      uaVersion = String((JSON.parse(readTextSync(path(APP_ROOT, "VERSION.json")) ?? "") as { version?: string }).version ?? "dev").replace(/[^\w.+-]/g, "") || "dev";
    } catch {
      uaVersion = "dev";
    }
  }
  return uaVersion;
}

/** A web view in the connection's session, with the navigation rules of the Mac client. */
export function createWebView(o: WebViewOptions): any {
  const settings = new WebKit.Settings({
    enable_developer_extras: DEBUG,
    enable_media_stream: true,
    enable_back_forward_navigation_gestures: true,
    javascript_can_access_clipboard: true,
    enable_smooth_scrolling: true,
  });
  // `AISpaceLinux/<version>` after WebKit's own user agent, as the Mac (`AISpaceDesktop/`) and phone
  // (`AISpaceMobile/`) clients add theirs: pages such as the feedback button tell this client from a browser.
  settings.set_user_agent_with_application_details("AISpaceLinux", clientVersion());
  const view = new WebKit.WebView({ network_session: networkSession(o.connectionId), settings, hexpand: true, vexpand: true, ...(o.contentManager ? { user_content_manager: o.contentManager } : {}) });
  /** The origin the view counts as its own: where its first page loaded. */
  let home: string | undefined;
  view.connect("load-changed", (_v: unknown, event: number) => {
    const uri = view.get_uri() ?? "";
    if (event === WebKit.LoadEvent.COMMITTED && !home && /^https?:/i.test(uri)) home = uri;
    if (event === WebKit.LoadEvent.FINISHED) o.onFinished?.(uri);
  });
  view.connect("load-failed", (_v: unknown, _e: unknown, uri: string, error: any) => {
    // A cancelled load, or a response handed to a download, is not the connection's fault.
    if (error?.matches?.(WebKit.NetworkError, WebKit.NetworkError.CANCELLED) || error?.matches?.(WebKit.PolicyError, WebKit.PolicyError.FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE)) return false;
    o.onFailed?.(uri, error?.message ?? "load failed");
    return false;
  });
  view.connect("notify::title", () => o.onTitle?.(view.get_title() ?? ""));
  view.connect("web-process-terminated", () => {
    log("web process ended; reloading", view.get_uri());
    view.reload();
  });
  view.connect("decide-policy", (_v: unknown, decision: any, type: number) => {
    if (type === WebKit.PolicyDecisionType.RESPONSE) {
      if (!decision.is_mime_type_supported()) {
        decision.download();
        return true;
      }
      return false;
    }
    const action = decision.get_navigation_action();
    const uri: string = action.get_request().get_uri();
    const current = view.get_uri() ?? "";
    const own = home ?? o.connection;
    const verdict = decideNavigation(
      {
        url: uri,
        isMainFrame: type === WebKit.PolicyDecisionType.NAVIGATION_ACTION,
        isLinkActivation: action.get_navigation_type() === WebKit.NavigationType.LINK_CLICKED,
        opensNewWindow: type === WebKit.PolicyDecisionType.NEW_WINDOW_ACTION,
        fromHomePage: Boolean(current) && sameOrigin(current, own),
      },
      own,
    );
    if (verdict === "allow") return false;
    decision.ignore();
    if (verdict === "external") o.onExternal(uri);
    return true;
  });
  // window.open and target=_blank were decided above; never a second web view.
  view.connect("create", () => null);
  view.connect("permission-request", (_v: unknown, request: any) => {
    if (request instanceof WebKit.UserMediaPermissionRequest) {
      const audio = WebKit.user_media_permission_is_for_audio_device(request);
      const video = WebKit.user_media_permission_is_for_video_device(request);
      const kind = audio && video ? "both" : video ? "camera" : "microphone";
      if (grantsMicrophone(kind, view.get_uri() ?? undefined, home ?? o.connection, o.connection)) request.allow();
      else request.deny();
      return true;
    }
    request.deny();
    return true;
  });
  return view;
}
