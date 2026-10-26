/**
 * `bun desktop/linux/soak.ts [--build <dir>] [--minutes <n>] [--poll <seconds>] [--churn] [--visible]`:
 * a memory soak test of the built Linux client (docs/linux-desktop.md#memory).
 *
 * It serves a stand-in Space on loopback (apps, agents, and widgets of every kind: lists, block
 * cards with charts, progress bars and gauges, one embedded page), starts the client from `--build`
 * (default desktop/linux/build/ai-space) in a D-Bus session of its own with its own XDG
 * directories, so an installed copy and its saved Spaces are left alone, and prints the client's
 * RSS and threads every 15 seconds, then the growth per hour after a two-minute warm-up.
 *
 * `--poll` (default 2) shortens the client's 30-second look at the Space (`AISPACE_POLL_SECONDS`),
 * so a few minutes stand for hours. `--churn` changes one widget on every fetch, so every look
 * redraws; without it every answer is the same, as most looks at a real Space are. The client
 * runs on a headless GNOME Shell when `gnome-shell` is installed; `--visible` puts it on the
 * desktop instead.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACE_ROOT } from "../../src/space/config.ts";

const argv = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const build = opt("build", join(SPACE_ROOT, "desktop", "linux", "build", "ai-space"));
const minutes = Number(opt("minutes", "30"));
const poll = Number(opt("poll", "2"));
const churn = argv.includes("--churn");
const visible = argv.includes("--visible");

// The stand-in Space.

const apps = Array.from({ length: 40 }, (_, i) => ({ id: `app${i}`, title: `App ${i}`, description: `The app number ${i}`, url: `/apps/app${i}/`, icon: i % 3 ? `/api/apps/app${i}/icon` : "📦", service: { health: i % 7 ? "ok" : "down" } }));
const agents = Array.from({ length: 10 }, (_, i) => ({ id: `app${i}/agent`, app: `app${i}`, name: "agent", title: `Agent ${i}`, description: "Helps", avatar: `/api/apps/app${i}/icon` }));
const points = (n: number) => Array.from({ length: 24 }, (_, i) => ({ t: `2026-01-01T${String(i).padStart(2, "0")}:00:00Z`, v: Math.round(50 + 30 * Math.sin((i + n) / 3)) }));
function widgets(n: number) {
  const list = [];
  for (let i = 0; i < 24; i++) {
    const base = { id: `app${i}/w`, app: `app${i}`, name: "w", title: `Widget ${i}`, icon: `/api/apps/app${i}/icon`, size: i % 4 ? "1x1" : "2x1", ok: true };
    if (i % 3 === 0) list.push({ ...base, kind: "items", items: Array.from({ length: 5 }, (_, k) => ({ text: `Item ${k} of widget ${i}${churn && i === 0 && k === 0 ? ` · ${n}` : ""}`, url: `/apps/app${i}/#${k}`, time: "2026-01-01T00:00:00Z" })) });
    else
      list.push({
        ...base,
        blocks: [
          { type: "trend", label: "Trend", style: i % 2 ? "line" : "bar", points: points(churn && i === 1 ? n : 0) },
          { type: "metric", label: "Value", value: churn && i === 1 ? n : 1234 + i, delta: { value: 5, format: "percent" } },
          { type: "progress", label: "Progress", value: 3, max: 4 },
          { type: "gauge", label: "Gauge", value: 70, min: 0, max: 100, zones: [{ to: 50, tone: "positive" }, { to: 80, tone: "warning" }, { to: 100, tone: "negative" }] },
          { type: "status", label: "Status", value: "All good", tone: "positive" },
        ],
      });
  }
  list.push({ id: "app0/embed", app: "app0", name: "embed", title: "Embedded", kind: "embed", size: "1x1", ok: true, icon: "http://127.0.0.1:9/missing.png", link: "/apps/app0/" });
  return { ok: true, asOf: new Date().toISOString(), widgets: list };
}
const screens = [
  { id: "home", name: "", items: [...apps.slice(0, 15).map((a) => `app:${a.id}`), "agent:app0/agent", "builtin:settings", ...widgets(0).widgets.map((w) => `widget:${w.id}`)] },
  { id: "s2", name: "Second", items: [...apps.slice(15, 30).map((a) => `app:${a.id}`), ...widgets(0).widgets.slice(0, 6).map((w) => `widget:${w.id}`)] },
];
const icon = await Bun.file(join(SPACE_ROOT, "desktop", "macos", "AISpace", "Resources", "AppIcon.svg")).bytes();
let fetches = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    const json = (v: unknown) => Response.json(v);
    if (p === "/api/space") return json({ product: "ai-space", api: 1, version: "0.0.0", edition: "server", name: "soak" });
    if (p === "/api/panel/layout") return json({ ok: true, layout: { screens } });
    if (p === "/api/apps") return json({ apps });
    if (p === "/api/agents") return json({ agents });
    if (p === "/api/widgets") return json(widgets(++fetches));
    if (p === "/api/peers") return json({ peers: [] });
    if (p.startsWith("/api/inbox")) return json({ items: Array.from({ length: 20 }, (_, i) => ({ thread: `t${i}`, app: "app1", text: `Thread ${i}`, lastAt: "2026-01-01T00:00:00Z", unread: i < 3 })) });
    if (p === "/api/agents/runs") return json({ runs: [] });
    if (p.endsWith("/icon")) return new Response(icon, { headers: { "content-type": "image/svg+xml" } });
    if (p.startsWith("/api/")) return json({});
    return new Response(`<!doctype html><body>${p}<script>setInterval(() => document.body.append("."), 5000)</script>`, { headers: { "content-type": "text/html" } });
  },
});

// The client, in a session and directories of its own.

const dir = await mkdtemp(join(tmpdir(), "ai-space-soak-"));
await mkdir(join(dir, "config", "ai-space"), { recursive: true });
await Bun.write(join(dir, "config", "ai-space", "connections.json"), JSON.stringify([{ id: "soak", name: "Soak", url: `http://127.0.0.1:${server.port}/`, isDefault: true, managed: false }]));
const pidFile = join(dir, "client.pid");
const headless = !visible && Bun.which("gnome-shell") !== null;
const script = `
set -e
${headless ? `gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x900 --wayland-display=ai-space-soak-$$ >"${dir}/shell.log" 2>&1 &
shell=$!
for i in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/ai-space-soak-$$" ] && break; sleep 0.2; done
export WAYLAND_DISPLAY=ai-space-soak-$$ GDK_BACKEND=wayland
unset DISPLAY` : "shell="}
"${build}/bin/ai-space" >"${dir}/client.log" 2>&1 &
echo $! >"${pidFile}"
wait $! || true
[ -z "$shell" ] || kill $shell
`;
const session = Bun.spawn(["dbus-run-session", "--", "sh", "-c", script], {
  env: { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), AISPACE_POLL_SECONDS: String(poll) },
  stdout: "ignore",
  stderr: "ignore",
});

let pid = 0;
for (let i = 0; i < 100 && !pid; i++) {
  await Bun.sleep(200);
  pid = Number((await Bun.file(pidFile).text().catch(() => "")).trim()) || 0;
}
if (!pid) throw new Error(`the client did not start; see ${dir}`);

const status = async () => {
  const text = await Bun.file(`/proc/${pid}/status`).text().catch(() => "");
  const field = (name: string) => Number(new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(text)?.[1] ?? NaN);
  return { rss: field("VmRSS"), threads: field("Threads") };
};

console.log(`soak: ${build}, ${minutes} min, a look every ${poll} s (${30 / poll}x), ${churn ? "a change on every look" : "the same answer every time"}, ${headless ? "headless" : "on this desktop"}`);
console.log("seconds\trss_MB\tthreads");
const start = Date.now();
const samples: { s: number; rss: number }[] = [];
try {
  while (Date.now() - start < minutes * 60_000) {
    const { rss, threads } = await status();
    if (!Number.isFinite(rss)) throw new Error(`the client exited; see ${dir}/client.log`);
    const s = Math.round((Date.now() - start) / 1000);
    samples.push({ s, rss });
    console.log(`${s}\t${(rss / 1024).toFixed(1)}\t${threads}`);
    await Bun.sleep(15_000);
  }
} finally {
  try {
    process.kill(pid);
  } catch {}
  await session.exited;
  server.stop(true);
}

// Growth after the warm-up, as a least-squares slope.
const warm = samples.filter((x) => x.s >= 120);
if (warm.length >= 2) {
  const n = warm.length;
  const mx = warm.reduce((a, x) => a + x.s, 0) / n;
  const my = warm.reduce((a, x) => a + x.rss, 0) / n;
  const slope = warm.reduce((a, x) => a + (x.s - mx) * (x.rss - my), 0) / warm.reduce((a, x) => a + (x.s - mx) ** 2, 0);
  const perHour = (slope * 3600) / 1024;
  console.log(`after warm-up: ${(warm[0]!.rss / 1024).toFixed(0)} MB → ${(warm[n - 1]!.rss / 1024).toFixed(0)} MB; ${perHour.toFixed(0)} MB per hour of the test, ${(perHour / (30 / poll)).toFixed(0)} MB per hour at the real 30-second pace`);
}
await rm(dir, { recursive: true, force: true });
