import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeOnly } from "../runtimes/registry.ts";
import { fakeModelBin } from "../runtimes/testing.ts";
import { PeerHub } from "../peers/hub.ts";
import { PeerLedgers } from "../peers/ledgers.ts";
import { createModelRoutes, createPeerUsageRoutes } from "./api.ts";
import { mergeReports, peerReport, usageReport } from "./report.ts";
import { ModelService } from "./service.ts";
import { ModelStore } from "./store.ts";
import type { ModelCallInput } from "./types.ts";

// A hub ("main") and one peer, which the hub calls "box" and which calls itself "box-space".
// Each sent one call to the other; each ledger holds both its own row and the other's.

let dir: string;
let hubStore: ModelStore;
let peerStore: ModelStore;
let peerServer: ReturnType<typeof Bun.serve>;
let hubServer: ReturnType<typeof Bun.serve>;
let hubBase: string;
let peerDown = false;

const NOW = Date.now();
const call = (over: Partial<ModelCallInput>): ModelCallInput => ({
  app: "x",
  tag: "t",
  model: "opus",
  backend: "local",
  origin: "run",
  status: "ok",
  startedAt: NOW - 60_000,
  durationMs: 1000,
  promptChars: 10,
  usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1 },
  costUsd: 0.01,
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-peer-ledger-"));
  hubStore = new ModelStore(join(dir, "hub.db"));
  peerStore = new ModelStore(join(dir, "peer.db"));

  // The hub's own call, run here.
  hubStore.add(call({ app: "todo", tag: "chat", model: "sonnet", startedAt: NOW - 50_000 }));
  // The hub's call sent to the peer: the hub's row names the peer as the machine.
  hubStore.add(call({ app: "feed", tag: "translate", model: "gpt-6-luna", machine: "box", backend: "peer:box", startedAt: NOW - 40_000 }));
  // The peer's call run here for it: the peer's own row counts it.
  hubStore.add(call({ app: "box-space/watch", tag: "web", origin: "peer", startedAt: NOW - 30_000 }));

  // The peer's row of the hub's call: the hub's own row counts it.
  peerStore.add(call({ app: "main/feed", tag: "translate", model: "gpt-6-luna", origin: "peer", startedAt: NOW - 40_000 }));
  // The peer's call it sent to the hub.
  peerStore.add(call({ app: "watch", tag: "web", machine: "main", backend: "peer:main", startedAt: NOW - 30_000 }));
  // The peer's own call, run on the peer.
  peerStore.add(call({ app: "theme", tag: "digest", startedAt: NOW - 20_000, usage: { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }));
  // An app the peer link does not share.
  peerStore.add(call({ app: "secret", tag: "x", startedAt: NOW - 10_000 }));

  const service = (store: ModelStore) => new ModelService({ store, runtimes: claudeOnly(fakeModelBin()), maxConcurrency: 1, log: () => {} });
  const peerRoutes = createPeerUsageRoutes({ service: service(peerStore), name: "box-space", skipApps: () => ["secret"] });
  peerServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: peerRoutes, fetch: () => new Response("nf", { status: 404 }) });
  const peerBase = `http://127.0.0.1:${peerServer.port}`;

  peerDown = false;
  const hub = new PeerHub([{ name: "box", url: peerBase, token: "t", headers: {}, refreshMs: 10_000 }], {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      if (peerDown) throw new Error("connection refused");
      return fetch(url, init);
    }) as typeof fetch,
  });
  hubServer = Bun.serve({
    port: 0,
    routes: createModelRoutes({ service: service(hubStore), peerLedgers: new PeerLedgers(hub, "main", { timeoutMs: 2_000 }) }),
    fetch: () => new Response("nf", { status: 404 }),
  });
  hubBase = `http://127.0.0.1:${hubServer.port}`;
});

afterEach(async () => {
  hubServer.stop(true);
  peerServer.stop(true);
  hubStore.close();
  peerStore.close();
  await rm(dir, { recursive: true, force: true });
});

type Row = { app: string; tag: string; model: string; machine: string; calls: number };
const rows = (j: { byTag: Row[] }) => j.byTag.map((r) => `${r.app} ${r.tag} ${r.machine ? `${r.machine}:` : ""}${r.model}`).sort();

describe("the hub's usage with its peers' ledgers", () => {
  test("each call once, under the app that started it and the machine that ran it", async () => {
    const j = await (await fetch(`${hubBase}/api/model/usage?window=24h`)).json();
    expect(rows(j)).toEqual(["box/theme digest box:opus", "box/watch web main:opus", "feed translate box:gpt-6-luna", "todo chat sonnet"]);
    expect(j.totals.calls).toBe(4);
    expect(j.history.totals.calls).toBe(4);
    expect(j.byApp.map((r: { app: string }) => r.app)).toContain("box/theme");
    expect(j.byModel.map((r: { model: string; machine: string }) => `${r.machine}:${r.model}`).sort()).toEqual([":sonnet", "box:gpt-6-luna", "box:opus", "main:opus"]);
    expect(j.byBackend.map((r: { backend: string }) => r.backend).sort()).toEqual(["box:local", "box:peer:main", "local", "peer:box"]);
    expect(j.peers).toEqual([{ name: "box", ok: true, asOf: expect.any(String) }]);
  });

  test("recent calls merge newest first, with ids that do not collide", async () => {
    const j = await (await fetch(`${hubBase}/api/model/calls?limit=10`)).json();
    expect(j.calls.map((c: { app: string }) => c.app)).toEqual(["box/theme", "box/watch", "feed", "todo"]);
    expect(j.calls[0]).toMatchObject({ peer: "box", machine: "box", peerId: 3 });
    expect(j.calls[1]).toMatchObject({ machine: "main" });
    expect(new Set(j.calls.map((c: { id: number }) => c.id)).size).toBe(4);
    expect(j.calls[0].id).toBeLessThan(0);
  });

  test("a peer that stops answering is shown from its last answer, marked", async () => {
    await fetch(`${hubBase}/api/model/usage?window=24h`);
    peerDown = true;
    const j = await (await fetch(`${hubBase}/api/model/usage?window=24h`)).json();
    expect(j.totals.calls).toBe(4);
    expect(j.peers[0]).toMatchObject({ name: "box", ok: false, asOf: expect.any(String), error: "connection refused" });
  });

  test("a peer that never answered adds nothing, and the hub keeps the calls it ran for it", async () => {
    peerDown = true;
    const j = await (await fetch(`${hubBase}/api/model/usage?window=24h`)).json();
    expect(rows(j)).toEqual(["box-space/watch web opus", "feed translate box:gpt-6-luna", "todo chat sonnet"]);
    expect(j.peers).toEqual([{ name: "box", ok: false, error: "connection refused" }]);
  });

  test("an app filter reads this machine only", async () => {
    const j = await (await fetch(`${hubBase}/api/model/usage?window=24h&app=todo`)).json();
    expect(j.totals.calls).toBe(1);
    expect(j.peers).toBeUndefined();
  });
});

test("a peer's report keeps its own rows apart from the hub's", () => {
  const local = usageReport(hubStore, "24h", "local", { skipCallers: ["box-space"] }, NOW);
  const theirs = peerReport("box", usageReport(peerStore, "24h", "local", { skipCallers: ["main"], skipApps: ["secret"] }, NOW));
  const merged = mergeReports(local, [theirs]);
  expect(merged.totals.calls).toBe(local.totals.calls + theirs.totals.calls);
  // Largest first by tokens, as the store orders them.
  expect(merged.byTag[0]).toMatchObject({ app: "box/theme", machine: "box" });
  expect(merged.history.days.reduce((n, d) => n + d.calls, 0)).toBe(4);
  expect(mergeReports(local, [])).toBe(local);
});
