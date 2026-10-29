import type { ClientInfo, ClientKind } from "./types.ts";

/**
 * Which client a page runs in, from its `User-Agent`. The native clients add a token of their own
 * to their web views: `AISpaceDesktop/<v>` (Mac), `AISpaceMobile/<v>` (iPhone and Android) and
 * `AISpaceLinux/<v>` (Linux, WebKitGTK) and `AISpaceWindows/<v>` (Windows, WebView2); anything else
 * is a browser, on a phone, a tablet or a desktop.
 */
export function clientOf(ua: string): ClientInfo {
  const u = ua.slice(0, 1000);
  const os = osOf(u);
  const token = (name: string) => new RegExp(`${name}/([\\w.-]+)`).exec(u)?.[1];
  const native = (kind: ClientKind, v: string | undefined): ClientInfo => ({ kind, os, browser: "webview", ...(v ? { version: v.slice(0, 32) } : {}) });
  const windows = token("AISpaceWindows");
  if (windows !== undefined) return native("windows-client", windows);
  const linux = token("AISpaceLinux");
  if (linux !== undefined) return native("linux-client", linux);
  const desktop = token("AISpaceDesktop");
  if (desktop !== undefined) return native("mac-client", desktop);
  const mobile = token("AISpaceMobile");
  if (mobile !== undefined) return native(os === "Android" ? "android-client" : "iphone-client", mobile);
  const tablet = /iPad|Tablet/.test(u) || (/Android/.test(u) && !/Mobile/.test(u));
  const phone = !tablet && /iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone/.test(u);
  return { kind: phone ? "phone-browser" : tablet ? "tablet-browser" : "desktop-browser", os, browser: browserOf(u) };
}

function osOf(u: string): string {
  if (/iPhone|iPad|iPod/.test(u)) return "iOS";
  if (/Android/.test(u)) return "Android";
  if (/Mac OS X|Macintosh/.test(u)) return "macOS";
  if (/Windows/.test(u)) return "Windows";
  if (/CrOS/.test(u)) return "ChromeOS";
  if (/Linux|X11/.test(u)) return "Linux";
  return "unknown";
}

function browserOf(u: string): string {
  if (/Edg\//.test(u)) return "Edge";
  if (/OPR\//.test(u)) return "Opera";
  if (/Firefox\/|FxiOS/.test(u)) return "Firefox";
  if (/Chrome\/|CriOS/.test(u)) return "Chrome";
  if (/Safari\//.test(u)) return "Safari";
  if (/AppleWebKit/.test(u)) return "WebKit";
  return "unknown";
}

const KIND_LABEL: Record<ClientKind, { en: string; zh: string }> = {
  "desktop-browser": { en: "Desktop browser", zh: "桌面浏览器" },
  "phone-browser": { en: "Phone browser", zh: "手机浏览器" },
  "tablet-browser": { en: "Tablet browser", zh: "平板浏览器" },
  "mac-client": { en: "Mac client", zh: "Mac 客户端" },
  "iphone-client": { en: "iPhone client", zh: "iPhone 客户端" },
  "android-client": { en: "Android client", zh: "Android 客户端" },
  "linux-client": { en: "Linux client", zh: "Linux 客户端" },
  "windows-client": { en: "Windows client", zh: "Windows 客户端" },
};

/** "Desktop browser (Chrome · Linux)", "Linux 客户端": the line the button shows and the todo keeps. */
export function clientLabel(c: ClientInfo, lang: "en" | "zh" = "en"): string {
  // A native client's name already says its system.
  if (c.browser === "webview") return KIND_LABEL[c.kind][lang];
  const parts = [c.browser !== "unknown" ? c.browser : "", c.os !== "unknown" ? c.os : ""].filter(Boolean);
  return `${KIND_LABEL[c.kind][lang]}${parts.length ? ` (${parts.join(" · ")})` : ""}`;
}
