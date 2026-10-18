// The app's server: the page and its API on the port ai-space gives it, loopback only.
// Bun only, no dependencies to install: `space app build` packs these files as they are.
import page from "./public/index.html";

const port = Number(process.env.PORT) || 8710;

Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": page,
    "/healthz": new Response("ok"),
    "/api/hello": () => Response.json({ ok: true, message: "Hello from My App", time: new Date().toISOString() }),
  },
});

console.log(`my-app listening on http://127.0.0.1:${port}`);
