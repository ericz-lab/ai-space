// The app's server: the page and its API on the port ai-space gives it, loopback only.
// Bun only, no dependencies to install: `space app build` packs these files as they are.
import page from "./public/index.html";

const port = Number(process.env.PORT) || 8710;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  // Bun closes a request idle for 10 s by default; a stream or a model call can be quiet longer.
  idleTimeout: 255,
  // Without this Bun serves the page in development mode, whose hot-reload socket stays open while
  // the page is; the Space counts that as use and refuses to upgrade or stop the app.
  development: false,
  routes: {
    "/": page,
    "/healthz": new Response("ok"),
    "/api/hello": () => Response.json({ ok: true, message: "Hello from My App", time: new Date().toISOString() }),
  },
});

console.log(`my-app listening on http://127.0.0.1:${port}`);
