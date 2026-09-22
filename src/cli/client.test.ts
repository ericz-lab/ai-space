import { describe, expect, test } from "bun:test";
import { scriptedFetch } from "../space/notify/testing.ts";
import { Client, DEFAULT_URL, parseSse, resolveTarget } from "./client.ts";
import { ApiError, Unreachable } from "./types.ts";

describe("resolveTarget", () => {
  test("flags win, then the environment, then the workspace .env, then loopback", async () => {
    const file = async () => ({ SPACE_HOST: "10.0.0.1", SPACE_PORT: "9000", SPACE_API_TOKEN: "file-token" });
    expect(await resolveTarget({ url: "http://x:1/", token: "t" }, {}, file)).toMatchObject({ url: "http://x:1", token: "t" });
    expect(await resolveTarget({}, { SPACE_API_URL: "http://127.0.0.1:8701", SPACE_API_TOKEN: "env-token" }, file)).toMatchObject({ url: "http://127.0.0.1:8701", token: "env-token" });
    expect(await resolveTarget({}, {}, file)).toMatchObject({ url: "http://10.0.0.1:9000", token: "file-token" });
    expect(await resolveTarget({}, { SPACE_PORT: "8799" }, async () => ({}))).toMatchObject({ url: "http://127.0.0.1:8799", token: "" });
    expect(await resolveTarget({}, {}, async () => ({}))).toMatchObject({ url: DEFAULT_URL, token: "" });
  });

  test("keeps the app's own token and name for the routes that take an app identity", async () => {
    const t = await resolveTarget({}, { SPACE_APP_TOKEN: "sat_x", SPACE_APP: "demo", SPACE_API_TOKEN: "op" }, async () => ({}));
    expect(t).toMatchObject({ appToken: "sat_x", app: "demo", token: "op" });
  });

  test("an unreadable .env is the same as an empty one", async () => {
    expect(await resolveTarget({}, {}, async () => { throw new Error("nope"); })).toMatchObject({ url: DEFAULT_URL });
  });
});

describe("Client", () => {
  const client = (s = scriptedFetch()) => ({ s, c: new Client({ url: "http://h:1", token: "op", appToken: "sat" }, s.fetch as unknown as typeof fetch) });

  test("adds the operator token, or the app token when asked", async () => {
    const { s, c } = client();
    s.reply({ status: 200, body: { ok: true } }, { status: 200, body: { ok: true } });
    await c.get("/api/tasks");
    await c.post("/api/notify", { text: "x" }, { asApp: true });
    expect(s.calls[0]).toMatchObject({ url: "http://h:1/api/tasks", method: "GET", headers: { authorization: "Bearer op" } });
    expect(s.calls[1]).toMatchObject({ method: "POST", headers: { authorization: "Bearer sat", "content-type": "application/json" }, body: { text: "x" } });
  });

  test("a refusal is an ApiError with the status and the server's message", async () => {
    const { s, c } = client();
    s.reply({ status: 401, body: { ok: false, error: "unauthorized" } });
    const e = await c.get("/api/x").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.message).toBe("401: unauthorized");
  });

  test("an accepted status is not an error", async () => {
    const { s, c } = client();
    s.reply({ status: 409, body: { ok: true, started: false } });
    expect(await c.post<{ ok: boolean; started: boolean }>("/api/tasks/x/run", undefined, { accept: [409] })).toEqual({ ok: true, started: false });
  });

  test("nothing answering is Unreachable", async () => {
    const { s, c } = client();
    s.reply(new Error("ECONNREFUSED"));
    const e = await c.get("/healthz").catch((x) => x);
    expect(e).toBeInstanceOf(Unreachable);
    expect(e.message).toContain("http://h:1");
  });
});

test("parseSse splits events, ignores comments, joins multi-line data", async () => {
  const text = ": keepalive\n\nevent: delta\ndata: {\"text\":\"a\"}\n\ndata: one\ndata: two\n\nevent: done\ndata: {}\n";
  const stream = new Response(text).body!;
  const events = [];
  for await (const ev of parseSse(stream)) events.push(ev);
  expect(events).toEqual([
    { event: "delta", data: '{"text":"a"}' },
    { event: "message", data: "one\ntwo" },
    { event: "done", data: "{}" },
  ]);
});
