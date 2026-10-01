import { describe, expect, test } from "bun:test";
import { parseFilterFlags } from "./consumer.ts";
import { runCli } from "./testing.ts";
import { EXIT } from "./types.ts";

const consumer = {
  name: "hub-sync",
  subscriptions: [{ event: "asset-center/group.changed", filter: { groupId: ["g1", "g2"] } }],
  calls: [{ capability: "asset-center/group-members", filter: { groupId: ["g1", "g2"] } }],
  tokenHint: "sec_abcdef…",
  createdAt: new Date().toISOString(),
};

describe("space consumer", () => {
  test("add builds subscriptions and calls from flags, one filter for both, and prints the token", async () => {
    const r = await runCli(["consumer", "add", "hub-sync", "--event", "asset-center/group.changed", "--filter", "groupId=g1,g2", "--call", "asset-center/group-members"], (t) =>
      t.scripted.reply({ status: 201, body: { ok: true, consumer, token: "sec_secret" } }),
    );
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8700/api/consumers", headers: { authorization: "Bearer op-token" } });
    expect(r.calls[0]!.body).toEqual({
      name: "hub-sync",
      subscriptions: [{ event: "asset-center/group.changed", filter: { groupId: ["g1", "g2"] } }],
      calls: [{ capability: "asset-center/group-members", filter: { groupId: ["g1", "g2"] } }],
    });
    expect(r.out).toContain("sec_secret");
  });

  test("add takes a JSON body and needs an event otherwise", async () => {
    const body = { name: "x", subscriptions: ["a/b"] };
    const r = await runCli(["consumer", "add", JSON.stringify(body)], (t) => t.scripted.reply({ status: 201, body: { ok: true, consumer: { ...consumer, name: "x", calls: [] }, token: "sec_t" } }));
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls[0]!.body).toEqual(body);
    expect((await runCli(["consumer", "add", "x"])).code).toBe(EXIT.usage);
    expect(() => parseFilterFlags(["nokey"])).toThrow();
    expect(parseFilterFlags(["groupId=g1"])).toEqual({ groupId: "g1" });
  });

  test("ls, rotate and rm call their routes; rm and rotate ask without --yes", async () => {
    const ls = await runCli(["consumer", "ls"], (t) => t.scripted.reply({ status: 200, body: { ok: true, consumers: [consumer] } }));
    expect(ls.out.join("\n")).toContain("hub-sync");
    expect(ls.out.join("\n")).toContain("asset-center/group-members");
    expect((await runCli(["consumer", "rm", "hub-sync"])).code).toBe(EXIT.usage);
    const rm = await runCli(["consumer", "rm", "hub-sync", "--yes"], (t) => t.scripted.reply({ status: 200, body: { ok: true } }));
    expect(rm.calls[0]).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:8700/api/consumers/hub-sync" });
    const rot = await runCli(["consumer", "rotate", "hub-sync", "-y"], (t) => t.scripted.reply({ status: 200, body: { ok: true, consumer, token: "sec_new" } }));
    expect(rot.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8700/api/consumers/hub-sync/rotate" });
    expect(rot.out).toContain("sec_new");
  });
});
