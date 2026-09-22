import { expect, test } from "bun:test";
import { createLogsRoutes } from "./api.ts";
import type { LogsProcess, LogsRequest } from "./logs.ts";

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

function fakeSpawn(lines: string[], code = 0, opts: { hang?: boolean } = {}) {
  const requests: LogsRequest[] = [];
  let killed = false;
  let release: (() => void) | undefined;
  const spawn = (req: LogsRequest): LogsProcess => {
    requests.push(req);
    const gen = async function* () {
      for (const l of lines) yield l;
      if (opts.hang) await new Promise<void>((r) => (release = r));
    };
    return {
      lines: gen(),
      exited: Promise.resolve(code),
      kill: () => {
        killed = true;
        release?.();
      },
    };
  };
  return { spawn, requests, killed: () => killed };
}

function call(routes: ReturnType<typeof createLogsRoutes>, url: string, params: Record<string, string>, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const req = Object.assign(new Request(url, { headers, signal }), { params });
  return (routes["/api/apps/:app/logs"]!.GET as Handler)(req);
}

test("the last lines as text, with the exit code in a header", async () => {
  const f = fakeSpawn(["one", "two"]);
  const routes = createLogsRoutes({ template: "t", token: "tok", knownApp: (a) => a === "demo", spawn: f.spawn });
  const res = await call(routes, "http://h/api/apps/demo/logs?lines=2", { app: "demo" }, { authorization: "Bearer tok" });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toBe("one\ntwo\n");
  expect(f.requests[0]).toEqual({ app: "demo", lines: 2, follow: false });
});

test("token, unknown app and bad lines are refused; space is always known", async () => {
  const f = fakeSpawn(["x"]);
  const routes = createLogsRoutes({ template: "t", token: "tok", knownApp: () => false, spawn: f.spawn });
  expect((await call(routes, "http://h/api/apps/demo/logs", { app: "demo" })).status).toBe(401);
  expect((await call(routes, "http://h/api/apps/demo/logs", { app: "demo" }, { authorization: "Bearer tok" })).status).toBe(404);
  expect((await call(routes, "http://h/api/apps/space/logs?lines=x", { app: "space" }, { authorization: "Bearer tok" })).status).toBe(400);
  expect((await call(routes, "http://h/api/apps/space/logs", { app: "space" }, { authorization: "Bearer tok" })).status).toBe(200);
  expect((await call(routes, "http://h/api/apps/a%3Bb/logs", { app: "a;b" }, { authorization: "Bearer tok" })).status).toBe(400);
});

test("a command that fails with no output is a 502", async () => {
  const f = fakeSpawn([], 1);
  const routes = createLogsRoutes({ template: "t", knownApp: () => true, spawn: f.spawn });
  const res = await call(routes, "http://h/api/apps/demo/logs", { app: "demo" });
  expect(res.status).toBe(502);
});

test("follow streams one event per line, ends with the exit code", async () => {
  const f = fakeSpawn(["a", "b"], 0);
  const routes = createLogsRoutes({ template: "t", knownApp: () => true, spawn: f.spawn, keepaliveMs: 60_000 });
  const res = await call(routes, "http://h/api/apps/demo/logs?follow=1", { app: "demo" });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(await res.text()).toBe('event: line\ndata: "a"\n\nevent: line\ndata: "b"\n\nevent: end\ndata: {"code":0}\n\n');
  expect(f.requests[0]!.follow).toBe(true);
});

test("the command is killed when the reader leaves", async () => {
  const f = fakeSpawn(["a"], 0, { hang: true });
  const routes = createLogsRoutes({ template: "t", knownApp: () => true, spawn: f.spawn, keepaliveMs: 60_000 });
  const ac = new AbortController();
  const res = await call(routes, "http://h/api/apps/demo/logs?follow=1", { app: "demo" }, {}, ac.signal);
  const reader = res.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: "a"');
  ac.abort();
  await Bun.sleep(10);
  expect(f.killed()).toBe(true);
});
