import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";
import { CaddyBackend, type Runner } from "./caddy.ts";
import { CADDYFILE_HEADER, renderCaddyfile } from "./caddyfile.ts";
import { loadRouterConfig } from "./config.ts";
import { Router } from "./router.ts";
import { hostStatus, routableHost, routeTable } from "./table.ts";
import type { Route } from "./types.ts";

const mf = (app: string, extra: Partial<Manifest> = {}): Manifest => ({ app, dir: `/apps/${app}`, spec: 1, status: "active", agents: [], widgets: [], tasks: [], ...extra });
const svc = (port: number) => ({ command: "bun run", port });

describe("loadRouterConfig", () => {
  test("off by default; caddy needs a domain; values are normalised", () => {
    expect(loadRouterConfig({})).toEqual({ config: { backend: "none", domain: "", port: 8080, panelHost: "", caddyBin: "caddy" }, warnings: [] });
    const on = loadRouterConfig({ SPACE_ROUTER: "caddy", SPACE_DOMAIN: " Example.COM. ", SPACE_ROUTER_PORT: "8081", SPACE_PANEL_HOST: "space.example.com", SPACE_ROUTER_CADDY: "/opt/caddy" });
    expect(on).toEqual({ config: { backend: "caddy", domain: "example.com", port: 8081, panelHost: "space.example.com", caddyBin: "/opt/caddy" }, warnings: [] });
    const noDomain = loadRouterConfig({ SPACE_ROUTER: "caddy" });
    expect(noDomain.config.backend).toBe("none");
    expect(noDomain.warnings[0]).toMatch(/needs SPACE_DOMAIN/);
    const bad = loadRouterConfig({ SPACE_ROUTER: "nginx", SPACE_DOMAIN: "https://x.com", SPACE_ROUTER_PORT: "big", SPACE_PANEL_HOST: "not a host" });
    expect(bad.config).toEqual({ backend: "none", domain: "", port: 8080, panelHost: "", caddyBin: "caddy" });
    expect(bad.warnings).toHaveLength(4);
  });
});

describe("routeTable", () => {
  test("one route per app with a service port and a public url; wildcard is one label under the domain", () => {
    const routes = routeTable(
      [
        mf("b", { url: "https://b.example.com/", service: svc(8720) }),
        mf("a", { url: "https://A.example.com/docs", service: svc(8710) }),
        mf("deep", { url: "https://x.y.example.com", service: svc(8730) }),
        mf("other", { url: "https://other.net", service: svc(8740) }),
        mf("local", { url: "http://127.0.0.1:8750", service: svc(8750) }),
        mf("localhost", { url: "http://localhost:8751/", service: svc(8751) }),
        mf("no-service", { url: "https://link.example.com" }),
        mf("no-url", { service: svc(8760) }),
        mf("gone", { url: "https://gone.example.com", service: svc(8770), status: "archived" }),
        mf("rest", { url: "https://rest.example.com", service: svc(8780), status: "paused" }),
      ],
      { domain: "example.com", panelHost: "", panelPort: 8700 },
    );
    expect(routes).toEqual([
      { app: "a", host: "a.example.com", target: "127.0.0.1:8710", status: "wildcard" },
      { app: "b", host: "b.example.com", target: "127.0.0.1:8720", status: "wildcard" },
      { app: "deep", host: "x.y.example.com", target: "127.0.0.1:8730", status: "explicit" },
      { app: "other", host: "other.net", target: "127.0.0.1:8740", status: "explicit" },
      { app: "rest", host: "rest.example.com", target: "127.0.0.1:8780", status: "wildcard" },
    ]);
  });

  test("the panel comes first; a hostname taken twice is a conflict for the later app", () => {
    const routes = routeTable([mf("z", { url: "https://same.example.com", service: svc(2) }), mf("a", { url: "https://same.example.com", service: svc(1) })], {
      domain: "example.com",
      panelHost: "space.example.com",
      panelPort: 8700,
    });
    expect(routes).toEqual([
      { app: "space", host: "space.example.com", target: "127.0.0.1:8700", status: "wildcard" },
      { app: "a", host: "same.example.com", target: "127.0.0.1:1", status: "wildcard" },
      { app: "z", host: "same.example.com", target: "127.0.0.1:2", status: "conflict" },
    ]);
  });

  test("helpers", () => {
    expect(hostStatus("a.example.com", "example.com")).toBe("wildcard");
    expect(hostStatus("example.com", "example.com")).toBe("explicit");
    expect(hostStatus("a.example.com", "")).toBe("explicit");
    expect(hostStatus("a.notexample.com", "example.com")).toBe("explicit");
    expect(routableHost("https://A.Example.com:8443/x")).toBe("a.example.com");
    expect(routableHost("http://[::1]:8700")).toBeUndefined();
    expect(routableHost("not a url")).toBeUndefined();
    expect(routableHost(undefined)).toBeUndefined();
  });
});

describe("renderCaddyfile", () => {
  const opts = { port: 8080, socket: "/ws/run/caddy.sock", logDir: "/ws/logs/router" };

  test("global options, one site per route sorted by host, conflicts skipped, a 404 catch-all", () => {
    const routes: Route[] = [
      { app: "b", host: "b.example.com", target: "127.0.0.1:8720", status: "wildcard" },
      { app: "a", host: "a.example.com", target: "127.0.0.1:8710", status: "explicit" },
      { app: "c", host: "a.example.com", target: "127.0.0.1:8730", status: "conflict" },
    ];
    expect(renderCaddyfile(routes, opts)).toBe(
      [
        CADDYFILE_HEADER,
        "{",
        "\tadmin unix//ws/run/caddy.sock",
        "\tauto_https off",
        "\tdefault_bind 127.0.0.1",
        "}",
        "",
        "# a",
        "http://a.example.com:8080 {",
        "\treverse_proxy 127.0.0.1:8710 {",
        "\t\theader_up X-Space-User {header.Cf-Access-Authenticated-User-Email}",
        "\t}",
        "\tlog {",
        "\t\toutput file /ws/logs/router/a.log {",
        "\t\t\troll_size 10MiB",
        "\t\t\troll_keep 3",
        "\t\t}",
        "\t}",
        "}",
        "",
        "# b",
        "http://b.example.com:8080 {",
        "\treverse_proxy 127.0.0.1:8720 {",
        "\t\theader_up X-Space-User {header.Cf-Access-Authenticated-User-Email}",
        "\t}",
        "\tlog {",
        "\t\toutput file /ws/logs/router/b.log {",
        "\t\t\troll_size 10MiB",
        "\t\t\troll_keep 3",
        "\t\t}",
        "\t}",
        "}",
        "",
        "http://:8080 {",
        '\trespond "no such app" 404',
        "}",
        "",
      ].join("\n"),
    );
  });

  test("no routes is still a valid file", () => {
    const text = renderCaddyfile([], opts);
    expect(text).toContain("auto_https off");
    expect(text).toContain("http://:8080 {");
    expect(text).not.toContain("reverse_proxy");
  });
});

function fakeRunner(fail = false) {
  const calls: string[][] = [];
  const run: Runner = async (cmd) => {
    calls.push(cmd);
    return fail ? { code: 1, stdout: "", stderr: "Error: adapting config\nconnection refused" } : { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("CaddyBackend", () => {
  test("writes only when the content changed; reload names the file and the socket; a failure carries Caddy's last line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-router-"));
    const file = join(dir, "run", "Caddyfile");
    const ok = fakeRunner();
    const caddy = new CaddyBackend({ bin: "caddy", file, socket: join(dir, "run", "caddy.sock"), run: ok.run });
    expect(await caddy.write("a\n")).toBe(true);
    expect(await caddy.write("a\n")).toBe(false);
    expect(await caddy.write("b\n")).toBe(true);
    expect(await Bun.file(file).text()).toBe("b\n");
    await caddy.reload();
    expect(ok.calls).toEqual([["caddy", "reload", "--config", file, "--adapter", "caddyfile", "--address", `unix/${join(dir, "run", "caddy.sock")}`]]);
    expect(await caddy.installed()).toBe(true);
    const bad = new CaddyBackend({ bin: "caddy", file, socket: "/s", run: fakeRunner(true).run });
    await expect(bad.reload()).rejects.toThrow("connection refused");
    expect(await bad.installed()).toBe(false);
  });
});

describe("Router", () => {
  const setup = async (backend: "none" | "caddy", fail = false) => {
    const dir = await mkdtemp(join(tmpdir(), "space-router-"));
    const apps: Manifest[] = [mf("a", { url: "https://a.example.com", service: svc(8710) })];
    const runner = fakeRunner(fail);
    const file = join(dir, "run", "Caddyfile");
    const log: string[] = [];
    const router = new Router({
      config: { backend, domain: "example.com", port: 8080, panelHost: "", caddyBin: "caddy" },
      apps: () => apps,
      panelPort: 8700,
      file,
      socket: join(dir, "run", "caddy.sock"),
      logDir: join(dir, "logs", "router"),
      backend: new CaddyBackend({ bin: "caddy", file, socket: join(dir, "run", "caddy.sock"), run: runner.run }),
      log: (l) => log.push(l),
      debounceMs: 10,
    });
    return { router, apps, runner, file, log };
  };

  test("coalesces calls into one write and one reload; nothing on a second sync without a change", async () => {
    const { router, apps, runner, file } = await setup("caddy");
    const results = await Promise.all([router.sync(), router.sync(), router.sync()]);
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(results[0]).toBe(results[1]);
    expect(runner.calls).toHaveLength(1);
    expect(await Bun.file(file).text()).toContain("http://a.example.com:8080 {");
    expect((await router.sync()).changed).toBe(false);
    expect(runner.calls).toHaveLength(1);
    apps.push(mf("b", { url: "https://b.example.com", service: svc(8720) }));
    expect((await router.syncNow()).changed).toBe(true);
    expect(runner.calls).toHaveLength(2);
    expect(router.status().routes.map((r) => r.app)).toEqual(["a", "b"]);
    router.stop();
  });

  test("a failed reload is recorded, not thrown, and retried on the next sync", async () => {
    const { router, runner, log } = await setup("caddy", true);
    const r = await router.sync();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("connection refused");
    expect(router.status().lastSync?.ok).toBe(false);
    expect(log.at(-1)).toMatch(/sync failed: connection refused/);
    await router.sync();
    expect(runner.calls).toHaveLength(2);
  });

  test("backend none writes nothing but still lists the table", async () => {
    const { router, runner, file } = await setup("none");
    expect((await router.sync()).ok).toBe(true);
    expect(runner.calls).toEqual([]);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(router.enabled).toBe(false);
    expect(router.status().routes).toEqual([{ app: "a", host: "a.example.com", target: "127.0.0.1:8710", status: "wildcard" }]);
  });
});
