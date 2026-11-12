import { parseUrl, sameOrigin } from "./url.ts";

/**
 * What a web view does with a navigation (the Mac's `NavigationPolicy`): the page stays in its
 * tab; everything else goes to the default browser, or to the app's own tab when the link is an
 * app's (the caller checks `appForUrl` on `external`). A redirect or script navigation away from
 * the page's origin stays, so an access layer's sign-in can complete, but a link the person
 * clicks on the page leaves.
 */
export type NavigationDecision = "allow" | "external" | "download" | "cancel";

export type NavigationRequest = {
  url: string;
  isMainFrame: boolean;
  /** The person clicked a link. */
  isLinkActivation: boolean;
  /** target=_blank or window.open. */
  opensNewWindow: boolean;
  /** The main frame currently shows the view's own origin (the Space, or the app of a tab). */
  fromHomePage: boolean;
};

export function decideNavigation(r: NavigationRequest, home: string): NavigationDecision {
  const scheme = parseUrl(r.url)?.scheme ?? r.url.split(":")[0]!.toLowerCase();
  const web = scheme === "http" || scheme === "https";
  const same = web && sameOrigin(r.url, home);
  if (r.opensNewWindow) return web ? "external" : "cancel";
  switch (scheme) {
    case "about":
    case "blob":
    case "data":
      return "allow";
    case "http":
    case "https":
      break;
    default:
      // mailto:, tel:, other apps' schemes: only on a click, and never inside the view.
      return r.isLinkActivation ? "external" : "cancel";
  }
  if (!r.isMainFrame || same) return "allow";
  if (r.isLinkActivation && r.fromHomePage) return "external";
  return "allow";
}

/**
 * The microphone for the pages this app opened (voice input), when the page and the frame asking
 * are both of the view's own origin or the connection's; never the camera.
 */
export function grantsMicrophone(kind: "microphone" | "camera" | "both", frame: string | undefined, home: string, connection: string): boolean {
  if (kind !== "microphone" || !frame) return false;
  const u = parseUrl(frame);
  if (!u || (u.scheme !== "http" && u.scheme !== "https")) return false;
  return sameOrigin(frame, home) || sameOrigin(frame, connection);
}

/**
 * A page whose web process ended is loaded again, after a wait that doubles with each crash in the
 * last minute (1 s, 2 s, 4 s); a fourth crash within that minute gives up, so a page that crashes as
 * it loads is not reloaded forever. `recent` is when the earlier crashes were; `null` means give up.
 */
export const CRASH_RELOAD = { limit: 3, windowMs: 60_000, firstDelayMs: 1_000 };

export function crashReload(recent: readonly number[], now: number): { delayMs: number; recent: number[] } | null {
  const kept = [...recent.filter((at) => now - at < CRASH_RELOAD.windowMs), now];
  if (kept.length > CRASH_RELOAD.limit) return null;
  return { delayMs: CRASH_RELOAD.firstDelayMs * 2 ** (kept.length - 1), recent: kept };
}
