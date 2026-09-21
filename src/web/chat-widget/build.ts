import { join } from "node:path";

/**
 * The chat widget as one script apps embed (`/api/chat/widget.js`), bundled
 * from `widget.ts` with Bun at boot: a few milliseconds, cached for the life
 * of the process. The stylesheet is imported into the script as text and
 * injected into the widget's shadow root; `/api/chat/widget.css` serves the
 * same text for apps that want to read or override it. `dev` rebuilds on
 * every request.
 */

export type WidgetBundle = { js: string; css: string; etag: string };

export function buildWidget(opts: { dev?: boolean } = {}): () => Promise<WidgetBundle> {
  let cached: Promise<WidgetBundle> | undefined;
  return () => {
    if (!opts.dev && cached) return cached;
    cached = bundle().catch((e) => {
      cached = undefined;
      throw e;
    });
    return cached;
  };
}

async function bundle(): Promise<WidgetBundle> {
  const dir = import.meta.dir;
  const result = await Bun.build({
    entrypoints: [join(dir, "widget.ts")],
    target: "browser",
    format: "iife",
    minify: process.env.NODE_ENV === "production" || process.env.SPACE_DEV !== "1",
    loader: { ".css": "text" },
  });
  if (!result.success) throw new Error(`chat widget build failed: ${result.logs.map((l) => l.message).join("; ")}`);
  const js = await result.outputs[0]!.text();
  const css = await Bun.file(join(dir, "widget.css")).text();
  const etag = `"${Bun.hash(js).toString(16)}"`;
  return { js, css, etag };
}
