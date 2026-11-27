import { describe, expect, test } from "bun:test";
import { runCli } from "./testing.ts";
import { EXIT } from "./types.ts";

/** `space delegate` (docs/cli.md#delegate): the turn's run token and API address from its environment. */

const env = { SPACE_HOME: "/nonexistent/space-cli-test", SPACE_API_URL: "http://127.0.0.1:8711", SPACE_RUN_TOKEN: "srt_turn" };
const delegation = { id: 3, label: "Delegation #3", state: "running", permission: "edit", to: { agent: "space/engineer", role: "engineer", title: "Engineer", session: "s-1" }, createdAt: new Date().toISOString(), endedAt: null, notes: [{ seq: 1, at: "", kind: "brief", text: "Goal: x" }, { seq: 2, at: "", kind: "say", text: "also y", taken: true, readAt: null }], delivered: null, asking: [] };

describe("space delegate", () => {
  test("start sends the brief from stdin with the run token, to the turn's Space", async () => {
    const r = await runCli(["delegate", "start", "engineer", "--brief-file", "-", "--continue", "#2", "--image", "12"], (t) => t.scripted.reply({ status: 201, body: { ok: true, delegation } }), { env, stdin: async () => "Goal: x\nWhere: app-src/notes\n" });
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8711/api/delegations", headers: { authorization: "Bearer srt_turn" } });
    expect(r.calls[0]!.body).toEqual({ to: "engineer", brief: "Goal: x\nWhere: app-src/notes\n", continue: 2, images: [12] });
    expect(r.out[0]).toStartWith("Delegation #3 started: Engineer (space/engineer), permission edit.");
  });

  test("start and say need the run token; the brief is given once", async () => {
    expect((await runCli(["delegate", "start", "engineer", "--brief", "x"], () => {}, { env: { SPACE_HOME: env.SPACE_HOME } })).code).toBe(EXIT.usage);
    expect((await runCli(["delegate", "say", "3", "x"], () => {}, { env: { SPACE_HOME: env.SPACE_HOME } })).code).toBe(EXIT.usage);
    expect((await runCli(["delegate", "start", "engineer"], () => {}, { env })).code).toBe(EXIT.usage);
    expect((await runCli(["delegate", "start", "engineer", "--brief", "x", "--brief-file", "-"], () => {}, { env })).code).toBe(EXIT.usage);
  });

  test("say: taken, or not taken with the reason (exit 1)", async () => {
    const ok = await runCli(["delegate", "say", "3", "also", "the", "label"], (t) => t.scripted.reply({ status: 200, body: { ok: true } }), { env });
    expect(ok.code).toBe(EXIT.ok);
    expect(ok.calls[0]).toMatchObject({ url: "http://127.0.0.1:8711/api/delegations/3/steer", body: { message: "also the label" } });
    const ended = await runCli(["delegate", "say", "3", "late"], (t) => t.scripted.reply({ status: 200, body: { ok: false, reason: "ended", error: "Delegation #3 has ended" } }), { env });
    expect(ended.code).toBe(EXIT.failed);
    expect(ended.err[0]).toBe("Delegation #3: not taken (ended): Delegation #3 has ended");
  });

  test("stop prints what the delegate had said; show prints the record and the last steps", async () => {
    const stop = await runCli(["delegate", "stop", "3"], (t) => t.scripted.reply({ status: 200, body: { ok: true, stopped: true, last: "half done" } }), { env });
    expect(stop.out).toEqual(["Delegation #3 stopped. Files it changed stay changed. What it had said:", "half done"]);
    const show = await runCli(["delegate", "show", "3"], (t) => t.scripted.reply({ status: 200, body: { ok: true, delegation, notes: delegation.notes, tail: ["Bash: bun test"] } }), { env });
    expect(show.out[0]).toStartWith("Delegation #3 → Engineer (space/engineer): running · session s-1");
    expect(show.out.slice(1)).toEqual(["  1. brief: Goal: x", "  2. say (taken, not read yet): also y", "  last steps:", "    Bash: bun test"]);
  });
});
