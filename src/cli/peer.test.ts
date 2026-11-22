import { expect, test } from "bun:test";
import { runCli } from "./testing.ts";

// `space peer migrate` against a scripted hub: what it sends, what it prints, its exit codes. The migration itself
// runs between two in-process Spaces in src/space/peers/migrate.test.ts.

const dry = {
  ok: true, peer: "box", state: "dry-run", connection: undefined,
  steps: [
    { step: "connection", status: "would", detail: "create an incoming connection for 0d8c… under the alias box" },
    { step: "peer", status: "would", detail: "ask the peer to dial https://hub.example" },
    { step: "verify", status: "would", detail: "wait up to 30 s" },
    { step: "legacy", status: "would", detail: "comment out SPACE_PEER_BOX, SPACE_PEER_BOX_TOKEN" },
  ],
  removed: [{ key: "SPACE_PEER_BOX", value: "https://box.example" }, { key: "SPACE_PEER_BOX_TOKEN", value: "abcd…wxyz" }],
  warnings: ["The peer now dials https://hub.example/api/connections/channel."],
};

test("a dry run sends its flags to the migrate route and prints the plan", async () => {
  const r = await runCli(["peer", "migrate", "box", "--dry-run", "--hub-url", "https://hub.example", "--wait", "5"], (t) => t.scripted.reply({ status: 200, body: dry }));
  expect(r.code).toBe(0);
  expect(r.calls[0]).toMatchObject({ method: "POST", url: expect.stringMatching(/\/api\/peers\/box\/migrate$/), body: { mode: "auto", dryRun: true, hubUrl: "https://hub.example", waitMs: 5000 } });
  expect(r.out[0]).toBe("box: dry run, nothing changed");
  expect(r.out).toContain("  → connection create an incoming connection for 0d8c… under the alias box");
  expect(r.out).toContain("    SPACE_PEER_BOX_TOKEN=abcd…wxyz");
  expect(r.err.join("\n")).toContain("note: The peer now dials");
});

test("a peer that cannot be migrated automatically exits 1 with the reason; manual and finish are their own modes", async () => {
  const refused = { ok: false, peer: "box", state: "needs-manual", steps: [{ step: "peer", status: "failed", detail: "no adopt route" }], warnings: [], error: "run `space peer migrate box --manual`" };
  const r = await runCli(["peer", "migrate", "box"], (t) => t.scripted.reply({ status: 409, body: refused }));
  expect(r.code).toBe(1);
  expect(r.err.join("\n")).toContain("--manual");
  const manual = await runCli(["peer", "migrate", "box", "--manual"], (t) => t.scripted.reply({ status: 200, body: { ok: true, peer: "box", state: "manual", steps: [], warnings: [], manual: ["SPACE_CONNECTION_X_TOKEN=tok", "space peer migrate box --finish"] } }));
  expect(manual).toMatchObject({ code: 0 });
  expect(manual.calls[0]?.body).toMatchObject({ mode: "manual" });
  expect(manual.out).toContain("  SPACE_CONNECTION_X_TOKEN=tok");
  const finish = await runCli(["peer", "migrate", "box", "--finish", "--keep-legacy", "--json"], (t) => t.scripted.reply({ status: 200, body: { ok: true, peer: "box", state: "kept", steps: [], warnings: [] } }));
  expect(finish.code).toBe(0);
  expect(finish.calls[0]?.body).toEqual({ mode: "finish", keepLegacy: true });
  expect(JSON.parse(finish.out.join("\n"))).toMatchObject({ state: "kept" });
});

test("--all migrates each legacy peer, carries on past a refusal and exits 1 when one failed", async () => {
  const peers = { ok: true, peers: [{ name: "a", via: "http" }, { name: "b", via: "connection" }, { name: "c", via: "http" }] };
  const r = await runCli(["peer", "migrate", "--all"], (t) => t.scripted.reply(
    { status: 200, body: peers },
    { status: 400, body: { ok: false, error: "no public address" } },
    { status: 200, body: { ok: true, peer: "c", state: "migrated", steps: [], warnings: [] } },
  ));
  expect(r.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /api/peers", "POST /api/peers/a/migrate", "POST /api/peers/c/migrate"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("c: migrated");
});

test("the command line is checked before anything is sent", async () => {
  for (const argv of [["peer", "migrate"], ["peer", "migrate", "a", "--all"], ["peer", "migrate", "a", "--manual", "--finish"], ["peer", "migrate", "--all", "--peer-id", "x"], ["peer", "migrate", "a", "--wait", "0"], ["peer", "migrate", "a", "b"]]) {
    const r = await runCli(argv);
    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
  }
});

test("peer ls says which peers are still on the legacy channel", async () => {
  const r = await runCli(["peer", "ls"], (t) => t.scripted.reply({ status: 200, body: { ok: true, peers: [{ name: "a", via: "http", url: "https://a", health: "ok", stale: false, apps: 1, agents: 0, widgets: 0 }, { name: "b", via: "connection", url: "connection:c1", health: "ok", stale: false, apps: 2, agents: 0, widgets: 0 }] } }));
  expect(r.code).toBe(0);
  expect(r.out.find((l) => l.startsWith("a "))).toContain("legacy");
  expect(r.out.find((l) => l.startsWith("b "))).toContain("connection");
  expect(r.err).toEqual(["1 on the legacy peer channel: `space peer migrate --all` moves them onto connections (docs/peers.md#moving-a-legacy-peer)"]);
});
