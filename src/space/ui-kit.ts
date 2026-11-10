import { join } from "node:path";

/**
 * The built-in apps' stylesheet (docs/ui-kit.md): `src/web/ui-kit/kit.css`, served as
 * `/_space/ui.css`. The router sends every app hostname's `/_space/*` here and the package
 * gateway answers the same path, so a page links one stylesheet on its own origin and all
 * built-in apps change together with the space. Read once; `dev` reads on every request.
 */

export const UI_KIT_PATH = "/_space/ui.css";
const FILE = join(import.meta.dir, "..", "web", "ui-kit", "kit.css");

export type UiKit = { css: string; etag: string };
type Routes = Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;

export function loadUiKit(opts: { dev?: boolean } = {}): () => Promise<UiKit> {
  let cached: Promise<UiKit> | undefined;
  return () => {
    if (!opts.dev && cached) return cached;
    cached = Bun.file(FILE)
      .text()
      .then((css) => ({ css, etag: `"${Bun.hash(css).toString(16)}"` }))
      .catch((e) => {
        cached = undefined;
        throw e;
      });
    return cached;
  };
}

/** The stylesheet, or 304 when the page already has this version. */
export async function uiKitResponse(req: Request, kit: () => Promise<UiKit>): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const k = await kit();
  if (req.headers.get("if-none-match") === k.etag) return new Response(null, { status: 304, headers: { etag: k.etag } });
  return new Response(req.method === "HEAD" ? null : k.css, {
    headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", etag: k.etag, "x-content-type-options": "nosniff" },
  });
}

export function createUiKitRoutes(kit: () => Promise<UiKit>): Routes {
  return { [UI_KIT_PATH]: { GET: (req) => uiKitResponse(req, kit) } };
}
