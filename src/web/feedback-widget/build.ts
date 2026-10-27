import { join } from "node:path";

/**
 * The feedback button's script (`/_space/feedback.js`), bundled from `widget.ts` with Bun at boot
 * like the chat widget: the stylesheet goes into the script as text and into the button's shadow
 * root. Cached for the life of the process; `dev` rebuilds on every request.
 */

export type FeedbackBundle = { js: string; etag: string };

export function buildFeedbackScript(opts: { dev?: boolean } = {}): () => Promise<FeedbackBundle> {
  let cached: Promise<FeedbackBundle> | undefined;
  return () => {
    if (!opts.dev && cached) return cached;
    cached = bundle().catch((e) => {
      cached = undefined;
      throw e;
    });
    return cached;
  };
}

async function bundle(): Promise<FeedbackBundle> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "widget.ts")],
    target: "browser",
    format: "iife",
    minify: process.env.SPACE_DEV !== "1",
    loader: { ".css": "text" },
  });
  if (!result.success) throw new Error(`feedback script build failed: ${result.logs.map((l) => l.message).join("; ")}`);
  const js = await result.outputs[0]!.text();
  return { js, etag: `"${Bun.hash(js).toString(16)}"` };
}
