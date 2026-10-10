import { join } from "node:path";
import index from "./index.html";

/**
 * Routes for the web UI: the bundled page at `/` (Bun's HTML import bundles
 * main.tsx and styles.css) and the few files the PWA shell and the pet need
 * at fixed public paths.
 */

const PUBLIC: Record<string, string> = {
  "/favicon.svg": "favicon.svg",
  "/settings.svg": "settings.svg",
  "/terminal.svg": "terminal.svg",
  "/inbox.svg": "inbox.svg",
  "/assistant.svg": "assistant.svg",
  "/manifest.webmanifest": "manifest.webmanifest",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/icon-512.png": "icon-512.png",
  "/pet.webp": "pet.webp",
  // The presets' backdrops (theme.ts `backdrop`), framed behind the page.
  "/backdrops/orbit.html": "backdrops/orbit.html",
  "/backdrops/northern.html": "backdrops/northern.html",
  "/backdrops/papercut.html": "backdrops/papercut.html",
  "/backdrops/prism.html": "backdrops/prism.html",
};

type WebRoutes = Record<string, typeof index | (() => Response)>;

export function createWebRoutes(): WebRoutes {
  const routes: WebRoutes = { "/": index };
  for (const [path, file] of Object.entries(PUBLIC)) {
    routes[path] = () => new Response(Bun.file(join(import.meta.dir, "public", file)), { headers: { "cache-control": "public, max-age=86400" } });
  }
  return routes;
}
